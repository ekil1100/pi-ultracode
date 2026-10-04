/**
 * The `workflow` tool: parses a workflow script, persists it, runs it through the
 * deterministic runtime with live progress, supports resume, and returns the
 * structured result to the parent assistant.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  defineTool,
  highlightCode,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import beautify from "js-beautify";
import { Context, Effect, Result } from "effect";
import { Type } from "typebox";
import {
  WORKFLOW_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "../prompts.ts";
import {
  DISPLAY_INPUT_LIMIT,
  redactCommand,
  safeDisplayText,
  safeTranscriptText,
} from "./display-text.ts";
import { parseWorkflowScript, normalizeScript } from "./parser.ts";
import {
  ABSOLUTE_MAX_AGENTS,
  DEFAULT_MAX_AGENTS,
  MAX_WORKFLOW_LOGS,
  WORKFLOW_LOG_OMITTED_TEXT,
  runWorkflow,
  type WorkflowRunOptions,
} from "./runtime.ts";
import type { AgentRunner, ModelRuntimeLike, ThinkingLevel } from "./agent-runner.ts";
import { RunJournal, hashString, type JournalAgentRecord } from "./journal.ts";
import { WorkflowRegistry } from "./registry.ts";
import { normalizeMaxAgents } from "./admission.ts";
import { acquireWorkflowLease } from "./leases.ts";
import {
  artifactPathExists,
  assertRegularArtifactFile,
  ensurePrivateArtifactDirectory,
  readArtifactFile,
  standaloneWorkflowRunsDir,
  writeArtifactFile,
} from "./run-artifacts.ts";
import { assertWorkflowArgsLimit } from "./value-limits.ts";
import { readSavedWorkflowByName } from "./saved-workflow.ts";
import { resolveRepositoryContext } from "./repository-context.ts";
import { verifyAppliedPatch } from "./worktree.ts";
import { WorkflowRunDetails, normalizeTaskUsage, type WorkflowTaskSummary } from "./run-details.ts";
import {
  createSnapshot,
  preview,
  recompute,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.ts";

const workflowToolSchema = Type.Object(
  {
    script: Type.Optional(
      Type.String({
        description:
          "Inline raw JavaScript workflow script (no Markdown fences). The source must begin with export const meta = { name: 'snake_case', description: '...' }. Should call agent() at least once for useful orchestration. Required unless `name` or `scriptPath` is given.",
      }),
    ),
    scriptPath: Type.Optional(
      Type.String({
        description: "Path to a workflow script file to run instead of an inline `script`.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Name of a saved workflow under project .pi/ultracode/workflows/ or user-scoped ~/.pi/ultracode/workflows/.",
      }),
    ),
    args: Type.Optional(
      Type.Any({
        description: "Optional JSON value exposed to the workflow script as the global `args`.",
      }),
    ),
    resumeFromRunId: Type.Optional(
      Type.String({
        description:
          "Resume an immutable prior run. Script and args must match exactly; successful agent calls replay by stable call path. maxAgents may only stay the same or increase.",
      }),
    ),
    maxAgents: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: ABSOLUTE_MAX_AGENTS,
        description: `Lifetime live-agent admission cap for this run across resumes. Defaults to ${DEFAULT_MAX_AGENTS}; absolute range is 1..${ABSOLUTE_MAX_AGENTS}. Cache replay is free. This is not a token budget.`,
      }),
    ),
  },
  { additionalProperties: false },
);

export interface WorkflowToolDeps {
  /** Session-owned workflow registry shared with commands and overlays. */
  registry?: WorkflowRegistry;
  /** Canonical runtime supplied by an SDK host; shared by all child sessions. */
  modelRuntime?: ModelRuntimeLike;
  /** Optional host-provided fallback effort for workflow subagents.
   *  Each child session clamps it independently. A per-call `model: "X:level"`
   *  suffix or agentType `thinking:` override still wins. */
  getThinkingLevel?: () => ThinkingLevel | undefined;
  /** Optional execution gate for mode-scoped registrations. Omit for standalone use. */
  isExecutionAllowed?: () => boolean;
  /** Test seam: inject a runner using the same scheduling contract as the runtime. */
  testRunner?: AgentRunner;
  /** Test seam: override the workflow runtime (lets tests capture the options,
   *  including the forwarded thinkingLevel, without spinning up real subagents). */
  runWorkflowFn?: typeof runWorkflow;
  /** Internal test seam for bounded cancellation cleanup. */
  cleanupTimeoutMs?: number;
}

let runCounter = 0;

/** Throttle: min ms between activity-driven re-renders (avoids token-by-token
 *  re-render storms when many subagents stream concurrently). */
const ACTIVITY_RENDER_INTERVAL_MS = 100;

function nextRunId(): string {
  runCounter += 1;
  const nonce = crypto.randomBytes(6).toString("hex");
  return `wf_${Date.now().toString(36)}-${runCounter.toString(36)}-${nonce}`;
}

