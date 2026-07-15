/**
 * Live progress snapshots for a running workflow, plus compact text renderers used
 * for streamed tool updates and the final tool result.
 */

import { safeDisplayText } from "./display-text.ts";
import type { WorkflowMeta } from "./parser.ts";

export type WorkflowAgentStatus = "running" | "done" | "error" | "skipped" | "cached";

export interface WorkflowActiveToolSnapshot {
  id: string;
  name: string;
  args?: string;
  startedAt: number;
  lastUpdateAt: number;
}

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  /** Wall-clock ms when the agent started (host layer; set by the tool). */
  startedAt?: number;
  /** Wall-clock ms when the agent finished. */
  endedAt?: number;
  /** Runtime duration in ms (endedAt - startedAt). */
  durationMs?: number;
  /** Wall-clock ms of the last observed session event inside the subagent. */
  lastActivityAt?: number;
  /** Last known factual state, e.g. "waiting for model" or "retry 2/3". */
  activity?: string;
  /** Tool calls that have started but have not emitted tool_execution_end. */
  activeTools?: WorkflowActiveToolSnapshot[];
  /** @deprecated Raw assistant stream text is never captured or rendered. */
  streamTail?: string;
}

export interface WorkflowSnapshot {
  runId?: string;
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  cachedCount: number;
  spentTokens: number;
  budgetTotal: number | null;
  durationMs?: number;
  result?: unknown;
  status: "running" | "completed" | "aborted" | "failed";
}

export interface RenderOptions {
  maxAgents?: number;
  maxLogs?: number;
  showResultPreviews?: boolean;
  /** @deprecated No-op retained for source compatibility. */
  showStream?: boolean;
  /** Override `Date.now()` for deterministic elapsed/activity rendering in tests. */
  now?: number;
}

export function createSnapshot(meta: WorkflowMeta, runId: string, budgetTotal: number | null): WorkflowSnapshot {
  return {
    runId,
    name: safeDisplayText(meta.name, 120) || "workflow",
    description: meta.description ? safeDisplayText(meta.description, 240) : undefined,
    phases: meta.phases?.map((p) => safeDisplayText(p.title, 120)).filter(Boolean) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    cachedCount: 0,
    spentTokens: 0,
    budgetTotal,
    status: "running",
  };
}

