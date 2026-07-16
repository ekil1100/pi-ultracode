import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkflowAgentRunner,
  forwardTelemetry,
  type AgentSessionLike,
  type AgentTelemetryEvent,
} from "../src/workflow/agent-runner.ts";
import { createSnapshot, recompute, renderWorkflowLines } from "../src/workflow/display.ts";
import {
  WorkflowRunDetails,
  MAX_LIVE_TASK_BYTES,
  MAX_TASK_TRANSCRIPT_BYTES,
} from "../src/workflow/run-details.ts";
import { WorkflowRegistry, getRegistry } from "../src/workflow/registry.ts";
import { WorkflowOverlayComponent } from "../src/workflow/workflow-overlay.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { runWorkflow } from "../src/workflow/runtime.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";

function fakeSession(overrides: Partial<AgentSessionLike> = {}): AgentSessionLike {
  return {
    thinkingLevel: "medium",
    supportsThinking: () => true,
    prompt: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    dispose: () => {},
    messages: [],
    ...overrides,
  };
}

const plainTheme: any = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
};

test("forwardTelemetry emits visible text, bounded tool previews, and no thinking content", () => {
  const events: AgentTelemetryEvent[] = [];
  const emit = (event: AgentTelemetryEvent) => events.push(event);

  forwardTelemetry({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  }, emit);
  forwardTelemetry({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "hidden chain of thought" },
  }, emit);
  forwardTelemetry({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "npm test" },
  }, emit);
  forwardTelemetry({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    isError: false,
    result: { content: [{ type: "text", text: "ok\nAPI_KEY=TOP_SECRET" }] },
  }, emit);

  assert.deepEqual(events[0], { kind: "text_delta", delta: "hello" });
  assert.equal(events.some((event: any) => JSON.stringify(event).includes("hidden chain of thought")), false);
  const toolEnd = events.find((event) => event.kind === "tool_end") as any;
  assert.match(toolEnd.resultPreview, /API_KEY=\*\*\*/);
  assert.doesNotMatch(toolEnd.resultPreview, /TOP_SECRET/);

  forwardTelemetry({
    type: "tool_execution_end",
    toolCallId: "t2",
    toolName: "bash",
    result: { content: [{ type: "text", text: "界".repeat(10_000) }] },
  }, emit);
  const bounded = events.at(-1) as any;
  assert.ok(Buffer.byteLength(bounded.resultPreview, "utf8") <= 8 * 1024);
});

test("WorkflowAgentRunner reports the actual model, effort, usage, and live telemetry", async () => {
  const messages: any[] = [];
  let listener: ((event: unknown) => void) | undefined;
  const telemetry: AgentTelemetryEvent[] = [];
  const model = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    thinkingLevelMap: { max: "max" },
  };
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    model,
    thinkingLevel: "max",
    createSession: async () => ({
      session: fakeSession({
        model,
        thinkingLevel: "max",
        messages,
        subscribe: (next) => {
          listener = next;
          return () => { listener = undefined; };
        },
        prompt: async () => {
          listener?.({ type: "turn_start", turnIndex: 0 });
          listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "stream" } });
          listener?.({ type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "one.ts" } });
          listener?.({ type: "tool_execution_start", toolCallId: "two", toolName: "read", args: { path: "two.ts" } });
          const message = {
            role: "assistant",
            content: [{ type: "text", text: "stream complete" }],
            usage: { input: 100, output: 40, cacheRead: 500, cacheWrite: 20, cost: { total: 0.25 } },
          };
          messages.push(message);
          listener?.({ type: "message_end", message });
        },
        getSessionStats: () => ({
          assistantMessages: 1,
          toolCalls: 2,
          tokens: { input: 100, output: 40, cacheRead: 500, cacheWrite: 20, total: 660 },
          cost: 0.25,
        }),
      }),
    }),
  });

  const result = await runner.run({
    prompt: "test",
    label: "telemetry",
    onTelemetry: (event) => telemetry.push(event),
  });

  assert.equal(result.modelId, "gpt-5.6-sol");
  assert.equal(result.effort, "max");
  assert.equal(result.usage.totalTokens, 140, "cache traffic is excluded from compact token use");
  assert.equal(result.usage.cacheReadTokens, 500);
  assert.equal(result.usage.turns, 1);
  assert.equal(result.usage.toolUses, 2);
  assert.ok(telemetry.some((event) => event.kind === "model_resolved"));
  assert.ok(telemetry.some((event) => event.kind === "text_delta"));
});

