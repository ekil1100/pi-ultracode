import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTelemetryEvent, AgentUsage, ThinkingLevel } from "./agent-runner.ts";
import { safeDisplayText, safeTranscriptText } from "./display-text.ts";
import { preview, recompute, type WorkflowAgentStatus, type WorkflowSnapshot } from "./display.ts";

export const RUN_DETAILS_VERSION = 1;
export const MAX_LIVE_TASK_BYTES = 1024 * 1024;
export const MAX_LIVE_TASK_LINES = 5_000;
export const MAX_LIVE_RUN_BYTES = 32 * 1024 * 1024;
export const MAX_TASK_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const MAX_DETAILS_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RUN_TRANSCRIPT_PAYLOAD_BYTES = MAX_RUN_TRANSCRIPT_BYTES - MAX_DETAILS_MANIFEST_BYTES;
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;
const TRANSCRIPT_MARKER_BYTES = 1024;
const TRANSCRIPT_TAIL_BYTES = MAX_TASK_TRANSCRIPT_BYTES - TRANSCRIPT_HEAD_BYTES - TRANSCRIPT_MARKER_BYTES;
const TRANSCRIPT_TEXT_CHUNK_CHARS = 48 * 1024;
const MAX_PERSISTED_EVENT_TEXT = 32 * 1024 * 1024;
const MAX_RESULT_PREVIEW = 64 * 1024;
const MAX_LIVE_PROMPT_BYTES = 128 * 1024;
const MAX_LIVE_PROMPT_LINES = 500;
const ESTIMATED_RENDER_WIDTH = 80;
const LIVE_OMISSION_TEXT = "… earlier live output omitted …";
const PROMPT_OMISSION_TEXT = "… prompt truncated in live view; full prompt remains in the transcript …";

export interface WorkflowTaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
  turns: number;
  toolUses: number;
  retries: number;
  compactions: number;
}

export type WorkflowTimelineKind =
  | "turn"
  | "text"
  | "thinking"
  | "tool"
  | "retry"
  | "compaction"
  | "error"
  | "omitted";

export interface WorkflowTimelineEvent {
  seq: number;
  ts: number;
  kind: WorkflowTimelineKind;
  turn?: number;
  text?: string;
  streaming?: boolean;
  startedAt?: number;
  endedAt?: number;
  toolCallId?: string;
  toolName?: string;
  toolArgs?: string;
  resultPreview?: string;
  isError?: boolean;
  state?: string;
}

export interface WorkflowTaskSummary {
  id: number;
  label: string;
  phase?: string;
  workflowPath: string[];
  status: WorkflowAgentStatus;
  promptPreview: string;
  requestedModelId?: string;
  requestedEffort?: ThinkingLevel;
  modelId?: string;
  effort?: ThinkingLevel;
  usage: WorkflowTaskUsage;
  currentTurn?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  agentType?: string;
  isolation?: string;
  structuredOutput?: boolean;
  cached?: boolean;
  legacyCache?: boolean;
  transcriptPath?: string;
  transcriptOmittedBytes?: number;
}

export interface WorkflowTaskDetail extends WorkflowTaskSummary {
  prompt: string;
  events: WorkflowTimelineEvent[];
}

export interface StartWorkflowTaskInput {
  id: number;
  label: string;
  phase?: string;
  workflowPath?: string[];
  prompt: string;
  modelPattern?: string;
  requestedEffort?: ThinkingLevel;
  agentType?: string;
  isolation?: string;
  structuredOutput?: boolean;
  cached?: boolean;
  cachedRecord?: Partial<WorkflowTaskSummary>;
}

export interface FinishWorkflowTaskInput {
  status: "done" | "error" | "cancelled" | "cached";
  result?: unknown;
  error?: string;
  usage?: AgentUsage;
  modelId?: string;
  effort?: ThinkingLevel;
}

export interface WorkflowRunDetailsManifest {
  version: number;
  runId: string;
  name: string;
  updatedAt: number;
  snapshot: WorkflowSnapshot;
  tasks: WorkflowTaskSummary[];
  transcriptBytes: number;
}

interface InternalTask extends WorkflowTaskDetail {
  eventsLoaded: boolean;
  writer?: BoundedTaskTranscriptWriter;
  promptBytes: number;
  promptLines: number;
  liveBytes: number;
  liveLines: number;
  omittedLiveBytes: number;
}

function emptyUsage(): WorkflowTaskUsage {
  return {
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
  };
}

export function normalizeTaskUsage(value: AgentUsage | Partial<WorkflowTaskUsage> | undefined): WorkflowTaskUsage {
  const inputTokens = finite(value?.inputTokens);
  const outputTokens = finite(value?.outputTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: finite(value?.cacheReadTokens),
    cacheWriteTokens: finite(value?.cacheWriteTokens),
    totalTokens: inputTokens + outputTokens,
    cost: finite(value?.cost),
    turns: finite(value?.turns),
    toolUses: finite(value?.toolUses),
    retries: finite(value?.retries),
    compactions: finite(value?.compactions),
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function displayActualModelId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutThinking = value.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
  return safeDisplayText(withoutThinking, 120) || undefined;
}

function displayRequestedModelId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutThinking = value.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
  const providerSeparator = withoutThinking.indexOf("/");
  return safeDisplayText(providerSeparator >= 0 ? withoutThinking.slice(providerSeparator + 1) : withoutThinking, 120) || undefined;
}

function safeMultiline(value: string, max = MAX_PERSISTED_EVENT_TEXT): string {
  const bounded = value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return safeTranscriptText(bounded, max);
}

function chunkText(value: string, maxChars: number): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += maxChars) {
    chunks.push(value.slice(offset, offset + maxChars));
  }
  return chunks;
}

