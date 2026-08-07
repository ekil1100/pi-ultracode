import { Worker } from "node:worker_threads";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_LIMIT,
} from "./parser.ts";
import {
  WorkflowAbortError,
  WorkflowPolicyError,
  WorkflowStallError,
  WORKFLOW_ABORT_ERROR_CODE,
  WORKFLOW_POLICY_ERROR_CODE,
  WORKFLOW_STALL_ERROR_CODE,
  type PanelReservation,
} from "./admission.ts";

export interface ScriptExecutorHost {
  agent(payload: any): Promise<unknown>;
  reservePanel(payload: {
    callPath?: unknown;
    reserveAgents: number;
    branchCount: number;
    parentReservationIds?: string[];
  }): Promise<PanelReservation>;
  completePanelBranch(payload: {
    callPath?: unknown;
    branchIndex: number;
    outcome: "success" | "failed";
  }): Promise<void>;
  releasePanel(payload: {
    reservationId: string;
    callPath?: unknown;
    completed?: boolean;
    branchOutcomes?: unknown;
  }): Promise<void>;
  loadWorkflow(payload: { nameOrRef: unknown; callPath?: unknown; args?: unknown }): Promise<{ meta: unknown; body: string }>;
  validateOutput(payload: { value: unknown; label?: unknown }): Promise<void>;
  log(message: string): void;
  phase(title: string): void;
}

export interface ScriptExecutorOptions {
  cwd: string;
  args?: unknown;
  name: string;
  signal: AbortSignal;
  checkpointLimit?: number;
  /** Internal test seam: how long the worker may go without a heartbeat. Not a public workflow option. */
  stallTimeoutMs?: number;
  /** Internal test seam for host-call fuel. */
  hostCallLimit?: number;
  /** Internal test seam for the Worker's V8 old-generation heap cap. */
  workerMemoryLimitMb?: number;
}

type TerminationCause = "abort" | "stall" | "fatal" | "error" | "cleanup";

export async function executeWorkflowScript(
  body: string,
  host: ScriptExecutorHost,
  options: ScriptExecutorOptions,
): Promise<unknown> {
  if (options.signal.aborted) throw new WorkflowAbortError();
  const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
    workerData: {
      body,
      args: options.args,
      cwd: options.cwd,
      name: options.name,
      checkpointLimit: options.checkpointLimit ?? DEFAULT_WORKFLOW_CHECKPOINT_LIMIT,
      hostCallLimit: normalizeHostCallLimit(options.hostCallLimit),
    },
    resourceLimits: workerResourceLimits(options.workerMemoryLimitMb),
  });
  const stallTimeoutMs = options.stallTimeoutMs ?? 5_000;
  let lastHeartbeat = Date.now();
  let lastProgress = lastHeartbeat;
  let lastCheckpointCount = 0;
  let pendingRpcCount = 0;
  let settled = false;
  let terminationCause: TerminationCause | undefined;
  let fatalError: Error | undefined;
  let watchdog: NodeJS.Timeout | undefined;

  const terminate = (cause: TerminationCause): void => {
    terminationCause ??= cause;
    void worker.terminate().catch(() => undefined);
  };

  const abortWorker = () => {
    if (settled) return;
    terminate("abort");
  };
  options.signal.addEventListener("abort", abortWorker, { once: true });

  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const settle = (ok: boolean, value: unknown): void => {
        if (settled) return;
        settled = true;
        if (watchdog) clearInterval(watchdog);
        if (ok) resolve(value);
        else reject(value);
      };
      const rejectAndTerminate = (error: unknown, cause: TerminationCause): void => {
        if (cause === "fatal" && error instanceof Error) fatalError ??= error;
        settle(false, error);
        terminate(cause);
      };

      watchdog = setInterval(() => {
        if (settled) return;
        const now = Date.now();
        if (now - lastHeartbeat > stallTimeoutMs) {
          if (options.signal.aborted) {
            rejectAndTerminate(new WorkflowAbortError(), "abort");
          } else {
            rejectAndTerminate(new WorkflowStallError(`workflow script worker became unresponsive for ${stallTimeoutMs}ms`), "stall");
          }
          return;
        }
        if (pendingRpcCount === 0 && now - lastProgress > stallTimeoutMs) {
          rejectAndTerminate(
            new WorkflowStallError(`workflow script made no script progress for ${stallTimeoutMs}ms`),
            "stall",
          );
        }
      }, Math.max(10, Math.min(250, Math.floor(stallTimeoutMs / 2))));
      watchdog.unref?.();

      if (options.signal.aborted) {
        rejectAndTerminate(new WorkflowAbortError(), "abort");
        return;
      }

      worker.on("message", (message: any) => {
        if (settled || !message || typeof message !== "object") return;
        if (message.type === "heartbeat") {
          lastHeartbeat = Date.now();
          const checkpoints = Number.isFinite(message.checkpoints) ? Number(message.checkpoints) : lastCheckpointCount;
          if (checkpoints !== lastCheckpointCount) {
            lastCheckpointCount = checkpoints;
            lastProgress = lastHeartbeat;
          }
          return;
        }
        if (message.type === "fatal") {
          const error = reviveError(message.error);
          fatalError = error;
          rejectAndTerminate(error, "fatal");
          return;
        }
        if (message.type === "event") {
          lastProgress = Date.now();
          try {
            if (message.op === "log") host.log(String(message.payload?.message ?? ""));
            else if (message.op === "phase") host.phase(String(message.payload?.title ?? ""));
          } catch (error) {
            rejectAndTerminate(error, "error");
          }
          return;
        }
        if (message.type === "rpc") {
          pendingRpcCount++;
          lastProgress = Date.now();
          void handleRpc(message).finally(() => {
            pendingRpcCount = Math.max(0, pendingRpcCount - 1);
            lastProgress = Date.now();
          });
          return;
        }
        if (message.type === "result") {
          if (message.ok) settle(true, message.value);
          else {
            const error = reviveError(message.error);
            if (error instanceof WorkflowPolicyError) fatalError ??= error;
            settle(false, fatalError ?? error);
          }
        }
      });

      worker.on("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
          settle(false, new WorkflowPolicyError("workflow script exceeded its worker memory limit"));
          return;
        }
        settle(false, error);
      });

      worker.on("exit", (code) => {
        if (settled) return;
        if (fatalError) {
          settle(false, fatalError);
        } else if (terminationCause === "abort" || options.signal.aborted) {
          settle(false, new WorkflowAbortError());
        } else if (terminationCause === "stall") {
          settle(false, new WorkflowStallError(`workflow script worker became unresponsive for ${stallTimeoutMs}ms`));
        } else if (code === 0) {
          settle(false, new Error("workflow script worker exited without returning a result"));
        } else {
          settle(false, new Error(`workflow script worker exited with code ${code}`));
        }
      });

      async function handleRpc(message: any): Promise<void> {
        const { id, op, payload } = message;
        try {
          let value: unknown;
          switch (op) {
            case "agent":
              value = await host.agent(payload);
              break;
            case "reservePanel":
              value = await host.reservePanel(payload);
              break;
            case "completePanelBranch":
              await host.completePanelBranch(payload);
              value = undefined;
              break;
            case "releasePanel":
              await host.releasePanel(payload);
              value = undefined;
              break;
            case "loadWorkflow":
              value = await host.loadWorkflow(payload);
              break;
            case "validateOutput":
              await host.validateOutput(payload);
              value = undefined;
              break;
            default:
              throw new WorkflowPolicyError(`unknown workflow host RPC: ${op}`);
          }
          safePost(worker, { type: "rpcResult", id, ok: true, value: cloneForPost(value) });
        } catch (error) {
          safePost(worker, { type: "rpcResult", id, ok: false, error: serializeError(error) });
        }
      }
    });
    return result;
  } finally {
    settled = true;
    if (watchdog) clearInterval(watchdog);
    options.signal.removeEventListener("abort", abortWorker);
    terminate("cleanup");
    await worker.terminate().catch(() => undefined);
  }
}