type WorkflowExecute = ToolDefinition<typeof workflowToolSchema, any>["execute"];

interface HostFailure {
  readonly _tag: "HostFailure";
  readonly cause: unknown;
}
const hostFailure = (cause: unknown): HostFailure => ({ _tag: "HostFailure", cause });
const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: hostFailure });
const bestEffort = (thunk: () => unknown) => attempt(thunk).pipe(Effect.ignore);

const WorkflowHost = Context.Service<HostDeps>("pi-ultracode/workflow/Host");

type HostDeps = WorkflowToolDeps & { registry: WorkflowRegistry };
interface HostInput {
  deps: HostDeps;
  params: Parameters<WorkflowExecute>[1];
  signal: Parameters<WorkflowExecute>[2];
  onUpdate: Parameters<WorkflowExecute>[3];
  ctx: Parameters<WorkflowExecute>[4];
  abort: {
    controller: AbortController;
    requested: boolean;
    accepting: boolean;
    request: () => void;
  };
}

function createHostInput(deps: HostDeps, args: Parameters<WorkflowExecute>): HostInput {
  const [, params, signal, onUpdate, ctx] = args;
  const abort: HostInput["abort"] = {
    controller: new AbortController(),
    requested: false,
    accepting: true,
    request: () => {
      if (!abort.accepting) return;
      abort.requested = true;
      abort.controller.abort();
    },
  };
  return { deps, params, signal, onUpdate, ctx, abort };
}

function checkHostAbort({ signal, abort }: HostInput) {
  return attempt(() => {
    if (signal?.aborted || abort.controller.signal.aborted)
      throw new Error("Workflow was aborted before it started");
  });
}

function acquireAbortListener({ deps, signal, abort }: HostInput) {
  return attempt(() => {
    if (deps.isExecutionAllowed?.() === false) {
      throw new Error(
        "The workflow tool is disabled. Run /ultracode or select an Ultracode depth before using it.",
      );
    }
  }).pipe(
    // Register removal first: a host can attach a listener and then throw.
    Effect.andThen(
      Effect.acquireRelease(Effect.succeed(abort.request), (listener) =>
        Effect.sync(() => {
          abort.accepting = false;
        }).pipe(Effect.andThen(bestEffort(() => signal?.removeEventListener("abort", listener)))),
      ),
    ),
    Effect.andThen(attempt(() => signal?.addEventListener("abort", abort.request, { once: true }))),
  );
}

function prepareWorkflow(input: HostInput) {
  const { params, ctx } = input;
  const cwd = ctx.cwd;
  const projectTrusted = ctx.isProjectTrusted?.() ?? false;
  const repositoryContext = resolveRepositoryContext(cwd);
  const targetIdentity = repositoryContext.identity;
  assertWorkflowArgsLimit(params.args);
  const requestedMaxAgents =
    params.maxAgents === undefined ? undefined : normalizeMaxAgents(params.maxAgents);
  const resolvedScript = resolveScript(params, cwd, projectTrusted);
  const script = normalizeScript(resolvedScript.script);
  const parsed = parseWorkflowScript(script);
  const displayName = safeDisplayText(parsed.meta.name, 60) || "workflow";
  const runsDir = workflowRunsDir(ctx);
  const requestedRunId = params.resumeFromRunId?.trim();
  const runId = requestedRunId ? requireSafeRunId(requestedRunId) : nextRunId();
  const resuming = Boolean(requestedRunId);
  if (resuming && !RunJournal.exists(runsDir, runId)) {
    throw new Error(`workflow: resumeFromRunId ${runId} was not found in this session`);
  }
  return {
    ...input,
    cwd,
    projectTrusted,
    repositoryContext,
    targetIdentity,
    requestedMaxAgents,
    script,
    sourceLabel: resolvedScript.sourceLabel,
    parsed,
    displayName,
    runsDir,
    runId,
    resuming,
  };
}
type PreparedWorkflow = ReturnType<typeof prepareWorkflow>;

interface AcquiredWorkflow extends PreparedWorkflow {
  scriptPath: string;
  workflowStartedAt: number;
  thinkingLevel: ThinkingLevel | undefined;
  activeJournal: RunJournal;
  effectiveMaxAgents: number;
  state: ObserverState;
}
interface ObserverState {
  snapshot: WorkflowSnapshot;
  updateObserverEnabled: boolean;
  // Mutate live fields on every tick; throttle only activity-driven rendering.
  lastActivityRenderMs: number;
  acceptingEvents: boolean;
  heartbeatFailure: HostFailure | undefined;
}
interface ObservedWorkflow extends AcquiredWorkflow {
  runDetails: WorkflowRunDetails;
  handle: ReturnType<WorkflowRegistry["register"]>;
}