function joinTranscriptChunks(chunks: Map<number, string>, expectedCount: number): string {
  const output: string[] = [];
  let previous = -1;
  for (const [index, text] of [...chunks.entries()].sort((left, right) => left[0] - right[0])) {
    if (index > previous + 1) output.push("\n… middle transcript chunks omitted …\n");
    output.push(text);
    previous = index;
  }
  if (previous + 1 < expectedCount) output.push("\n… trailing transcript chunks omitted …");
  return output.join("");
}

function safeResult(value: unknown): string | undefined {
  if (typeof value === "string") {
    const text = safeMultiline(value, MAX_RESULT_PREVIEW).trim();
    return text || undefined;
  }
  const text = preview(value, MAX_RESULT_PREVIEW).trim();
  return text || undefined;
}

function advanceRenderedLines(value: string, initialColumn = 0): { added: number; column: number } {
  let added = 0;
  let column = initialColumn;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) {
      added++;
      column = 0;
      continue;
    }
    column++;
    if (column >= ESTIMATED_RENDER_WIDTH) {
      added++;
      column = 0;
    }
  }
  return { added, column };
}

function estimatedRenderedLines(value: string): number {
  return 1 + advanceRenderedLines(value).added;
}

function eventWeight(event: WorkflowTimelineEvent): { bytes: number; lines: number } {
  const text = [event.text, event.resultPreview, event.toolArgs].filter(Boolean).join("\n");
  return {
    bytes: Buffer.byteLength(text, "utf8") + 128,
    lines: estimatedRenderedLines(text),
  };
}

function cloneEvent(event: WorkflowTimelineEvent): WorkflowTimelineEvent {
  return { ...event };
}

function cloneSummary(task: InternalTask): WorkflowTaskSummary {
  return {
    id: task.id,
    label: task.label,
    phase: task.phase,
    workflowPath: [...task.workflowPath],
    status: task.status,
    promptPreview: task.promptPreview,
    requestedModelId: task.requestedModelId,
    requestedEffort: task.requestedEffort,
    modelId: task.modelId,
    effort: task.effort,
    usage: { ...task.usage },
    currentTurn: task.currentTurn,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    durationMs: task.durationMs,
    resultPreview: task.resultPreview,
    error: task.error,
    agentType: task.agentType,
    isolation: task.isolation,
    structuredOutput: task.structuredOutput,
    cached: task.cached,
    legacyCache: task.legacyCache,
    transcriptPath: task.transcriptPath,
    transcriptOmittedBytes: task.transcriptOmittedBytes,
  };
}

/**
 * Deep module for one run's task details. The workflow tool only forwards
 * lifecycle/telemetry events; buffering, redaction, persistence, and restore
 * stay local to this implementation.
 */
export class WorkflowRunDetails {
  readonly runId: string;
  readonly name: string;
  readonly runsDir: string;
  readonly manifestPath: string;

  private readonly tasks = new Map<number, InternalTask>();
  private readonly listeners = new Set<() => void>();
  private readonly streamingLineColumns = new Map<string, number>();
  private readonly artifactBudget: RunArtifactBudget;
  private sequence = 0;
  private viewedTaskId?: number;

  constructor(input: { runId: string; name: string; runsDir: string }) {
    this.runId = input.runId;
    this.name = safeDisplayText(input.name, 120) || "workflow";
    this.runsDir = input.runsDir;
    this.manifestPath = path.join(input.runsDir, `${input.runId}.details.json`);
    const taskDir = this.taskDir();
    try {
      fs.mkdirSync(taskDir, { recursive: true });
    } catch {
      // Artifact persistence is best-effort; live details remain available.
    }
    this.artifactBudget = new RunArtifactBudget(taskDir, MAX_RUN_TRANSCRIPT_PAYLOAD_BYTES);
  }

  static restore(manifestPath: string): { details: WorkflowRunDetails; snapshot: WorkflowSnapshot } | undefined {
    let manifest: WorkflowRunDetailsManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as WorkflowRunDetailsManifest;
    } catch {
      return undefined;
    }
    if (
      manifest.version !== RUN_DETAILS_VERSION
      || !/^wf_[a-z0-9_-]{1,120}$/i.test(manifest.runId ?? "")
      || typeof manifest.name !== "string"
      || !manifest.snapshot
    ) return undefined;
    const details = new WorkflowRunDetails({
      runId: manifest.runId,
      name: manifest.name,
      runsDir: path.dirname(manifestPath),
    });
    for (const rawSummary of Array.isArray(manifest.tasks) ? manifest.tasks : []) {
      const summary = restoreTaskSummary(rawSummary, details.name);
      if (!summary) continue;
      const task: InternalTask = {
        ...summary,
        transcriptPath: isPathInside(summary.transcriptPath, details.taskDir()) ? summary.transcriptPath : undefined,
        workflowPath: [...(summary.workflowPath ?? [details.name])],
        usage: normalizeTaskUsage(summary.usage),
        prompt: summary.promptPreview ?? "",
        events: [],
        eventsLoaded: false,
        promptBytes: Buffer.byteLength(summary.promptPreview ?? "", "utf8"),
        promptLines: estimatedRenderedLines(summary.promptPreview ?? ""),
        liveBytes: 0,
        liveLines: 0,
        omittedLiveBytes: 0,
      };
      details.tasks.set(task.id, task);
      details.sequence = Math.max(details.sequence, task.id);
    }
    let snapshot: WorkflowSnapshot;
    try {
      snapshot = recompute(snapshotForManifest(manifest.snapshot));
    } catch {
      return undefined;
    }
    snapshot.runId = manifest.runId;
    snapshot.detailsManifestPath = manifestPath;
    snapshot.agents = snapshot.agents.map((agent) => ({
      ...agent,
      transcriptPath: isPathInside(agent.transcriptPath, details.taskDir()) ? agent.transcriptPath : undefined,
    }));
    return { details, snapshot };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setViewedTask(id: number | undefined): void {
    this.viewedTaskId = id;
  }

