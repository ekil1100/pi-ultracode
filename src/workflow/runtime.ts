/**
 * Deterministic workflow runtime.
 *
 * Parses a workflow script and runs its body inside a Node vm sandbox with the
 * orchestration globals: agent(), parallel(), pipeline(), phase(), log(),
 * workflow(), plus `args` and `cwd`. The Worker installs context-realm wrappers,
 * disables string/wasm code generation, omits Date / require / fs / network, and
 * makes Math.random() throw. These are determinism and liveness guards, not a
 * claim that Node's vm is a security sandbox.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Deferred, Effect, Fiber, Queue, Result, Scope } from "effect";
import type { JsonObject } from "@earendil-works/pi-ai";
import { createJevBatch } from "../jev.ts";
import type { SelectorBackend } from "../selector-backend.ts";
import { parseWorkflowScript, type WorkflowMeta } from "./parser.ts";
import { executeWorkflowScript, type ScriptExecutorHost } from "./script-executor.ts";
import {
  AgentAdmission,
  ABSOLUTE_MAX_AGENTS,
  DEFAULT_MAX_AGENTS,
  WorkflowAbortError,
  WorkflowCleanupTimeoutError,
  WorkflowPolicyError,
  isWorkflowPolicyError,
  normalizeMaxAgents,
  type PanelReservation,
} from "./admission.ts";
// Static import: a dynamic import() of this module misbehaves under Pi's jiti
// loader ("WorkflowAgentRunner is not a constructor"). The runner service constructs the
// default runner unless the host injects one.
import { resolveModelSelection, WorkflowAgentRunner } from "./agent-runner.ts";
import type {
  AgentActivityInput,
  AgentRunResult,
  AgentRunner,
  AgentTelemetryEvent,
  AgentUsage,
  ModelLike,
  ModelRegistryLike,
  ModelRuntimeLike,
  ThinkingLevel,
} from "./agent-runner.ts";
import { safeDisplayText } from "./display-text.ts";
import { standaloneWorkflowRunsDir } from "./run-artifacts.ts";
import {
  assertWorkflowArgsLimit,
  assertWorkflowOutputLimit,
  assertWorkflowSchemaLimit,
} from "./value-limits.ts";

import { discoverAgentTypes, resolveAgentType } from "./agent-types.ts";
import { readSavedWorkflowByName } from "./saved-workflow.ts";
import { resolveRepositoryContext } from "./repository-context.ts";
import {
  agentCallKey,
  hashBytes,
  hashString,
  stableStringify,
  RunJournal,
  type JournalAgentRecord,
} from "./journal.ts";
import {
  applyPatch,
  captureWorktreeDiff,
  createWorktree,
  hasChanges,
  removeWorktree,
  verifyAppliedPatch,
  writeRescuePatch,
  type Worktree,
  type WorktreeDiff,
} from "./worktree.ts";

const MAX_CONCURRENCY = 16;
const DEFAULT_CLEANUP_TIMEOUT_MS = 25_000;
const REPOSITORY_APPLY_LOCKS = new Map<string, ExecutionGate>();
export { DEFAULT_MAX_AGENTS, ABSOLUTE_MAX_AGENTS };
export const MAX_WORKFLOW_LOGS = 256;
export const WORKFLOW_LOG_OMITTED_TEXT = "additional workflow logs omitted";

export interface AgentEventBase {
  id: number;
  callPath: string;
  label: string;
  phase?: string;
  workflowPath?: string[];
}

/** Live activity observed inside a running subagent. */
export type AgentActivityEvent = AgentEventBase & AgentActivityInput;

export interface WorkflowRunOptions {
  cwd?: string;
  args?: unknown;
  /** Parent session's immutable project-trust decision. Defaults to false. */
  projectTrusted?: boolean;
  /** Canonical repository and relative-cwd identity. Computed when omitted. */
  targetIdentity?: string;
  signal?: AbortSignal;
  concurrency?: number;
  /** Logical cap on agent() slots for this workflow. Defaults to 128; absolute range 1..1024. */
  maxAgents?: number;
  /** Internal test seam for worker liveness watchdog; not exposed as a tool parameter. */
  stallTimeoutMs?: number;
  /** Internal cleanup deadline after cancellation; production defaults to 25 seconds. */
  cleanupTimeoutMs?: number;
  /** Internal test seam for result-bearing/event host-call fuel; production defaults to 10,000. */
  hostCallLimit?: number;
  /** Internal test seam for the script Worker's V8 old-generation heap cap. */
  workerMemoryLimitMb?: number;
  /** Host registry used for model selection and native classification/auth. */
  modelRegistry?: ModelRegistryLike;
  /** Canonical model/auth runtime shared across child sessions. */
  modelRuntime?: ModelRuntimeLike;
  model?: ModelLike;
  thinkingLevel?: ThinkingLevel;
  /** Effort judge only; execution models remain unchanged. */
  selectorBackend?: SelectorBackend;
  /** Inject a runner; scheduling-aware wrappers must declare supportsSchedulingHooks. */
  runner?: AgentRunner;
  journal?: RunJournal;
  /** Loads a saved workflow body by name; defaults to disk discovery. */
  loadSavedWorkflow?: (name: string) => { meta: WorkflowMeta; body: string };
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (
    event: AgentEventBase & {
      prompt: string;
      cached: boolean;
      modelPattern?: string;
      requestedEffort?: ThinkingLevel;
      agentType?: string;
      isolation?: string;
      structuredOutput?: boolean;
      cachedRecord?: JournalAgentRecord;
    },
  ) => void;
  onAgentEnd?: (
    event: AgentEventBase & {
      result: unknown;
      status: "done" | "error";
      usage?: AgentUsage;
      modelId?: string;
      effort?: ThinkingLevel;
      error?: string;
      cachedRecord?: JournalAgentRecord;
    },
  ) => void;
  onAgentActivity?: (event: AgentActivityEvent) => void;
  onAgentTelemetry?: (event: AgentEventBase & AgentTelemetryEvent) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  /** Lifetime live-agent admissions across this run and all resumes. */
  agentsUsed: number;
  cachedCount: number;
  spentTokens: number;
  /** Actual input+output tokens incurred by live child sessions. */
  newTokens: number;
  /** Original input+output usage represented by cached replayed tasks. */
  replayedTokens: number;
  durationMs: number;
  /** Effective logical agent-slot cap used by this run. */
  maxAgents: number;
}

interface ActivePanelTrace {
  branchCount: number;
  panelReservationId: string;
  branchReservationIds: string[];
  calls: Array<{ callPath: string; status: "pending" | "success" | "failed" }>;
}

interface AgentPayload {
  callPath?: unknown;
  prompt: unknown;
  options?: unknown;
  assignedPhase?: string;
  workflowPath?: string[];
  workflowContext?: JsonObject;
  scheduling?: JsonObject[];
  reservationIds?: string[];
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number; // number of agent() invocations (for ids / cap)
  cachedCount: number;
  spent: number; // observed output tokens for usage display
  newTokens: number;
  replayedTokens: number;
  maxAgents: number;
}

type WorktreeOutcome =
  | { status: "unchanged" | "applied"; keepWorktree: false }
  | { status: "rescued"; keepWorktree: false; recoveryPath: string }
  | { status: "preserved"; keepWorktree: true; recoveryPath: string };

// Runtime failures retain the exact thrown value (including non-Error rejections).
// Host boundaries unwrap them; Effect v4 runPromise throws a failure
// directly rather than replacing it with a FiberFailure.
interface RuntimeFailure {
  readonly _tag: "RuntimeFailure";
  readonly error: unknown;
}
const runtimeFailure = (error: unknown): RuntimeFailure => ({ _tag: "RuntimeFailure", error });
const attempt = <A>(thunk: () => A): Effect.Effect<A, RuntimeFailure> =>
  Effect.try({ try: thunk, catch: runtimeFailure });
