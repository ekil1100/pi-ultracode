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

import * as os from "node:os";
import * as path from "node:path";
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
// loader ("WorkflowAgentRunner is not a constructor"). Tests inject a runner, so
// they never construct this class; production builds it via getRunner().
import { resolveModelSelection, WorkflowAgentRunner } from "./agent-runner.ts";
import type {
  AgentActivityInput,
  AgentRunResult,
  AgentTelemetryEvent,
  AgentUsage,
  ModelLike,
  ModelRegistryLike,
  ModelRuntimeLike,
  ThinkingLevel,
} from "./agent-runner.ts";
import { safeDisplayText } from "./display-text.ts";
import {
  artifactPathExists,
  readArtifactFile,
  readContainedArtifactFile,
  standaloneWorkflowRunsDir,
} from "./run-artifacts.ts";
import {
  assertWorkflowArgsLimit,
  assertWorkflowOutputLimit,
  assertWorkflowSchemaLimit,
} from "./value-limits.ts";

import { discoverAgentTypes, resolveAgentType, type AgentTypeDef } from "./agent-types.ts";
import {
  agentCallKey,
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
  isGitRepo,
  removeWorktree,
  writeRescuePatch,
  type Worktree,
  type WorktreeDiff,
} from "./worktree.ts";

const MAX_CONCURRENCY = 16;
const DEFAULT_CLEANUP_TIMEOUT_MS = 25_000;
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
  /** Synchronous extension facade used for model selection. */
  modelRegistry?: ModelRegistryLike;
  /** Canonical model/auth runtime shared across child sessions. */
  modelRuntime?: ModelRuntimeLike;
  model?: ModelLike;
  thinkingLevel?: ThinkingLevel;
  /** Inject a runner (tests). */
  runner?: { run: WorkflowAgentRunner["run"] };
  journal?: RunJournal;
  /** Loads a saved workflow body by name; defaults to disk discovery. */
  loadSavedWorkflow?: (nameOrRef: string | { scriptPath: string }) => { meta: WorkflowMeta; body: string };
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: AgentEventBase & {
    prompt: string;
    cached: boolean;
    modelPattern?: string;
    requestedEffort?: ThinkingLevel;
    agentType?: string;
    isolation?: string;
    structuredOutput?: boolean;
    cachedRecord?: JournalAgentRecord;
  }) => void;
  onAgentEnd?: (event: AgentEventBase & {
    result: unknown;
    status: "done" | "error";
    usage?: AgentUsage;
    modelId?: string;
    effort?: ThinkingLevel;
    error?: string;
    cachedRecord?: JournalAgentRecord;
  }) => void;
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
  calls: Array<{ callPath: string; status: "pending" | "success" | "failed" }>;
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

