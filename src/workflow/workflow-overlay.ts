import {
  getMarkdownTheme,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { safeDisplayText, safeTranscriptText } from "./display-text.ts";
import type { RunHandle, WorkflowRegistry } from "./registry.ts";
import type {
  WorkflowTaskDetail,
  WorkflowTaskSummary,
  WorkflowTimelineEvent,
} from "./run-details.ts";

const MIN_SPLIT_WIDTH = 100;
const MAX_RENDER_FPS_INTERVAL_MS = 100;
let overlayOpen = false;

interface TaskViewport {
  offset: number;
  follow: boolean;
  lastLineCount: number;
  newLines: number;
  showPrompt: boolean;
}

function defaultViewport(): TaskViewport {
  return { offset: 0, follow: true, lastLineCount: 0, newLines: 0, showPrompt: false };
}

/** Open the interactive workflow/run browser used by both F6 and /workflows. */
export async function openWorkflowOverlay(
  ctx: ExtensionContext,
  registry: WorkflowRegistry,
  preferredRunId?: string,
): Promise<void> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    const runs = registry.list();
    ctx.ui.notify(
      runs.length ? `${runs.length} workflow run(s); the detail overlay requires TUI mode.` : "No workflow runs in this session yet.",
      runs.length ? "info" : "warning",
    );
    return;
  }
  if (overlayOpen) {
    ctx.ui.notify("Workflow detail is already open.", "info");
    return;
  }
  const runs = registry.list();
  if (runs.length === 0) {
    ctx.ui.notify("No workflow runs in this session yet.", "info");
    return;
  }
  if (preferredRunId) {
    const requestedRunId = preferredRunId;
    const direct = registry.get(requestedRunId);
    const matches = direct ? [direct] : runs.filter((handle) => handle.snapshot.runId?.startsWith(requestedRunId));
    if (matches.length === 0) {
      ctx.ui.notify(`No workflow run matching "${safeDisplayText(requestedRunId, 80)}".`, "warning");
      return;
    }
    if (matches.length > 1) {
      ctx.ui.notify(`Workflow run prefix "${safeDisplayText(requestedRunId, 80)}" is ambiguous.`, "warning");
      return;
    }
    preferredRunId = matches[0]!.snapshot.runId;
  }

  overlayOpen = true;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new WorkflowOverlayComponent({
        tui,
        theme,
        registry,
        preferredRunId,
        onClose: () => done(),
      }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "94%",
          minWidth: 40,
          maxHeight: "92%",
          margin: 1,
        },
      },
    );
  } finally {
    overlayOpen = false;
  }
}