  startTask(input: StartWorkflowTaskInput): WorkflowTaskSummary {
    const restored = this.tasks.get(input.id);
    if (input.cached && restored) {
      restored.status = "cached";
      restored.cached = true;
      restored.currentTurn = undefined;
      this.notify();
      return cloneSummary(restored);
    }

    const prompt = safeTranscriptText(input.prompt, MAX_TASK_TRANSCRIPT_BYTES);
    const cached = input.cachedRecord;
    const task: InternalTask = {
      id: input.id,
      label: safeDisplayText(input.label, 120) || `agent ${input.id}`,
      phase: input.phase ? safeDisplayText(input.phase, 120) : undefined,
      workflowPath: (input.workflowPath?.length ? input.workflowPath : [this.name])
        .map((part) => safeDisplayText(part, 120))
        .filter(Boolean),
      status: input.cached ? "cached" : "running",
      prompt,
      promptPreview: safeDisplayText(prompt, 240),
      requestedModelId: displayRequestedModelId(input.cached ? cached?.requestedModelId ?? input.modelPattern : input.modelPattern),
      requestedEffort: input.cached ? cached?.requestedEffort ?? cached?.effort : input.requestedEffort,
      modelId: displayActualModelId(cached?.modelId),
      effort: cached?.effort,
      usage: normalizeTaskUsage(cached?.usage),
      currentTurn: undefined,
      startedAt: cached?.startedAt ?? Date.now(),
      endedAt: cached?.endedAt,
      durationMs: cached?.durationMs,
      resultPreview: cached?.resultPreview,
      error: cached?.error,
      agentType: input.agentType ? safeDisplayText(input.agentType, 80) : cached?.agentType,
      isolation: input.isolation ? safeDisplayText(input.isolation, 40) : cached?.isolation,
      structuredOutput: input.structuredOutput ?? cached?.structuredOutput,
      cached: Boolean(input.cached),
      legacyCache: cached?.legacyCache ?? Boolean(input.cached && (!cached?.modelId || !cached?.effort)),
      transcriptPath: cached?.transcriptPath,
      transcriptOmittedBytes: cached?.transcriptOmittedBytes,
      events: [],
      eventsLoaded: true,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      promptLines: estimatedRenderedLines(prompt),
      liveBytes: Buffer.byteLength(prompt, "utf8"),
      liveLines: estimatedRenderedLines(prompt),
      omittedLiveBytes: 0,
    };

    if (!input.cached) {
      const writer = new BoundedTaskTranscriptWriter({
        dir: this.taskDir(),
        taskId: input.id,
        budget: this.artifactBudget,
      });
      writer.reset();
      this.persistPrompt(writer, input.id, prompt);
      task.writer = writer;
      task.transcriptPath = writer.finalPath;
    }

    this.tasks.set(input.id, task);
    this.sequence = Math.max(this.sequence, input.id);
    this.trimMemory();
    this.notify();
    return cloneSummary(task);
  }

  record(id: number, event: AgentTelemetryEvent): WorkflowTaskSummary | undefined {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return task ? cloneSummary(task) : undefined;
    const now = Date.now();