test("WorkflowRunDetails aggregates, redacts, persists, and restores a task timeline", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-"));
  const details = new WorkflowRunDetails({ runId: "wf_details", name: "audit", runsDir: root });
  details.startTask({
    id: 1,
    label: "payments review",
    phase: "Verify",
    workflowPath: ["audit"],
    prompt: "Review payments\nAPI_KEY=PROMPT_SECRET",
    modelPattern: "openai-codex/gpt-5.6-sol:max",
    requestedEffort: "max",
    agentType: "reviewer",
    isolation: "worktree",
    structuredOutput: true,
  });
  details.record(1, { kind: "model_resolved", modelId: "gpt-5.6-sol", effort: "max" });
  details.record(1, { kind: "turn_start", turnIndex: 0 });
  details.record(1, { kind: "text_delta", delta: "Analyzing TOKEN=STREAM_SECRET" });
  const liveTranscriptPath = details.getTaskSummary(1)!.transcriptPath!;
  const pendingDisk = [liveTranscriptPath, `${liveTranscriptPath}.head`, `${liveTranscriptPath}.tail`]
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => fs.readFileSync(candidate, "utf8"))
    .join("\n");
  assert.doesNotMatch(pendingDisk, /Analyzing|STREAM_SECRET/, "raw text deltas are never persisted");
  details.record(1, { kind: "thinking_start" });
  details.record(1, { kind: "thinking_end" });
  details.record(1, { kind: "tool_start", toolCallId: "tool-1", toolName: "bash", toolArgs: "npm test" });
  details.record(1, {
    kind: "tool_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: false,
    resultPreview: "128 tests passed\nPASSWORD=RESULT_SECRET",
  });
  details.record(1, {
    kind: "message_end",
    text: "Analyzing TOKEN=STREAM_SECRET\nDone",
    usage: {
      inputTokens: 109_000,
      outputTokens: 32_000,
      cacheReadTokens: 280_000,
      cacheWriteTokens: 18_000,
      totalTokens: 141_000,
      cost: 1.2345,
    },
  });
  const summary = details.finishTask(1, {
    status: "done",
    result: "Done",
    modelId: "gpt-5.6-sol",
    effort: "max",
    usage: {
      inputTokens: 109_000,
      outputTokens: 32_000,
      cacheReadTokens: 280_000,
      cacheWriteTokens: 18_000,
      totalTokens: 141_000,
      cost: 1.2345,
      turns: 1,
      toolUses: 1,
      retries: 0,
      compactions: 0,
    },
  })!;

  assert.equal(summary.modelId, "gpt-5.6-sol");
  assert.equal(summary.effort, "max");
  assert.equal(summary.usage.totalTokens, 141_000);
  const live = details.getTask(1)!;
  const liveText = JSON.stringify(live);
  assert.doesNotMatch(liveText, /PROMPT_SECRET|STREAM_SECRET|RESULT_SECRET/);
  assert.match(liveText, /\*\*\*/);
  assert.ok(live.events.some((event) => event.kind === "thinking" && event.text === undefined));

  const snapshot = createSnapshot({ name: "audit", description: "x" }, "wf_details", null);
  snapshot.status = "completed";
  details.close(snapshot);
  assert.ok(fs.existsSync(details.manifestPath));
  const manifestDisk = fs.readFileSync(details.manifestPath, "utf8");
  assert.doesNotMatch(manifestDisk, /PROMPT_SECRET|STREAM_SECRET|RESULT_SECRET/);
  assert.ok(summary.transcriptPath && fs.existsSync(summary.transcriptPath));
  const disk = fs.readFileSync(summary.transcriptPath!, "utf8");
  assert.doesNotMatch(disk, /PROMPT_SECRET|STREAM_SECRET|RESULT_SECRET/);

  const restored = WorkflowRunDetails.restore(details.manifestPath)!;
  const restoredTask = restored.details.getTask(1)!;
  assert.equal(restoredTask.label, "payments review");
  assert.equal(restoredTask.usage.totalTokens, 141_000);
  assert.equal(restoredTask.agentType, "reviewer");
  assert.equal(restoredTask.isolation, "worktree");
  assert.equal(restoredTask.structuredOutput, true);
  assert.equal(restoredTask.events.filter((event) => event.kind === "tool").length, 1, "start/end upserts restore as one tool event");
  assert.equal(restoredTask.events.filter((event) => event.kind === "thinking").length, 1);
  assert.ok(
    restoredTask.events.findIndex((event) => event.kind === "turn")
      < restoredTask.events.findIndex((event) => event.kind === "text"),
    "timeline restoration uses event sequence rather than completion write order",
  );
  assert.match(restoredTask.prompt, /API_KEY=\*\*\*/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("WorkflowRunDetails bounds a live streaming task and inserts an omission marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-cap-"));
  const details = new WorkflowRunDetails({ runId: "wf_cap", name: "cap", runsDir: root });
  details.startTask({ id: 1, label: "large", prompt: "p" });
  details.record(1, { kind: "turn_start" });
  details.record(1, { kind: "text_delta", delta: "x".repeat(500_000) });
  const task = details.getTask(1)!;
  assert.ok(task.events.some((event) => event.kind === "omitted"));
  assert.ok(Buffer.byteLength(JSON.stringify(task.events), "utf8") < MAX_LIVE_TASK_BYTES * 1.2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("final task transcripts preserve valid JSONL within the strict 10MB cap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-artifact-cap-"));
  const details = new WorkflowRunDetails({ runId: "wf_artifact_cap", name: "cap", runsDir: root });
  details.startTask({ id: 1, label: "large final", prompt: "p" });
  details.record(1, { kind: "turn_start" });
  details.record(1, {
    kind: "message_end",
    text: "x".repeat(MAX_TASK_TRANSCRIPT_BYTES + 512 * 1024),
  });
  assert.ok(details.getTask(1)?.events.some((event) => event.kind === "text" && event.text?.endsWith("x")));
  const summary = details.finishTask(1, { status: "done", result: "done" })!;
  const snapshot = createSnapshot({ name: "cap", description: "x" }, "wf_artifact_cap", null);
  details.close(snapshot);

  const stat = fs.statSync(summary.transcriptPath!);
  assert.ok(stat.size <= MAX_TASK_TRANSCRIPT_BYTES, `${stat.size} exceeds the per-task artifact cap`);
  const lines = fs.readFileSync(summary.transcriptPath!, "utf8").trim().split("\n");
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(lines.some((line) => JSON.parse(line).recordType === "omitted"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow rendering shows model, effort, turns, tools, and compact token use", () => {
  const snapshot = createSnapshot({ name: "stats", description: "x" }, "wf_stats", null);
  snapshot.agents = [{
    id: 1,
    label: "payments review",
    status: "done",
    modelId: "gpt-5.6-sol",
    effort: "max",
    usage: {
      inputTokens: 109_000,
      outputTokens: 32_000,
      cacheReadTokens: 280_000,
      cacheWriteTokens: 18_000,
      totalTokens: 141_000,
      cost: 1.2345,
      turns: 15,
      toolUses: 42,
      retries: 0,
      compactions: 0,
    },
  }];
  const text = renderWorkflowLines(recompute(snapshot)).join("\n");
  assert.match(text, /gpt-5\.6-sol • max · 15 turns · 42 tool uses · 141k token/);
  assert.doesNotMatch(text, /openai-codex/);

  snapshot.agents = [{ id: 9, label: "starting", status: "running", requestedModelId: "requested-only", requestedEffort: "high" }];
  const unresolved = renderWorkflowLines(recompute(snapshot)).join("\n");
  assert.match(unresolved, /resolving model… • resolving effort…/);
  assert.doesNotMatch(unresolved, /requested-only/, "requested values are not presented as actually applied");

  snapshot.agents = [{ id: 2, label: "legacy", status: "cached", legacyCache: true }];
  const legacy = renderWorkflowLines(recompute(snapshot)).join("\n");
  assert.match(legacy, /model unavailable • effort unavailable · metrics unavailable · cached legacy entry/);
  assert.doesNotMatch(legacy, /0 turns/);

  snapshot.agents = [{
    id: 3,
    label: "cancelled",
    status: "cancelled",
    modelId: "gpt-5.6-sol",
    effort: "max",
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 140,
      cost: 0,
      turns: 1,
      toolUses: 0,
      retries: 0,
      compactions: 0,
    },
  }];
  const partial = renderWorkflowLines(recompute(snapshot)).join("\n");
  assert.match(partial, /140\+ token · partial/);
  assert.match(partial, /1 cancelled/);
});

