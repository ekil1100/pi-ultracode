/**
 * The `workflow` tool: parses a workflow script, persists it, runs it through the
 * deterministic runtime with live progress, supports resume, and returns the
 * structured result to the parent assistant.
 */

import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  WORKFLOW_GUIDELINES,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
} from "../prompts.ts";
import { redactCommand, safeDisplayText } from "./display-text.ts";
import { parseWorkflowScript, normalizeScript } from "./parser.ts";
import {
  ABSOLUTE_MAX_AGENTS,
  DEFAULT_MAX_AGENTS,
  MAX_WORKFLOW_LOGS,
  WORKFLOW_LOG_OMITTED_TEXT,
  runWorkflow,
} from "./runtime.ts";
import type { ModelRuntimeLike, ThinkingLevel } from "./agent-runner.ts";
import { RunJournal, hashString, type JournalAgentRecord } from "./journal.ts";
import { getRegistry } from "./registry.ts";
import { normalizeMaxAgents } from "./admission.ts";
import { acquireWorkflowLease, type WorkflowLease } from "./leases.ts";
import {
  artifactPathExists,
  assertRegularArtifactFile,
  ensurePrivateArtifactDirectory,
  readArtifactFile,
  readContainedArtifactFile,
  standaloneWorkflowRunsDir,
  writeArtifactFile,
} from "./run-artifacts.ts";
import { assertWorkflowArgsLimit } from "./value-limits.ts";
import {
  WorkflowRunDetails,
  normalizeTaskUsage,
  type WorkflowTaskSummary,
} from "./run-details.ts";
import {
  createSnapshot,
  preview,
  recompute,
  renderWorkflowText,
  type WorkflowSnapshot,
} from "./display.ts";

