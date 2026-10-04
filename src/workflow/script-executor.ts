import { Worker } from "node:worker_threads";
import { Effect, Option, Queue, Result, type Scope } from "effect";
import { DEFAULT_WORKFLOW_CHECKPOINT_LIMIT } from "./parser.ts";
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
  /** Sealed ready calls; promises settle independently, without a result barrier. */
  agentBatch?(payloads: any[]): Promise<unknown>[];
  /** Cancel child work after a fatal script policy without terminating branch finally blocks. */
  abortChildren?(error: Error): void;
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
  loadWorkflow(payload: {
    nameOrRef: unknown;
    callPath?: unknown;
    args?: unknown;
  }): Promise<{ meta: unknown; body: string }>;
  validateOutput(payload: { value: unknown; label?: unknown }): Promise<void>;
  log(message: string): void;
  phase(title: string): void;
}

export interface ScriptExecutorOptions {
  cwd: string;
  args?: unknown;
  name: string;
  meta?: unknown;
  signal: AbortSignal;
  checkpointLimit?: number;
  /** Internal test seam: how long the worker may go without a heartbeat. Not a public workflow option. */
  stallTimeoutMs?: number;
  /** Internal test seam for host-call fuel. */
  hostCallLimit?: number;
  /** Internal test seam for the Worker's V8 old-generation heap cap. */
  workerMemoryLimitMb?: number;
  /** Bound for fatal host-RPC draining before forced termination. */
  fatalDrainTimeoutMs?: number;
}

/** Keep arbitrary host failures intact at the exported Promise boundary. */
interface ScriptFailure {
  readonly _tag: "ScriptFailure";
  readonly cause: unknown;
}

const scriptFailure = (cause: unknown): ScriptFailure => ({ _tag: "ScriptFailure", cause });
const attempt = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: scriptFailure });

type ExecutorEvent =
  | { readonly type: "message"; readonly message: any }
  | { readonly type: "error"; readonly error: NodeJS.ErrnoException }
  | { readonly type: "exit"; readonly code: number }
  | { readonly type: "watchdog" | "fatalDeadline" | "rpcSettled" };

export function executeWorkflowScript(
  body: string,
  host: ScriptExecutorHost,
  options: ScriptExecutorOptions,
): Promise<unknown> {
  // Effect v4 runPromise rejects with the original failure value, not a FiberFailure.
  return Effect.runPromise(
    executeScript(body, host, options).pipe(
      Effect.scoped,
      Effect.mapError((failure) => failure.cause),
    ),
  );
}

function executeScript(body: string, host: ScriptExecutorHost, options: ScriptExecutorOptions) {
  function startWorker(events: Queue.Queue<ExecutorEvent>, fatalDrainTimeoutMs: number) {
    return Effect.acquireRelease(
      attempt(() => createWorker(body, options)),
      (resource) => resource.stop,
    ).pipe(
      Effect.flatMap((resource) =>
        Effect.scope.pipe(
          Effect.flatMap((scope) =>
            runWorker(host, options, events, resource, scope, fatalDrainTimeoutMs),
          ),
        ),
      ),
    );
  }

  return Effect.suspend(() => {
    if (options.signal.aborted) return Effect.fail(scriptFailure(new WorkflowAbortError()));
    return attempt(() => normalizeFatalDrainTimeout(options.fatalDrainTimeoutMs)).pipe(
      Effect.flatMap((fatalDrainTimeoutMs) =>
        Effect.acquireRelease(Queue.unbounded<ExecutorEvent>(), Queue.shutdown).pipe(
          Effect.flatMap((events) => startWorker(events, fatalDrainTimeoutMs)),
        ),
      ),
    );
  });
}