export class WorkflowOverlayComponent implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly registry: WorkflowRegistry;
  private readonly onClose: () => void;
  private readonly viewports = new Map<string, TaskViewport>();
  private readonly unsubscribers: Array<() => void> = [];
  private detailsUnsubscribe?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private lastRenderRequest = 0;
  private disposed = false;

  private mode: "runs" | "tasks" | "detail" = "tasks";
  private selectedRunId?: string;
  private selectedRunIndex = 0;
  private selectedTaskId?: number;
  private selectedTaskIndex = 0;
  private focus: "tasks" | "detail" = "tasks";
  private searchMode = false;
  private search = "";
  private runningOnly = false;

  constructor(input: {
    tui: TUI;
    theme: Theme;
    registry: WorkflowRegistry;
    preferredRunId?: string;
    onClose: () => void;
  }) {
    this.tui = input.tui;
    this.theme = input.theme;
    this.registry = input.registry;
    this.onClose = input.onClose;
    this.selectInitialRun(input.preferredRunId);
    this.unsubscribers.push(this.registry.subscribe(() => this.requestRender()));
    this.subscribeSelectedDetails();
    this.heartbeat = setInterval(() => this.requestRender(), 1000);
    this.heartbeat.unref?.();
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      if (matchesKey(data, "escape")) {
        this.searchMode = false;
        this.search = "";
      } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.searchMode = false;
      } else if (matchesKey(data, "backspace")) {
        this.search = this.search.slice(0, -1);
      } else if (isPrintableInput(data)) {
        this.search += data;
      }
      this.clampTaskSelection();
      this.requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.mode === "detail" || (this.mode === "tasks" && this.focus === "detail")) {
        this.mode = "tasks";
        this.focus = "tasks";
      } else if (this.mode === "tasks" && this.registry.list().length > 1) {
        this.mode = "runs";
      } else {
        this.dispose();
        this.onClose();
      }
      this.requestRender();
      return;
    }

    if (this.mode === "runs") {
      this.handleRunInput(data);
      return;
    }

    const split = this.tui.terminal.columns >= MIN_SPLIT_WIDTH;
    if (matchesKey(data, "tab") && split) {
      this.focus = this.focus === "tasks" ? "detail" : "tasks";
      this.requestRender();
      return;
    }
    if (data === "/" && this.focus === "tasks") {
      this.searchMode = true;
      this.search = "";
      this.requestRender();
      return;
    }
    if ((data === "r" || data === "R") && this.focus === "tasks") {
      this.runningOnly = true;
      this.clampTaskSelection();
      this.requestRender();
      return;
    }
    if ((data === "a" || data === "A") && this.focus === "tasks") {
      this.runningOnly = false;
      this.clampTaskSelection();
      this.requestRender();
      return;
    }
    if ((data === "p" || data === "P") && this.selectedTaskId != null) {
      const viewport = this.viewport();
      viewport.showPrompt = !viewport.showPrompt;
      this.requestRender();
      return;
    }

    if (this.focus === "tasks") this.handleTaskListInput(data, split);
    else this.handleDetailInput(data);
  }

  render(width: number): string[] {
    this.lastRenderRequest = Date.now();
    const safeWidth = Math.max(20, width);
    const height = Math.max(10, Math.min(36, Math.floor(this.tui.terminal.rows * 0.82)));
    if (this.mode === "runs") return this.renderRunSelector(safeWidth, height);

    const split = safeWidth >= MIN_SPLIT_WIDTH && this.mode !== "detail";
    if (!split) {
      return this.mode === "detail"
        ? this.renderSinglePane(this.renderDetailPane(safeWidth - 2, height - 2), safeWidth)
        : this.renderSinglePane(this.renderTaskPane(safeWidth - 2, height - 2), safeWidth);
    }

    const leftWidth = Math.max(30, Math.min(42, Math.floor(safeWidth * 0.34)));
    const rightWidth = safeWidth - leftWidth - 3;
    const left = this.renderTaskPane(leftWidth, height - 2);
    const right = this.renderDetailPane(rightWidth, height - 2);
    const lines = [
      `${this.theme.fg("border", `╭${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}╮`)}`,
    ];
    for (let row = 0; row < height - 2; row++) {
      lines.push(
        `${this.theme.fg("border", "│")}${padLine(left[row] ?? "", leftWidth)}${this.theme.fg("border", "│")}${padLine(right[row] ?? "", rightWidth)}${this.theme.fg("border", "│")}`,
      );
    }
    lines.push(this.theme.fg("border", `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`));
    return lines;
  }

  invalidate(): void {
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.detailsUnsubscribe?.();
    this.detailsUnsubscribe = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.selectedHandle()?.details?.setViewedTask(undefined);
  }

  private selectInitialRun(preferredRunId?: string): void {
    const runs = this.registry.list();
    if (preferredRunId) {
      const direct = this.registry.get(preferredRunId);
      const matches = direct ? [direct] : runs.filter((handle) => handle.snapshot.runId?.startsWith(preferredRunId));
      if (matches.length === 1) {
        this.selectRun(matches[0]!);
        return;
      }
    }
    const active = runs.filter((handle) => handle.snapshot.status === "running");
    if (active.length === 1) {
      this.selectRun(active[0]!);
      return;
    }
    if (active.length > 1) {
      this.mode = "runs";
      this.selectedRunIndex = 0;
      return;
    }
    this.selectRun(runs[0]!);
  }

  private selectRun(handle: RunHandle): void {
    this.selectedRunId = handle.snapshot.runId;
    this.mode = "tasks";
    this.selectedTaskIndex = 0;
    const tasks = this.filteredTasks();
    const activeIndex = findMostRecentlyActiveTaskIndex(tasks);
    this.selectedTaskIndex = activeIndex >= 0 ? activeIndex : Math.max(0, tasks.length - 1);
    this.selectedTaskId = tasks[this.selectedTaskIndex]?.id;
    handle.details?.setViewedTask(this.selectedTaskId);
  }

  private subscribeSelectedDetails(): void {
    this.detailsUnsubscribe?.();
    this.detailsUnsubscribe = undefined;
    const details = this.selectedHandle()?.details;
    if (details) this.detailsUnsubscribe = details.subscribe(() => this.requestRender());
  }

  private handleRunInput(data: string): void {
    const runs = this.registry.list();
    if (matchesKey(data, "up")) this.selectedRunIndex = Math.max(0, this.selectedRunIndex - 1);
    else if (matchesKey(data, "down")) this.selectedRunIndex = Math.min(runs.length - 1, this.selectedRunIndex + 1);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const selected = runs[this.selectedRunIndex];
      if (selected) {
        this.selectedHandle()?.details?.setViewedTask(undefined);
        this.selectRun(selected);
        this.subscribeSelectedDetails();
      }
    }
    this.requestRender();
  }

  private handleTaskListInput(data: string, split: boolean): void {
    const tasks = this.filteredTasks();
    const currentIndex = tasks.findIndex((task) => task.id === this.selectedTaskId);
    if (currentIndex >= 0) this.selectedTaskIndex = currentIndex;
    if (matchesKey(data, "up")) this.selectedTaskIndex = Math.max(0, this.selectedTaskIndex - 1);
    else if (matchesKey(data, "down")) this.selectedTaskIndex = Math.min(tasks.length - 1, this.selectedTaskIndex + 1);
    else if (matchesKey(data, "pageUp")) this.selectedTaskIndex = Math.max(0, this.selectedTaskIndex - 10);
    else if (matchesKey(data, "pageDown")) this.selectedTaskIndex = Math.min(tasks.length - 1, this.selectedTaskIndex + 10);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      if (split) this.focus = "detail";
      else {
        this.mode = "detail";
        this.focus = "detail";
      }
    }
    this.selectedTaskId = tasks[this.selectedTaskIndex]?.id;
    this.selectedHandle()?.details?.setViewedTask(this.selectedTaskId);
    this.requestRender();
  }

  private handleDetailInput(data: string): void {
    const viewport = this.viewport();
    const page = Math.max(5, Math.floor(this.tui.terminal.rows * 0.5));
    if (matchesKey(data, "up")) {
      viewport.offset = Math.max(0, viewport.offset - 1);
      viewport.follow = false;
    } else if (matchesKey(data, "down")) {
      viewport.offset++;
      viewport.follow = false;
    } else if (matchesKey(data, "pageUp")) {
      viewport.offset = Math.max(0, viewport.offset - page);
      viewport.follow = false;
    } else if (matchesKey(data, "pageDown")) {
      viewport.offset += page;
      viewport.follow = false;
    } else if (matchesKey(data, "end")) {
      viewport.follow = true;
      viewport.newLines = 0;
    }
    this.requestRender();
  }

  private renderRunSelector(width: number, height: number): string[] {
    const runs = this.registry.list();
    const inner = width - 2;
    const content: string[] = [
      this.theme.fg("accent", this.theme.bold("Workflow runs")),
      this.theme.fg("dim", "↑↓ select · Enter open · Esc close"),
      "",
    ];
    for (const [index, handle] of runs.entries()) {
      const selected = index === this.selectedRunIndex;
      const snapshot = handle.snapshot;
      const glyph = runGlyph(snapshot.status);
      const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
      content.push(`${prefix}${glyph} ${snapshot.runId ?? "run"} · ${snapshot.name}`);
      content.push(this.theme.fg("dim", `    ${snapshot.doneCount}/${snapshot.agentCount} done${snapshot.runningCount ? ` · ${snapshot.runningCount} running` : ""}`));
    }
    return this.renderSinglePane(fitHeight(content, height - 2), width);
  }

  private renderSinglePane(content: string[], width: number): string[] {
    const inner = width - 2;
    const lines = [this.theme.fg("border", `╭${"─".repeat(inner)}╮`)];
    for (const line of content) lines.push(`${this.theme.fg("border", "│")}${padLine(line, inner)}${this.theme.fg("border", "│")}`);
    lines.push(this.theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  private renderTaskPane(width: number, height: number): string[] {
    const handle = this.selectedHandle();
    if (!handle) return fitHeight([this.theme.fg("warning", "Run unavailable")], height);
    const tasks = this.filteredTasks();
    const stableIndex = tasks.findIndex((task) => task.id === this.selectedTaskId);
    if (stableIndex >= 0) this.selectedTaskIndex = stableIndex;
    const header = this.searchMode
      ? `Search: ${this.search}▌`
      : `${handle.snapshot.name} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
    const lines: string[] = [
      this.theme.fg("accent", this.theme.bold(header)),
      this.theme.fg("dim", this.searchMode ? "type · Enter apply · Esc clear" : "/ search · r running · a all · Tab detail"),
      "",
    ];
    let lastPhase: string | undefined;
    let selectedLine = 3;
    for (const task of tasks) {
      if (task.phase !== lastPhase) {
        lastPhase = task.phase;
        lines.push(this.theme.fg("muted", `─ ${task.phase ?? "unphased"} ─`));
      }
      const selected = task.id === this.selectedTaskId;
      if (selected) selectedLine = lines.length;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      lines.push(`${prefix} ${taskGlyph(task.status, this.theme)} #${task.id} ${task.label}`);
      lines.push(this.theme.fg("dim", `  ${compactTaskStats(task)}`));
    }
    const bodyHeight = Math.max(1, height - 1);
    const start = Math.max(0, Math.min(selectedLine - Math.floor(bodyHeight / 2), Math.max(0, lines.length - bodyHeight)));
    const visible = lines.slice(start, start + bodyHeight);
    visible.push(this.theme.fg("dim", "Esc runs/close"));
    return fitHeight(visible, height);
  }

  private renderDetailPane(width: number, height: number): string[] {
    const task = this.selectedTask();
    if (!task) return fitHeight([this.theme.fg("dim", "Select a task to inspect")], height);
    const model = task.modelId ?? (task.status === "running" ? "resolving model…" : task.legacyCache ? "model unavailable" : "model unresolved");
    const effort = task.effort ?? (task.status === "running" ? "resolving effort…" : task.legacyCache ? "effort unavailable" : "effort unresolved");
    const partial = task.status === "cancelled" || task.status === "error" || (task.status === "running" && task.currentTurn != null);
    const breadcrumb = [...task.workflowPath, task.phase, `#${task.id} ${task.label}`].filter(Boolean).join(" › ");
    const metrics = task.legacyCache
      ? `${model} • ${effort} · metrics unavailable for legacy cache entry`
      : `${model} • ${effort} · ${task.usage.turns} turn${task.usage.turns === 1 ? "" : "s"} · ${task.usage.toolUses} tool use${task.usage.toolUses === 1 ? "" : "s"} · ${formatTokens(task.usage.totalTokens)}${partial ? "+" : ""} token${partial ? " · partial" : ""}`;
    const optionParts = [
      task.requestedModelId ? `requested ${task.requestedModelId}${task.requestedEffort ? ` • ${task.requestedEffort}` : ""}` : undefined,
      task.agentType ? `role ${task.agentType}` : undefined,
      task.isolation,
      task.structuredOutput ? "structured output" : undefined,
    ].filter(Boolean);
    const fixed = [
      this.theme.fg("accent", this.theme.bold(breadcrumb)),
      metrics,
      ...(task.legacyCache ? [] : [
        this.theme.fg("dim", `input ${formatTokens(task.usage.inputTokens)} · output ${formatTokens(task.usage.outputTokens)} · cost ${formatCost(task.usage.cost)}`),
        this.theme.fg("dim", `cache read ${formatTokens(task.usage.cacheReadTokens)} · cache write ${formatTokens(task.usage.cacheWriteTokens)}`),
      ]),
      ...(optionParts.length ? [this.theme.fg("dim", `options: ${optionParts.join(" · ")}`)] : []),
      this.theme.fg("dim", `${task.status}${task.currentTurn ? ` · current: turn ${task.currentTurn} streaming` : ""}${task.usage.retries ? ` · ${task.usage.retries} retries` : ""}${task.usage.compactions ? ` · ${task.usage.compactions} compactions` : ""}`),
    ];
    const body = this.timelineLines(task, width);
    const viewport = this.viewport();
    const bodyHeight = Math.max(1, height - fixed.length - 2);
    if (body.length > viewport.lastLineCount && !viewport.follow) {
      viewport.newLines += body.length - viewport.lastLineCount;
    }
    viewport.lastLineCount = body.length;
    const maxOffset = Math.max(0, body.length - bodyHeight);
    if (viewport.follow) {
      viewport.offset = maxOffset;
      viewport.newLines = 0;
    } else {
      viewport.offset = Math.max(0, Math.min(viewport.offset, maxOffset));
    }
    const visible = body.slice(viewport.offset, viewport.offset + bodyHeight);
    const footer = viewport.follow
      ? "↑↓/PgUp scroll · End follow · p prompt · Tab tasks · Esc back"
      : `↓ ${viewport.newLines} new lines · End to follow`;
    return fitHeight([...fixed, "", ...visible, this.theme.fg("dim", footer)], height);
  }

  private timelineLines(task: WorkflowTaskDetail, width: number): string[] {
    const lines: string[] = [];
    const viewport = this.viewport();
    if (viewport.showPrompt) {
      lines.push(this.theme.fg("muted", "── Task prompt ──"));
      lines.push(...wrapPlain(safeTranscriptText(task.prompt), width));
      lines.push("");
    }
    for (const event of task.events) lines.push(...renderTimelineEvent(event, width, this.theme));
    if (task.resultPreview && !task.events.some((event) => event.kind === "text")) {
      lines.push(this.theme.fg("muted", "── Final result ──"));
      lines.push(...wrapPlain(safeTranscriptText(task.resultPreview), width));
    }
    if (task.error && !task.events.some((event) => event.kind === "error")) {
      lines.push(this.theme.fg("error", `Error: ${task.error}`));
    }
    if (lines.length === 0) lines.push(this.theme.fg("dim", task.status === "running" ? "Waiting for output…" : "No transcript output."));
    return lines;
  }

  private filteredTasks(): WorkflowTaskSummary[] {
    const tasks = this.taskSummaries(this.selectedHandle());
    const query = this.search.trim().toLowerCase();
    const phaseOrder = new Map<string, number>();
    for (const task of tasks) {
      const phase = task.phase ?? "Other";
      if (!phaseOrder.has(phase)) phaseOrder.set(phase, phaseOrder.size);
    }
    return tasks.filter((task) => {
      if (this.runningOnly && task.status !== "running") return false;
      if (!query) return true;
      return `${task.label} ${task.phase ?? ""} ${task.modelId ?? task.requestedModelId ?? ""} ${task.status}`.toLowerCase().includes(query);
    }).sort((left, right) => {
      const leftPhase = phaseOrder.get(left.phase ?? "Other") ?? Number.MAX_SAFE_INTEGER;
      const rightPhase = phaseOrder.get(right.phase ?? "Other") ?? Number.MAX_SAFE_INTEGER;
      return leftPhase - rightPhase || left.id - right.id;
    });
  }

  private taskSummaries(handle: RunHandle | undefined): WorkflowTaskSummary[] {
    if (!handle) return [];
    if (handle.details) return handle.details.listTasks();
    return handle.snapshot.agents.map((agent) => ({
      id: agent.id,
      label: agent.label,
      phase: agent.phase,
      workflowPath: agent.workflowPath ?? [handle.snapshot.name],
      status: agent.status,
      promptPreview: "",
      requestedModelId: agent.requestedModelId,
      requestedEffort: agent.requestedEffort as any,
      modelId: agent.modelId,
      effort: agent.effort as any,
      agentType: agent.agentType,
      isolation: agent.isolation,
      structuredOutput: agent.structuredOutput,
      usage: agent.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: 0,
        turns: 0,
        toolUses: 0,
        retries: 0,
        compactions: 0,
      },
      currentTurn: agent.currentTurn,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      durationMs: agent.durationMs,
      resultPreview: agent.resultPreview,
      error: agent.error,
      cached: agent.status === "cached",
      legacyCache: agent.legacyCache,
      transcriptPath: agent.transcriptPath,
    }));
  }

  private selectedTask(): WorkflowTaskDetail | undefined {
    const handle = this.selectedHandle();
    if (!handle || this.selectedTaskId == null) return undefined;
    const detail = handle.details?.getTask(this.selectedTaskId);
    if (detail) return detail;
    const summary = this.taskSummaries(handle).find((task) => task.id === this.selectedTaskId);
    return summary ? { ...summary, prompt: summary.promptPreview, events: [] } : undefined;
  }

  private selectedHandle(): RunHandle | undefined {
    return this.selectedRunId ? this.registry.get(this.selectedRunId) : undefined;
  }

  private clampTaskSelection(): void {
    const tasks = this.filteredTasks();
    const stableIndex = tasks.findIndex((task) => task.id === this.selectedTaskId);
    if (stableIndex >= 0) this.selectedTaskIndex = stableIndex;
    else this.selectedTaskIndex = Math.max(0, Math.min(this.selectedTaskIndex, Math.max(0, tasks.length - 1)));
    this.selectedTaskId = tasks[this.selectedTaskIndex]?.id;
  }

  private viewport(): TaskViewport {
    const key = `${this.selectedRunId ?? "run"}:${this.selectedTaskId ?? "task"}`;
    let value = this.viewports.get(key);
    if (!value) {
      value = defaultViewport();
      this.viewports.set(key, value);
    }
    return value;
  }

  private requestRender(): void {
    if (this.disposed) return;
    const elapsed = Date.now() - this.lastRenderRequest;
    if (elapsed >= MAX_RENDER_FPS_INTERVAL_MS) {
      this.lastRenderRequest = Date.now();
      this.tui.requestRender();
      return;
    }
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (this.disposed) return;
      this.lastRenderRequest = Date.now();
      this.tui.requestRender();
    }, MAX_RENDER_FPS_INTERVAL_MS - elapsed);
  }
}