    switch (event.kind) {
      case "model_requested":
        task.requestedModelId = displayActualModelId(event.modelId) ?? task.requestedModelId;
        task.requestedEffort = event.effort ?? task.requestedEffort;
        break;
      case "model_resolved":
        task.modelId = displayActualModelId(event.modelId) ?? task.modelId;
        task.effort = event.effort;
        break;
      case "turn_start": {
        const turn = task.usage.turns + 1;
        task.currentTurn = turn;
        this.pushEvent(task, { seq: ++this.sequence, ts: now, kind: "turn", turn, state: "streaming" }, true);
        break;
      }
      case "text_delta": {
        let textEvent = [...task.events].reverse().find((candidate) => candidate.kind === "text" && candidate.streaming);
        if (!textEvent) {
          textEvent = {
            seq: ++this.sequence,
            ts: now,
            kind: "text",
            turn: task.currentTurn ?? task.usage.turns + 1,
            text: "",
            streaming: true,
          };
          this.pushEvent(task, textEvent, false);
        }
        const delta = event.delta.length > MAX_LIVE_TASK_BYTES
          ? safeTranscriptText(event.delta, MAX_LIVE_TASK_BYTES)
          : event.delta;
        const previousText = textEvent.text ?? "";
        const lineKey = `${task.id}:${textEvent.seq}`;
        const previousColumn = this.streamingLineColumns.get(lineKey)
          ?? advanceRenderedLines(previousText).column;
        const lineAdvance = advanceRenderedLines(delta, previousColumn);
        this.streamingLineColumns.set(lineKey, lineAdvance.column);
        textEvent.text = `${previousText}${delta}`;
        task.liveBytes += Buffer.byteLength(delta, "utf8");
        task.liveLines += lineAdvance.added;
        break;
      }
      case "message_end": {
        task.usage.turns++;
        if (event.usage) {
          task.usage.inputTokens += event.usage.inputTokens;
          task.usage.outputTokens += event.usage.outputTokens;
          task.usage.cacheReadTokens += event.usage.cacheReadTokens;
          task.usage.cacheWriteTokens += event.usage.cacheWriteTokens;
          task.usage.totalTokens = task.usage.inputTokens + task.usage.outputTokens;
          task.usage.cost += event.usage.cost;
        }
        const text = safeMultiline(event.text);
        let textEvent = [...task.events].reverse().find((candidate) => candidate.kind === "text" && candidate.streaming);
        if (!textEvent && text) {
          textEvent = {
            seq: ++this.sequence,
            ts: now,
            kind: "text",
            turn: task.currentTurn ?? task.usage.turns,
          };
          task.events.push(textEvent);
        }
        if (textEvent) {
          textEvent.text = text;
          textEvent.streaming = false;
          textEvent.endedAt = now;
          this.streamingLineColumns.delete(`${task.id}:${textEvent.seq}`);
          this.persistTimelineEvent(task, textEvent);
        }
        const thinking = [...task.events].reverse().find(
          (candidate) => candidate.kind === "thinking" && candidate.streaming,
        );
        if (thinking) {
          thinking.streaming = false;
          thinking.state = "done";
          thinking.endedAt = now;
          this.persistTimelineEvent(task, thinking);
        }
        const turnEvent = [...task.events].reverse().find(
          (candidate) => candidate.kind === "turn" && candidate.state === "streaming",
        );
        if (turnEvent) {
          turnEvent.state = "done";
          turnEvent.endedAt = now;
          this.persistTimelineEvent(task, turnEvent);
        }
        task.currentTurn = undefined;
        if (event.error) this.pushError(task, event.error, now);
        this.recomputeTaskWeight(task);
        break;
      }
      case "thinking_start":
        this.pushEvent(task, {
          seq: ++this.sequence,
          ts: now,
          kind: "thinking",
          turn: task.currentTurn,
          state: "streaming",
          streaming: true,
          startedAt: now,
        }, true);
        break;
      case "thinking_end": {
        const thinking = [...task.events].reverse().find((candidate) => candidate.kind === "thinking" && candidate.streaming);
        if (thinking) {
          thinking.streaming = false;
          thinking.state = "done";
          thinking.endedAt = now;
          this.persistTimelineEvent(task, thinking);
        }
        break;
      }
      case "tool_start":
        task.usage.toolUses++;
        this.pushEvent(task, {
          seq: ++this.sequence,
          ts: now,
          kind: "tool",
          turn: task.currentTurn ?? task.usage.turns,
          state: "running",
          streaming: true,
          startedAt: now,
          toolCallId: event.toolCallId,
          toolName: safeDisplayText(event.toolName, 80) || "tool",
          toolArgs: event.toolArgs ? safeDisplayText(event.toolArgs, 240) : undefined,
        }, true);
        break;
      case "tool_end": {
        let tool = [...task.events].reverse().find(
          (candidate) => candidate.kind === "tool" && candidate.toolCallId === event.toolCallId && candidate.streaming,
        );
        if (!tool) {
          tool = {
            seq: ++this.sequence,
            ts: now,
            kind: "tool",
            toolCallId: event.toolCallId,
            toolName: safeDisplayText(event.toolName, 80) || "tool",
            startedAt: now,
          };
          task.events.push(tool);
        }
        tool.streaming = false;
        tool.state = event.isError ? "failed" : "done";
        tool.isError = event.isError;
        tool.endedAt = now;
        tool.resultPreview = event.resultPreview ? safeMultiline(event.resultPreview, 8 * 1024) : undefined;
        this.persistTimelineEvent(task, tool);
        this.recomputeTaskWeight(task);
        break;
      }
      case "retry":
        if (event.state === "start") task.usage.retries++;
        this.pushEvent(task, {
          seq: ++this.sequence,
          ts: now,
          kind: "retry",
          state: event.state,
          text: safeDisplayText(event.detail, 240),
        }, true);
        break;
      case "compaction":
        if (event.state === "start") task.usage.compactions++;
        this.pushEvent(task, {
          seq: ++this.sequence,
          ts: now,
          kind: "compaction",
          state: event.state,
          text: safeDisplayText(event.detail, 240),
        }, true);
        break;
      case "run_error":
        task.modelId = displayActualModelId(event.modelId) ?? task.modelId;
        task.effort = event.effort ?? task.effort;
        task.usage = normalizeTaskUsage(event.usage);
        this.pushError(task, event.error, now);
        break;
    }

    this.trimMemory();
    this.notify();
    return cloneSummary(task);
  }

  finishTask(id: number, input: FinishWorkflowTaskInput): WorkflowTaskSummary | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const now = Date.now();
    task.status = input.status === "cancelled" ? "cancelled" : input.status;
    task.cached = input.status === "cached" || task.cached;
    task.currentTurn = undefined;
    if (input.status !== "cached") {
      task.endedAt = now;
      if (task.startedAt != null) task.durationMs = Math.max(0, now - task.startedAt);
    }
    if (input.usage) task.usage = normalizeTaskUsage(input.usage);
    task.modelId = displayActualModelId(input.modelId) ?? task.modelId;
    task.effort = input.effort ?? task.effort;
    task.resultPreview = safeResult(input.result) ?? task.resultPreview;
    if (input.error) {
      task.error = safeDisplayText(input.error, 512);
      this.pushError(task, input.error, now);
    }