export async function runWorkflow<T = unknown>(
  rawScript: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  if (options.signal?.aborted) throw new WorkflowAbortError();
  assertWorkflowArgsLimit(options.args);
  const started = Date.now();
  const maxAgents = normalizeMaxAgents(options.maxAgents ?? options.journal?.effectiveMaxAgents);
  const { meta, body } = parseWorkflowScript(rawScript);
  const runtime = new Runtime(options, maxAgents);
  const onOuterAbort = () => runtime.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (options.signal?.aborted) runtime.abort();
  try {
    const result = await runtime.runBody(body, options.args, meta.name);
    if (runtime.policyError) throw runtime.policyError;
    await runtime.drain(normalizeCleanupTimeout(options.cleanupTimeoutMs));
    if (runtime.policyError) throw runtime.policyError;
    assertWorkflowOutputLimit(result);
    // Keep the public value detached from the Worker message object.
    const cloned = cloneResult(result, "workflow result");
    return {
      meta,
      result: cloned as T,
      logs: runtime.state.logs,
      phases: runtime.state.phases,
      agentCount: runtime.state.agentCount,
      agentsUsed: runtime.agentsUsed,
      cachedCount: runtime.state.cachedCount,
      spentTokens: runtime.state.spent,
      newTokens: runtime.state.newTokens,
      replayedTokens: runtime.state.replayedTokens,
      durationMs: Date.now() - started,
      maxAgents,
    };
  } catch (error) {
    runtime.abort();
    if (error instanceof WorkflowCleanupTimeoutError) throw error;
    const cleanupTimeoutMs = normalizeCleanupTimeout(options.cleanupTimeoutMs);
    try {
      await runtime.drain(cleanupTimeoutMs);
    } catch (cleanupError) {
      throw cleanupError;
    }
    if (runtime.policyError) throw runtime.policyError;
    if (options.signal?.aborted && !isWorkflowPolicyError(error)) {
      throw new WorkflowAbortError();
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

class Runtime implements ScriptExecutorHost {
  readonly state: RuntimeState;
  private readonly options: WorkflowRunOptions;
  private readonly cwd: string;
  private runnerInstance: { run: WorkflowAgentRunner["run"] } | undefined;
  private readonly agentTypes: Map<string, AgentTypeDef>;
  private readonly limiter: <R>(fn: () => Promise<R>) => Promise<R>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly applyLock = new Mutex();
  private readonly childController = new AbortController();
  private readonly scriptController = new AbortController();
  private readonly admission: AgentAdmission;
  private readonly seenCallPaths = new Set<string>();
  private readonly agentRequestOccurrences = new Map<string, number>();
  private readonly nestedRequestOccurrences = new Map<string, number>();
  private readonly activePanelTraces = new Map<string, ActivePanelTrace>();
  policyError: WorkflowPolicyError | undefined;

  constructor(options: WorkflowRunOptions, maxAgents: number) {
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
    this.runnerInstance = options.runner;
    this.agentTypes = discoverAgentTypes(this.cwd);
    this.admission = new AgentAdmission(maxAgents, options.journal?.agentsUsed ?? 0);
    this.state = {
      logs: [],
      phases: [],
      agentCount: 0,
      cachedCount: 0,
      spent: 0,
      newTokens: 0,
      replayedTokens: 0,
      maxAgents,
    };
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? os.cpus().length ?? 8;
    const defaultConcurrency = Math.max(1, Math.min(Math.max(1, cores - 2), MAX_CONCURRENCY));
    const concurrency = normalizeConcurrency(options.concurrency, defaultConcurrency);
    this.limiter = createLimiter(concurrency, this.childController.signal);
  }

  get agentsUsed(): number {
    return this.admission.usedAgents;
  }

  abort(): void {
    if (!this.childController.signal.aborted) this.childController.abort();
    if (!this.scriptController.signal.aborted) this.scriptController.abort();
  }

  async drain(timeoutMs?: number): Promise<void> {
    const configuredTimeoutMs = timeoutMs;
    const deadline = configuredTimeoutMs === undefined ? undefined : Date.now() + configuredTimeoutMs;
    while (this.pending.size > 0) {
      const batch = Promise.allSettled([...this.pending]);
      if (deadline === undefined) {
        await batch;
        continue;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new WorkflowCleanupTimeoutError(configuredTimeoutMs!);
      await raceWithCleanupTimeout(batch, remainingMs, configuredTimeoutMs!);
    }
  }

  /** Lazily construct the default in-memory runner (skipped when a runner is injected). */
  private getRunner(): { run: WorkflowAgentRunner["run"] } {
    if (!this.runnerInstance) {
      this.runnerInstance = new WorkflowAgentRunner({
        cwd: this.cwd,
        modelRegistry: this.options.modelRegistry,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
      });
    }
    return this.runnerInstance;
  }

  async runBody(body: string, args: unknown, name: string): Promise<unknown> {
    this.throwIfAborted();
    return await executeWorkflowScript(body, this, {
      cwd: this.cwd,
      args,
      name,
      signal: this.scriptController.signal,
      stallTimeoutMs: this.options.stallTimeoutMs,
      hostCallLimit: this.options.hostCallLimit,
      workerMemoryLimitMb: this.options.workerMemoryLimitMb,
    });
  }

  private throwIfAborted(): void {
    if (this.childController.signal.aborted || this.options.signal?.aborted) throw new WorkflowAbortError();
  }

  phase(title: string): void {
    if (!title) return;
    this.state.currentPhase = title;
    if (!this.state.phases.includes(title)) this.state.phases.push(title);
    this.options.onPhase?.(title);
  }

  log(message: string): void {
    this.logLine(message);
  }

  async reservePanel(payload: {
    callPath?: unknown;
    reserveAgents: number;
    branchCount: number;
    parentReservationIds?: string[];
  }): Promise<PanelReservation> {
    this.throwIfAborted();
    try {
      const callPath = requireString(payload.callPath, "parallel callPath");
      const parentReservationIds = Array.isArray(payload.parentReservationIds)
        ? payload.parentReservationIds
        : [];
      let replay: ReturnType<RunJournal["panelReplayPlan"]> | undefined;
      try {
        replay = this.options.journal?.panelReplayPlan(callPath, payload.branchCount);
      } catch (error) {
        throw journalPolicyError(error, "workflow panel replay lookup failed");
      }
      const liveSlots = replay
        ? Math.max(
            replay.branchNeedsSlot.filter(Boolean).length,
            payload.reserveAgents - replay.slotCredit,
          )
        : payload.reserveAgents;
      const panel = replay
        ? this.admission.reservePanelWithBranchNeeds(
            liveSlots,
            replay.branchNeedsSlot,
            parentReservationIds,
            payload.reserveAgents - liveSlots,
          )
        : this.admission.reservePanelWithBranches(payload.reserveAgents, payload.branchCount, parentReservationIds);
      try {
        this.options.journal?.recordPanelOpen(callPath, payload.reserveAgents, payload.branchCount);
      } catch (error) {
        for (const reservationId of panel.branchReservationIds) this.admission.releasePanel(reservationId);
        this.admission.releasePanel(panel.panelReservationId);
        throw journalPolicyError(error, "workflow panel-open commit failed");
      }
      if (this.activePanelTraces.has(callPath)) {
        for (const reservationId of panel.branchReservationIds) this.admission.releasePanel(reservationId);
        this.admission.releasePanel(panel.panelReservationId);
        throw new WorkflowPolicyError(`workflow produced duplicate parallel callPath: ${callPath}`);
      }
      this.activePanelTraces.set(callPath, { branchCount: payload.branchCount, calls: [] });
      return panel;
    } catch (error) {
      this.recordPolicyError(error);
      throw error;
    }
  }

  async completePanelBranch(payload: {
    callPath?: unknown;
    branchIndex: number;
    outcome: "success" | "failed";
  }): Promise<void> {
    try {
      const callPath = requireString(payload.callPath, "parallel callPath");
      const trace = this.activePanelTraces.get(callPath);
      if (
        !trace
        || !Number.isInteger(payload.branchIndex)
        || payload.branchIndex < 0
        || payload.branchIndex >= trace.branchCount
        || (payload.outcome !== "success" && payload.outcome !== "failed")
      ) {
        throw new WorkflowPolicyError(`workflow returned invalid branch completion for ${callPath}`);
      }
      const prefix = `${callPath}/b:${payload.branchIndex}/`;
      const calls = trace.calls.filter((call) => call.callPath.startsWith(prefix));
      if (calls.some((call) => call.status === "pending")) {
        throw new WorkflowPolicyError(`workflow branch completed with pending agent calls at ${callPath}`);
      }
      this.options.journal?.recordPanelBranch(
        callPath,
        payload.branchIndex,
        payload.outcome,
        calls.map((call) => ({
          callPath: call.callPath,
          status: call.status === "success" ? "success" : "failed",
        })),
      );
    } catch (error) {
      const failure = journalPolicyError(error, "workflow panel-branch commit failed");
      this.recordPolicyError(failure);
      throw failure;
    }
  }

  async releasePanel(payload: {
    reservationId: string;
    callPath?: unknown;
    completed?: boolean;
    branchOutcomes?: unknown;
  }): Promise<void> {
    const callPath = typeof payload.callPath === "string" ? payload.callPath : undefined;
    const trace = callPath ? this.activePanelTraces.get(callPath) : undefined;
    if (payload.completed && callPath && trace) {
      const branchOutcomes = Array.isArray(payload.branchOutcomes)
        ? payload.branchOutcomes
        : [];
      if (
        branchOutcomes.length !== trace.branchCount
        || branchOutcomes.some((outcome) => outcome !== "success" && outcome !== "failed")
      ) {
        throw new WorkflowPolicyError(`workflow returned invalid branch outcomes for ${callPath}`);
      }
      try {
        this.options.journal?.recordPanelComplete(
          callPath,
          trace.branchCount,
          branchOutcomes as Array<"success" | "failed">,
          trace.calls.map((call) => ({
            callPath: call.callPath,
            status: call.status === "success" ? "success" : "failed",
          })),
        );
      } catch (error) {
        const failure = journalPolicyError(error, "workflow panel completion commit failed");
        this.recordPolicyError(failure);
        throw failure;
      }
    }
    this.admission.releasePanel(payload.reservationId);
    if (callPath) this.activePanelTraces.delete(callPath);
  }

  private beginPanelAgent(callPath: string): void {
    for (const [panelPath, trace] of this.activePanelTraces) {
      if (!callPath.startsWith(`${panelPath}/`)) continue;
      trace.calls.push({ callPath, status: "pending" });
    }
  }

  private finishPanelAgent(callPath: string, status: "success" | "failed"): void {
    for (const [panelPath, trace] of this.activePanelTraces) {
      if (!callPath.startsWith(`${panelPath}/`)) continue;
      const call = trace.calls.find((candidate) => candidate.callPath === callPath);
      if (call) call.status = status;
    }
  }

  async loadWorkflow(payload: {
    nameOrRef: unknown;
    callPath?: unknown;
    args?: unknown;
  }): Promise<{ meta: WorkflowMeta; body: string; callPath: string }> {
    this.throwIfAborted();
    assertWorkflowArgsLimit(payload.args);
    const workerCallPath = requireString(payload.callPath, "nested workflow callPath");
    const ref = normalizeWorkflowRef(payload.nameOrRef);
    const argsJson = JSON.stringify(payload.args);
    const sourceCallPath = workerCallPath.replace(/:\d+$/, "");
    const requestHash = hashString(`${stableStringify(ref)}\u0000${argsJson}`).slice(0, 16);
    const requestBase = `${sourceCallPath}/q:${requestHash}`;
    const requestOccurrence = this.nestedRequestOccurrences.get(requestBase) ?? 0;
    this.nestedRequestOccurrences.set(requestBase, requestOccurrence + 1);
    const callPath = `${requestBase}:${requestOccurrence}`;
    const loader = this.options.loadSavedWorkflow ?? ((r) => loadSavedWorkflowFromDisk(r, this.cwd));
    const loaded = loader(ref);
    const sourceHash = hashString(
      `${stableStringify(loaded.meta)}\u0000${loaded.body}\u0000${argsJson}`,
    );
    try {
      this.options.journal?.recordNestedSource(callPath, sourceHash);
    } catch (error) {
      const failure = journalPolicyError(error, "nested workflow identity commit failed");
      this.recordPolicyError(failure);
      throw failure;
    }
    return { ...loaded, callPath };
  }

  async validateOutput(payload: { value: unknown; label?: unknown }): Promise<void> {
    try {
      assertWorkflowOutputLimit(payload.value, "nested workflow output");
    } catch (error) {
      this.recordPolicyError(error);
      throw error;
    }
  }

  async agent(payload: {
    callPath?: unknown;
    prompt: unknown;
    options?: unknown;
    assignedPhase?: string;
    workflowPath?: string[];
    reservationIds?: string[];
  }): Promise<unknown> {
    this.throwIfAborted();
    const workerCallPath = requireString(payload.callPath, "agent callPath");
    if (this.seenCallPaths.has(workerCallPath)) {
      const error = new WorkflowPolicyError(`workflow produced duplicate agent callPath: ${workerCallPath}`);
      this.recordPolicyError(error);
      throw error;
    }
    this.seenCallPaths.add(workerCallPath);
    const prompt = requireString(payload.prompt, "agent prompt");
    const opts = normalizeAgentOptions(payload.options);
    // The Worker owns phase scope. Falling back to host-global display state here
    // would make cache identity depend on parallel branch completion order.
    const assignedPhase = opts.phase ?? payload.assignedPhase;
    const sourceCallPath = workerCallPath.replace(/:\d+$/, "");
    const requestHash = hashString(stableStringify({
      prompt,
      options: { ...opts, phase: assignedPhase },
    })).slice(0, 16);
    const requestBase = `${sourceCallPath}/q:${requestHash}`;
    const requestOccurrence = this.agentRequestOccurrences.get(requestBase) ?? 0;
    this.agentRequestOccurrences.set(requestBase, requestOccurrence + 1);
    const callPath = `${requestBase}:${requestOccurrence}`;
    const id = ++this.state.agentCount;
    const label = opts.label?.trim() || defaultLabel(assignedPhase, id);
    const workflowPath = Array.isArray(payload.workflowPath) ? [...payload.workflowPath] : [];
    const agentTypeDef = resolveAgentType(opts.agentType, this.agentTypes);
    const selection = resolveModelSelection({
      pattern: opts.model,
      roleModel: agentTypeDef?.model,
      roleThinking: agentTypeDef?.thinking,
      defaultModel: this.options.model,
      defaultThinking: this.options.thinkingLevel,
      models: this.options.modelRegistry?.getAvailable(),
    });
    const key = agentCallKey(prompt, {
      ...opts,
      phase: assignedPhase,
      agentTypeDefinition: agentTypeDef,
      effectiveModel: modelIdentity(selection.model),
      effectiveThinking: selection.thinkingLevel,
    });

    let cached: JournalAgentRecord | undefined;
    try {
      cached = this.options.journal?.lookup(callPath, key);
    } catch (error) {
      const failure = journalPolicyError(error, "workflow cache lookup failed");
      this.recordPolicyError(failure);
      throw failure;
    }
    if (cached) {
      this.beginPanelAgent(callPath);
      this.state.cachedCount++;
      this.state.spent += cached.outputTokens ?? 0;
      this.state.replayedTokens += cached.totalTokens ?? 0;
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
      this.notifyObserver(() => this.options.onAgentStart?.({
        id,
        callPath,
        label,
        phase: assignedPhase,
        workflowPath,
        prompt,
        cached: true,
        modelPattern: opts.model,
        requestedEffort: this.options.thinkingLevel,
        agentType: opts.agentType,
        isolation: opts.isolation,
        structuredOutput: opts.schema != null,
        cachedRecord: cloneResult(cached, "cached agent record"),
      }));
      this.notifyObserver(() => this.options.onAgentEnd?.({
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
      }));
      this.finishPanelAgent(callPath, "success");
      return replayValue;
    }

    try {
      const ordinal = this.admission.consumeAgent(Array.isArray(payload.reservationIds) ? payload.reservationIds : []);
      this.options.journal?.recordAdmission(callPath, key, ordinal);
    } catch (error) {
      const failure = journalPolicyError(error, "workflow admission commit failed");
      this.recordPolicyError(failure);
      throw failure;
    }

    this.beginPanelAgent(callPath);
    const run = this.limiter(async () => {
      this.notifyObserver(() => this.options.onAgentStart?.({
        id,
        callPath,
        label,
        phase: assignedPhase,
        workflowPath,
        prompt,
        cached: false,
        modelPattern: opts.model,
        requestedEffort: this.options.thinkingLevel,
        agentType: opts.agentType,
        isolation: opts.isolation,
        structuredOutput: opts.schema != null,
      }));
      let worktree: Worktree | undefined;
      let keepWorktree = false;
      let observedUsage: AgentUsage | undefined;
      try {
        this.throwIfAborted();
        if (opts.isolation === "worktree") {
          worktree = this.tryCreateWorktree(id);
        }

        const runner = this.getRunner();
        const onActivity: ((e: AgentActivityInput) => void) | undefined = this.options.onAgentActivity
          ? (e: AgentActivityInput) =>
              this.options.onAgentActivity!({ id, callPath, label, phase: assignedPhase, workflowPath, ...e })
          : undefined;
        const onTelemetry: ((e: AgentTelemetryEvent) => void) | undefined = this.options.onAgentTelemetry
          ? (e: AgentTelemetryEvent) =>
              this.options.onAgentTelemetry!({ id, callPath, label, phase: assignedPhase, workflowPath, ...e })
          : undefined;
        const agentStartedAt = Date.now();
        const result: AgentRunResult = await runner.run({
          prompt,
          label,
          schema: opts.schema,
          signal: this.childController.signal,
          instructions: buildInstructions(assignedPhase, opts),
          modelPattern: opts.model,
          agentTypeDef,
          cwd: worktree?.agentCwd,
          onActivity,
          onTelemetry,
        });
        this.throwIfAborted();
        const usage = normalizeAgentUsage(result.usage);
        this.state.spent += usage.outputTokens;
        this.state.newTokens += usage.totalTokens;
        observedUsage = usage;

        // Clone failures are ordinary runner-result failures. Values that clone
        // successfully but violate the durable JSON contract are fatal policy.
        const clonedValue = cloneResult(result.value, "agent result");
        try {
          assertWorkflowOutputLimit(clonedValue, "workflow agent output");
        } catch (error) {
          this.recordPolicyError(error);
          throw error;
        }

        if (worktree) keepWorktree = await this.integrateWorktree(worktree, id, label);
        this.notifyObserver(() => this.options.onAgentEnd?.({
          id,
          callPath,
          label,
          phase: assignedPhase,
          workflowPath,
          result: clonedValue,
          status: "done",
          usage,
          modelId: result.modelId,
          effort: result.effort,
        }));
        // Commit resume state only after observers accepted the successful
        // completion. Otherwise a callback failure could return null live but
        // replay a success from the journal on the next generation.
        try {
          this.options.journal?.recordAgent({
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
            requestedEffort: this.options.thinkingLevel,
            modelId: result.modelId,
            effort: result.effort,
            agentType: opts.agentType,
            isolation: opts.isolation,
            structuredOutput: opts.schema != null,
            startedAt: agentStartedAt,
            durationMs: Date.now() - agentStartedAt,
          });
        } catch (error) {
          const failure = journalPolicyError(error, "workflow agent-result commit failed");
          this.recordPolicyError(failure);
          throw failure;
        }
        this.finishPanelAgent(callPath, "success");
        return clonedValue;
      } catch (error) {
        if (this.childController.signal.aborted || this.options.signal?.aborted || isWorkflowPolicyError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.finishPanelAgent(callPath, "failed");
        this.logLine(`agent ${label} failed: ${message}`);
        this.notifyObserver(() => this.options.onAgentEnd?.({
          id,
          callPath,
          label,
          phase: assignedPhase,
          workflowPath,
          result: null,
          status: "error",
          error: message,
          usage: observedUsage,
        }));
        return null;
      } finally {
        if (worktree && !keepWorktree) {
          try {
            removeWorktree(worktree);
          } catch {
            // ignore cleanup failures
          }
        }
      }
    });
    this.track(run);
    return await run;
  }

  private notifyObserver(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      const failure = new WorkflowPolicyError(`workflow observer failed: ${errorMessage(error)}`);
      (failure as Error & { cause?: unknown }).cause = error;
      this.recordPolicyError(failure);
      throw failure;
    }
  }

  private recordPolicyError(error: unknown): void {
    if (isWorkflowPolicyError(error)) {
      this.policyError ??= error;
      this.abort();
    }
  }

  private tryCreateWorktree(index: number): Worktree | undefined {
    if (!isGitRepo(this.cwd)) {
      this.logLine(`agent #${index}: isolation:'worktree' ignored — not a git repository`);
      return undefined;
    }
    try {
      const runId = this.options.journal ? path.basename(this.options.journal.filePath, ".jsonl") : "run";
      return createWorktree(this.cwd, runId, index);
    } catch (error) {
      this.logLine(`agent #${index}: worktree setup failed (${errorMessage(error)}); running in shared cwd`);
      return undefined;
    }
  }

  /**
   * Fold a worktree's changes back into the shared working tree. Returns true
   * when the worktree must be KEPT (its changes are not safely preserved
   * elsewhere — e.g. apply conflicted AND the rescue write failed). Never throws:
   * a writeback failure must not discard the agent's already-completed result
   * or its token spend.
   */
  private async integrateWorktree(worktree: Worktree, id: number, label: string): Promise<boolean> {
    // Outer safety net: a writeback/integration failure (including a host
    // onUpdate callback throwing during a log line) must never discard the
    // agent's completed work. Fail-safe toward KEEPING the worktree.
    try {
      let diff: WorktreeDiff;
      try {
        diff = captureWorktreeDiff(worktree);
      } catch (error) {
        this.logLine(
          `worktree[${label}]: diff capture failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
        );
        return true;
      }
      if (!hasChanges(diff)) {
        this.logLine(`worktree[${label}]: no changes (auto-removed)`);
        return false;
      }
      // Apply patches back to the shared tree sequentially to avoid corruption.
      let keep = false;
      await this.applyLock.run(async () => {
        const applied = applyPatch(this.cwd, diff.patch);
        if (applied) {
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s), +${diff.insertions}/-${diff.deletions} applied to working tree`,
          );
          return;
        }
        // 3-way conflict: `applyPatch` already reverted the shared tree to its
        // pre-apply state. Persist the patch so the agent's work is recoverable
        // before the worktree is removed.
        const runId = this.options.journal
          ? path.basename(this.options.journal.filePath, ".jsonl")
          : "run";
        const rescueDir = this.rescueDir();
        try {
          const rescue = writeRescuePatch(rescueDir, runId, id, label, diff.patch);
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s), +${diff.insertions}/-${diff.deletions} could NOT be auto-applied (3-way conflict); patch saved to ${rescue} — review and apply with: git apply --3way ${rescue}`,
          );
        } catch (error) {
          // Rescue write failed (disk full / permission / bad path). Keep the
          // worktree so the user can recover the changes manually.
          keep = true;
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s) could NOT be auto-applied (3-way conflict) AND rescue write failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
          );
        }
      });
      return keep;
    } catch (error) {
      try {
        this.logLine(
          `worktree[${label}]: integration failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
        );
      } catch {
        // best-effort logging
      }
      return true;
    }
  }

  /** Write rescue patches beside the journal or in a user-owned cwd-hash scope. */
  private rescueDir(): string {
    const journalDir = this.options.journal ? path.dirname(this.options.journal.filePath) : undefined;
    if (journalDir) return path.join(journalDir, "patches");
    return path.join(standaloneWorkflowRunsDir(this.cwd), "patches");
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
  }

  private logLine(text: string): void {
    if (this.state.logs.length > MAX_WORKFLOW_LOGS) return;
    const safe = safeDisplayText(text, 512);
    if (!safe) return;
    const entry = this.state.logs.length === MAX_WORKFLOW_LOGS
      ? WORKFLOW_LOG_OMITTED_TEXT
      : safe;
    this.state.logs.push(entry);
    this.options.onLog?.(entry);
  }
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
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    schema: options.schema,
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation === "worktree" ? "worktree" : undefined,
    agentType: optionalString(options.agentType, "agent type"),
  };
}

function normalizeWorkflowRef(value: unknown): string | { scriptPath: string } {
  if (typeof value === "string") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
      throw new TypeError("workflow() name must contain only letters, numbers, underscore, or hyphen");
    }
    return value;
  }
  if (value && typeof value === "object" && typeof (value as any).scriptPath === "string") {
    return { scriptPath: (value as any).scriptPath };
  }
  throw new TypeError("workflow() expects a workflow name string or { scriptPath }");
}