function runWorker(
  host: ScriptExecutorHost,
  options: ScriptExecutorOptions,
  events: Queue.Queue<ExecutorEvent>,
  resource: ReturnType<typeof createWorker>,
  scope: Scope.Scope,
  fatalDrainTimeoutMs: number,
) {
  const { worker } = resource;
  const emit = (event: ExecutorEvent): void => {
    Queue.offerUnsafe(events, event);
  };
  const stallTimeoutMs = options.stallTimeoutMs ?? 5_000;
  let lastHeartbeat = Date.now();
  let lastProgress = lastHeartbeat;
  let lastCheckpointCount = 0;
  let pendingRpcCount = 0;
  let abortRequested = false;
  let workerReportedResult = false;
  let fatalError: Error | undefined;
  const continueEvents = Effect.succeed(Option.none<unknown>());

  function installListeners() {
    const onMessage = (message: unknown) => emit({ type: "message", message });
    const onError = (error: NodeJS.ErrnoException) => emit({ type: "error", error });
    const onExit = (code: number) => emit({ type: "exit", code });
    const onAbort = () => {
      abortRequested = true;
      // Terminate in the signal callback, before any cancelled host Promise
      // can send a reply that lets the worker advance into a branch finally.
      Effect.runSync(Effect.forkIn(resource.stop, scope, { startImmediately: true }));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    return () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      options.signal.removeEventListener("abort", onAbort);
    };
  }

  const listeners = Effect.acquireRelease(
    Effect.sync(installListeners),
    // Keep the error listener installed until termination has actually completed.
    (removeListeners) => Effect.andThen(resource.stop, Effect.sync(removeListeners)),
  );
  const watchdog = Effect.acquireRelease(
    Effect.sync(() => {
      const timer = setInterval(
        () => emit({ type: "watchdog" }),
        Math.max(10, Math.min(250, Math.floor(stallTimeoutMs / 2))),
      );
      timer.unref?.();
      return timer;
    }),
    (timer) => Effect.sync(() => clearInterval(timer)),
  );

  function beginFatalDrain(error: Error) {
    return Effect.suspend(() => {
      const first = fatalError === undefined;
      fatalError ??= error;
      return attempt(() => host.abortChildren?.(fatalError!)).pipe(
        Effect.ignore,
        Effect.andThen(() =>
          first
            ? Effect.acquireRelease(
                Effect.sync(() => {
                  const timer = setTimeout(
                    () => emit({ type: "fatalDeadline" }),
                    fatalDrainTimeoutMs,
                  );
                  timer.unref?.();
                  return timer;
                }),
                (timer) => Effect.sync(() => clearTimeout(timer)),
              ).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );
    });
  }

  function dispatchRpc(message: any, agentResult?: Effect.Effect<unknown, ScriptFailure>) {
    return Effect.suspend(() => {
      pendingRpcCount++;
      lastProgress = Date.now();
      return handleRpc(worker, host, message, agentResult).pipe(
        Effect.ensuring(Effect.sync(() => emit({ type: "rpcSettled" }))),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      );
    });
  }

  function checkWatchdog() {
    if (fatalError) return continueEvents;
    const now = Date.now();
    if (now - lastHeartbeat > stallTimeoutMs) {
      return Effect.fail(
        scriptFailure(
          options.signal.aborted
            ? new WorkflowAbortError()
            : new WorkflowStallError(
                `workflow script worker became unresponsive for ${stallTimeoutMs}ms`,
              ),
        ),
      );
    }
    if (pendingRpcCount === 0 && now - lastProgress > stallTimeoutMs) {
      return Effect.fail(
        scriptFailure(
          new WorkflowStallError(`workflow script made no script progress for ${stallTimeoutMs}ms`),
        ),
      );
    }
    return continueEvents;
  }

  function handleMessage(
    message: any,
  ): Effect.Effect<Option.Option<unknown>, ScriptFailure, Scope.Scope> {
    if (!message || typeof message !== "object") return continueEvents;
    switch (message.type) {
      case "heartbeat": {
        lastHeartbeat = Date.now();
        const checkpoints = Number.isFinite(message.checkpoints)
          ? Number(message.checkpoints)
          : lastCheckpointCount;
        if (checkpoints !== lastCheckpointCount) {
          lastCheckpointCount = checkpoints;
          lastProgress = lastHeartbeat;
        }
        return continueEvents;
      }
      case "fatal":
        return beginFatalDrain(reviveError(message.error)).pipe(Effect.andThen(continueEvents));
      case "event":
        lastProgress = Date.now();
        return attempt(() => {
          if (message.op === "log") host.log(String(message.payload?.message ?? ""));
          else if (message.op === "phase") host.phase(String(message.payload?.title ?? ""));
        }).pipe(Effect.andThen(continueEvents));
      case "agentBatch": {
        const calls = message.calls as Array<{ payload: unknown }>;
        // The host starts every Promise at once. Observe all of them in this
        // synchronous step, before dispatch can yield or the scope can close.
        return attempt(() =>
          host.agentBatch?.(calls.map((call) => call.payload)).map(observeAgentResult),
        ).pipe(
          Effect.flatMap((results) =>
            Effect.forEach(calls, (call, index) => dispatchRpc(call, results?.[index]), {
              concurrency: 1,
              discard: true,
            }),
          ),
          Effect.andThen(continueEvents),
        );
      }
      case "rpc":
        return dispatchRpc(message).pipe(Effect.andThen(continueEvents));
      case "result": {
        workerReportedResult = true;
        if (fatalError) return continueEvents;
        if (message.ok) return Effect.succeed(Option.some(message.value));
        const error = reviveError(message.error);
        return error instanceof WorkflowPolicyError
          ? beginFatalDrain(error).pipe(Effect.andThen(continueEvents))
          : Effect.fail(scriptFailure(error));
      }
      default:
        return continueEvents;
    }
  }

  function handleEvent(
    event: ExecutorEvent,
  ): Effect.Effect<Option.Option<unknown>, ScriptFailure, Scope.Scope> {
    switch (event.type) {
      case "rpcSettled":
        pendingRpcCount = Math.max(0, pendingRpcCount - 1);
        lastProgress = Date.now();
        return continueEvents;
      case "fatalDeadline":
        return fatalError ? Effect.fail(scriptFailure(fatalError)) : continueEvents;
      case "watchdog":
        return checkWatchdog();
      case "error":
        if (event.error.code !== "ERR_WORKER_OUT_OF_MEMORY") {
          return Effect.fail(scriptFailure(event.error));
        }
        workerReportedResult = true;
        return beginFatalDrain(
          new WorkflowPolicyError("workflow script exceeded its worker memory limit"),
        ).pipe(Effect.andThen(continueEvents));
      case "exit":
        if (fatalError) {
          workerReportedResult = true;
          return continueEvents;
        }
        return Effect.fail(
          scriptFailure(
            abortRequested || options.signal.aborted
              ? new WorkflowAbortError()
              : new Error(
                  event.code === 0
                    ? "workflow script worker exited without returning a result"
                    : `workflow script worker exited with code ${event.code}`,
                ),
          ),
        );
      case "message":
        return handleMessage(event.message);
    }
  }

  // One consumer preserves worker message order. RPC fibers start immediately
  // but settle independently, so a slow sibling never becomes a result barrier.
  function consumeEvents(): Effect.Effect<unknown, ScriptFailure, Scope.Scope> {
    return Effect.suspend(() => {
      if (fatalError && workerReportedResult && pendingRpcCount === 0) {
        return Effect.fail(scriptFailure(fatalError));
      }
      return Queue.take(events).pipe(
        Effect.flatMap(handleEvent),
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : consumeEvents(),
        ),
      );
    });
  }

  return listeners.pipe(Effect.andThen(watchdog), Effect.andThen(consumeEvents));
}