function acquireJournal(prepared: PreparedWorkflow) {
  const {
    params,
    parsed,
    runId,
    script,
    projectTrusted,
    targetIdentity,
    requestedMaxAgents,
    resuming,
    runsDir,
    repositoryContext,
  } = prepared;
  return Effect.acquireRelease(
    attempt(() => {
      const journalMeta = {
        type: "run" as const,
        runId,
        name: parsed.meta.name,
        scriptHash: hashString(script),
        args: params.args,
        projectTrusted,
        targetIdentity,
        startedAt: Date.now(),
        maxAgents: requestedMaxAgents,
      };
      return resuming
        ? RunJournal.resume(runsDir, runId, journalMeta, {
            validateDelivery(record) {
              if (
                !record.deliveryPatchPath ||
                !record.deliveryPatchHash ||
                !repositoryContext.repoRoot
              ) {
                throw new Error(
                  `workflow delivery at ${record.callPath} has no verifiable Git target`,
                );
              }
              if (
                !verifyAppliedPatch(
                  repositoryContext.repoRoot,
                  record.deliveryPatchPath,
                  record.deliveryPatchHash,
                  path.join(runsDir, "patches"),
                )
              ) {
                throw new Error(
                  `workflow delivery at ${record.callPath} is no longer present; start a new run`,
                );
              }
            },
          })
        : RunJournal.create(runsDir, journalMeta);
    }),
    (journal) => bestEffort(() => journal.close()),
  );
}

function persistScript(prepared: PreparedWorkflow, scriptPath: string): void {
  const { runsDir, resuming, script, runId } = prepared;
  ensurePrivateArtifactDirectory(runsDir);
  if (resuming) {
    assertRegularArtifactFile(scriptPath, "workflow resume script");
    if (readArtifactFile(scriptPath, "workflow resume script") !== script) {
      throw new Error(
        `workflow ${runId} has an immutable script; start a new run for changed source`,
      );
    }
  } else {
    writeArtifactFile(scriptPath, script, { trustedRoot: runsDir });
  }
}

function acquireRun(prepared: PreparedWorkflow) {
  const { deps, runsDir, runId, parsed } = prepared;
  const scriptPath = path.join(runsDir, `${runId}.workflow.js`);
  const workflowStartedAt = Date.now();
  return attempt(() => deps.getThinkingLevel?.()).pipe(
    Effect.bindTo("thinkingLevel"),
    Effect.tap(() => checkHostAbort(prepared)),
    Effect.tap(() =>
      Effect.acquireRelease(
        attempt(() => acquireWorkflowLease(runsDir, runId)),
        (lease) => bestEffort(() => lease.release()),
      ),
    ),
    Effect.tap(() => attempt(() => persistScript(prepared, scriptPath))),
    Effect.bind("activeJournal", () => acquireJournal(prepared)),
    Effect.map(({ thinkingLevel, activeJournal }): AcquiredWorkflow => {
      const effectiveMaxAgents = activeJournal.effectiveMaxAgents;
      const snapshot = createSnapshot(parsed.meta, runId);
      snapshot.maxAgents = effectiveMaxAgents;
      snapshot.agentsUsed = activeJournal.agentsUsed;
      return {
        ...prepared,
        scriptPath,
        workflowStartedAt,
        thinkingLevel,
        activeJournal,
        effectiveMaxAgents,
        state: {
          snapshot,
          updateObserverEnabled: true,
          lastActivityRenderMs: 0,
          acceptingEvents: true,
          heartbeatFailure: undefined,
        },
      };
    }),
  );
}

function acquireRunObserver(run: AcquiredWorkflow) {
  const { runsDir, runId, resuming, parsed, state, deps, abort } = run;
  const acquireDetails = Effect.acquireRelease(
    attempt(() => {
      const detailsPath = path.join(runsDir, `${runId}.details.json`);
      if (resuming && artifactPathExists(detailsPath)) {
        assertRegularArtifactFile(detailsPath, "workflow details manifest");
      }
      return (
        (resuming ? WorkflowRunDetails.restore(detailsPath)?.details : undefined) ??
        new WorkflowRunDetails({ runId, name: parsed.meta.name, runsDir })
      );
    }),
    (details) => bestEffort(() => details.close(state.snapshot)),
  );
  return acquireDetails.pipe(
    Effect.tap((runDetails) =>
      attempt(() => {
        if (resuming) runDetails.beginGeneration();
        state.snapshot.detailsManifestPath = runDetails.manifestPath;
      }),
    ),
    Effect.tap(() => checkHostAbort(run)),
    Effect.bindTo("runDetails"),
    Effect.bind("handle", ({ runDetails }) =>
      attempt(() => deps.registry.register(runId, state.snapshot, abort.request, runDetails)),
    ),
    Effect.map(({ runDetails, handle }): ObservedWorkflow => ({ ...run, runDetails, handle })),
  );
}

function emitRunUpdate({ onUpdate, state }: ObservedWorkflow): void {
  if (!onUpdate || !state.updateObserverEnabled) return;
  Effect.runSync(
    attempt(() =>
      onUpdate({
        content: [{ type: "text", text: renderWorkflowText(state.snapshot) }],
        details: structuredClone(state.snapshot),
      }),
    ).pipe(Effect.result),
  ).pipe(
    Result.getOrElse((failure) => {
      state.updateObserverEnabled = false;
      throw failure.cause;
    }),
  );
}