    for (const event of task.events) {
      if (!event.streaming) continue;
      event.streaming = false;
      event.endedAt = now;
      if (event.kind === "text") {
        event.text = safeMultiline(event.text ?? "");
        this.streamingLineColumns.delete(`${task.id}:${event.seq}`);
      }
      if (event.kind === "turn") event.state = input.status === "cancelled" ? "cancelled" : "incomplete";
      if (event.kind === "thinking") event.state = input.status === "cancelled" ? "cancelled" : "incomplete";
      if (event.kind === "tool") event.state = input.status === "cancelled" ? "cancelled" : "incomplete";
      this.persistTimelineEvent(task, event);
    }
    this.recomputeTaskWeight(task);
    if (task.writer) {
      task.transcriptOmittedBytes = task.writer.omittedBytes;
      const finalized = task.writer.finalize();
      task.transcriptOmittedBytes = task.writer.omittedBytes;
      if (finalized) task.writer = undefined;
    }
    this.trimMemory();
    this.notify();
    return cloneSummary(task);
  }

  listTasks(): WorkflowTaskSummary[] {
    return [...this.tasks.values()].sort((a, b) => a.id - b.id).map(cloneSummary);
  }

  getTask(id: number): WorkflowTaskDetail | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    this.loadPersistedEvents(task);
    return {
      ...cloneSummary(task),
      prompt: task.prompt,
      events: task.events.map((event) => ({
        ...cloneEvent(event),
        text: event.text ? safeMultiline(event.text, MAX_LIVE_TASK_BYTES) : undefined,
        resultPreview: event.resultPreview ? safeMultiline(event.resultPreview, 8 * 1024) : undefined,
      })),
    };
  }

  getTaskSummary(id: number): WorkflowTaskSummary | undefined {
    const task = this.tasks.get(id);
    return task ? cloneSummary(task) : undefined;
  }

  persist(snapshot: WorkflowSnapshot): void {
    const manifest: WorkflowRunDetailsManifest = {
      version: RUN_DETAILS_VERSION,
      runId: this.runId,
      name: this.name,
      updatedAt: Date.now(),
      snapshot: snapshotForManifest(snapshot),
      tasks: this.listTasks().map(taskForManifest),
      transcriptBytes: this.artifactBudget.usedBytes,
    };
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
      let serialized = JSON.stringify(manifest, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > MAX_DETAILS_MANIFEST_BYTES) {
        manifest.snapshot.logs = [];
        manifest.snapshot.agents = manifest.snapshot.agents.map((agent) => ({
          ...agent,
          resultPreview: undefined,
          error: undefined,
          activity: undefined,
        }));
        manifest.tasks = manifest.tasks.map((task) => ({
          ...task,
          promptPreview: "",
          resultPreview: undefined,
          error: undefined,
        }));
        serialized = JSON.stringify(manifest);
      }
      if (Buffer.byteLength(serialized, "utf8") > MAX_DETAILS_MANIFEST_BYTES) return;
      const temp = `${this.manifestPath}.tmp-${process.pid}`;
      fs.writeFileSync(temp, serialized, "utf8");
      fs.renameSync(temp, this.manifestPath);
    } catch {
      // Persistence failure does not affect the workflow result.
    }
  }

  close(snapshot: WorkflowSnapshot): void {
    for (const task of this.tasks.values()) {
      if (!task.writer) continue;
      task.transcriptOmittedBytes = task.writer.omittedBytes;
      const finalized = task.writer.finalize();
      task.transcriptOmittedBytes = task.writer.omittedBytes;
      if (finalized) task.writer = undefined;
    }
    this.persist(snapshot);
  }

  private taskDir(): string {
    return path.join(this.runsDir, `${this.runId}.tasks`);
  }

  private pushError(task: InternalTask, error: string, now: number): void {
    task.error = safeDisplayText(error, 512);
    const previous = [...task.events].reverse().find((event) => event.kind === "error");
    if (previous?.text === task.error) return;
    this.pushEvent(task, {
      seq: ++this.sequence,
      ts: now,
      kind: "error",
      text: task.error,
      isError: true,
    }, true);
  }

  private pushEvent(task: InternalTask, event: WorkflowTimelineEvent, persist: boolean): void {
    task.events.push(event);
    const weight = eventWeight(event);
    task.liveBytes += weight.bytes;
    task.liveLines += weight.lines;
    if (persist) this.persistTimelineEvent(task, event);
  }

  private persistPrompt(writer: BoundedTaskTranscriptWriter, taskId: number, prompt: string): void {
    const chunks = chunkText(safeMultiline(prompt), TRANSCRIPT_TEXT_CHUNK_CHARS);
    for (const [chunkIndex, text] of chunks.entries()) {
      writer.append({
        version: RUN_DETAILS_VERSION,
        recordType: "prompt",
        runId: this.runId,
        taskId,
        ts: Date.now(),
        chunkIndex,
        chunkCount: chunks.length,
        text,
      });
    }
  }

  private persistTimelineEvent(task: InternalTask, event: WorkflowTimelineEvent): void {
    if (!task.writer) return;
    const safeEvent: WorkflowTimelineEvent = {
      ...event,
      text: event.text ? safeMultiline(event.text) : undefined,
      resultPreview: event.resultPreview ? safeMultiline(event.resultPreview, 8 * 1024) : undefined,
      toolArgs: event.toolArgs ? safeDisplayText(event.toolArgs, 240) : undefined,
      streaming: event.streaming,
    };
    const chunks = safeEvent.kind === "text" ? chunkText(safeEvent.text ?? "", TRANSCRIPT_TEXT_CHUNK_CHARS) : [safeEvent.text];
    for (const [chunkIndex, text] of chunks.entries()) {
      task.writer.append({
        version: RUN_DETAILS_VERSION,
        recordType: "event",
        runId: this.runId,
        taskId: task.id,
        ts: Date.now(),
        baseSeq: safeEvent.seq,
        chunkIndex,
        chunkCount: chunks.length,
        event: safeEvent.kind === "text" ? { ...safeEvent, text } : safeEvent,
      });
    }
    task.transcriptOmittedBytes = task.writer.omittedBytes;
  }

  private recomputeTaskWeight(task: InternalTask): void {
    task.promptBytes = Buffer.byteLength(task.prompt, "utf8");
    task.promptLines = estimatedRenderedLines(task.prompt);
    task.liveBytes = task.promptBytes;
    task.liveLines = task.promptLines;
    for (const event of task.events) {
      const weight = eventWeight(event);
      task.liveBytes += weight.bytes;
      task.liveLines += weight.lines;
      if (event.kind === "text" && event.streaming) {
        this.streamingLineColumns.set(`${task.id}:${event.seq}`, advanceRenderedLines(event.text ?? "").column);
      }
    }
  }

  private trimMemory(): void {
    for (const task of this.tasks.values()) this.trimTask(task);
    let total = [...this.tasks.values()].reduce((sum, task) => sum + task.liveBytes, 0);
    if (total <= MAX_LIVE_RUN_BYTES) return;

    const candidates = [...this.tasks.values()].sort((a, b) => {
      if (a.id === this.viewedTaskId) return 1;
      if (b.id === this.viewedTaskId) return -1;
      const aDone = a.status === "running" ? 1 : 0;
      const bDone = b.status === "running" ? 1 : 0;
      return aDone - bDone || a.id - b.id;
    });
    for (const task of candidates) {
      while (total > MAX_LIVE_RUN_BYTES) {
        let removed = this.removeOldestEvent(task);
        if (!removed && task.id !== this.viewedTaskId && task.prompt.length > 4 * 1024) {
          const before = Buffer.byteLength(task.prompt, "utf8");
          task.prompt = `${task.prompt.slice(0, 4 * 1024 - 1)}…`;
          this.recomputeTaskWeight(task);
          removed = Math.max(0, before - Buffer.byteLength(task.prompt, "utf8"));
        }
        if (!removed) break;
        total -= removed;
      }
      if (total <= MAX_LIVE_RUN_BYTES) break;
    }
  }

  private trimTask(task: InternalTask): void {
    if (task.promptBytes > MAX_LIVE_PROMPT_BYTES || task.promptLines > MAX_LIVE_PROMPT_LINES) {
      this.truncateLivePrompt(task);
    }
    while (task.liveBytes > MAX_LIVE_TASK_BYTES || task.liveLines > MAX_LIVE_TASK_LINES) {
      if (this.removeOldestEvent(task)) continue;
      if (!this.truncateLivePrompt(task)) break;
    }
  }

  private truncateLivePrompt(task: InternalTask): number {
    const before = Buffer.byteLength(task.prompt, "utf8");
    const lines = task.prompt.split(/\r?\n/);
    let text = lines.slice(0, MAX_LIVE_PROMPT_LINES).join("\n");
    while (Buffer.byteLength(text, "utf8") > MAX_LIVE_PROMPT_BYTES && text.length > 1) {
      text = text.slice(0, Math.floor(text.length * 0.75));
    }
    if (text === task.prompt) return 0;
    task.prompt = `${text}\n${PROMPT_OMISSION_TEXT}`;
    this.recomputeTaskWeight(task);
    return Math.max(1, before - Buffer.byteLength(task.prompt, "utf8"));
  }

  private removeOldestEvent(task: InternalTask): number {
    const index = task.events.findIndex((event) => event.kind !== "omitted" && !event.streaming);
    if (index < 0) {
      const streaming = task.events.find((event) => event.kind === "text" && event.streaming && (event.text?.length ?? 0) > 1024);
      return streaming ? this.shrinkTextEvent(task, streaming) : 0;
    }
    const candidate = task.events[index];
    if (candidate?.kind === "text" && (candidate.text?.length ?? 0) > 1024) {
      return this.shrinkTextEvent(task, candidate);
    }
    const [removed] = task.events.splice(index, 1);
    if (!removed) return 0;
    this.streamingLineColumns.delete(`${task.id}:${removed.seq}`);
    const weight = eventWeight(removed);
    task.liveBytes = Math.max(0, task.liveBytes - weight.bytes);
    task.liveLines = Math.max(0, task.liveLines - weight.lines);
    task.omittedLiveBytes += weight.bytes;
    this.ensureLiveOmissionMarker(task);
    return weight.bytes;
  }

  private shrinkTextEvent(task: InternalTask, event: WorkflowTimelineEvent): number {
    if (!event.text) return 0;
    const before = eventWeight(event).bytes;
    const safeText = event.streaming
      ? safeTranscriptText(event.text, MAX_PERSISTED_EVENT_TEXT)
      : event.text;
    event.text = `…${safeText.slice(-Math.floor(safeText.length / 2))}`;
    this.recomputeTaskWeight(task);
    const removed = Math.max(0, before - eventWeight(event).bytes);
    task.omittedLiveBytes += removed;
    this.ensureLiveOmissionMarker(task);
    return Math.max(1, removed);
  }

  private ensureLiveOmissionMarker(task: InternalTask): void {
    let marker = task.events.find((event) => event.kind === "omitted");
    if (!marker) {
      marker = { seq: -1, ts: Date.now(), kind: "omitted", text: LIVE_OMISSION_TEXT };
      task.events.unshift(marker);
    }
    marker.text = `${LIVE_OMISSION_TEXT} (${formatBytes(task.omittedLiveBytes)})`;
    this.recomputeTaskWeight(task);
  }

  private loadPersistedEvents(task: InternalTask): void {
    if (task.eventsLoaded) return;
    task.eventsLoaded = true;
    if (!task.transcriptPath) return;
    let content: string;
    try {
      const resolved = path.resolve(task.transcriptPath);
      const root = path.resolve(this.taskDir()) + path.sep;
      if (!resolved.startsWith(root)) return;
      content = fs.readFileSync(resolved, "utf8");
    } catch {
      return;
    }
    const loadedEvents = new Map<number, WorkflowTimelineEvent>();
    const eventChunks = new Map<number, { event: WorkflowTimelineEvent; chunks: Map<number, string>; count: number }>();
    const promptChunks = new Map<number, string>();
    let promptChunkCount = 0;
    const omissionEvents: WorkflowTimelineEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as any;
        if (record.recordType === "prompt" && typeof record.text === "string") {
          const index = Number.isFinite(record.chunkIndex) ? record.chunkIndex : 0;
          promptChunks.set(index, record.text);
          promptChunkCount = Math.max(promptChunkCount, Number.isFinite(record.chunkCount) ? record.chunkCount : 1);
        } else if (record.recordType === "event" && record.event?.kind && Number.isFinite(record.event.seq)) {
          const event = record.event as WorkflowTimelineEvent;
          const count = Number.isFinite(record.chunkCount) ? Math.max(1, record.chunkCount) : 1;
          if (event.kind === "text" && count > 1) {
            const seq = Number.isFinite(record.baseSeq) ? record.baseSeq : event.seq;
            const group = eventChunks.get(seq) ?? { event, chunks: new Map<number, string>(), count };
            group.event = event;
            group.count = Math.max(group.count, count);
            group.chunks.set(Number.isFinite(record.chunkIndex) ? record.chunkIndex : 0, event.text ?? "");
            eventChunks.set(seq, group);
          } else {
            loadedEvents.set(event.seq, event);
          }
        } else if (record.recordType === "omitted") {
          omissionEvents.push({
            seq: -1,
            ts: finite(record.ts),
            kind: "omitted",
            text: typeof record.message === "string" ? record.message : LIVE_OMISSION_TEXT,
          });
        }
      } catch {
        // Ignore a partial/corrupt line; later records remain readable.
      }
    }
    if (promptChunks.size > 0) {
      task.prompt = joinTranscriptChunks(promptChunks, promptChunkCount);
      task.promptPreview = safeDisplayText(task.prompt, 240);
    }
    for (const [seq, group] of eventChunks) {
      loadedEvents.set(seq, { ...group.event, seq, text: joinTranscriptChunks(group.chunks, group.count) });
    }
    task.events.push(...omissionEvents, ...[...loadedEvents.values()].sort((left, right) => left.seq - right.seq));
    this.recomputeTaskWeight(task);
    this.trimMemory();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // UI listeners are isolated from execution.
      }
    }
  }
}