function createWorker(body: string, options: ScriptExecutorOptions) {
  const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
    workerData: {
      body,
      args: options.args,
      cwd: options.cwd,
      name: options.name,
      meta: options.meta,
      checkpointLimit: options.checkpointLimit ?? DEFAULT_WORKFLOW_CHECKPOINT_LIMIT,
      hostCallLimit: normalizeHostCallLimit(options.hostCallLimit),
    },
    resourceLimits: workerResourceLimits(options.workerMemoryLimitMb),
  });
  // The sole cached native Promise belongs to Worker. Abort and scope release
  // share it; every finalizer awaits the same termination rather than detaching it.
  let termination: Promise<number> | undefined;
  const stop = Effect.tryPromise({
    try: () => (termination ??= worker.terminate()),
    catch: scriptFailure,
  }).pipe(Effect.ignore);
  return { worker, stop };
}

function observeAgentResult(promise: Promise<unknown>) {
  // This adapter never rejects; each RPC later restores its own value or error.
  const result = promise.then(Result.succeed, (cause) => Result.fail(scriptFailure(cause)));
  return Effect.promise(() => result).pipe(Effect.flatMap(Effect.fromResult));
}

function handleRpc(
  worker: Worker,
  host: ScriptExecutorHost,
  message: any,
  agentResult?: Effect.Effect<unknown, ScriptFailure>,
) {
  const { id, op, payload } = message;
  const result =
    agentResult ??
    Effect.tryPromise({
      try: () => {
        switch (op) {
          case "agent":
            return host.agent(payload);
          case "reservePanel":
            return host.reservePanel(payload);
          case "completePanelBranch":
            return host.completePanelBranch(payload);
          case "releasePanel":
            return host.releasePanel(payload);
          case "loadWorkflow":
            return host.loadWorkflow(payload);
          case "validateOutput":
            return host.validateOutput(payload);
          default:
            throw new WorkflowPolicyError(`unknown workflow host RPC: ${op}`);
        }
      },
      catch: scriptFailure,
    });
  return result.pipe(
    Effect.flatMap((value) =>
      cloneForPost(
        op === "completePanelBranch" || op === "releasePanel" || op === "validateOutput"
          ? undefined
          : value,
      ),
    ),
    Effect.match({
      onSuccess: (value) => ({ type: "rpcResult", id, ok: true, value }),
      onFailure: (failure) => ({
        type: "rpcResult",
        id,
        ok: false,
        error: serializeError(failure.cause),
      }),
    }),
    Effect.flatMap((response) => safePost(worker, response)),
  );
}