function renderTimelineEvent(event: WorkflowTimelineEvent, width: number, theme: Theme): string[] {
  switch (event.kind) {
    case "turn":
      return [theme.fg("muted", `── Turn ${event.turn ?? "?"}${event.state === "streaming" ? " · streaming" : ""} ${"─".repeat(8)}`)];
    case "text": {
      const text = event.streaming ? safeTranscriptText(event.text ?? "") : event.text ?? "";
      if (!text) return [];
      if (event.streaming) return wrapPlain(text, width);
      try {
        return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
      } catch {
        return wrapPlain(text, width);
      }
    }
    case "thinking": {
      const duration = event.startedAt != null
        ? formatDuration(Math.max(0, (event.endedAt ?? Date.now()) - event.startedAt))
        : undefined;
      return [theme.fg("dim", `◌ thinking${duration ? ` · ${duration}` : ""}${event.streaming ? "…" : ""}`)];
    }
    case "tool": {
      const glyph = event.streaming ? "▶" : event.isError ? "✗" : "✓";
      const duration = event.startedAt != null
        ? formatDuration(Math.max(0, (event.endedAt ?? Date.now()) - event.startedAt))
        : undefined;
      const color = event.isError ? "error" : event.streaming ? "warning" : "success";
      const summary = `${glyph} ${event.toolName ?? "tool"}${event.toolArgs ? `: ${event.toolArgs}` : ""}${duration ? ` · ${duration}` : ""}`;
      const lines = [theme.fg(color, truncateToWidth(summary, width, "…"))];
      if (event.resultPreview) {
        for (const line of event.resultPreview.split(/\r?\n/)) {
          lines.push(...wrapPlain(`  ${line}`, width).map((value) => theme.fg("dim", value)));
        }
      }
      return lines;
    }
    case "retry":
      return [theme.fg("warning", `↻ ${event.text ?? "retry"}`)];
    case "compaction":
      return [theme.fg("muted", `◇ ${event.text ?? "compaction"}`)];
    case "error":
      return [theme.fg("error", `Error: ${event.text ?? "unknown error"}`)];
    case "omitted":
      return [theme.fg("warning", event.text ?? "… output omitted …")];
  }
}