const workflowToolSchema = Type.Object({
  script: Type.Optional(
    Type.String({
      description:
        "Inline raw JavaScript workflow script (no Markdown fences). The source must begin with export const meta = { name: 'snake_case', description: '...' }. Should call agent() at least once for useful orchestration. Required unless `name` or `scriptPath` is given.",
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({ description: "Path to a workflow script file to run instead of an inline `script`." }),
  ),
  name: Type.Optional(
    Type.String({ description: "Name of a saved workflow (under .pi/ultracode/workflows/) to run." }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed to the workflow script as the global `args`." }),
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
      description:
        `Lifetime live-agent admission cap for this run across resumes. Defaults to ${DEFAULT_MAX_AGENTS}; absolute range is 1..${ABSOLUTE_MAX_AGENTS}. Cache replay is free. This is not a token budget.`,
    }),
  ),
}, { additionalProperties: false });

export interface WorkflowToolDeps {
  /** Canonical runtime supplied by an SDK host; shared by all child sessions. */
  modelRuntime?: ModelRuntimeLike;
  /** The ultracode effort level to forward to every workflow subagent as its
   *  default thinking level (`max` when ultracode is on, so each subagent's own
   *  session clamps it independently; undefined when off). A per-call
   *  `model: "X:level"` suffix or agentType `thinking:` override still wins. */
  getThinkingLevel?: () => ThinkingLevel | undefined;
  /** Optional execution gate for mode-scoped registrations. Omit for standalone use. */
  isExecutionAllowed?: () => boolean;
  /** Test seam: inject a subagent runner so the tool path can run without a model. */
  testRunner?: { run: (call: any) => Promise<any> };
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

export function createWorkflowTool(deps: WorkflowToolDeps = {}): ToolDefinition<typeof workflowToolSchema, any> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_GUIDELINES,
    parameters: workflowToolSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (deps.isExecutionAllowed?.() === false) {
        throw new Error("The workflow tool is disabled. Run /ultracode on before using it.");
      }
      const controller = new AbortController();
      let abortRequested = false;
      const requestAbort = () => {
        abortRequested = true;
        controller.abort();
      };
      const onOuterAbort = () => requestAbort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      try {
        if (signal?.aborted || controller.signal.aborted) throw new Error("Workflow was aborted before it started");

      const cwd = ctx.cwd;
      assertWorkflowArgsLimit(params.args);
      const requestedMaxAgents = params.maxAgents === undefined ? undefined : normalizeMaxAgents(params.maxAgents);
      const resolvedScript = resolveScript(params, cwd);
      const script = normalizeScript(resolvedScript.script);
      const sourceLabel = resolvedScript.sourceLabel;
      const parsed = parseWorkflowScript(script);
      const displayName = safeDisplayText(parsed.meta.name, 60) || "workflow";

      const runsDir = workflowRunsDir(ctx);
      const requestedRunId = params.resumeFromRunId?.trim();
      const runId = requestedRunId ? requireSafeRunId(requestedRunId) : nextRunId();
      const resuming = Boolean(requestedRunId);
      if (resuming && !RunJournal.exists(runsDir, runId)) {
        throw new Error(`workflow: resumeFromRunId ${runId} was not found in this session`);
      }
      // Forward the raw `max` request so each subagent session clamps it against
      // that subagent's model. Undefined when ultracode is off.
      const thinkingLevel = deps.getThinkingLevel?.();
      if (controller.signal.aborted) throw new Error("Workflow was aborted before it started");
      const run = deps.runWorkflowFn ?? runWorkflow;
      const workflowStartedAt = Date.now();
      let lease: WorkflowLease | undefined;
      let journal: RunJournal | undefined;
      let toolSucceeded = false;
      lease = acquireWorkflowLease(runsDir, runId);
      try {

      // Persist new scripts next to the session. Resume artifacts are immutable:
      // validate the existing file now and compare its content below.
      const scriptPath = path.join(runsDir, `${runId}.workflow.js`);
      ensurePrivateArtifactDirectory(runsDir);
      if (resuming) {
        assertRegularArtifactFile(scriptPath, "workflow resume script");
        const persistedScript = readArtifactFile(scriptPath, "workflow resume script");
        if (persistedScript !== script) {
          throw new Error(`workflow ${runId} has an immutable script; start a new run for changed source`);
        }
      } else {
        writeArtifactFile(scriptPath, script, { trustedRoot: runsDir });
      }

      // Journal (create new, or resume an existing run id).
      const journalMeta = {
        type: "run" as const,
        runId,
        name: parsed.meta.name,
        scriptHash: hashString(script),
        args: params.args,
        startedAt: Date.now(),
        maxAgents: requestedMaxAgents,
      };
      journal = resuming
        ? RunJournal.resume(runsDir, runId, journalMeta)
        : RunJournal.create(runsDir, journalMeta);
      const activeJournal = journal;
      const effectiveMaxAgents = activeJournal.effectiveMaxAgents;

      // Snapshot + registry + abort plumbing.
      let snapshot = createSnapshot(parsed.meta, runId);
      snapshot.maxAgents = effectiveMaxAgents;
      snapshot.agentsUsed = activeJournal.agentsUsed;
      const detailsPath = path.join(runsDir, `${runId}.details.json`);
      if (resuming && artifactPathExists(detailsPath)) {
        assertRegularArtifactFile(detailsPath, "workflow details manifest");
      }
      const restoredDetails = resuming
        ? WorkflowRunDetails.restore(detailsPath)?.details
        : undefined;
      const runDetails = restoredDetails ?? new WorkflowRunDetails({
        runId,
        name: parsed.meta.name,
        runsDir,
      });
      if (resuming) runDetails.beginGeneration();
      snapshot.detailsManifestPath = runDetails.manifestPath;
      if (controller.signal.aborted) throw new Error("Workflow was aborted before it started");
      const registry = getRegistry();
      registry.setScope(runsDir);
      const handle = registry.register(runId, snapshot, requestAbort, runDetails);
      let updateObserverEnabled = true;
      const emitUpdate = () => {
        if (!onUpdate || !updateObserverEnabled) return;
        try {
          onUpdate({ content: [{ type: "text", text: renderWorkflowText(snapshot) }], details: snapshot });
        } catch (error) {
          updateObserverEnabled = false;
          throw error;
        }
      };

      const update = () => {
        const totals = representedUsage(snapshot);
        snapshot.newTokens = totals.newTokens;
        snapshot.replayedTokens = totals.replayedTokens;
        snapshot.spentTokens = totals.outputTokens;
        snapshot = recompute(snapshot);
        handle.snapshot = snapshot;
        registry.notify();
        emitUpdate();
      };

      // Throttle state for activity-driven re-renders. Agent fields below are
      // mutated on every activity tick; only the TUI re-render is throttled, so
      // `/workflows <runId>` still reads fully-live fields between renders.
      let lastActivityRenderMs = 0;
      let acceptingEvents = true;

      const recordPhase = (title?: string): string | undefined => {
        if (!title) return undefined;
        const safe = safeDisplayText(title, 120);
        if (safe && !snapshot.phases.includes(safe)) snapshot.phases.push(safe);
        return safe || undefined;
      };

      // Heartbeat: keep elapsed/no-event markers live in the compact panel even
      // when a subagent emits no events. Detached timer callbacks must never throw
      // past the tool lifecycle; convert observer failures into a controlled run
      // failure and let the runtime finish abort/drain cleanup before releasing the lease.
      let heartbeatFailed = false;
      let heartbeatError: unknown;
      const heartbeat = setInterval(() => {
        try {
          update();
        } catch (error) {
          if (!heartbeatFailed) {
            heartbeatFailed = true;
            heartbeatError = error;
          }
          clearInterval(heartbeat);
          controller.abort();
        }
      }, 1000);

      try {
        const result = await run(script, {
          cwd,
          args: params.args,
          signal: controller.signal,
          thinkingLevel,
          modelRegistry: ctx.modelRegistry as any,
          modelRuntime: deps.modelRuntime,
          model: ctx.model as any,
          runner: deps.testRunner,
          journal: activeJournal,
          maxAgents: effectiveMaxAgents,
          cleanupTimeoutMs: deps.cleanupTimeoutMs,
          onLog(message) {
            if (!acceptingEvents || snapshot.logs.length > MAX_WORKFLOW_LOGS) return;
            const safe = safeDisplayText(message, 512);
            if (!safe) return;
            snapshot.logs.push(
              snapshot.logs.length === MAX_WORKFLOW_LOGS
                ? WORKFLOW_LOG_OMITTED_TEXT
                : safe,
            );
            update();
          },
          onPhase(title) {
            if (!acceptingEvents) return;
            snapshot.currentPhase = recordPhase(title);
            update();
          },
          onAgentStart(event) {
            if (!acceptingEvents) return;
            snapshot.agentsUsed = activeJournal.agentsUsed;
            const phase = recordPhase(event.phase);
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
            snapshot.agents.push(agent);
            update();
            runDetails.persist(snapshot);
          },
          onAgentEnd(event) {
            if (!acceptingEvents) return;
            const agent = snapshot.agents.find((a) => a.id === event.id);
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
              if (event.status === "error") agent.error = event.error ? statusText(event.error) : preview(event.result);
              const endedAt = Date.now();
              agent.endedAt = endedAt;
              clearAgentTransient(agent);
              if (agent.startedAt != null) agent.durationMs = endedAt - agent.startedAt;
              if (summary) applyTaskSummary(agent, summary);
            }
            update();
            runDetails.persist(snapshot);
          },
          onAgentTelemetry(event) {
            if (!acceptingEvents) return;
            const agent = snapshot.agents.find((candidate) => candidate.id === event.id);
            if (!agent || agent.status !== "running") return;
            const summary = runDetails.record(event.id, event);
            if (summary) applyTaskSummary(agent, summary);
            const now = Date.now();
            agent.lastActivityAt = now;
            if (now - lastActivityRenderMs >= ACTIVITY_RENDER_INTERVAL_MS) {
              lastActivityRenderMs = now;
              update();
            }
          },
          onAgentActivity(event) {
            if (!acceptingEvents) return;
            const agent = snapshot.agents.find((a) => a.id === event.id);
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

            if (now - lastActivityRenderMs >= ACTIVITY_RENDER_INTERVAL_MS) {
              lastActivityRenderMs = now;
              update();
            }
          },
        });

        // The runtime normally rejects after cancellation, but success must not
        // win a race with a detached heartbeat failure or a user/registry abort.
        if (heartbeatFailed) throw heartbeatError;
        if (abortRequested || controller.signal.aborted) throw new Error("Workflow execution ended after cancellation");

        acceptingEvents = false;
        for (const agent of snapshot.agents) clearAgentTransient(agent);
        snapshot.result = result.result;
        snapshot.spentTokens = result.spentTokens;
        snapshot.newTokens = result.newTokens ?? 0;
        snapshot.replayedTokens = result.replayedTokens ?? 0;
        snapshot.maxAgents = result.maxAgents ?? effectiveMaxAgents;
        snapshot.agentsUsed = result.agentsUsed ?? activeJournal.agentsUsed;
        snapshot.durationMs = result.durationMs;
        snapshot.status = "completed";
        snapshot = recompute(snapshot);
        handle.snapshot = snapshot;
        try {
          runDetails.close(snapshot);
        } catch {
          // best-effort manifest close
        }
        registry.notify();
        journal?.recordResult({
          ok: true,
          result: result.result,
          agentCount: result.agentCount,
          durationMs: result.durationMs,
        });
        emitUpdate();

        const agentsUsed = result.agentsUsed ?? activeJournal.agentsUsed;
        ctx.ui?.notify(
          `Workflow ${displayName} completed: ${agentsUsed}/${result.maxAgents ?? effectiveMaxAgents} lifetime agent slot(s), ~${result.spentTokens} output tokens.`,
          "info",
        );

        const cachedNote = result.cachedCount ? ` (${result.cachedCount} cached from resume)` : "";
        toolSucceeded = true;
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow ${displayName} completed: ${result.agentCount} agent call(s), lifetime slots ${agentsUsed}/${result.maxAgents ?? effectiveMaxAgents}${cachedNote}, ` +
                `~${result.spentTokens} output tokens, ${Math.round(result.durationMs)}ms.\n` +
                `runId: ${runId}  (script: ${scriptPath})\n\n` +
                `Result:\n${safeJson(result.result)}`,
            },
          ],
          details: { ...snapshot, runId, scriptPath, source: sourceLabel, maxAgents: result.maxAgents ?? effectiveMaxAgents },
        };
      } catch (error) {
        const failure = heartbeatFailed ? heartbeatError : error;
        const aborted = abortRequested;
        acceptingEvents = false;
        if (!controller.signal.aborted) controller.abort();
        for (const agent of snapshot.agents) {
          if (agent.status === "running") {
            agent.status = aborted ? "cancelled" : "error";
            agent.error ??= aborted ? "cancelled" : "workflow failed";
            const summary = runDetails.finishTask(agent.id, {
              status: aborted ? "cancelled" : "error",
              error: agent.error,
            });
            if (summary) applyTaskSummary(agent, summary);
          }
          clearAgentTransient(agent);
        }
        snapshot.status = aborted ? "aborted" : "failed";
        snapshot.durationMs = Math.max(0, Date.now() - workflowStartedAt);
        const totals = representedUsage(snapshot);
        snapshot.newTokens = totals.newTokens;
        snapshot.replayedTokens = totals.replayedTokens;
        snapshot.spentTokens = totals.outputTokens;
        snapshot = recompute(snapshot);
        handle.snapshot = snapshot;
        try {
          runDetails.close(snapshot);
        } catch {
          // best-effort manifest close
        }
        registry.notify();
        const errorText = statusText(failure);
        try {
          journal?.recordResult({
            ok: false,
            error: errorText,
            agentCount: snapshot.agentCount,
            durationMs: snapshot.durationMs ?? 0,
          });
        } catch {
          // A poisoned journal must not append after a partial write; preserve
          // the execution failure that brought us into this path.
        }
        emitUpdate();
        ctx.ui?.notify(
          `Workflow ${displayName} ${aborted ? "was aborted" : "failed"}${aborted ? "" : `: ${errorText}`}`,
          aborted ? "warning" : "error",
        );
        if (aborted) {
          throw new Error(`Workflow ${displayName} was aborted (runId: ${runId})`, { cause: failure });
        }
        throw new Error(`Workflow ${displayName} failed: ${errorText}`, { cause: failure });
      } finally {
        acceptingEvents = false;
        try {
          clearInterval(heartbeat);
        } catch {
          // best-effort cleanup
        }
        try {
          runDetails.close(snapshot);
        } catch {
          // best-effort cleanup
        }
      }
      } finally {
        let journalCloseError: unknown;
        try {
          journal?.close();
        } catch (error) {
          journalCloseError = error;
        }
        try {
          lease?.release();
        } catch {
          // best-effort cleanup; active-run leases must never mask the original error
        }
        if (toolSucceeded && journalCloseError) {
          throw new Error(`workflow journal close failed: ${statusText(journalCloseError)}`, { cause: journalCloseError });
        }
      }
      } finally {
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const snapshot = result.details as WorkflowSnapshot | undefined;
      if (snapshot?.name) {
        return new Text(renderWorkflowText(snapshot, {
          maxAgentRows: expanded ? Number.MAX_SAFE_INTEGER : undefined,
          maxLogs: expanded ? 12 : undefined,
          showResultPreviews: expanded && !isPartial,
        }), 0, 0);
      }
      const text = result.content?.[0];
      return new Text(text?.type === "text" ? text.text : theme.fg("muted", "workflow"), 0, 0);
    },
  });
}

function resolveScript(
  params: { script?: string; scriptPath?: string; name?: string },
  cwd: string,
): { script: string; sourceLabel: string } {
  if (params.script && params.script.trim()) {
    return { script: normalizeScript(params.script), sourceLabel: "inline" };
  }
  if (params.scriptPath) {
    const full = path.isAbsolute(params.scriptPath) ? params.scriptPath : path.join(cwd, params.scriptPath);
    return { script: readArtifactFile(full, "workflow script", 16 * 1024 * 1024), sourceLabel: `scriptPath:${params.scriptPath}` };
  }
  if (params.name) {
    requireSafeWorkflowName(params.name);
    const roots = [cwd, os.homedir()];
    for (const root of roots) {
      const dir = path.join(root, ".pi", "ultracode", "workflows");
      for (const candidate of [`${params.name}.workflow.js`, `${params.name}.js`]) {
        const full = path.join(dir, candidate);
        if (artifactPathExists(full)) {
          return {
            script: readContainedArtifactFile(root, full, "saved workflow", 16 * 1024 * 1024),
            sourceLabel: `name:${params.name}`,
          };
        }
      }
    }
    throw new Error(`workflow: no saved workflow named "${params.name}" found under .pi/ultracode/workflows/`);
  }
  throw new Error("workflow requires one of: `script`, `scriptPath`, or `name`.");
}

export function workflowRunsDir(ctx: { sessionManager?: { getSessionDir?: () => string }; cwd: string }): string {
  try {
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    if (sessionDir) return path.join(sessionDir, "ultracode-runs");
  } catch {
    // fall through
  }
  return standaloneWorkflowRunsDir(ctx.cwd);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}


function requireSafeWorkflowName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error("workflow name must contain only letters, numbers, underscore, or hyphen");
  }
  return value;
}

function requireSafeRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("workflow: resumeFromRunId must contain only letters, numbers, dot, underscore, or hyphen");
  }
  return value;
}

function statusText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return safeDisplayText(text, 160) || "unknown error";
}

function representedUsage(snapshot: WorkflowSnapshot): { newTokens: number; replayedTokens: number; outputTokens: number } {
  let newTokens = 0;
  let replayedTokens = 0;
  let outputTokens = 0;
  for (const agent of snapshot.agents) {
    const tokens = agent.legacyCache ? 0 : agent.usage?.totalTokens ?? 0;
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
    endedAt: record.startedAt != null && record.durationMs != null
      ? record.startedAt + record.durationMs
      : undefined,
    resultPreview: preview(record.value),
    cached: true,
    legacyCache: !record.modelId
      || !record.effort
      || record.inputTokens == null
      || record.totalTokens == null
      || record.cacheReadTokens == null
      || record.cacheWriteTokens == null
      || record.turns == null
      || record.toolUses == null,
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