test("runWorkflow separates new token usage from cached replay usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-cache-"));
  const runId = "wf_cache_details";
  const script = `export const meta = { name: 'cache', description: 'x' }\nreturn await agent('p', { label: 'a' })`;
  const runner = {
    run: async () => ({
      value: "done",
      modelId: "gpt-5.6-sol",
      effort: "max" as const,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 500,
        cacheWriteTokens: 20,
        totalTokens: 140,
        cost: 0.25,
        turns: 2,
        toolUses: 3,
      },
      cwd: process.cwd(),
    }),
  };
  const firstJournal = RunJournal.create(root, { type: "run", runId, name: "cache", scriptHash: "1", startedAt: 0 });
  const first = await runWorkflow(script, { runner, journal: firstJournal });
  firstJournal.close();
  assert.equal(first.newTokens, 140);
  assert.equal(first.replayedTokens, 0);

  const secondJournal = RunJournal.resume(root, runId, { type: "run", runId, name: "cache", scriptHash: "1", startedAt: 1 });
  const second = await runWorkflow(script, {
    runner: { run: async () => { throw new Error("cache miss"); } },
    journal: secondJournal,
  });
  secondJournal.close();
  assert.equal(second.newTokens, 0);
  assert.equal(second.replayedTokens, 140);

  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow tool keeps raw deltas out of tool details while the private task store streams them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-tool-"));
  const runWorkflowFn = (async (_script: string, options: any) => {
    options.onAgentStart?.({
      id: 1,
      label: "stream",
      prompt: "p",
      cached: false,
      workflowPath: ["streaming"],
      requestedEffort: "max",
    });
    options.onAgentTelemetry?.({ id: 1, label: "stream", workflowPath: ["streaming"], kind: "model_resolved", modelId: "gpt-5.6-sol", effort: "max" });
    options.onAgentTelemetry?.({ id: 1, label: "stream", workflowPath: ["streaming"], kind: "turn_start" });
    options.onAgentTelemetry?.({ id: 1, label: "stream", workflowPath: ["streaming"], kind: "text_delta", delta: "LIVE_DELTA" });
    options.onAgentEnd?.({
      id: 1,
      label: "stream",
      workflowPath: ["streaming"],
      status: "done",
      result: "final",
      modelId: "gpt-5.6-sol",
      effort: "max",
      usage: { outputTokens: 2, inputTokens: 3, totalTokens: 5, cost: 0, turns: 1, toolUses: 0 },
    });
    return {
      result: "final",
      agentCount: 1,
      cachedCount: 0,
      spentTokens: 2,
      newTokens: 5,
      replayedTokens: 0,
      durationMs: 1,
      logs: [],
      phases: [],
      meta: { name: "streaming" },
    };
  }) as any;
  const tool = createWorkflowTool({ runWorkflowFn });
  const result = await tool.execute(
    "tc",
    { script: `export const meta = { name: 'streaming', description: 'x' }\nreturn await agent('p')` } as any,
    undefined,
    undefined,
    { cwd: process.cwd(), sessionManager: { getSessionDir: () => root } } as any,
  );
  assert.doesNotMatch(JSON.stringify(result.details), /LIVE_DELTA/);
  assert.ok(fs.existsSync((result.details as any).detailsManifestPath));
  const runId = (result.details as any).runId;
  const task = getRegistry().get(runId)?.details?.getTask(1);
  assert.ok(task);
  assert.match(JSON.stringify(task), /LIVE_DELTA/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("registry restoration marks interrupted runs and tasks as cancelled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-stale-"));
  const details = new WorkflowRunDetails({ runId: "wf_stale", name: "stale", runsDir: root });
  details.startTask({ id: 1, label: "pending", prompt: "p" });
  let snapshot = createSnapshot({ name: "stale", description: "x" }, "wf_stale", null);
  snapshot.agents = [{ id: 1, label: "pending", status: "running" }];
  snapshot = recompute(snapshot);
  details.persist(snapshot);

  const registry = new WorkflowRegistry();
  assert.equal(registry.restoreRuns(root), 1);
  const restored = registry.get("wf_stale")!;
  assert.equal(restored.snapshot.status, "aborted");
  assert.equal(restored.snapshot.agents[0]?.status, "cancelled");
  assert.equal(restored.details?.getTaskSummary(1)?.status, "cancelled");
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow overlay renders responsive task stats and consumes Escape before closing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-overlay-"));
  const registry = new WorkflowRegistry();
  registry.setScope(root);
  const details = new WorkflowRunDetails({ runId: "wf_overlay", name: "audit", runsDir: root });
  details.startTask({
    id: 1,
    label: "payments",
    phase: "Verify",
    prompt: "p",
    modelPattern: "openai-codex/gpt-5.6-sol:max",
    requestedEffort: "max",
    agentType: "reviewer",
    structuredOutput: true,
  });
  details.record(1, { kind: "model_resolved", modelId: "gpt-5.6-sol", effort: "max" });
  details.record(1, { kind: "turn_start" });
  details.record(1, { kind: "text_delta", delta: "streaming output" });
  let snapshot = createSnapshot({ name: "audit", description: "x" }, "wf_overlay", null);
  snapshot.agents = [{ id: 1, label: "payments", phase: "Verify", status: "running" }];
  snapshot = recompute(snapshot);
  registry.register("wf_overlay", snapshot, () => {}, details);

  let renders = 0;
  let closed = 0;
  const tui: any = { terminal: { columns: 120, rows: 40 }, requestRender: () => { renders++; } };
  const component = new WorkflowOverlayComponent({ tui, theme: plainTheme, registry, preferredRunId: "wf_overlay", onClose: () => { closed++; } });
  const text = component.render(120).join("\n");
  assert.match(text, /gpt-5\.6-sol • max/);
  assert.match(text, /cache read 0 · cache write 0/);
  assert.match(text, /cost \$0\.0000/);
  assert.match(text, /role reviewer · structured output/);
  assert.match(text, /streaming output/);

  component.handleInput("\t");
  component.handleInput("\u001b");
  assert.equal(closed, 0, "Escape returns focus from detail to the task list");
  component.handleInput("\u001b");
  assert.equal(closed, 1, "a second Escape closes the overlay");
  component.dispose();

  const narrowTui: any = { terminal: { columns: 70, rows: 30 }, requestRender: () => {} };
  const narrow = new WorkflowOverlayComponent({ tui: narrowTui, theme: plainTheme, registry, preferredRunId: "wf_overlay", onClose: () => {} });
  assert.doesNotMatch(narrow.render(70).join("\n"), /streaming output/);
  narrow.handleInput("\r");
  assert.match(narrow.render(70).join("\n"), /streaming output/, "Enter opens the narrow detail page");
  narrow.handleInput("\u001b");
  assert.doesNotMatch(narrow.render(70).join("\n"), /streaming output/, "Escape returns to the narrow task list");
  narrow.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});