export function recompute(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((a) => a.status === "running").length;
  const doneCount = snapshot.agents.filter((a) => a.status === "done" || a.status === "cached").length;
  const errorCount = snapshot.agents.filter((a) => a.status === "error").length;
  const cachedCount = snapshot.agents.filter((a) => a.status === "cached").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount, cachedCount };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: RenderOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 6;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const now = options.now ?? Date.now();

  const tokens = snapshot.spentTokens
    ? ` · ${formatTokens(snapshot.spentTokens)}${snapshot.budgetTotal ? `/${formatTokens(snapshot.budgetTotal)}` : ""} tok`
    : "";
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  const cached = snapshot.cachedCount ? ` · ${snapshot.cachedCount} cached` : "";
  const header = `◆ ${statusMark(snapshot.status)} ${shorten(snapshot.name, 60)} (${snapshot.doneCount}/${snapshot.agentCount} done${state})${cached}${tokens}`;
  const lines = [header];

  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...snapshot.agents.map((a) => a.phase).filter((p): p is string => Boolean(p)),
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((a) => a.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const a of agents) rendered.add(a);
    const done = agents.filter((a) => a.status === "done" || a.status === "cached").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const complete = agents.length > 0 && done + errors === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${shorten(phase, 60)} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}`,
    );
    for (const agent of agents.slice(-maxAgents)) {
      lines.push(renderAgentLine(agent, { showResultPreviews, now }));
    }
    if (agents.length > maxAgents) lines.push(`    … ${agents.length - maxAgents} earlier agents`);
  }

  const unphased = snapshot.agents.filter((a) => !rendered.has(a));
  if (unphased.length) {
    lines.push("  (unphased)");
    for (const agent of unphased.slice(-maxAgents)) {
      lines.push(renderAgentLine(agent, { showResultPreviews, now }));
    }
  }

  for (const log of snapshot.logs.slice(-maxLogs)) lines.push(`  log: ${shorten(log, 100)}`);
  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, options: RenderOptions = {}): string {
  return renderWorkflowLines(snapshot, options).join("\n");
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : boundedProjection(value, max);
  return text ? safeDisplayText(text, max) : "";
}

function statusMark(status: WorkflowSnapshot["status"]): string {
  switch (status) {
    case "completed":
      return "✓";
    case "aborted":
      return "■";
    case "failed":
      return "✗";
    default:
      return "▶";
  }
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "running":
      return "●";
    case "done":
      return "✓";
    case "cached":
      return "⟲";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  return safeDisplayText(value, max);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const PREVIEW_MAX_STRING = 256;
const UNINSPECTABLE_PREVIEW = "[Uninspectable]";

/**
 * Build a UI-only projection without invoking arbitrary object hooks. Objects
 * and arrays intentionally remain opaque: JavaScript has no bounded own-key
 * enumeration API, and Proxy/accessor traps must never affect agent success.
 */
function boundedProjection(value: unknown, _max: number): string {
  try {
    if (value === null) return "null";
    if (typeof value === "string") {
      const bounded = value.length > PREVIEW_MAX_STRING
        ? `${value.slice(0, PREVIEW_MAX_STRING)}…`
        : value;
      return JSON.stringify(bounded);
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") {
      return String(value);
    }
    if (typeof value === "bigint") return "[BigInt]";
    if (typeof value === "symbol") return "[Symbol]";
    if (typeof value === "function") return "[Function]";
    return Array.isArray(value) ? "[Array]" : "[Object]";
  } catch {
    return UNINSPECTABLE_PREVIEW;
  }
}

/** Seconds without an observable session event before visibility escalates. */
export const IDLE_THRESHOLD_S = 30;

function renderAgentLine(
  agent: WorkflowAgentSnapshot,
  opts: {
    showResultPreviews: boolean;
    now: number;
  },
): string {
  const meta = agentMeta(agent, opts.now);
  const result = opts.showResultPreviews && agent.resultPreview
    ? ` — ${safeDisplayText(agent.resultPreview, 80)}`
    : "";
  return `    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${meta}${result}`;
}

/** Compact per-agent timing/activity suffix for the live snapshot. */
function agentMeta(agent: WorkflowAgentSnapshot, now: number): string {
  if (agent.status === "running") {
    const startedAt = agent.startedAt ?? now;
    const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
    const lastAct = agent.lastActivityAt ?? startedAt;
    const silence = Math.max(0, Math.floor((now - lastAct) / 1000));
    const activeTools = agent.activeTools ?? [];

    if (activeTools.length > 0) {
      const tool = visibleTool(activeTools);
      const toolDuration = formatDuration(Math.max(0, now - tool.startedAt));
      const toolName = shorten(tool.name, 30) || "tool";
      const args = tool.args ? `: ${shorten(tool.args, 60)}` : "";
      const others = activeTools.length > 1 ? ` +${activeTools.length - 1} more` : "";
      const noToolEvents = Math.max(0, Math.floor((now - tool.lastUpdateAt) / 1000));
      const warning = noToolEvents >= IDLE_THRESHOLD_S ? ` · ⚠ no tool events ${noToolEvents}s` : "";
      return ` · ${elapsed}s · running ${toolName}${args} (${toolDuration})${others}${warning}`;
    }

    if (silence >= IDLE_THRESHOLD_S) {
      const last = agent.activity ? ` · last: ${shorten(agent.activity, 64)}` : "";
      return ` · ${elapsed}s · ⚠ no events ${silence}s${last}`;
    }
    const activity = agent.activity ? ` · ${shorten(agent.activity, 64)}` : "";
    return ` · ${elapsed}s${activity}`;
  }
  if (agent.durationMs != null && agent.durationMs > 0) return ` · ${formatDuration(agent.durationMs)}`;
  return "";
}

function visibleTool(tools: WorkflowActiveToolSnapshot[]): WorkflowActiveToolSnapshot {
  return tools.reduce((stalest, tool) => tool.lastUpdateAt < stalest.lastUpdateAt ? tool : stalest);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) return "<1s";
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}