function workerResourceLimits(value: number | undefined): {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
} {
  const oldGenerationMb = value ?? 128;
  if (!Number.isInteger(oldGenerationMb) || oldGenerationMb < 16 || oldGenerationMb > 1024) {
    throw new WorkflowPolicyError("workflow workerMemoryLimitMb must be an integer between 16 and 1024");
  }
  return {
    maxOldGenerationSizeMb: oldGenerationMb,
    maxYoungGenerationSizeMb: Math.max(8, Math.min(32, Math.floor(oldGenerationMb / 4))),
    stackSizeMb: 8,
  };
}

function normalizeHostCallLimit(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new WorkflowPolicyError("workflow hostCallLimit must be an integer between 1 and 1000000");
  }
  return value;
}

function cloneForPost(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`workflow host RPC result must be structured-cloneable.${detail}`);
  }
}

function safePost(worker: Worker, message: unknown): void {
  try {
    worker.postMessage(message);
  } catch {
    // Worker already exited/terminated; runtime drain will settle the host-side promise.
  }
}

function reviveError(value: any): Error {
  if (value?.code === WORKFLOW_POLICY_ERROR_CODE) return new WorkflowPolicyError(value.message ?? "workflow policy violation");
  if (value?.code === WORKFLOW_ABORT_ERROR_CODE) return new WorkflowAbortError(value.message ?? "workflow aborted");
  if (value?.code === WORKFLOW_STALL_ERROR_CODE) return new WorkflowStallError(value.message ?? "workflow stalled");
  const error = new Error(value?.message ?? String(value ?? "unknown error"));
  error.name = value?.name ?? "Error";
  if (value?.code) (error as any).code = value.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

function serializeError(error: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (error instanceof WorkflowPolicyError) {
    return { name: error.name, message: error.message, code: WORKFLOW_POLICY_ERROR_CODE, stack: error.stack };
  }
  if (error instanceof WorkflowAbortError) {
    return { name: error.name, message: error.message, code: WORKFLOW_ABORT_ERROR_CODE, stack: error.stack };
  }
  if (error instanceof WorkflowStallError) {
    return { name: error.name, message: error.message, code: WORKFLOW_STALL_ERROR_CODE, stack: error.stack };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: typeof error === "object" && error ? (error as any).code : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };
}