const fromPromise = <A>(thunk: () => Promise<A>): Effect.Effect<A, RuntimeFailure> =>
  Effect.tryPromise({ try: thunk, catch: runtimeFailure });
const runBoundary = <A>(effect: Effect.Effect<A, RuntimeFailure>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError((failure) => failure.error)));

// Result unwrapping keeps synchronous callbacks synchronous and throws the exact
// original value, independently of the Effect runtime's failure representation.
const runSyncBoundary = <A>(effect: Effect.Effect<A, RuntimeFailure>): A =>
  Result.getOrThrowWith(Effect.runSync(Effect.result(effect)), (failure) => failure.error);

const WorkflowOptions = Context.Service<WorkflowRunOptions>("pi-ultracode/workflow/Options");
const WorkflowRunner = Context.Service<{
  readonly get: Effect.Effect<AgentRunner, RuntimeFailure>;
}>("pi-ultracode/workflow/Runner");

function makeRunnerService(options: WorkflowRunOptions) {
  let runner = options.runner;
  return {
    get: attempt(
      () =>
        (runner ??= new WorkflowAgentRunner({
          cwd: options.cwd ?? process.cwd(),
          projectTrusted: options.projectTrusted ?? false,
          modelRegistry: options.modelRegistry,
          modelRuntime: options.modelRuntime,
          model: options.model,
          thinkingLevel: options.thinkingLevel,
        })),
    ),
  };
}

function prepareWorkflow(rawScript: string, options: WorkflowRunOptions) {
  return attempt(() => {
    if (options.signal?.aborted) throw new WorkflowAbortError();
    assertWorkflowArgsLimit(options.args);
    if (options.journal && options.journal.projectTrusted !== options.projectTrusted) {
      throw new WorkflowPolicyError(
        "workflow journal project trust context does not match this execution",
      );
    }
    const targetIdentity = resolveRepositoryContext(options.cwd ?? process.cwd()).identity;
    if (options.targetIdentity !== undefined && options.targetIdentity !== targetIdentity) {
      throw new WorkflowPolicyError("workflow target identity does not match the actual cwd");
    }
    if (options.journal && options.journal.targetIdentity !== targetIdentity) {
      throw new WorkflowPolicyError(
        "workflow journal repository/cwd target does not match this execution",
      );
    }
    const cleanupTimeoutMs = normalizeCleanupTimeout(options.cleanupTimeoutMs);
    const effectiveOptions = { ...options, targetIdentity, cleanupTimeoutMs };
    const started = Date.now();
    const maxAgents = normalizeMaxAgents(options.maxAgents ?? options.journal?.effectiveMaxAgents);
    return {
      effectiveOptions,
      cleanupTimeoutMs,
      started,
      maxAgents,
      ...parseWorkflowScript(rawScript),
    };
  });
}

type PreparedWorkflow = Effect.Success<ReturnType<typeof prepareWorkflow>>;
type WorkflowRuntime = Effect.Success<ReturnType<typeof initializeWorkflowRuntime>>;

function recoverWorkflowFailure(
  runtime: WorkflowRuntime,
  options: WorkflowRunOptions,
  cleanupTimeoutMs: number,
  failure: RuntimeFailure,
): Effect.Effect<never, RuntimeFailure> {
  return Effect.suspend(() => {
    runtime.abort();
    if (failure.error instanceof WorkflowCleanupTimeoutError) return Effect.fail(failure);
    return runtime.drain(cleanupTimeoutMs).pipe(
      Effect.catch((cleanupFailure) => {
        const policy =
          runtime.policyError() ??
          (isWorkflowPolicyError(failure.error) ? failure.error : undefined);
        if (policy) {
          (policy as WorkflowPolicyError & { cleanupError?: unknown }).cleanupError =
            cleanupFailure.error;
          return Effect.fail(runtimeFailure(policy));
        }
        return Effect.fail(cleanupFailure);
      }),
      Effect.andThen(runtime.checkPolicy),
      Effect.andThen(() =>
        Effect.fail(
          options.signal?.aborted && !isWorkflowPolicyError(failure.error)
            ? runtimeFailure(new WorkflowAbortError())
            : failure,
        ),
      ),
    );
  });
}

function executePreparedWorkflow<T>(
  runtime: WorkflowRuntime,
  prepared: PreparedWorkflow,
  options: WorkflowRunOptions,
) {
  const { cleanupTimeoutMs, started, maxAgents, meta, body } = prepared;
  return runtime.runBody(body, options.args, meta.name).pipe(
    Effect.tap(runtime.checkPolicy),
    Effect.tap(() => runtime.drain(cleanupTimeoutMs)),
    Effect.tap(runtime.checkPolicy),
    Effect.flatMap((result) =>
      attempt(() => {
        assertWorkflowOutputLimit(result);
        return {
          meta,
          result: cloneResult(result, "workflow result") as T,
          logs: runtime.state.logs,
          phases: runtime.state.phases,
          agentCount: runtime.state.agentCount,
          agentsUsed: runtime.agentsUsed(),
          cachedCount: runtime.state.cachedCount,
          spentTokens: runtime.state.spent,
          newTokens: runtime.state.newTokens,
          replayedTokens: runtime.state.replayedTokens,
          durationMs: Date.now() - started,
          maxAgents,
        };
      }),
    ),
    Effect.catch((failure) => recoverWorkflowFailure(runtime, options, cleanupTimeoutMs, failure)),
  );
}

