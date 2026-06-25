/**
 * Live progress snapshots for a running workflow, plus compact text renderers used
 * for streamed tool updates and the final tool result.
 */

import type { WorkflowMeta } from "./parser.ts";

export type WorkflowAgentStatus = "running" | "done" | "error" | "skipped" | "cached";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
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
}

export function createSnapshot(meta: WorkflowMeta, runId: string, budgetTotal: number | null): WorkflowSnapshot {
  return {
    runId,
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((p) => p.title) ?? [],
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
  const header = `◆ ${statusMark(snapshot.status)} ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})${cached}${tokens}`;
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
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}`,
    );
    for (const agent of agents.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
    if (agents.length > maxAgents) lines.push(`    … ${agents.length - maxAgents} earlier agents`);
  }

  const unphased = snapshot.agents.filter((a) => !rendered.has(a));
  if (unphased.length) {
    lines.push("  (unphased)");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`);
    }
  }

  for (const log of snapshot.logs.slice(-maxLogs)) lines.push(`  log: ${shorten(log, 100)}`);
  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, options: RenderOptions = {}): string {
  return renderWorkflowLines(snapshot, options).join("\n");
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : safeJson(value);
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
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
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