function workerResourceLimits(value: number | undefined): {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
} {
  const oldGenerationMb = value ?? 128;
  if (!Number.isInteger(oldGenerationMb) || oldGenerationMb < 16 || oldGenerationMb > 1024) {
    throw new WorkflowPolicyError(
      "workflow workerMemoryLimitMb must be an integer between 16 and 1024",
    );
  }
  return {
    maxOldGenerationSizeMb: oldGenerationMb,
    maxYoungGenerationSizeMb: Math.max(8, Math.min(32, Math.floor(oldGenerationMb / 4))),
    stackSizeMb: 8,
  };
}

function normalizeFatalDrainTimeout(value: number | undefined): number {
  if (value === undefined) return 25_000;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new WorkflowPolicyError("workflow fatal drain timeout must be a positive integer");
  }
  return value;
}

function normalizeHostCallLimit(value: number | undefined): number {
  if (value === undefined) return 10_000;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new WorkflowPolicyError(
      "workflow hostCallLimit must be an integer between 1 and 1000000",
    );
  }
  return value;
}

function cloneForPost(value: unknown) {
  return Effect.try({
    try: () => structuredClone(value),
    catch: (error) => {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      return scriptFailure(
        new Error(`workflow host RPC result must be structured-cloneable.${detail}`),
      );
    },
  });
}

function safePost(worker: Worker, message: unknown) {
  // Worker already exited/terminated; runtime drain will settle the host-side promise.
  return attempt(() => worker.postMessage(message)).pipe(Effect.ignore);
}

function reviveError(value: any): Error {
  if (value?.code === WORKFLOW_POLICY_ERROR_CODE)
    return new WorkflowPolicyError(value.message ?? "workflow policy violation");
  if (value?.code === WORKFLOW_ABORT_ERROR_CODE)
    return new WorkflowAbortError(value.message ?? "workflow aborted");
  if (value?.code === WORKFLOW_STALL_ERROR_CODE)
    return new WorkflowStallError(value.message ?? "workflow stalled");
  const error = new Error(value?.message ?? String(value ?? "unknown error"));
  error.name = value?.name ?? "Error";
  if (value?.code) (error as any).code = value.code;
  if (value?.stack) error.stack = value.stack;
  return error;
}

function serializeError(error: unknown): {
  name: string;
  message: string;
  code?: string;
  stack?: string;
} {
  if (error instanceof WorkflowPolicyError) {
    return {
      name: error.name,
      message: error.message,
      code: WORKFLOW_POLICY_ERROR_CODE,
      stack: error.stack,
    };
  }
  if (error instanceof WorkflowAbortError) {
    return {
      name: error.name,
      message: error.message,
      code: WORKFLOW_ABORT_ERROR_CODE,
      stack: error.stack,
    };
  }
  if (error instanceof WorkflowStallError) {
    return {
      name: error.name,
      message: error.message,
      code: WORKFLOW_STALL_ERROR_CODE,
      stack: error.stack,
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code: typeof error === "object" && error ? (error as any).code : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  };
}