function compactTaskStats(task: WorkflowTaskSummary): string {
  const model = task.modelId ?? (task.legacyCache ? "model unavailable" : "resolving…");
  const effort = task.effort ?? (task.legacyCache ? "effort unavailable" : "…");
  if (task.legacyCache) return `${model} • ${effort} · metrics unavailable · cached legacy entry`;
  const partial = task.status === "cancelled" || task.status === "error" || (task.status === "running" && task.currentTurn != null);
  return `${model} • ${effort} · ${task.usage.turns}t · ${task.usage.toolUses}u · ${formatTokens(task.usage.totalTokens)}${partial ? "+ · partial" : ""}`;
}

function findMostRecentlyActiveTaskIndex(tasks: WorkflowTaskSummary[]): number {
  let selected = -1;
  let time = -1;
  for (const [index, task] of tasks.entries()) {
    if (task.status !== "running") continue;
    const candidate = task.startedAt ?? 0;
    if (candidate >= time) {
      selected = index;
      time = candidate;
    }
  }
  return selected;
}

function taskGlyph(status: WorkflowTaskSummary["status"], theme: Theme): string {
  if (status === "running") return theme.fg("accent", "●");
  if (status === "done") return theme.fg("success", "✓");
  if (status === "cached") return theme.fg("success", "⟲");
  if (status === "cancelled" || status === "skipped") return theme.fg("warning", "■");
  return theme.fg("error", "✗");
}

function runGlyph(status: string): string {
  if (status === "running") return "▶";
  if (status === "completed") return "✓";
  if (status === "aborted") return "■";
  return "✗";
}

function wrapPlain(text: string, width: number): string[] {
  if (!text) return [""];
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line) return [""];
    return wrapTextWithAnsi(line, Math.max(1, width));
  });
}

function padLine(value: string, width: number): string {
  const truncated = truncateToWidth(value, Math.max(0, width), "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function fitHeight(lines: string[], height: number): string[] {
  const result = lines.slice(0, Math.max(0, height));
  while (result.length < height) result.push("");
  return result;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.0000";
  if (value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}

function isPrintableInput(data: string): boolean {
  return data.length > 0 && !data.includes("\u001b") && [...data].every((char) => char >= " ");
}
