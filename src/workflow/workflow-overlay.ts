import { Effect, Result, Exit, Scope } from "effect";
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
const OPEN_OVERLAYS = new WeakSet<WorkflowRegistry>();

type OverlayNavigationKey = "pageUp" | "pageDown" | "end";

function matchesOverlayNavigationKey(data: string, key: OverlayNavigationKey): boolean {
  return matchesKey(data, key) || matchesKey(data, `ctrl+${key}`);
}

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

const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: (error) => error });
const bestEffort = (thunk: () => unknown) => attempt(thunk).pipe(Effect.ignore);

/** Open the interactive workflow/run browser used by both F6 and /workflows. */
export function openWorkflowOverlay(
  ctx: ExtensionContext,
  registry: WorkflowRegistry,
  preferredRunId?: string,
): Promise<void> {
  return Effect.runPromise(
    attempt(() => {
      if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
        const runs = registry.list();
        ctx.ui.notify(
          runs.length
            ? `${runs.length} workflow run(s); the detail overlay requires TUI mode.`
            : "No workflow runs in this session yet.",
          runs.length ? "info" : "warning",
        );
        return Effect.void;
      }
      if (OPEN_OVERLAYS.has(registry)) {
        ctx.ui.notify("Workflow detail is already open.", "info");
        return Effect.void;
      }
      const runs = registry.list();
      if (runs.length === 0) {
        ctx.ui.notify("No workflow runs in this session yet.", "info");
        return Effect.void;
      }
      if (preferredRunId) {
        const requestedRunId = preferredRunId;
        const direct = registry.get(requestedRunId);
        const matches = direct
          ? [direct]
          : runs.filter((handle) => handle.snapshot.runId?.startsWith(requestedRunId));
        if (matches.length === 0) {
          ctx.ui.notify(
            `No workflow run matching "${safeDisplayText(requestedRunId, 80)}".`,
            "warning",
          );
          return Effect.void;
        }
        if (matches.length > 1) {
          ctx.ui.notify(
            `Workflow run prefix "${safeDisplayText(requestedRunId, 80)}" is ambiguous.`,
            "warning",
          );
          return Effect.void;
        }
        preferredRunId = matches[0]!.snapshot.runId;
      }

      let component: WorkflowOverlayComponent | undefined;
      return Effect.acquireRelease(
        Effect.sync(() => OPEN_OVERLAYS.add(registry)),
        () =>
          Effect.sync(() => {
            OPEN_OVERLAYS.delete(registry);
          }),
      ).pipe(
        Effect.andThen(Effect.addFinalizer(() => bestEffort(() => component?.dispose()))),
        Effect.andThen(
          Effect.tryPromise({
            try: () =>
              ctx.ui.custom<void>(
                (tui, theme, _keybindings, done) => {
                  component = new WorkflowOverlayComponent({
                    tui,
                    theme,
                    registry,
                    preferredRunId,
                    onClose: () => done(),
                  });
                  return component;
                },
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
              ),
            catch: (error) => error,
          }),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.flatten),
  );
}

interface WorkflowOverlayInput {
  tui: TUI;
  theme: Theme;
  registry: WorkflowRegistry;
  preferredRunId?: string;
  onClose: () => void;
}

/** Pi and SDK consumers retain the public constructor and synchronous Component API. */
export interface WorkflowOverlayComponent extends ReturnType<typeof makeWorkflowOverlay> {}
export class WorkflowOverlayComponent implements Component {
  constructor(input: WorkflowOverlayInput) {
    Object.assign(this, makeWorkflowOverlay(input));
  }
}

function makeWorkflowOverlay({
  tui,
  theme,
  registry,
  preferredRunId,
  onClose,
}: WorkflowOverlayInput) {
  const scope = Scope.makeUnsafe();
  const viewports = new Map<string, TaskViewport>();
  let detailsScope: Scope.Closeable | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRenderRequest = 0;
  let disposed = false;
  let mode: "runs" | "tasks" | "detail" = "tasks";
  let selectedRunId: string | undefined;
  let selectedRunIndex = 0;
  let selectedTaskId: number | undefined;
  let selectedTaskIndex = 0;
  let focus: "tasks" | "detail" = "tasks";
  let searchMode = false;
  let search = "";
  let runningOnly = false;

  function handleInput(data: string): void {
    if (disposed) return;
    if (searchMode) {
      if (matchesKey(data, "escape")) {
        searchMode = false;
        search = "";
      } else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        searchMode = false;
      } else if (matchesKey(data, "backspace")) {
        search = search.slice(0, -1);
      } else if (isPrintableInput(data)) {
        search += data;
      }
      clampTaskSelection();
      requestRender();
      return;
    }

    if (matchesKey(data, "escape")) {
      if (mode === "detail" || (mode === "tasks" && focus === "detail")) {
        mode = "tasks";
        focus = "tasks";
      } else if (mode === "tasks" && registry.list().length > 1) {
        mode = "runs";
      } else {
        dispose();
        onClose();
      }
      requestRender();
      return;
    }

    if (mode === "runs") {
      handleRunInput(data);
      return;
    }

    const split = tui.terminal.columns >= MIN_SPLIT_WIDTH;
    if (matchesKey(data, "tab") && split) {
      focus = focus === "tasks" ? "detail" : "tasks";
      requestRender();
      return;
    }
    if (data === "/" && focus === "tasks") {
      searchMode = true;
      search = "";
      requestRender();
      return;
    }
    if ((data === "r" || data === "R") && focus === "tasks") {
      runningOnly = true;
      clampTaskSelection();
      requestRender();
      return;
    }
    if ((data === "a" || data === "A") && focus === "tasks") {
      runningOnly = false;
      clampTaskSelection();
      requestRender();
      return;
    }
    if ((data === "p" || data === "P") && selectedTaskId != null) {
      const viewport = getViewport();
      viewport.showPrompt = !viewport.showPrompt;
      requestRender();
      return;
    }

    if (focus === "tasks") handleTaskListInput(data, split);
    else handleDetailInput(data);
  }

  function render(width: number): string[] {
    if (disposed) return [];
    lastRenderRequest = Date.now();
    const safeWidth = Math.max(20, width);
    const height = Math.max(10, Math.min(36, Math.floor(tui.terminal.rows * 0.82)));
    if (mode === "runs") return renderRunSelector(safeWidth, height);

    const split = safeWidth >= MIN_SPLIT_WIDTH && mode !== "detail";
    if (!split) {
      return mode === "detail"
        ? renderSinglePane(renderDetailPane(safeWidth - 2, height - 2), safeWidth)
        : renderSinglePane(renderTaskPane(safeWidth - 2, height - 2), safeWidth);
    }

    const leftWidth = Math.max(30, Math.min(42, Math.floor(safeWidth * 0.34)));
    const rightWidth = safeWidth - leftWidth - 3;
    const left = renderTaskPane(leftWidth, height - 2);
    const right = renderDetailPane(rightWidth, height - 2);
    const lines = [`${theme.fg("border", `╭${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}╮`)}`];
    for (let row = 0; row < height - 2; row++) {
      lines.push(
        `${theme.fg("border", "│")}${padLine(left[row] ?? "", leftWidth)}${theme.fg("border", "│")}${padLine(right[row] ?? "", rightWidth)}${theme.fg("border", "│")}`,
      );
    }
    lines.push(theme.fg("border", `╰${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}╯`));
    return lines;
  }

  function invalidate(): void {
    requestRender();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    Effect.runSync(Scope.close(scope, Exit.void));
  }

  function selectInitialRun(preferredRunId?: string): void {
    const runs = registry.list();
    if (preferredRunId) {
      const direct = registry.get(preferredRunId);
      const matches = direct
        ? [direct]
        : runs.filter((handle) => handle.snapshot.runId?.startsWith(preferredRunId));
      if (matches.length === 1) {
        selectRun(matches[0]!);
        return;
      }
    }
    const active = runs.filter((handle) => handle.snapshot.status === "running");
    if (active.length === 1) {
      selectRun(active[0]!);
      return;
    }
    if (active.length > 1) {
      mode = "runs";
      selectedRunIndex = 0;
      return;
    }
    selectRun(runs[0]!);
  }

  function selectRun(handle: RunHandle): void {
    selectedRunId = handle.snapshot.runId;
    mode = "tasks";
    selectedTaskIndex = 0;
    const tasks = filteredTasks();
    const activeIndex = findMostRecentlyActiveTaskIndex(tasks);
    selectedTaskIndex = activeIndex >= 0 ? activeIndex : Math.max(0, tasks.length - 1);
    selectedTaskId = tasks[selectedTaskIndex]?.id;
  }

  function subscribeSelectedDetails(): void {
    if (detailsScope) Effect.runSync(Scope.close(detailsScope, Exit.void));
    detailsScope = Scope.makeUnsafe();
    const details = selectedHandle()?.details;
    if (!details) return;
    Effect.runSync(
      Effect.acquireRelease(Effect.succeed(details), (selected) =>
        bestEffort(() => selected.setViewedTask(undefined)),
      ).pipe(
        Effect.andThen(attempt(() => details.setViewedTask(selectedTaskId))),
        Effect.andThen(
          Effect.acquireRelease(
            attempt(() => details.subscribe(requestRender)),
            (unsubscribe) => bestEffort(unsubscribe),
          ),
        ),
        Scope.provide(detailsScope),
      ),
    );
  }

  function handleRunInput(data: string): void {
    const runs = registry.list();
    if (matchesKey(data, "up")) selectedRunIndex = Math.max(0, selectedRunIndex - 1);
    else if (matchesKey(data, "down"))
      selectedRunIndex = Math.min(runs.length - 1, selectedRunIndex + 1);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      const selected = runs[selectedRunIndex];
      if (selected) {
        selectRun(selected);
        subscribeSelectedDetails();
      }
    }
    requestRender();
  }

  function handleTaskListInput(data: string, split: boolean): void {
    const tasks = filteredTasks();
    const currentIndex = tasks.findIndex((task) => task.id === selectedTaskId);
    if (currentIndex >= 0) selectedTaskIndex = currentIndex;
    if (matchesKey(data, "up")) selectedTaskIndex = Math.max(0, selectedTaskIndex - 1);
    else if (matchesKey(data, "down"))
      selectedTaskIndex = Math.min(tasks.length - 1, selectedTaskIndex + 1);
    else if (matchesOverlayNavigationKey(data, "pageUp"))
      selectedTaskIndex = Math.max(0, selectedTaskIndex - 10);
    else if (matchesOverlayNavigationKey(data, "pageDown"))
      selectedTaskIndex = Math.min(tasks.length - 1, selectedTaskIndex + 10);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      if (split) focus = "detail";
      else {
        mode = "detail";
        focus = "detail";
      }
    }
    selectedTaskId = tasks[selectedTaskIndex]?.id;
    selectedHandle()?.details?.setViewedTask(selectedTaskId);
    requestRender();
  }

  function handleDetailInput(data: string): void {
    const viewport = getViewport();
    const page = Math.max(5, Math.floor(tui.terminal.rows * 0.5));
    if (matchesKey(data, "up")) {
      viewport.offset = Math.max(0, viewport.offset - 1);
      viewport.follow = false;
    } else if (matchesKey(data, "down")) {
      viewport.offset++;
      viewport.follow = false;
    } else if (matchesOverlayNavigationKey(data, "pageUp")) {
      viewport.offset = Math.max(0, viewport.offset - page);
      viewport.follow = false;
    } else if (matchesOverlayNavigationKey(data, "pageDown")) {
      viewport.offset += page;
      viewport.follow = false;
    } else if (matchesOverlayNavigationKey(data, "end")) {
      viewport.follow = true;
      viewport.newLines = 0;
    }
    requestRender();
  }

  function renderRunSelector(width: number, height: number): string[] {
    const runs = registry.list();
    const inner = width - 2;
    const content: string[] = [
      theme.fg("accent", theme.bold("Workflow runs")),
      theme.fg("dim", "↑↓ select · Enter open · Esc close"),
      "",
    ];
    for (const [index, handle] of runs.entries()) {
      const selected = index === selectedRunIndex;
      const snapshot = handle.snapshot;
      const glyph = runGlyph(snapshot.status);
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      content.push(`${prefix}${glyph} ${snapshot.runId ?? "run"} · ${snapshot.name}`);
      content.push(
        theme.fg(
          "dim",
          `    ${snapshot.doneCount}/${snapshot.agentCount} done${snapshot.runningCount ? ` · ${snapshot.runningCount} running` : ""}`,
        ),
      );
    }
    return renderSinglePane(fitHeight(content, height - 2), width);
  }

  function renderSinglePane(content: string[], width: number): string[] {
    const inner = width - 2;
    const lines = [theme.fg("border", `╭${"─".repeat(inner)}╮`)];
    for (const line of content)
      lines.push(`${theme.fg("border", "│")}${padLine(line, inner)}${theme.fg("border", "│")}`);
    lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
    return lines;
  }

  function renderTaskPane(width: number, height: number): string[] {
    const handle = selectedHandle();
    if (!handle) return fitHeight([theme.fg("warning", "Run unavailable")], height);
    const tasks = filteredTasks();
    const stableIndex = tasks.findIndex((task) => task.id === selectedTaskId);
    if (stableIndex >= 0) selectedTaskIndex = stableIndex;
    const header = searchMode
      ? `Search: ${search}▌`
      : `${handle.snapshot.name} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
    const lines: string[] = [
      theme.fg("accent", theme.bold(header)),
      theme.fg(
        "dim",
        searchMode ? "type · Enter apply · Esc clear" : "/ search · r running · a all · Tab detail",
      ),
      "",
    ];
    let lastPhase: string | undefined;
    let selectedLine = 3;
    for (const task of tasks) {
      if (task.phase !== lastPhase) {
        lastPhase = task.phase;
        lines.push(theme.fg("muted", `─ ${task.phase ?? "unphased"} ─`));
      }
      const selected = task.id === selectedTaskId;
      if (selected) selectedLine = lines.length;
      const prefix = selected ? theme.fg("accent", ">") : " ";
      lines.push(`${prefix} ${taskGlyph(task.status, theme)} #${task.id} ${task.label}`);
      lines.push(theme.fg("dim", `  ${compactTaskStats(task)}`));
    }
    const bodyHeight = Math.max(1, height - 1);
    const start = Math.max(
      0,
      Math.min(selectedLine - Math.floor(bodyHeight / 2), Math.max(0, lines.length - bodyHeight)),
    );
    const visible = lines.slice(start, start + bodyHeight);
    visible.push(theme.fg("dim", "Esc runs/close"));
    return fitHeight(visible, height);
  }

  function renderDetailPane(width: number, height: number): string[] {
    const task = selectedTask();
    if (!task) return fitHeight([theme.fg("dim", "Select a task to inspect")], height);
    const model =
      task.modelId ??
      (task.status === "running"
        ? "resolving model…"
        : task.legacyCache
          ? "model unavailable"
          : "model unresolved");
    const effort =
      task.effort ??
      (task.status === "running"
        ? "resolving effort…"
        : task.legacyCache
          ? "effort unavailable"
          : "effort unresolved");
    const partial =
      task.status === "cancelled" ||
      task.status === "error" ||
      (task.status === "running" && task.currentTurn != null);
    const breadcrumb = [...task.workflowPath, task.phase, `#${task.id} ${task.label}`]
      .filter(Boolean)
      .join(" › ");
    const metrics = task.legacyCache
      ? `${model} • ${effort} · metrics unavailable for legacy cache entry`
      : `${model} • ${effort} · ${task.usage.turns} turn${task.usage.turns === 1 ? "" : "s"} · ${task.usage.toolUses} tool use${task.usage.toolUses === 1 ? "" : "s"} · ${formatTokens(task.usage.totalTokens)}${partial ? "+" : ""} token${partial ? " · partial" : ""}`;
    const optionParts = [
      task.requestedModelId
        ? `requested ${task.requestedModelId}${task.requestedEffort ? ` • ${task.requestedEffort}` : ""}`
        : undefined,
      task.agentType ? `role ${task.agentType}` : undefined,
      task.isolation,
      task.structuredOutput ? "structured output" : undefined,
    ].filter(Boolean);
    const fixed = [
      theme.fg("accent", theme.bold(breadcrumb)),
      metrics,
      ...(task.legacyCache
        ? []
        : [
            theme.fg(
              "dim",
              `input ${formatTokens(task.usage.inputTokens)} · output ${formatTokens(task.usage.outputTokens)} · cost ${formatCost(task.usage.cost)}`,
            ),
            theme.fg(
              "dim",
              `cache read ${formatTokens(task.usage.cacheReadTokens)} · cache write ${formatTokens(task.usage.cacheWriteTokens)}`,
            ),
          ]),
      ...(optionParts.length ? [theme.fg("dim", `options: ${optionParts.join(" · ")}`)] : []),
      theme.fg(
        "dim",
        `${task.status}${task.currentTurn ? ` · current: turn ${task.currentTurn} streaming` : ""}${task.usage.retries ? ` · ${task.usage.retries} retries` : ""}${task.usage.compactions ? ` · ${task.usage.compactions} compactions` : ""}`,
      ),
    ];
    const body = timelineLines(task, width);
    const viewport = getViewport();
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
    // Fullscreen owns unmodified paging keys before focused overlays receive input.
    // Ctrl variants remain routed to the overlay under Pi 0.84's default bindings.
    const pageKeys = tui.mode === "fullscreen" ? "Ctrl+PgUp/Dn" : "PgUp/Dn";
    const endKey = tui.mode === "fullscreen" ? "Ctrl+End" : "End";
    const footer = viewport.follow
      ? `↑↓/${pageKeys} scroll · ${endKey} follow · p prompt · Tab tasks · Esc back`
      : `↓ ${viewport.newLines} new lines · ${endKey} to follow`;
    return fitHeight([...fixed, "", ...visible, theme.fg("dim", footer)], height);
  }

  function timelineLines(task: WorkflowTaskDetail, width: number): string[] {
    const lines: string[] = [];
    const viewport = getViewport();
    if (viewport.showPrompt) {
      lines.push(theme.fg("muted", "── Task prompt ──"));
      lines.push(...wrapPlain(safeTranscriptText(task.prompt), width));
      lines.push("");
    }
    for (const event of task.events) lines.push(...renderTimelineEvent(event, width, theme));
    if (task.resultPreview && !task.events.some((event) => event.kind === "text")) {
      lines.push(theme.fg("muted", "── Final result ──"));
      lines.push(...wrapPlain(safeTranscriptText(task.resultPreview), width));
    }
    if (task.error && !task.events.some((event) => event.kind === "error")) {
      lines.push(theme.fg("error", `Error: ${task.error}`));
    }
    if (lines.length === 0)
      lines.push(
        theme.fg(
          "dim",
          task.status === "running" ? "Waiting for output…" : "No transcript output.",
        ),
      );
    return lines;
  }

  function filteredTasks(): WorkflowTaskSummary[] {
    const tasks = taskSummaries(selectedHandle());
    const query = search.trim().toLowerCase();
    const phaseOrder = new Map<string, number>();
    for (const task of tasks) {
      const phase = task.phase ?? "Other";
      if (!phaseOrder.has(phase)) phaseOrder.set(phase, phaseOrder.size);
    }
    return tasks
      .filter((task) => {
        if (runningOnly && task.status !== "running") return false;
        if (!query) return true;
        return `${task.label} ${task.phase ?? ""} ${task.modelId ?? task.requestedModelId ?? ""} ${task.status}`
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => {
        const leftPhase = phaseOrder.get(left.phase ?? "Other") ?? Number.MAX_SAFE_INTEGER;
        const rightPhase = phaseOrder.get(right.phase ?? "Other") ?? Number.MAX_SAFE_INTEGER;
        return leftPhase - rightPhase || left.id - right.id;
      });
  }

  function taskSummaries(handle: RunHandle | undefined): WorkflowTaskSummary[] {
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

  function selectedTask(): WorkflowTaskDetail | undefined {
    const handle = selectedHandle();
    if (!handle || selectedTaskId == null) return undefined;
    const detail = handle.details?.getTask(selectedTaskId);
    if (detail) return detail;
    const summary = taskSummaries(handle).find((task) => task.id === selectedTaskId);
    return summary ? { ...summary, prompt: summary.promptPreview, events: [] } : undefined;
  }

  function selectedHandle(): RunHandle | undefined {
    return selectedRunId ? registry.get(selectedRunId) : undefined;
  }

  function clampTaskSelection(): void {
    const tasks = filteredTasks();
    const stableIndex = tasks.findIndex((task) => task.id === selectedTaskId);
    if (stableIndex >= 0) selectedTaskIndex = stableIndex;
    else
      selectedTaskIndex = Math.max(0, Math.min(selectedTaskIndex, Math.max(0, tasks.length - 1)));
    selectedTaskId = tasks[selectedTaskIndex]?.id;
  }

  function getViewport(): TaskViewport {
    const key = `${selectedRunId ?? "run"}:${selectedTaskId ?? "task"}`;
    let value = viewports.get(key);
    if (!value) {
      value = defaultViewport();
      viewports.set(key, value);
    }
    return value;
  }

  function requestRender(): void {
    Effect.runSync(
      bestEffort(() => {
        if (disposed) return;
        const elapsed = Date.now() - lastRenderRequest;
        if (elapsed >= MAX_RENDER_FPS_INTERVAL_MS) {
          lastRenderRequest = Date.now();
          Effect.runSync(bestEffort(() => tui.requestRender()));
          return;
        }
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          if (disposed) return;
          lastRenderRequest = Date.now();
          Effect.runSync(bestEffort(() => tui.requestRender()));
        }, MAX_RENDER_FPS_INTERVAL_MS - elapsed);
      }),
    );
  }

  // Each cleanup is independent: a failing observer cannot strand timers or
  // other subscriptions. The same scope also owns partially constructed views.
  const setup = Effect.addFinalizer(() =>
    bestEffort(() => {
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      renderTimer = undefined;
    }),
  ).pipe(
    Effect.andThen(
      Effect.addFinalizer(() =>
        Effect.suspend(() => (detailsScope ? Scope.close(detailsScope, Exit.void) : Effect.void)),
      ),
    ),
    Effect.andThen(attempt(() => selectInitialRun(preferredRunId))),
    Effect.andThen(
      Effect.acquireRelease(
        attempt(() => registry.subscribe(requestRender)),
        (unsubscribe) => bestEffort(unsubscribe),
      ),
    ),
    Effect.andThen(attempt(subscribeSelectedDetails)),
    Effect.andThen(
      Effect.acquireRelease(
        attempt(() => setInterval(requestRender, 1000)),
        (timer) => bestEffort(() => clearInterval(timer)),
      ),
    ),
    Effect.tap((timer) => attempt(() => timer.unref?.())),
    Scope.provide(scope),
    Effect.matchEffect({
      onFailure: (error) => Effect.sync(dispose).pipe(Effect.andThen(Effect.fail(error))),
      onSuccess: () => Effect.void,
    }),
  );
  Effect.runSync(setup);
  return { handleInput, render, invalidate, dispose };
}