export function loadSavedWorkflowFromDisk(
  ref: string | { scriptPath: string },
  cwd: string,
): { meta: WorkflowMeta; body: string } {
  if (typeof ref === "object") {
    const scriptPath = path.isAbsolute(ref.scriptPath) ? ref.scriptPath : path.join(cwd, ref.scriptPath);
    return parseWorkflowScript(readArtifactFile(scriptPath, "nested workflow script", 16 * 1024 * 1024));
  }
  for (const root of [cwd, os.homedir()]) {
    const dir = path.join(root, ".pi", "ultracode", "workflows");
    for (const candidate of [`${ref}.workflow.js`, `${ref}.js`]) {
      const full = path.join(dir, candidate);
      if (artifactPathExists(full)) {
        return parseWorkflowScript(readContainedArtifactFile(root, full, "saved nested workflow", 16 * 1024 * 1024));
      }
    }
  }
  throw new Error(`workflow() could not find a saved workflow for ${JSON.stringify(ref)}`);
}

function buildInstructions(phase: string | undefined, opts: AgentOptions): string | undefined {
  const lines: string[] = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (opts.isolation === "worktree") {
    lines.push("You are running in an isolated git worktree; edit files freely without coordinating with siblings.");
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
    cost: typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : 0,
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
  return value === undefined ? undefined : usageInteger(value) ?? 0;
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
    throw new WorkflowPolicyError(`workflow concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
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

async function raceWithCleanupTimeout(
  work: Promise<unknown>,
  remainingMs: number,
  configuredTimeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WorkflowCleanupTimeoutError(configuredTimeoutMs)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createLimiter(limit: number, signal: AbortSignal): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  const rejectQueued = () => {
    const error = new WorkflowAbortError();
    for (const waiter of queue.splice(0)) waiter.reject(error);
  };
  signal.addEventListener("abort", rejectQueued, { once: true });

  const acquire = async (): Promise<void> => {
    if (signal.aborted) throw new WorkflowAbortError();
    if (active < limit) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      queue.push({ resolve, reject });
      if (signal.aborted) rejectQueued();
    });
  };

  const release = () => {
    active--;
    if (signal.aborted) {
      rejectQueued();
      return;
    }
    const waiter = queue.shift();
    if (!waiter) return;
    active++;
    waiter.resolve();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
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
  try {
    return structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}