export function runWorkflow<T = unknown>(
  rawScript: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  return runBoundary(
    prepareWorkflow(rawScript, options).pipe(
      Effect.flatMap((prepared) =>
        makeWorkflowRuntime(prepared.maxAgents, prepared.meta).pipe(
          Effect.provideService(WorkflowOptions, prepared.effectiveOptions),
          Effect.provideService(WorkflowRunner, makeRunnerService(prepared.effectiveOptions)),
          Effect.flatMap((runtime) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                options.signal?.addEventListener("abort", runtime.abort, { once: true });
                if (options.signal?.aborted) runtime.abort();
              }),
              () => Effect.sync(() => options.signal?.removeEventListener("abort", runtime.abort)),
            ).pipe(Effect.andThen(() => executePreparedWorkflow<T>(runtime, prepared, options))),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
}

function prepareRuntime(options: WorkflowRunOptions, maxAgents: number, meta: WorkflowMeta) {
  return attempt(() => {
    const cwd = options.cwd ?? process.cwd();
    const workflowContext: JsonObject = JSON.parse(JSON.stringify({ meta, args: options.args }));
    const agentTypes = discoverAgentTypes(cwd, options.projectTrusted ?? false);
    const admission = new AgentAdmission(maxAgents, options.journal?.agentsUsed ?? 0);
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? os.cpus().length ?? 8;
    const fallback = Math.max(1, Math.min(Math.max(1, cores - 2), MAX_CONCURRENCY));
    return {
      workflowContext,
      cwd,
      agentTypes,
      admission,
      concurrency: normalizeConcurrency(options.concurrency, fallback),
    };
  });
}

function makeWorkflowRuntime(maxAgents: number, meta: WorkflowMeta) {
  return WorkflowOptions.pipe(
    Effect.flatMap((options) =>
      WorkflowRunner.pipe(
        Effect.flatMap((runnerService) =>
          prepareRuntime(options, maxAgents, meta).pipe(
            Effect.flatMap((prepared) =>
              makeExecutionGate(prepared.concurrency).pipe(
                Effect.flatMap((execution) =>
                  initializeWorkflowRuntime(options, runnerService, maxAgents, prepared, execution),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function initializeWorkflowRuntime(
  options: WorkflowRunOptions,
  runnerService: ReturnType<typeof makeRunnerService>,
  maxAgents: number,
  {
    workflowContext,
    cwd,
    agentTypes,
    admission,
  }: Effect.Success<ReturnType<typeof prepareRuntime>>,
  execution: ExecutionGate,
) {
  const state: RuntimeState = {
    logs: [],
    phases: [],
    agentCount: 0,
    cachedCount: 0,
    spent: 0,
    newTokens: 0,
    replayedTokens: 0,
    maxAgents,
  };
  const pending = new Set<Fiber.Fiber<unknown, RuntimeFailure>>();
  const childController = new AbortController();
  const scriptController = new AbortController();
  const seenCallPaths = new Set<string>();
  const agentRequestOccurrences = new Map<string, number>();
  const nestedRequestOccurrences = new Map<string, number>();
  const activePanelTraces = new Map<string, ActivePanelTrace>();
  let cleanupDeadline: number | undefined;
  let policyError: WorkflowPolicyError | undefined;

  function abortChildren(): void {
    cleanupDeadline ??= Date.now() + (options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    if (!childController.signal.aborted) childController.abort();
  }
  function abort(): void {
    abortChildren();
    if (!scriptController.signal.aborted) scriptController.abort();
  }

  function drain(timeoutMs: number): Effect.Effect<void, RuntimeFailure> {
    return Effect.suspend(() => {
      cleanupDeadline ??= Date.now() + timeoutMs;
      return Effect.whileLoop({
        while: () => pending.size > 0,
        body: () => {
          const remainingMs = cleanupDeadline! - Date.now();
          if (remainingMs <= 0)
            return Effect.fail(runtimeFailure(new WorkflowCleanupTimeoutError(timeoutMs)));
          // Timeout interrupts only the wait, not the underlying runner. A native
          // runner may ignore cancellation; its scoped recovery must still run if it
          // settles later, without publishing a result after cancellation.
          return Fiber.awaitAll([...pending]).pipe(
            Effect.timeoutOrElse({
              duration: remainingMs,
              orElse: () => Effect.fail(runtimeFailure(new WorkflowCleanupTimeoutError(timeoutMs))),
            }),
          );
        },
        step: () => {},
      });
    }).pipe(Effect.ensuring(Effect.sync(() => releaseOpenPanels())));
  }

  function runBody(body: string, args: unknown, name: string) {
    return attempt(throwIfAborted).pipe(
      Effect.andThen(
        fromPromise(() =>
          executeWorkflowScript(body, host, {
            cwd,
            args,
            name,
            meta: workflowContext.meta,
            signal: scriptController.signal,
            stallTimeoutMs: options.stallTimeoutMs,
            hostCallLimit: options.hostCallLimit,
            workerMemoryLimitMb: options.workerMemoryLimitMb,
            fatalDrainTimeoutMs: options.cleanupTimeoutMs,
          }),
        ),
      ),
    );
  }

  const recordPolicyFailure = <A, R>(effect: Effect.Effect<A, RuntimeFailure, R>) =>
    effect.pipe(Effect.tapError(({ error }) => Effect.sync(() => recordPolicyError(error))));

  const journalOperation = <A>(operation: string, thunk: () => A) =>
    attempt(thunk).pipe(
      Effect.mapError(({ error }) => runtimeFailure(journalPolicyError(error, operation))),
    );

  type PanelRequest = Parameters<ScriptExecutorHost["reservePanel"]>[0];

  function reservePanelSlots(
    payload: PanelRequest,
    replay: ReturnType<RunJournal["panelReplayPlan"]> | undefined,
  ): PanelReservation {
    const parentReservationIds = Array.isArray(payload.parentReservationIds)
      ? payload.parentReservationIds
      : [];
    const liveSlots = replay
      ? Math.max(
          replay.branchNeedsSlot.filter(Boolean).length,
          payload.reserveAgents - replay.slotCredit,
        )
      : payload.reserveAgents;
    return replay
      ? admission.reservePanelWithBranchNeeds(
          liveSlots,
          replay.branchNeedsSlot,
          parentReservationIds,
          payload.reserveAgents - liveSlots,
        )
      : admission.reservePanelWithBranches(
          payload.reserveAgents,
          payload.branchCount,
          parentReservationIds,
        );
  }

  function commitPanelReservation(
    payload: PanelRequest,
    callPath: string,
    panel: PanelReservation,
  ) {
    return journalOperation("workflow panel-open commit failed", () =>
      options.journal?.recordPanelOpen(callPath, payload.reserveAgents, payload.branchCount),
    ).pipe(
      Effect.andThen(
        attempt(() => {
          if (activePanelTraces.has(callPath)) {
            throw new WorkflowPolicyError(
              `workflow produced duplicate parallel callPath: ${callPath}`,
            );
          }
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          for (const reservationId of panel.branchReservationIds)
            admission.releasePanel(reservationId);
          admission.releasePanel(panel.panelReservationId);
        }),
      ),
      Effect.andThen(
        Effect.sync(() => {
          activePanelTraces.set(callPath, {
            branchCount: payload.branchCount,
            panelReservationId: panel.panelReservationId,
            branchReservationIds: [...panel.branchReservationIds],
            calls: [],
          });
          return panel;
        }),
      ),
    );
  }

  const reservePanel = (payload: PanelRequest) =>
    attempt(throwIfAborted).pipe(
      Effect.andThen(attempt(() => requireString(payload.callPath, "parallel callPath"))),
      Effect.flatMap((callPath) =>
        journalOperation("workflow panel replay lookup failed", () =>
          options.journal?.panelReplayPlan(callPath, payload.branchCount),
        ).pipe(
          Effect.flatMap((replay) => attempt(() => reservePanelSlots(payload, replay))),
          Effect.flatMap((panel) => commitPanelReservation(payload, callPath, panel)),
        ),
      ),
      recordPolicyFailure,
    );

  const completePanelBranch = (payload: {
    callPath?: unknown;
    branchIndex: number;
    outcome: "success" | "failed";
  }) =>
    journalOperation("workflow panel-branch commit failed", () => {
      const callPath = requireString(payload.callPath, "parallel callPath");
      const trace = activePanelTraces.get(callPath);
      if (
        !trace ||
        !Number.isInteger(payload.branchIndex) ||
        payload.branchIndex < 0 ||
        payload.branchIndex >= trace.branchCount ||
        (payload.outcome !== "success" && payload.outcome !== "failed")
      ) {
        throw new WorkflowPolicyError(
          `workflow returned invalid branch completion for ${callPath}`,
        );
      }
      const prefix = `${callPath}/b:${payload.branchIndex}/`;
      const calls = trace.calls.filter((call) => call.callPath.startsWith(prefix));
      if (calls.some((call) => call.status === "pending")) {
        throw new WorkflowPolicyError(
          `workflow branch completed with pending agent calls at ${callPath}`,
        );
      }
      options.journal?.recordPanelBranch(
        callPath,
        payload.branchIndex,
        payload.outcome,
        calls.map((call) => ({
          callPath: call.callPath,
          status: call.status === "success" ? "success" : "failed",
        })),
      );
    }).pipe(recordPolicyFailure);

  const releasePanel = (payload: {
    reservationId: string;
    callPath?: unknown;
    completed?: boolean;
    branchOutcomes?: unknown;
  }) =>
    Effect.suspend(() => {
      const callPath = typeof payload.callPath === "string" ? payload.callPath : undefined;
      const trace = callPath ? activePanelTraces.get(callPath) : undefined;
      return journalOperation("workflow panel completion commit failed", () => {
        if (payload.completed && callPath && trace) {
          const branchOutcomes = Array.isArray(payload.branchOutcomes)
            ? payload.branchOutcomes
            : [];
          if (
            branchOutcomes.length !== trace.branchCount ||
            branchOutcomes.some((outcome) => outcome !== "success" && outcome !== "failed")
          ) {
            throw new WorkflowPolicyError(
              `workflow returned invalid branch outcomes for ${callPath}`,
            );
          }
          options.journal?.recordPanelComplete(
            callPath,
            trace.branchCount,
            branchOutcomes as Array<"success" | "failed">,
            trace.calls.map((call) => ({
              callPath: call.callPath,
              status: call.status === "success" ? "success" : "failed",
            })),
          );
        }
      }).pipe(
        recordPolicyFailure,
        Effect.ensuring(
          Effect.sync(() => {
            admission.releasePanel(payload.reservationId);
            if (callPath && trace) releasePanelTrace(callPath, trace);
          }),
        ),
      );
    });

  const loadWorkflow = (payload: { nameOrRef: unknown; callPath?: unknown; args?: unknown }) =>
    attempt(() => {
      throwIfAborted();
      assertWorkflowArgsLimit(payload.args);
      const workerCallPath = requireString(payload.callPath, "nested workflow callPath");
      const ref = normalizeWorkflowRef(payload.nameOrRef);
      const argsJson = JSON.stringify(payload.args);
      const sourceCallPath = workerCallPath.replace(/:\d+$/, "");
      const requestHash = hashString(`${stableStringify(ref)}\u0000${argsJson}`).slice(0, 16);
      const requestBase = `${sourceCallPath}/q:${requestHash}`;
      const requestOccurrence = nestedRequestOccurrences.get(requestBase) ?? 0;
      nestedRequestOccurrences.set(requestBase, requestOccurrence + 1);
      const callPath = `${requestBase}:${requestOccurrence}`;
      const loader =
        options.loadSavedWorkflow ??
        ((r) => loadSavedWorkflowFromDisk(r, cwd, options.projectTrusted ?? false));
      const loaded = loader(ref);
      const sourceHash = hashString(
        `${stableStringify(loaded.meta)}\u0000${loaded.body}\u0000${argsJson}`,
      );
      return { loaded, callPath, sourceHash };
    }).pipe(
      Effect.flatMap(({ loaded, callPath, sourceHash }) =>
        journalOperation("nested workflow identity commit failed", () =>
          options.journal?.recordNestedSource(callPath, sourceHash),
        ).pipe(recordPolicyFailure, Effect.as({ ...loaded, callPath })),
      ),
    );

  const validateOutput = (payload: { value: unknown; label?: unknown }) =>
    attempt(() => assertWorkflowOutputLimit(payload.value, "nested workflow output")).pipe(
      recordPolicyFailure,
    );

  function prepareAgent(payload: AgentPayload) {
    return attempt(() => {
      throwIfAborted();
      const workerCallPath = requireString(payload.callPath, "agent callPath");
      if (seenCallPaths.has(workerCallPath)) {
        const error = new WorkflowPolicyError(
          `workflow produced duplicate agent callPath: ${workerCallPath}`,
        );
        recordPolicyError(error);
        throw error;
      }
      seenCallPaths.add(workerCallPath);
      const prompt = requireString(payload.prompt, "agent prompt");
      const opts = normalizeAgentOptions(payload.options);
      // The Worker owns phase scope. Falling back to host-global display state here
      // would make cache identity depend on parallel branch completion order.
      const assignedPhase = opts.phase ?? payload.assignedPhase;
      const sourceCallPath = workerCallPath.replace(/:\d+$/, "");
      const requestHash = hashString(
        stableStringify({
          prompt,
          options: { ...opts, phase: assignedPhase },
        }),
      ).slice(0, 16);
      const requestBase = `${sourceCallPath}/q:${requestHash}`;
      const requestOccurrence = agentRequestOccurrences.get(requestBase) ?? 0;
      agentRequestOccurrences.set(requestBase, requestOccurrence + 1);
      const callPath = `${requestBase}:${requestOccurrence}`;
      const id = ++state.agentCount;
      const label = opts.label?.trim() || defaultLabel(assignedPhase, id);
      const workflowPath = Array.isArray(payload.workflowPath) ? [...payload.workflowPath] : [];
      const agentTypeDef = resolveAgentType(opts.agentType, agentTypes);
      if (opts.agentType !== undefined && !agentTypeDef) {
        const error = new WorkflowPolicyError(`unknown agent type: ${opts.agentType}`);
        recordPolicyError(error);
        throw error;
      }
      const selection = resolveModelSelection({
        pattern: opts.model,
        roleModel: agentTypeDef?.model,
        roleThinking: agentTypeDef?.thinking,
        defaultModel: options.model,
        defaultThinking: options.thinkingLevel,
        models: options.modelRegistry?.getAvailable(),
      });
      const key = agentCallKey(prompt, {
        ...opts,
        phase: assignedPhase,
        agentTypeDefinition: agentTypeDef,
        effectiveModel: modelIdentity(selection.model),
        effectiveThinking: selection.thinkingLevel,
        targetIdentity: options.targetIdentity,
      });

      return {
        callPath,
        prompt,
        opts,
        assignedPhase,
        id,
        label,
        workflowPath,
        agentTypeDef,
        selection,
        key,
      };
    }).pipe(
      Effect.flatMap((prepared) =>
        journalOperation("workflow cache lookup failed", () => {
          assertTargetIdentityCurrent();
          return options.journal?.lookup(prepared.callPath, prepared.key);
        }).pipe(
          recordPolicyFailure,
          Effect.map((cached) => ({ ...prepared, cached })),
        ),
      ),
    );
  }

  type PreparedAgent = Effect.Success<ReturnType<typeof prepareAgent>>;
  type JevMember = ReturnType<typeof createJevBatch>[number];

  function replayAgent(prepared: PreparedAgent, cached: JournalAgentRecord) {
    const { callPath, prompt, opts, assignedPhase, id, label, workflowPath, selection } = prepared;
    return verifyCachedDelivery(cached).pipe(
      Effect.andThen(
        attempt(() => {
          beginPanelAgent(callPath);
          state.cachedCount++;
          state.spent += cached.outputTokens ?? 0;
          state.replayedTokens += cached.totalTokens ?? 0;
          const cachedUsage: AgentUsage = {
            inputTokens: cached.inputTokens,
            outputTokens: cached.outputTokens ?? 0,
            totalTokens: cached.totalTokens ?? 0,
            cacheReadTokens: cached.cacheReadTokens,
            cacheWriteTokens: cached.cacheWriteTokens,
            cost: cached.cost ?? 0,
            turns: cached.turns,
            toolUses: cached.toolUses,
            retries: cached.retries,
            compactions: cached.compactions,
          };
          const replayValue = cloneResult(cached.value, "cached agent result");
          notifyObserver(() =>
            options.onAgentStart?.({
              id,
              callPath,
              label,
              phase: assignedPhase,
              workflowPath,
              prompt,
              cached: true,
              modelPattern: opts.model,
              requestedEffort: selection.thinkingLevel,
              agentType: opts.agentType,
              isolation: opts.isolation,
              structuredOutput: opts.schema != null,
              cachedRecord: cloneResult(cached, "cached agent record"),
            }),
          );
          notifyObserverBestEffort(() =>
            options.onAgentEnd?.({
              id,
              callPath,
              label,
              phase: assignedPhase,
              workflowPath,
              result: cloneResult(replayValue, "cached observer result"),
              status: "done",
              usage: cachedUsage,
              modelId: cached.modelId,
              effort: cached.effort,
              cachedRecord: cloneResult(cached, "cached agent record"),
            }),
          );
          finishPanelAgent(callPath, "success");
          return replayValue;
        }),
      ),
    );
  }

  function admitAgent(payload: AgentPayload, { callPath, key }: PreparedAgent) {
    return journalOperation("workflow admission commit failed", () => {
      const ordinal = admission.consumeAgent(
        Array.isArray(payload.reservationIds) ? payload.reservationIds : [],
      );
      options.journal?.recordAdmission(callPath, key, ordinal);
    }).pipe(recordPolicyFailure, Effect.andThen(attempt(() => beginPanelAgent(callPath))));
  }

  function makeAgentExecution() {
    return Effect.scope.pipe(
      Effect.flatMap((scope) => {
        let closed = false;
        const checkOpen = () => {
          throwIfAborted();
          if (closed) throw new WorkflowAbortError();
        };
        // Cache the Effect, not a Promise: forwarding runners share both pending
        // and completed acquisition. Closing this agent's scope cancels even an
        // acquisition that a faulty runner started without awaiting it.
        return Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        ).pipe(
          Effect.andThen(
            Effect.cached(
              Effect.acquireRelease(
                attempt(() => {
                  checkOpen();
                  return execution.request();
                }),
                (request) => Effect.sync(request.release),
              ).pipe(
                Effect.flatMap((request) => request.ready),
                Scope.provide(scope),
              ),
            ),
          ),
          Effect.map((permit) => permit.pipe(Effect.andThen(attempt(checkOpen)))),
        );
      }),
    );
  }

  function runLiveAgent(payload: AgentPayload, member: JevMember, prepared: PreparedAgent) {
    return Effect.suspend(() => {
      const {
        callPath,
        prompt,
        opts,
        assignedPhase,
        id,
        label,
        workflowPath,
        agentTypeDef,
        selection,
        key,
      } = prepared;
      let worktree: Worktree | undefined;
      let worktreeSettled = false;
      let keepWorktree = true;
      let observedUsage: AgentUsage | undefined;

      function prepareAgentResult(result: AgentRunResult, agentStartedAt: number) {
        return attempt(() => {
          throwIfAborted();
          const usage = normalizeAgentUsage(result.usage);
          state.spent += usage.outputTokens;
          state.newTokens += usage.totalTokens;
          observedUsage = usage;

          // Clone failures are ordinary runner-result failures. Values that clone
          // successfully but violate the durable JSON contract are fatal policy.
          const clonedValue = cloneResult(result.value, "agent result");
          return { clonedValue, usage };
        }).pipe(
          Effect.tap(({ clonedValue }) =>
            attempt(() => assertWorkflowOutputLimit(clonedValue, "workflow agent output")).pipe(
              recordPolicyFailure,
            ),
          ),
          Effect.map(({ clonedValue, usage }) => ({
            clonedValue,
            usage,
            commitAgent: (delivery?: { patchPath: string; patchHash: string }) =>
              attempt(assertTargetIdentityCurrent).pipe(
                Effect.andThen(
                  journalOperation("workflow agent-result commit failed", () => {
                    options.journal?.recordAgent({
                      callPath,
                      seq: id,
                      key,
                      label,
                      value: clonedValue,
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      totalTokens: usage.totalTokens,
                      cacheReadTokens: usage.cacheReadTokens,
                      cacheWriteTokens: usage.cacheWriteTokens,
                      cost: usage.cost,
                      turns: usage.turns,
                      toolUses: usage.toolUses,
                      retries: usage.retries,
                      compactions: usage.compactions,
                      requestedModelId: opts.model,
                      requestedEffort: selection.thinkingLevel,
                      modelId: result.modelId,
                      effort: result.effort,
                      agentType: opts.agentType,
                      isolation: opts.isolation,
                      structuredOutput: opts.schema != null,
                      deliveryPatchPath: delivery?.patchPath,
                      deliveryPatchHash: delivery?.patchHash,
                      startedAt: agentStartedAt,
                      durationMs: Date.now() - agentStartedAt,
                    });
                  }).pipe(recordPolicyFailure),
                ),
              ),
          })),
        );
      }

      function deliverAgentResult(
        commitAgent: (delivery?: {
          patchPath: string;
          patchHash: string;
        }) => Effect.Effect<void, RuntimeFailure>,
      ) {
        if (!worktree) return commitAgent();
        return integrateWorktree(worktree, id, label, callPath, commitAgent).pipe(
          Effect.flatMap((outcome) => {
            worktreeSettled = true;
            keepWorktree = outcome.keepWorktree;
            return outcome.status === "rescued" || outcome.status === "preserved"
              ? Effect.fail(
                  runtimeFailure(
                    new Error(
                      `worktree changes were not delivered; recover from ${outcome.recoveryPath}`,
                    ),
                  ),
                )
              : Effect.void;
          }),
        );
      }

      function publishAgentResult(result: AgentRunResult, clonedValue: unknown, usage: AgentUsage) {
        return attempt(() => {
          // The durable agent record is the publication point. Completion observers
          // run afterward and cannot veto a committed result.
          notifyObserverBestEffort(() =>
            options.onAgentEnd?.({
              id,
              callPath,
              label,
              phase: assignedPhase,
              workflowPath,
              result: cloneResult(clonedValue, "live observer result"),
              status: "done",
              usage,
              modelId: result.modelId,
              effort: result.effort,
            }),
          );
          finishPanelAgent(callPath, "success");
          return clonedValue;
        });
      }

      function callRunner(
        runner: AgentRunner,
        acquireExecution: Effect.Effect<void, RuntimeFailure>,
      ) {
        const onActivity: ((e: AgentActivityInput) => void) | undefined = options.onAgentActivity
          ? (e: AgentActivityInput) =>
              options.onAgentActivity!({
                id,
                callPath,
                label,
                phase: assignedPhase,
                workflowPath,
                ...e,
              })
          : undefined;
        const onTelemetry: ((e: AgentTelemetryEvent) => void) | undefined = options.onAgentTelemetry
          ? (e: AgentTelemetryEvent) =>
              options.onAgentTelemetry!({
                id,
                callPath,
                label,
                phase: assignedPhase,
                workflowPath,
                ...e,
              })
          : undefined;
        const agentStartedAt = Date.now();
        return fromPromise(() =>
          runner.run({
            prompt,
            label,
            schema: opts.schema,
            signal: childController.signal,
            ...(runner.supportsSchedulingHooks
              ? {
                  acquireExecution: () => runBoundary(acquireExecution),
                  selectEffort: (task) => {
                    if (!task) {
                      member.skip();
                      return runBoundary(Effect.succeed(undefined));
                    }
                    return member.select({
                      ...task,
                      context: {
                        callPath,
                        workflowPath,
                        scheduling: payload.scheduling ?? [],
                        ...(assignedPhase ? { phase: assignedPhase } : {}),
                        ...(payload.workflowContext ? { workflow: payload.workflowContext } : {}),
                      },
                    });
                  },
                }
              : {}),
            instructions: buildInstructions(assignedPhase, opts),
            modelPattern: opts.model,
            agentTypeDef,
            cwd: worktree?.agentCwd,
            onActivity,
            onTelemetry,
          }),
        ).pipe(
          Effect.flatMap((result) =>
            prepareAgentResult(result, agentStartedAt).pipe(
              Effect.flatMap(({ clonedValue, usage, commitAgent }) =>
                deliverAgentResult(commitAgent).pipe(
                  Effect.andThen(publishAgentResult(result, clonedValue, usage)),
                ),
              ),
            ),
          ),
        );
      }

      function executeAgent(
        runner: AgentRunner,
        acquireExecution: Effect.Effect<void, RuntimeFailure>,
      ) {
        const ready = runner.supportsSchedulingHooks
          ? Effect.void
          : Effect.sync(() => member.skip()).pipe(Effect.andThen(acquireExecution));
        return ready.pipe(
          Effect.andThen(() =>
            opts.isolation === "worktree"
              ? createIsolatedWorktree(id).pipe(
                  Effect.tap((created) =>
                    Effect.sync(() => {
                      worktree = created;
                    }),
                  ),
                )
              : Effect.void,
          ),
          Effect.andThen(() => callRunner(runner, acquireExecution)),
        );
      }

      function recoverAgentFailure({ error }: RuntimeFailure) {
        const recovery =
          worktree && !worktreeSettled
            ? recoverFailedWorktree(worktree, id, label).pipe(
                Effect.tap((outcome) =>
                  Effect.sync(() => {
                    worktreeSettled = true;
                    keepWorktree = outcome.keepWorktree;
                    if (
                      childController.signal.aborted ||
                      options.signal?.aborted ||
                      isWorkflowPolicyError(error)
                    ) {
                      // Recursive worktree removal is not synchronously deadline-safe.
                      // Preserve it on cancellation/policy cleanup instead of overrunning the budget.
                      keepWorktree = true;
                      logLineBestEffort(
                        `worktree[${label}]: cleanup cancelled; worktree KEPT at ${worktree!.path}`,
                      );
                    }
                  }),
                ),
              )
            : Effect.void;
        return recovery.pipe(
          Effect.andThen(
            attempt(() => {
              if (
                childController.signal.aborted ||
                options.signal?.aborted ||
                isWorkflowPolicyError(error)
              )
                throw error;

              const message = error instanceof Error ? error.message : String(error);
              finishPanelAgent(callPath, "failed");
              logLine(`agent ${label} failed: ${message}`);
              notifyObserverBestEffort(() =>
                options.onAgentEnd?.({
                  id,
                  callPath,
                  label,
                  phase: assignedPhase,
                  workflowPath,
                  result: null,
                  status: "error",
                  error: message,
                  usage: observedUsage,
                }),
              );
              return null;
            }),
          ),
        );
      }

      return Effect.addFinalizer(() =>
        // Removal is best effort and must never change a delivery outcome.
        attempt(() => {
          if (worktree && worktreeSettled && !keepWorktree) removeWorktree(worktree);
        }).pipe(Effect.ignore),
      ).pipe(
        Effect.andThen(
          attempt(() => {
            notifyObserver(() =>
              options.onAgentStart?.({
                id,
                callPath,
                label,
                phase: assignedPhase,
                workflowPath,
                prompt,
                cached: false,
                modelPattern: opts.model,
                requestedEffort: selection.thinkingLevel,
                agentType: opts.agentType,
                isolation: opts.isolation,
                structuredOutput: opts.schema != null,
              }),
            );
          }),
        ),
        Effect.andThen(makeAgentExecution()),
        Effect.flatMap((acquireExecution) =>
          attempt(throwIfAborted).pipe(
            Effect.andThen(runnerService.get),
            Effect.flatMap((runner) => executeAgent(runner, acquireExecution)),
            Effect.catch(recoverAgentFailure),
          ),
        ),
        Effect.scoped,
      );
    });
  }

  function runAgent(payload: AgentPayload, member: JevMember) {
    return prepareAgent(payload).pipe(
      Effect.flatMap((prepared) =>
        prepared.cached
          ? replayAgent(prepared, prepared.cached)
          : admitAgent(payload, prepared).pipe(
              Effect.andThen(() => runLiveAgent(payload, member, prepared)),
            ),
      ),
      // Keep the selected policy failure on the host side before the Worker
      // serializes it. Recovery and rollback have already chosen its precedence.
      recordPolicyFailure,
    );
  }

  function agentBatch(payloads: AgentPayload[]): Promise<unknown>[] {
    const members = createJevBatch(
      payloads.length,
      workflowContext,
      childController.signal,
      options.selectorBackend,
    );
    return payloads.map((payload, index) => {
      // These fibers intentionally outlive a bounded drain if a native runner
      // ignores AbortSignal. Each owns its scope; the runtime tracks their exits.
      const fiber = Effect.runFork(
        runAgent(payload, members[index]).pipe(
          Effect.ensuring(Effect.sync(() => members[index].skip())),
        ),
      );
      pending.add(fiber);
      fiber.addObserver(() => pending.delete(fiber));
      return runBoundary(Fiber.join(fiber));
    });
  }

  function verifyCachedDelivery(record: JournalAgentRecord): Effect.Effect<void, RuntimeFailure> {
    return Effect.suspend(() => {
      if (!record.deliveryPatchPath || !record.deliveryPatchHash) return Effect.void;
      const { deliveryPatchPath, deliveryPatchHash } = record;
      return attempt(() => {
        const context = resolveRepositoryContext(cwd);
        if (!context.repoRoot || !options.journal) {
          const error = new WorkflowPolicyError(
            `cached worktree delivery at ${record.callPath} has no matching Git target`,
          );
          recordPolicyError(error);
          throw error;
        }
        return {
          repoRoot: context.repoRoot,
          patchRoot: path.join(path.dirname(options.journal.filePath), "patches"),
        };
      }).pipe(
        Effect.flatMap(({ repoRoot, patchRoot }) =>
          repositoryApplyLock(repoRoot).pipe(
            Effect.flatMap((lock) =>
              withExecutionPermit(
                lock,
                attempt(() =>
                  verifyAppliedPatch(repoRoot, deliveryPatchPath, deliveryPatchHash, patchRoot),
                ),
              ),
            ),
            Effect.flatMap((valid) =>
              valid
                ? Effect.void
                : Effect.fail(
                    runtimeFailure(
                      new Error(
                        "the delivered patch is no longer present in the shared working tree",
                      ),
                    ),
                  ),
            ),
            Effect.catch(({ error }) =>
              attempt(() => {
                const failure = new WorkflowPolicyError(
                  `cached worktree delivery at ${record.callPath} requires recovery: ${errorMessage(error)}`,
                );
                (failure as Error & { cause?: unknown }).cause = error;
                recordPolicyError(failure);
                throw failure;
              }),
            ),
          ),
        ),
      );
    });
  }

  /** Fold a successful isolated result into the shared repository. */
  function integrateWorktree(
    worktree: Worktree,
    id: number,
    label: string,
    callPath: string,
    commitAgent: (delivery?: {
      patchPath: string;
      patchHash: string;
    }) => Effect.Effect<void, RuntimeFailure>,
  ): Effect.Effect<WorktreeOutcome, RuntimeFailure> {
    const planDelivery = (diff: WorktreeDiff) =>
      attempt(() => {
        // Persist the exact delivery material before the shared repository changes.
        const runId = options.journal ? path.basename(options.journal.filePath, ".jsonl") : "run";
        const durablePatch = writeRescuePatch(rescueDir(), runId, id, label, diff.patch);
        return { durablePatch, patchHash: hashBytes(fs.readFileSync(durablePatch)) };
      });
    const applyDelivery = (diff: WorktreeDiff, durablePatch: string, patchHash: string) =>
      attempt(() => {
        throwIfAborted();
        assertTargetIdentityCurrent();
        options.journal?.recordDeliveryStart(callPath, durablePatch, patchHash);
        return applyPatch(worktree.repoRoot, diff.patch);
      }).pipe(
        Effect.flatMap((applied): Effect.Effect<WorktreeOutcome, RuntimeFailure> => {
          if (!applied) {
            logLineBestEffort(
              `worktree[${label}]: changes could NOT be applied cleanly; patch saved to ${durablePatch} — review and apply manually`,
            );
            return Effect.succeed({
              status: "rescued",
              keepWorktree: false,
              recoveryPath: durablePatch,
            });
          }
          return commitAgent({ patchPath: durablePatch, patchHash }).pipe(
            Effect.andThen(
              options.journal
                ? Effect.void
                : // Standalone runs have no replay state to verify.
                  attempt(() => fs.unlinkSync(durablePatch)).pipe(Effect.ignore),
            ),
            Effect.andThen(
              Effect.sync(() => {
                logLineBestEffort(
                  `worktree[${label}]: ${diff.filesChanged} file(s), +${diff.insertions}/-${diff.deletions} applied to working tree`,
                );
                return { status: "applied", keepWorktree: false } as const;
              }),
            ),
          );
        }),
      );
    return attempt(() => captureWorktreeDiff(worktree)).pipe(
      Effect.flatMap((diff): Effect.Effect<WorktreeOutcome, RuntimeFailure> => {
        if (!hasChanges(diff)) {
          return commitAgent().pipe(
            Effect.andThen(
              Effect.sync(() => {
                logLineBestEffort(`worktree[${label}]: no changes (auto-removed)`);
                return { status: "unchanged", keepWorktree: false } as const;
              }),
            ),
          );
        }
        return planDelivery(diff).pipe(
          Effect.flatMap(({ durablePatch, patchHash }) =>
            repositoryApplyLock(worktree.repoRoot).pipe(
              Effect.flatMap((lock) =>
                withExecutionPermit(lock, applyDelivery(diff, durablePatch, patchHash)),
              ),
            ),
          ),
        );
      }),
      Effect.catch((failure) => {
        logLineBestEffort(
          `worktree[${label}]: integration failed (${errorMessage(failure.error)}); worktree KEPT at ${worktree.path} — recover with: git -C ${worktree.path} diff`,
        );
        return isWorkflowPolicyError(failure.error)
          ? Effect.fail(failure)
          : Effect.succeed({
              status: "preserved",
              keepWorktree: true,
              recoveryPath: worktree.path,
            } as const);
      }),
    );
  }

  /** Preserve edits from a runner/policy/abort failure without publishing them. */
  const recoverFailedWorktree = (
    worktree: Worktree,
    id: number,
    label: string,
  ): Effect.Effect<WorktreeOutcome, RuntimeFailure> =>
    attempt(() => captureWorktreeDiff(worktree, remainingCleanupTimeout())).pipe(
      Effect.flatMap((diff) =>
        hasChanges(diff)
          ? rescueDiff(worktree, diff, id, label, "agent failed before delivery")
          : Effect.succeed({ status: "unchanged", keepWorktree: false } as const),
      ),
      Effect.catch(({ error }) =>
        Effect.sync(() => {
          logLineBestEffort(
            `worktree[${label}]: recovery capture failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} — recover with: git -C ${worktree.path} diff`,
          );
          return { status: "preserved", keepWorktree: true, recoveryPath: worktree.path } as const;
        }),
      ),
    );

  function throwIfAborted(): void {
    if (childController.signal.aborted || options.signal?.aborted) throw new WorkflowAbortError();
  }

  function phase(title: string): void {
    if (!title) return;
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    options.onPhase?.(title);
  }

  function releasePanelTrace(callPath: string, trace: ActivePanelTrace): void {
    for (const reservationId of trace.branchReservationIds) admission.releasePanel(reservationId);
    admission.releasePanel(trace.panelReservationId);
    activePanelTraces.delete(callPath);
  }

  function releaseOpenPanels(): void {
    for (const [callPath, trace] of activePanelTraces) releasePanelTrace(callPath, trace);
  }

  function beginPanelAgent(callPath: string): void {
    for (const [panelPath, trace] of activePanelTraces) {
      if (!callPath.startsWith(`${panelPath}/`)) continue;
      trace.calls.push({ callPath, status: "pending" });
    }
  }

  function finishPanelAgent(callPath: string, status: "success" | "failed"): void {
    for (const [panelPath, trace] of activePanelTraces) {
      if (!callPath.startsWith(`${panelPath}/`)) continue;
      const call = trace.calls.find((candidate) => candidate.callPath === callPath);
      if (call) call.status = status;
    }
  }

  function notifyObserver(callback: () => void): void {
    runSyncBoundary(
      attempt(callback).pipe(
        Effect.mapError(({ error }) => {
          const failure = new WorkflowPolicyError(
            `workflow observer failed: ${errorMessage(error)}`,
          );
          (failure as Error & { cause?: unknown }).cause = error;
          return runtimeFailure(failure);
        }),
        recordPolicyFailure,
      ),
    );
  }

  function notifyObserverBestEffort(callback: () => void): void {
    Effect.runSync(
      attempt(callback).pipe(
        Effect.catch(({ error }) =>
          Effect.sync(() =>
            logLineBestEffort(`workflow completion observer failed: ${errorMessage(error)}`),
          ),
        ),
      ),
    );
  }

  function recordPolicyError(error: unknown): void {
    if (isWorkflowPolicyError(error)) {
      policyError ??= error;
      // Let the Worker finish branch/panel finally blocks; only child work stops here.
      abortChildren();
    }
  }

  function createIsolatedWorktree(index: number): Effect.Effect<Worktree, RuntimeFailure> {
    return attempt(assertTargetIdentityCurrent).pipe(
      Effect.andThen(() => {
        const runId = options.journal ? path.basename(options.journal.filePath, ".jsonl") : "run";
        return attempt(() => createWorktree(cwd, runId, index)).pipe(
          Effect.flatMap((worktree) =>
            attempt(assertTargetIdentityCurrent).pipe(
              // Roll back only a failed post-create identity check. As before, a
              // removal failure takes precedence over that check's failure here.
              Effect.tapError(() => attempt(() => removeWorktree(worktree))),
              Effect.as(worktree),
            ),
          ),
          Effect.mapError((failure) =>
            isWorkflowPolicyError(failure.error)
              ? failure
              : runtimeFailure(
                  new Error(
                    `agent #${index}: worktree setup failed: ${errorMessage(failure.error)}`,
                  ),
                ),
          ),
        );
      }),
    );
  }

  function rescueDiff(
    worktree: Worktree,
    diff: WorktreeDiff,
    id: number,
    label: string,
    reason: string,
  ): Effect.Effect<WorktreeOutcome> {
    return attempt(() => {
      const runId = options.journal ? path.basename(options.journal.filePath, ".jsonl") : "run";
      return writeRescuePatch(rescueDir(), runId, id, label, diff.patch);
    }).pipe(
      Effect.match({
        onSuccess: (rescue): WorktreeOutcome => {
          logLineBestEffort(
            `worktree[${label}]: ${reason}; patch saved to ${rescue} — review and apply manually`,
          );
          return { status: "rescued", keepWorktree: false, recoveryPath: rescue };
        },
        onFailure: ({ error }): WorktreeOutcome => {
          logLineBestEffort(
            `worktree[${label}]: ${reason} AND rescue write failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} — recover with: git -C ${worktree.path} diff`,
          );
          return { status: "preserved", keepWorktree: true, recoveryPath: worktree.path };
        },
      }),
    );
  }

  function assertTargetIdentityCurrent(): void {
    const expected = options.targetIdentity;
    const actual = resolveRepositoryContext(cwd).identity;
    if (expected !== actual) {
      const error = new WorkflowPolicyError(
        "workflow repository/cwd target changed during execution",
      );
      recordPolicyError(error);
      throw error;
    }
  }

  function remainingCleanupTimeout(): number {
    if (cleanupDeadline === undefined) return DEFAULT_CLEANUP_TIMEOUT_MS;
    const remaining = cleanupDeadline - Date.now();
    if (remaining <= 0)
      throw new WorkflowCleanupTimeoutError(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS);
    return remaining;
  }

  /** Write rescue patches beside the journal or in a user-owned cwd-hash scope. */
  function rescueDir(): string {
    const journalDir = options.journal ? path.dirname(options.journal.filePath) : undefined;
    if (journalDir) return path.join(journalDir, "patches");
    return path.join(standaloneWorkflowRunsDir(cwd), "patches");
  }

  function logLineBestEffort(text: string): void {
    // Durable runtime state is authoritative; display observers cannot veto it.
    Effect.runSync(attempt(() => logLine(text)).pipe(Effect.ignore));
  }

  function logLine(text: string): void {
    if (state.logs.length > MAX_WORKFLOW_LOGS) return;
    const safe = safeDisplayText(text, 512);
    if (!safe) return;
    const entry = state.logs.length === MAX_WORKFLOW_LOGS ? WORKFLOW_LOG_OMITTED_TEXT : safe;
    state.logs.push(entry);
    options.onLog?.(entry);
  }
  const host: ScriptExecutorHost = {
    agent: (payload) => agentBatch([payload])[0],
    agentBatch,
    abortChildren,
    reservePanel: (payload) => runBoundary(reservePanel(payload)),
    completePanelBranch: (payload) => runBoundary(completePanelBranch(payload)),
    releasePanel: (payload) => runBoundary(releasePanel(payload)),
    loadWorkflow: (payload) => runBoundary(loadWorkflow(payload)),
    validateOutput: (payload) => runBoundary(validateOutput(payload)),
    phase,
    log: logLine,
  };
  return Effect.acquireRelease(
    Effect.sync(() =>
      childController.signal.addEventListener("abort", execution.close, { once: true }),
    ),
    () =>
      Effect.sync(() => {
        childController.signal.removeEventListener("abort", execution.close);
        execution.close();
        releaseOpenPanels();
      }),
  ).pipe(
    Effect.map(() => ({
      state,
      abort,
      drain,
      runBody,
      agentsUsed: () => admission.usedAgents,
      policyError: () => policyError,
      checkPolicy: attempt(() => {
        if (policyError) throw policyError;
      }),
    })),
  );
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (value == null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  assertWorkflowSchemaLimit(options.schema);
  if (options.isolation !== undefined && options.isolation !== "worktree") {
    throw new TypeError("agent isolation must be 'worktree' when provided");
  }
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    schema: options.schema,
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation,
    agentType: optionalNonEmptyTrimmedString(options.agentType, "agent type"),
  };
}

function normalizeWorkflowRef(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError(
      "workflow() expects a saved workflow name string; scriptPath is not supported",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError(
      "workflow() name must contain only letters, numbers, underscore, or hyphen",
    );
  }
  return value;
}

export function loadSavedWorkflowFromDisk(
  ref: string,
  cwd: string,
  projectTrusted = false,
): { meta: WorkflowMeta; body: string } {
  const saved = readSavedWorkflowByName(ref, cwd, projectTrusted);
  if (saved) return parseWorkflowScript(saved.script);
  throw new Error(
    `workflow() could not find an accessible saved workflow for ${JSON.stringify(ref)}`,
  );
}

function buildInstructions(phase: string | undefined, opts: AgentOptions): string | undefined {
  const lines: string[] = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (opts.isolation === "worktree") {
    lines.push(
      "You are running in an isolated git worktree; edit files freely without coordinating with siblings.",
    );
  }
  return lines.length ? lines.join("\n") : undefined;
}

function normalizeAgentUsage(value: AgentUsage): AgentUsage {
  const outputTokens = usageInteger(value.outputTokens) ?? 0;
  const totalHint = usageInteger(value.totalTokens) ?? outputTokens;
  const inputTokens = usageInteger(value.inputTokens) ?? Math.max(0, totalHint - outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: optionalUsageInteger(value.cacheReadTokens),
    cacheWriteTokens: optionalUsageInteger(value.cacheWriteTokens),
    cost:
      typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0
        ? value.cost
        : 0,
    turns: optionalUsageInteger(value.turns),
    toolUses: optionalUsageInteger(value.toolUses),
    retries: optionalUsageInteger(value.retries),
    compactions: optionalUsageInteger(value.compactions),
  };
}

function usageInteger(value: unknown): number | undefined {
  const maxComponent = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(maxComponent, Math.floor(value))
    : undefined;
}

function optionalUsageInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : (usageInteger(value) ?? 0);
}

function modelIdentity(model: ModelLike | undefined): unknown {
  if (!model) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

function defaultLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new WorkflowPolicyError(
      `workflow concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`,
    );
  }
  return value;
}

function normalizeCleanupTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CLEANUP_TIMEOUT_MS;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new WorkflowPolicyError("workflow cleanupTimeoutMs must be a positive integer");
  }
  return value;
}

interface ExecutionRequest {
  readonly ready: Effect.Effect<void, RuntimeFailure>;
  readonly release: () => void;
}
interface ExecutionGate {
  readonly request: () => ExecutionRequest;
  readonly close: () => void;
}

// A token is handed directly to the oldest waiter, before waking its fiber.
// Effect's Semaphore / token Queue wakeups alone allow a new caller to barge
// between release and the waiting fiber's next turn.
function makeExecutionGate(limit: number): Effect.Effect<ExecutionGate> {
  type Waiter = {
    readonly ready: Deferred.Deferred<void, RuntimeFailure>;
    state: "queued" | "held" | "released";
  };
  return Queue.unbounded<Waiter>().pipe(
    Effect.map((queue) => {
      let active = 0;
      let closed = false;
      function pump(): void {
        while (active < limit) {
          const next = Queue.takeUnsafe(queue);
          if (!next || next._tag === "Failure") return;
          const waiter = next.value;
          if (waiter.state !== "queued") continue;
          waiter.state = "held";
          active++;
          Deferred.doneUnsafe(waiter.ready, Effect.void);
        }
      }
      const close = () => {
        if (closed) return;
        closed = true;
        const failure = Effect.fail(runtimeFailure(new WorkflowAbortError()));
        for (;;) {
          const next = Queue.takeUnsafe(queue);
          if (!next || next._tag === "Failure") break;
          next.value.state = "released";
          Deferred.doneUnsafe(next.value.ready, failure);
        }
        Queue.shutdownUnsafe(queue);
      };
      const request = (): ExecutionRequest => {
        const waiter: Waiter = { ready: Deferred.makeUnsafe(), state: "queued" };
        if (closed) {
          waiter.state = "released";
          Deferred.doneUnsafe(waiter.ready, Effect.fail(runtimeFailure(new WorkflowAbortError())));
        } else {
          Queue.offerUnsafe(queue, waiter);
          pump();
        }
        return {
          ready: Deferred.await(waiter.ready),
          release: () => {
            if (waiter.state === "released") return;
            if (waiter.state === "held") active--;
            waiter.state = "released";
            Deferred.doneUnsafe(
              waiter.ready,
              Effect.fail(runtimeFailure(new WorkflowAbortError())),
            );
            if (!closed) pump();
          },
        };
      };
      return { request, close } satisfies ExecutionGate;
    }),
  );
}

const withExecutionPermit = <A, E, R>(gate: ExecutionGate, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(Effect.sync(gate.request), (request) => Effect.sync(request.release)).pipe(
    Effect.flatMap((request) => request.ready),
    Effect.andThen(effect),
    Effect.scoped,
  );

function repositoryApplyLock(repoRoot: string): Effect.Effect<ExecutionGate> {
  return Effect.suspend(() => {
    const key = fsRealpathOrResolve(repoRoot);
    const existing = REPOSITORY_APPLY_LOCKS.get(key);
    if (existing) return Effect.succeed(existing);
    return makeExecutionGate(1).pipe(
      Effect.tap((lock) =>
        Effect.sync(() => {
          REPOSITORY_APPLY_LOCKS.set(key, lock);
        }),
      ),
    );
  });
}

function fsRealpathOrResolve(value: string): string {
  return Result.try(() => path.resolve(value)).pipe(Result.getOrElse(() => value));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function optionalNonEmptyTrimmedString(value: unknown, name: string): string | undefined {
  const string = optionalString(value, name);
  if (string === undefined) return undefined;
  const trimmed = string.trim();
  if (!trimmed) throw new TypeError(`${name} must not be empty`);
  return trimmed;
}

function journalPolicyError(error: unknown, operation: string): WorkflowPolicyError {
  if (isWorkflowPolicyError(error)) return error;
  const failure = new WorkflowPolicyError(`${operation}: ${errorMessage(error)}`);
  (failure as Error & { cause?: unknown }).cause = error;
  return failure;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneResult<T>(value: T, name: string): T {
  return Result.try({
    try: () => structuredClone(value),
    catch: (error) => {
      const detail = error instanceof Error ? ` ${error.message}` : "";
      return new Error(
        `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
      );
    },
  }).pipe(Result.getOrThrow);
}