function renderTimelineEvent(event: WorkflowTimelineEvent, width: number, theme: Theme): string[] {
  switch (event.kind) {
    case "turn":
      return [
        theme.fg(
          "muted",
          `── Turn ${event.turn ?? "?"}${event.state === "streaming" ? " · streaming" : ""} ${"─".repeat(8)}`,
        ),
      ];
    case "text": {
      const text = event.streaming ? safeTranscriptText(event.text ?? "") : (event.text ?? "");
      if (!text) return [];
      if (event.streaming) return wrapPlain(text, width);
      return Result.try(() => new Markdown(text, 0, 0, getMarkdownTheme()).render(width)).pipe(
        Result.getOrElse(() => wrapPlain(text, width)),
      );
    }
    case "thinking": {
      const duration =
        event.startedAt != null
          ? formatDuration(Math.max(0, (event.endedAt ?? Date.now()) - event.startedAt))
          : undefined;
      return [
        theme.fg(
          "dim",
          `◌ thinking${duration ? ` · ${duration}` : ""}${event.streaming ? "…" : ""}`,
        ),
      ];
    }
    case "tool": {
      const glyph = event.streaming ? "▶" : event.isError ? "✗" : "✓";
      const duration =
        event.startedAt != null
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
  const partial =
    task.status === "cancelled" ||
    task.status === "error" ||
    (task.status === "running" && task.currentTurn != null);
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