function restoreTaskSummary(value: unknown, fallbackName: string): WorkflowTaskSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = Number.isInteger(raw.id) ? Number(raw.id) : 0;
  if (id < 1 || id > 1000) return undefined;
  const statuses: WorkflowAgentStatus[] = ["running", "done", "error", "cancelled", "skipped", "cached"];
  const status = statuses.includes(raw.status as WorkflowAgentStatus) ? raw.status as WorkflowAgentStatus : "cancelled";
  const requestedEffort = normalizeThinkingLevel(raw.requestedEffort);
  const effort = normalizeThinkingLevel(raw.effort);
  const workflowPath = Array.isArray(raw.workflowPath)
    ? raw.workflowPath.filter((part): part is string => typeof part === "string")
    : [fallbackName];
  return taskForManifest({
    id,
    label: typeof raw.label === "string" ? raw.label : `agent ${id}`,
    phase: typeof raw.phase === "string" ? raw.phase : undefined,
    workflowPath,
    status,
    promptPreview: typeof raw.promptPreview === "string" ? raw.promptPreview : "",
    requestedModelId: typeof raw.requestedModelId === "string" ? raw.requestedModelId : undefined,
    requestedEffort,
    modelId: typeof raw.modelId === "string" ? raw.modelId : undefined,
    effort,
    usage: normalizeTaskUsage(raw.usage as Partial<WorkflowTaskUsage> | undefined),
    currentTurn: typeof raw.currentTurn === "number" ? finite(raw.currentTurn) : undefined,
    startedAt: typeof raw.startedAt === "number" ? finite(raw.startedAt) : undefined,
    endedAt: typeof raw.endedAt === "number" ? finite(raw.endedAt) : undefined,
    durationMs: typeof raw.durationMs === "number" ? finite(raw.durationMs) : undefined,
    resultPreview: typeof raw.resultPreview === "string" ? raw.resultPreview : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    agentType: typeof raw.agentType === "string" ? raw.agentType : undefined,
    isolation: typeof raw.isolation === "string" ? raw.isolation : undefined,
    structuredOutput: raw.structuredOutput === true,
    cached: raw.cached === true,
    legacyCache: raw.legacyCache === true,
    transcriptPath: typeof raw.transcriptPath === "string" ? raw.transcriptPath : undefined,
    transcriptOmittedBytes: typeof raw.transcriptOmittedBytes === "number" ? finite(raw.transcriptOmittedBytes) : undefined,
  });
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value))
    ? value as ThinkingLevel
    : undefined;
}