function updateRun(run: ObservedWorkflow): void {
  const {
    state,
    handle,
    deps: { registry },
  } = run;
  const totals = representedUsage(state.snapshot);
  state.snapshot.newTokens = totals.newTokens;
  state.snapshot.replayedTokens = totals.replayedTokens;
  state.snapshot.spentTokens = totals.outputTokens;
  state.snapshot = recompute(state.snapshot);
  handle.snapshot = state.snapshot;
  registry.notify();
  emitRunUpdate(run);
}

function recordPhase(snapshot: WorkflowSnapshot, title?: string): string | undefined {
  if (!title) return undefined;
  const safe = safeDisplayText(title, 120);
  if (safe && !snapshot.phases.includes(safe)) snapshot.phases.push(safe);
  return safe || undefined;
}

function onLog(run: ObservedWorkflow, message: string): void {
  const { state } = run;

  if (!state.acceptingEvents || state.snapshot.logs.length > MAX_WORKFLOW_LOGS) return;
  const safe = safeDisplayText(message, 512);
  if (!safe) return;
  state.snapshot.logs.push(
    state.snapshot.logs.length === MAX_WORKFLOW_LOGS ? WORKFLOW_LOG_OMITTED_TEXT : safe,
  );
  updateRun(run);
}

function onPhase(run: ObservedWorkflow, title: string): void {
  const { state } = run;

  if (!state.acceptingEvents) return;
  state.snapshot.currentPhase = recordPhase(state.snapshot, title);
  updateRun(run);
}

function onAgentStart(
  run: ObservedWorkflow,
  event: Parameters<NonNullable<WorkflowRunOptions["onAgentStart"]>>[0],
): void {
  const { state, activeJournal, runDetails } = run;

  if (!state.acceptingEvents) return;
  state.snapshot.agentsUsed = activeJournal.agentsUsed;
  const phase = recordPhase(state.snapshot, event.phase);
  const startedAt = Date.now();
  const summary = runDetails.startTask({
    id: event.id,
    callPath: event.callPath,
    label: event.label,
    phase,
    workflowPath: event.workflowPath,
    prompt: event.prompt,
    modelPattern: event.modelPattern,
    requestedEffort: event.requestedEffort,
    agentType: event.agentType,
    isolation: event.isolation,
    structuredOutput: event.structuredOutput,
    cached: event.cached,
    cachedRecord: event.cachedRecord ? cachedRecordSummary(event.cachedRecord) : undefined,
  });
  const agent: WorkflowSnapshot["agents"][number] = {
    id: event.id,
    callPath: event.callPath,
    label: safeDisplayText(event.label, 120) || `agent ${event.id}`,
    phase,
    workflowPath: event.workflowPath,
    status: event.cached ? "cached" : "running",
    startedAt: summary.startedAt ?? startedAt,
    lastActivityAt: startedAt,
    activity: event.cached ? "replaying cache" : "starting session",
  };
  applyTaskSummary(agent, summary);
  state.snapshot.agents.push(agent);
  updateRun(run);
  runDetails.persist(state.snapshot);
}

function onAgentEnd(
  run: ObservedWorkflow,
  event: Parameters<NonNullable<WorkflowRunOptions["onAgentEnd"]>>[0],
): void {
  const { state, runDetails } = run;

  if (!state.acceptingEvents) return;
  const agent = state.snapshot.agents.find((a) => a.id === event.id);
  const summary = runDetails.finishTask(event.id, {
    status: event.cachedRecord ? "cached" : event.status,
    result: event.result,
    error: event.error,
    usage: event.usage,
    modelId: event.modelId,
    effort: event.effort,
  });
  if (agent) {
    if (agent.status !== "cached") agent.status = event.status;
    agent.resultPreview = preview(event.result);
    if (event.status === "error")
      agent.error = event.error ? statusText(event.error) : preview(event.result);
    const endedAt = Date.now();
    agent.endedAt = endedAt;
    clearAgentTransient(agent);
    if (agent.startedAt != null) agent.durationMs = endedAt - agent.startedAt;
    if (summary) applyTaskSummary(agent, summary);
  }
  updateRun(run);
  runDetails.persist(state.snapshot);
}

function onAgentTelemetry(
  run: ObservedWorkflow,
  event: Parameters<NonNullable<WorkflowRunOptions["onAgentTelemetry"]>>[0],
): void {
  const { state, runDetails } = run;

  if (!state.acceptingEvents) return;
  const agent = state.snapshot.agents.find((candidate) => candidate.id === event.id);
  if (!agent || agent.status !== "running") return;
  const summary = runDetails.record(event.id, event);
  if (summary) applyTaskSummary(agent, summary);
  const now = Date.now();
  agent.lastActivityAt = now;
  if (now - state.lastActivityRenderMs >= ACTIVITY_RENDER_INTERVAL_MS) {
    state.lastActivityRenderMs = now;
    updateRun(run);
  }
}