function taskForManifest(task: WorkflowTaskSummary): WorkflowTaskSummary {
  return {
    ...task,
    label: safeDisplayText(task.label, 120),
    phase: task.phase ? safeDisplayText(task.phase, 120) : undefined,
    workflowPath: task.workflowPath.map((part) => safeDisplayText(part, 120)),
    promptPreview: safeDisplayText(task.promptPreview, 240),
    requestedModelId: task.requestedModelId ? safeDisplayText(task.requestedModelId, 120) : undefined,
    modelId: task.modelId ? safeDisplayText(task.modelId, 120) : undefined,
    resultPreview: task.resultPreview ? safeDisplayText(task.resultPreview, 512) : undefined,
    error: task.error ? safeDisplayText(task.error, 512) : undefined,
    agentType: task.agentType ? safeDisplayText(task.agentType, 80) : undefined,
    isolation: task.isolation ? safeDisplayText(task.isolation, 40) : undefined,
  };
}

function snapshotForManifest(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  return {
    ...snapshot,
    name: safeDisplayText(snapshot.name, 120),
    description: snapshot.description ? safeDisplayText(snapshot.description, 240) : undefined,
    phases: snapshot.phases.map((phase) => safeDisplayText(phase, 120)),
    currentPhase: snapshot.currentPhase ? safeDisplayText(snapshot.currentPhase, 120) : undefined,
    logs: snapshot.logs.map((line) => safeDisplayText(line, 512)),
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      label: safeDisplayText(agent.label, 120),
      phase: agent.phase ? safeDisplayText(agent.phase, 120) : undefined,
      workflowPath: agent.workflowPath?.map((part) => safeDisplayText(part, 120)),
      resultPreview: agent.resultPreview ? safeDisplayText(agent.resultPreview, 512) : undefined,
      error: agent.error ? safeDisplayText(agent.error, 512) : undefined,
      requestedModelId: agent.requestedModelId ? safeDisplayText(agent.requestedModelId, 120) : undefined,
      modelId: agent.modelId ? safeDisplayText(agent.modelId, 120) : undefined,
      agentType: agent.agentType ? safeDisplayText(agent.agentType, 80) : undefined,
      isolation: agent.isolation ? safeDisplayText(agent.isolation, 40) : undefined,
      activity: agent.activity ? safeDisplayText(agent.activity, 160) : undefined,
      activeTools: undefined,
      streamTail: undefined,
    })),
    // The result already lives in the resume journal/tool result. Avoid a second
    // potentially huge or hostile serialization in the UI manifest.
    result: undefined,
  };
}