function onAgentActivity(
  run: ObservedWorkflow,
  event: Parameters<NonNullable<WorkflowRunOptions["onAgentActivity"]>>[0],
): void {
  const { state } = run;

  if (!state.acceptingEvents) return;
  const agent = state.snapshot.agents.find((a) => a.id === event.id);
  if (!agent || agent.status !== "running") return;
  const now = Date.now();
  agent.lastActivityAt = now;
  agent.activity = safeDisplayText(activityLabel(event.kind, event.detail), 160);

  if (event.kind === "tool") {
    const activeTools = agent.activeTools ?? [];
    const existing = activeTools.find((tool) => tool.id === event.toolCallId);
    if (event.toolState === "end") {
      agent.activeTools = activeTools.filter((tool) => tool.id !== event.toolCallId);
    } else {
      const toolName = safeDisplayText(event.toolName, 80) || "tool";
      const toolArgs = event.toolArgs ? safeDisplayText(event.toolArgs, 120) : undefined;
      if (existing) {
        existing.name = toolName;
        existing.args = toolArgs ?? existing.args;
        existing.lastUpdateAt = now;
      } else {
        activeTools.push({
          id: event.toolCallId,
          name: toolName,
          args: toolArgs,
          startedAt: now,
          lastUpdateAt: now,
        });
        agent.activeTools = activeTools;
      }
    }
  }

  if (now - state.lastActivityRenderMs >= ACTIVITY_RENDER_INTERVAL_MS) {
    state.lastActivityRenderMs = now;
    updateRun(run);
  }
}

function executeRun(run: ObservedWorkflow) {
  const {
    deps,
    script,
    cwd,
    params,
    projectTrusted,
    targetIdentity,
    abort,
    thinkingLevel,
    ctx,
    activeJournal,
    effectiveMaxAgents,
  } = run;
  const execute = deps.runWorkflowFn ?? runWorkflow;
  // The host signal requests runtime cancellation. Await its drain before
  // closing resources; never interrupt the Promise wait.
  return Effect.tryPromise({
    try: () =>
      execute(script, {
        cwd,
        args: params.args,
        projectTrusted,
        targetIdentity,
        signal: abort.controller.signal,
        thinkingLevel,
        modelRegistry: ctx.modelRegistry as any,
        modelRuntime: deps.modelRuntime,
        model: ctx.model as any,
        runner: deps.testRunner,
        journal: activeJournal,
        maxAgents: effectiveMaxAgents,
        cleanupTimeoutMs: deps.cleanupTimeoutMs,
        onLog: (event) => onLog(run, event),
        onPhase: (event) => onPhase(run, event),
        onAgentStart: (event) => onAgentStart(run, event),
        onAgentEnd: (event) => onAgentEnd(run, event),
        onAgentTelemetry: (event) => onAgentTelemetry(run, event),
        onAgentActivity: (event) => onAgentActivity(run, event),
      }),
    catch: hostFailure,
  }).pipe(Effect.uninterruptible);
}

function acquireHeartbeat(run: ObservedWorkflow) {
  const { state, abort } = run;
  return Effect.acquireRelease(
    attempt(() =>
      setInterval(() => {
        if (!state.acceptingEvents || state.heartbeatFailure) return;
        Effect.runSync(
          attempt(() => updateRun(run)).pipe(
            Effect.catch((failure) => {
              state.heartbeatFailure ??= failure;
              return bestEffort(() => abort.controller.abort());
            }),
          ),
        );
      }, 1000),
    ),
    (timer) => bestEffort(() => clearInterval(timer)),
  );
}