class RunArtifactBudget {
  usedBytes = 0;
  private readonly dir: string;
  private readonly maxBytes: number;

  constructor(dir: string, maxBytes: number) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    try {
      this.usedBytes = fs.readdirSync(dir)
        .filter((name) => /\.(?:jsonl|head|tail)$/.test(name))
        .reduce((sum, name) => sum + fileSize(path.join(dir, name)), 0);
    } catch {
      this.usedBytes = 0;
    }
  }

  reserve(bytes: number): boolean {
    if (this.usedBytes + bytes > this.maxBytes) return false;
    this.usedBytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.usedBytes = Math.max(0, this.usedBytes - Math.max(0, bytes));
  }
}

class BoundedTaskTranscriptWriter {
  readonly finalPath: string;
  readonly headPath: string;
  readonly tailPath: string;
  omittedBytes = 0;
  private headBytes = 0;
  private tailBytes = 0;

  constructor(input: { dir: string; taskId: number; budget: RunArtifactBudget }) {
    this.budget = input.budget;
    this.finalPath = path.join(input.dir, `${input.taskId}.transcript.jsonl`);
    this.headPath = `${this.finalPath}.head`;
    this.tailPath = `${this.finalPath}.tail`;
  }

  private readonly budget: RunArtifactBudget;

  reset(): void {
    for (const target of [this.finalPath, this.headPath, this.tailPath]) {
      const bytes = fileSize(target);
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // best-effort
      }
      this.budget.release(bytes);
    }
    this.headBytes = 0;
    this.tailBytes = 0;
    this.omittedBytes = 0;
  }

  append(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (!this.budget.reserve(bytes)) {
      this.omittedBytes += bytes;
      return;
    }
    try {
      if (this.headBytes + bytes <= TRANSCRIPT_HEAD_BYTES) {
        fs.appendFileSync(this.headPath, line, "utf8");
        this.headBytes += bytes;
      } else {
        fs.appendFileSync(this.tailPath, line, "utf8");
        this.tailBytes += bytes;
        if (this.tailBytes > TRANSCRIPT_TAIL_BYTES) this.compactTail();
      }
    } catch {
      this.budget.release(bytes);
      this.omittedBytes += bytes;
    }
  }

  finalize(): boolean {
    const head = readText(this.headPath);
    const tail = readText(this.tailPath);
    if (!head && !tail && fs.existsSync(this.finalPath)) return true;
    const markerCandidate = this.omittedBytes > 0
      ? `${JSON.stringify({
          version: RUN_DETAILS_VERSION,
          recordType: "omitted",
          ts: Date.now(),
          omittedBytes: this.omittedBytes,
          message: `… ${formatBytes(this.omittedBytes)} of middle transcript omitted …`,
        })}\n`
      : "";
    const markerBytes = Buffer.byteLength(markerCandidate, "utf8");
    const marker = markerBytes <= TRANSCRIPT_MARKER_BYTES && this.budget.reserve(markerBytes)
      ? markerCandidate
      : "";
    const combined = `${head}${marker}${tail}`;
    try {
      fs.mkdirSync(path.dirname(this.finalPath), { recursive: true });
      const temp = `${this.finalPath}.tmp-${process.pid}`;
      fs.writeFileSync(temp, combined, "utf8");
      fs.renameSync(temp, this.finalPath);
      fs.rmSync(this.headPath, { force: true });
      fs.rmSync(this.tailPath, { force: true });
      this.headBytes = 0;
      this.tailBytes = 0;
      return true;
    } catch {
      if (marker) this.budget.release(markerBytes);
      // Keep the head/tail files for recovery when final compaction fails.
      return false;
    }
  }

  private compactTail(): void {
    const content = readText(this.tailPath);
    if (!content) return;
    const lines = content.split("\n").filter(Boolean);
    const kept: string[] = [];
    let keptBytes = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = `${lines[index]}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      if (keptBytes + bytes > TRANSCRIPT_TAIL_BYTES) break;
      kept.unshift(line);
      keptBytes += bytes;
    }
    const removed = Math.max(0, this.tailBytes - keptBytes);
    try {
      fs.writeFileSync(this.tailPath, kept.join(""), "utf8");
      this.tailBytes = keptBytes;
      this.omittedBytes += removed;
      this.budget.release(removed);
    } catch {
      // Leave the original tail in place; a later append can retry compaction.
    }
  }
}

function isPathInside(candidate: string | undefined, rootDir: string): boolean {
  if (!candidate) return false;
  try {
    const resolved = fs.realpathSync(candidate);
    const root = fs.realpathSync(rootDir) + path.sep;
    return resolved.startsWith(root);
  } catch {
    return false;
  }
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${Math.round(bytes)}B`;
}