function workflowResult(run: ObservedWorkflow, result: Awaited<ReturnType<typeof runWorkflow>>) {
  const { state, activeJournal, effectiveMaxAgents, displayName, runId, scriptPath, sourceLabel } =
    run;
  const agentsUsed = result.agentsUsed ?? activeJournal.agentsUsed;
  const cachedNote = result.cachedCount ? ` (${result.cachedCount} cached from resume)` : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Workflow ${displayName} completed: ${result.agentCount} agent call(s), lifetime slots ${agentsUsed}/${result.maxAgents ?? effectiveMaxAgents}${cachedNote}, ` +
          `~${result.spentTokens} output tokens, ${Math.round(result.durationMs)}ms.\n` +
          `runId: ${runId}  (script: ${scriptPath})\n\n` +
          `Result:\n${safeJson(result.result)}`,
      },
    ],
    details: {
      ...structuredClone(state.snapshot),
      runId,
      scriptPath,
      source: sourceLabel,
      maxAgents: result.maxAgents ?? effectiveMaxAgents,
    },
  };
}

function completeRun(run: ObservedWorkflow, result: Awaited<ReturnType<typeof runWorkflow>>) {
  const {
    state,
    abort,
    activeJournal,
    effectiveMaxAgents,
    handle,
    ctx,
    displayName,
    deps: { registry },
  } = run;
  return attempt(() => {
    if (state.heartbeatFailure) throw state.heartbeatFailure.cause;
    if (abort.requested || abort.controller.signal.aborted) {
      throw new Error("Workflow execution ended after cancellation");
    }
    // This terminal record is the publication point for success.
    activeJournal.recordResult({
      ok: true,
      result: result.result,
      agentCount: result.agentCount,
      durationMs: result.durationMs,
    });
    state.acceptingEvents = false;
    for (const agent of state.snapshot.agents) clearAgentTransient(agent);
    state.snapshot.result = result.result;
    state.snapshot.spentTokens = result.spentTokens;
    state.snapshot.newTokens = result.newTokens ?? 0;
    state.snapshot.replayedTokens = result.replayedTokens ?? 0;
    state.snapshot.maxAgents = result.maxAgents ?? effectiveMaxAgents;
    state.snapshot.agentsUsed = result.agentsUsed ?? activeJournal.agentsUsed;
    state.snapshot.durationMs = result.durationMs;
    state.snapshot.status = "completed";
    state.snapshot = recompute(state.snapshot);
    handle.snapshot = state.snapshot;
  }).pipe(
    Effect.andThen(bestEffort(() => registry.notify())),
    Effect.andThen(bestEffort(() => emitRunUpdate(run))),
    Effect.andThen(
      bestEffort(() =>
        ctx.ui?.notify(
          `Workflow ${displayName} completed: ${result.agentsUsed ?? activeJournal.agentsUsed}/${result.maxAgents ?? effectiveMaxAgents} lifetime agent slot(s), ~${result.spentTokens} output tokens.`,
          "info",
        ),
      ),
    ),
    Effect.andThen(attempt(() => workflowResult(run, result))),
  );
}

function finishFailedAgent(
  runDetails: WorkflowRunDetails,
  agent: WorkflowSnapshot["agents"][number],
  aborted: boolean,
) {
  const finish =
    agent.status === "running"
      ? bestEffort(() => {
          agent.status = aborted ? "cancelled" : "error";
          agent.error ??= aborted ? "cancelled" : "workflow failed";
          const summary = runDetails.finishTask(agent.id, {
            status: aborted ? "cancelled" : "error",
            error: agent.error,
          });
          if (summary) applyTaskSummary(agent, summary);
        })
      : Effect.void;
  return finish.pipe(Effect.andThen(bestEffort(() => clearAgentTransient(agent))));
}

function failRun(run: ObservedWorkflow, error: HostFailure) {
  const {
    state,
    abort,
    activeJournal,
    handle,
    ctx,
    displayName,
    runId,
    workflowStartedAt,
    deps: { registry },
  } = run;
  return Effect.suspend(() => {
    const failure = (state.heartbeatFailure ?? error).cause;
    const aborted = abort.requested;
    const errorText = statusText(failure);
    state.acceptingEvents = false;
    return bestEffort(() => abort.controller.abort()).pipe(
      Effect.andThen(
        Effect.forEach(
          state.snapshot.agents,
          (agent) => finishFailedAgent(run.runDetails, agent, aborted),
          { discard: true },
        ),
      ),
      Effect.andThen(
        bestEffort(() => {
          state.snapshot.status = aborted ? "aborted" : "failed";
          state.snapshot.durationMs = Math.max(0, Date.now() - workflowStartedAt);
          const totals = representedUsage(state.snapshot);
          state.snapshot.newTokens = totals.newTokens;
          state.snapshot.replayedTokens = totals.replayedTokens;
          state.snapshot.spentTokens = totals.outputTokens;
          state.snapshot = recompute(state.snapshot);
          handle.snapshot = state.snapshot;
        }),
      ),
      Effect.andThen(bestEffort(() => registry.notify())),
      // Secondary persistence, observer and cleanup errors cannot
      // replace the original rejection (including non-Error values).
      Effect.andThen(
        bestEffort(() =>
          activeJournal.recordResult({
            ok: false,
            error: errorText,
            agentCount: state.snapshot.agentCount,
            durationMs: state.snapshot.durationMs ?? 0,
          }),
        ),
      ),
      Effect.andThen(bestEffort(() => emitRunUpdate(run))),
      Effect.andThen(
        bestEffort(() =>
          ctx.ui?.notify(
            `Workflow ${displayName} ${aborted ? "was aborted" : "failed"}${aborted ? "" : `: ${errorText}`}`,
            aborted ? "warning" : "error",
          ),
        ),
      ),
      Effect.andThen(
        Effect.fail(
          hostFailure(
            aborted
              ? new Error(`Workflow ${displayName} was aborted (runId: ${runId})`, {
                  cause: failure,
                })
              : new Error(`Workflow ${displayName} failed: ${errorText}`, {
                  cause: failure,
                }),
          ),
        ),
      ),
    );
  });
}

function runObservedWorkflow(run: ObservedWorkflow) {
  return acquireHeartbeat(run).pipe(
    // LIFO: close events, heartbeat, details, journal, lease, abort listener.
    Effect.andThen(
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          run.state.acceptingEvents = false;
        }),
      ),
    ),
    Effect.andThen(executeRun(run)),
    Effect.flatMap((result) => completeRun(run, result)),
    Effect.catch((error) => failRun(run, error)),
  );
}

function executeWorkflow(...args: Parameters<WorkflowExecute>) {
  return WorkflowHost.pipe(
    Effect.map((deps) => createHostInput(deps, args)),
    Effect.flatMap((input) =>
      acquireAbortListener(input).pipe(
        Effect.andThen(checkHostAbort(input)),
        Effect.andThen(attempt(() => prepareWorkflow(input))),
      ),
    ),
    Effect.flatMap(acquireRun),
    Effect.flatMap(acquireRunObserver),
    Effect.flatMap(runObservedWorkflow),
  );
}

export function createWorkflowTool(
  deps: WorkflowToolDeps = {},
): ToolDefinition<typeof workflowToolSchema, any> {
  const registry = deps.registry ?? new WorkflowRegistry();
  // Status updates rerender the call; format each completed display source only once.
  let formattedSource: { input: string; output: string } | undefined;
  return defineTool({
    renderShell: "self",
    name: "workflow",
    exposure: "model-only",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_GUIDELINES,
    parameters: workflowToolSchema,
    execute(...args) {
      return Effect.runPromise(
        executeWorkflow(...args).pipe(
          Effect.scoped,
          Effect.provideService(WorkflowHost, { ...deps, registry }),
          Effect.mapError((failure) => failure.cause),
        ),
      );
    },
    renderCall(args, theme, { argsComplete }) {
      const title = theme.fg("toolTitle", theme.bold("workflow"));
      if (typeof args.script === "string" && args.script.length > 0) {
        let source = safeTranscriptText(args.script, DISPLAY_INPUT_LIMIT);
        // Never format an incomplete stream or change the script used for execution.
        if (argsComplete) {
          if (formattedSource?.input !== source) {
            // A malformed or truncated display source can still be shown verbatim.
            const output = Result.try(() =>
              beautify.js(source, {
                indent_size: 2,
                preserve_newlines: true,
                wrap_line_length: 100,
              }),
            ).pipe(Result.getOrElse(() => source));
            formattedSource = {
              input: source,
              output: safeTranscriptText(output, DISPLAY_INPUT_LIMIT),
            };
          }
          source = formattedSource.output;
        }
        const call = new Container();
        call.addChild(new Text(title, 0, 0));
        call.addChild(new Spacer(1));
        call.addChild(
          workflowSection(
            "Script · JavaScript",
            highlightCode(source, "javascript").join("\n"),
            theme,
            "toolPendingBg",
          ),
        );
        return call;
      }
      const source = args.scriptPath || args.name;
      return new Text(
        source ? `${title} ${theme.fg("muted", safeDisplayText(source, 240))}` : title,
        0,
        0,
      );
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      const output = new Container();
      output.addChild(new Spacer(1));
      // Pi owns the pending/success/error background of the surrounding tool by
      // default. With self framing, keep these states on the result panel only.
      const background = isPartial
        ? "toolPendingBg"
        : context.isError || snapshot?.status === "failed" || snapshot?.status === "aborted"
          ? "toolErrorBg"
          : "toolSuccessBg";
      if (snapshot?.name) {
        output.addChild(
          workflowSection(
            "Status",
            renderWorkflowText(snapshot, {
              maxAgentRows: expanded ? Number.MAX_SAFE_INTEGER : undefined,
              maxLogs: expanded ? 12 : undefined,
              showResultPreviews: expanded && !isPartial,
            }),
            theme,
            background,
          ),
        );
      } else {
        const text = result.content?.[0];
        output.addChild(
          workflowSection(
            "Result",
            text?.type === "text" ? text.text : "workflow",
            theme,
            background,
          ),
        );
      }
      return output;
    },
  });
}

function workflowSection(
  heading: string,
  content: string,
  theme: Theme,
  background: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg",
): Box {
  const panel = new Box(1, 1, (text) => theme.bg(background, text));
  panel.addChild(new Text(theme.fg("toolTitle", theme.bold(heading)), 0, 0));
  panel.addChild(new Spacer(1));
  panel.addChild(new Text(content, 0, 0));
  return panel;
}

function resolveScript(
  params: { script?: string; scriptPath?: string; name?: string },
  cwd: string,
  projectTrusted: boolean,
): { script: string; sourceLabel: string } {
  if (params.script && params.script.trim()) {
    return { script: normalizeScript(params.script), sourceLabel: "inline" };
  }
  if (params.scriptPath) {
    const full = path.isAbsolute(params.scriptPath)
      ? params.scriptPath
      : path.join(cwd, params.scriptPath);
    return {
      script: readArtifactFile(full, "workflow script", 16 * 1024 * 1024),
      sourceLabel: `scriptPath:${params.scriptPath}`,
    };
  }
  if (params.name) {
    requireSafeWorkflowName(params.name);
    const saved = readSavedWorkflowByName(params.name, cwd, projectTrusted);
    if (saved) {
      return {
        script: saved.script,
        sourceLabel: `name:${params.name}:${saved.scope}`,
      };
    }
    throw new Error(`workflow: no accessible saved workflow named "${params.name}" was found`);
  }
  throw new Error("workflow requires one of: `script`, `scriptPath`, or `name`.");
}

export function workflowRunsDir(ctx: {
  sessionManager?: { getSessionDir?: () => string; getSessionId?: () => string };
  cwd: string;
}): string {
  let sessionDir: string | undefined;
  let sessionId: string | undefined;
  Effect.runSync(
    bestEffort(() => {
      sessionDir = ctx.sessionManager?.getSessionDir?.();
      sessionId = ctx.sessionManager?.getSessionId?.();
    }),
  );
  const base = sessionDir
    ? path.join(sessionDir, "ultracode-runs")
    : standaloneWorkflowRunsDir(ctx.cwd);
  if (!sessionId) return base;
  const scope = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return path.join(base, `session-${scope}`);
}

function safeJson(value: unknown): string {
  return Result.try(() => JSON.stringify(value, null, 2) ?? String(value)).pipe(
    Result.getOrElse(() => String(value)),
  );
}

function requireSafeWorkflowName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error("workflow name must contain only letters, numbers, underscore, or hyphen");
  }
  return value;
}

function requireSafeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(
      "workflow: resumeFromRunId must contain only letters, numbers, dot, underscore, or hyphen",
    );
  }
  return value;
}

function statusText(value: unknown): string {
  // Diagnostic formatting must preserve even an unprintable original cause.
  return Result.try(() => {
    const text = value instanceof Error ? value.message : String(value);
    return safeDisplayText(text, 160) || "unknown error";
  }).pipe(Result.getOrElse(() => "unknown error"));
}

function representedUsage(snapshot: WorkflowSnapshot): {
  newTokens: number;
  replayedTokens: number;
  outputTokens: number;
} {
  let newTokens = 0;
  let replayedTokens = 0;
  let outputTokens = 0;
  for (const agent of snapshot.agents) {
    const tokens = agent.legacyCache ? 0 : (agent.usage?.totalTokens ?? 0);
    outputTokens += agent.usage?.outputTokens ?? 0;
    if (agent.status === "cached") replayedTokens += tokens;
    else newTokens += tokens;
  }
  return { newTokens, replayedTokens, outputTokens };
}

function cachedRecordSummary(record: JournalAgentRecord): Partial<WorkflowTaskSummary> {
  return {
    id: record.seq,
    callPath: record.callPath,
    label: record.label,
    status: "cached",
    promptPreview: "",
    workflowPath: [],
    requestedModelId: record.requestedModelId,
    requestedEffort: record.requestedEffort,
    modelId: record.modelId,
    effort: record.effort,
    agentType: record.agentType,
    isolation: record.isolation,
    structuredOutput: record.structuredOutput,
    usage: normalizeTaskUsage({ ...record, totalTokens: record.totalTokens ?? 0 }),
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    endedAt:
      record.startedAt != null && record.durationMs != null
        ? record.startedAt + record.durationMs
        : undefined,
    resultPreview: preview(record.value),
    cached: true,
    legacyCache:
      !record.modelId ||
      !record.effort ||
      record.inputTokens == null ||
      record.totalTokens == null ||
      record.cacheReadTokens == null ||
      record.cacheWriteTokens == null ||
      record.turns == null ||
      record.toolUses == null,
    transcriptPath: record.transcriptPath,
  };
}

function applyTaskSummary(
  agent: WorkflowSnapshot["agents"][number],
  summary: WorkflowTaskSummary,
): void {
  agent.status = summary.status;
  agent.workflowPath = [...summary.workflowPath];
  agent.requestedModelId = summary.requestedModelId;
  agent.requestedEffort = summary.requestedEffort;
  agent.modelId = summary.modelId;
  agent.effort = summary.effort;
  agent.agentType = summary.agentType;
  agent.isolation = summary.isolation;
  agent.structuredOutput = summary.structuredOutput;
  agent.usage = { ...summary.usage };
  agent.currentTurn = summary.currentTurn;
  agent.legacyCache = summary.legacyCache;
  agent.transcriptPath = summary.transcriptPath;
  agent.startedAt = summary.startedAt ?? agent.startedAt;
  agent.endedAt = summary.endedAt ?? agent.endedAt;
  agent.durationMs = summary.durationMs ?? agent.durationMs;
  agent.error = summary.error ?? agent.error;
}

function clearAgentTransient(agent: WorkflowSnapshot["agents"][number]): void {
  agent.activeTools = undefined;
  agent.streamTail = undefined;
}

function activityLabel(kind: string, detail: string | undefined): string {
  if (kind === "text") return "responding";
  if (kind === "thinking") return "thinking";
  return detail?.trim() || kind;
}
