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
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import { openWorkflowOverlay, WorkflowOverlayComponent } from "../src/workflow/workflow-overlay.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { resolveRepositoryContext } from "../src/workflow/repository-context.ts";
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

  const snapshot = createSnapshot({ name: "audit", description: "x" }, "wf_details");
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

test("WorkflowRunDetails drops legacy budgetTotal while preserving usage on restore and persist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-legacy-budget-"));
  try {
    const details = new WorkflowRunDetails({ runId: "wf_legacy_budget", name: "legacy", runsDir: root });
    details.startTask({ id: 1, label: "usage", prompt: "p" });
    details.finishTask(1, {
      status: "done",
      result: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cost: 0,
      },
    });
    const snapshot = createSnapshot({ name: "legacy", description: "x" }, "wf_legacy_budget");
    snapshot.status = "completed";
    snapshot.spentTokens = 5;
    snapshot.newTokens = 15;
    snapshot.replayedTokens = 7;
    details.close(snapshot);

    const legacyManifest = JSON.parse(fs.readFileSync(details.manifestPath, "utf8"));
    legacyManifest.snapshot.budgetTotal = 123_000;
    fs.writeFileSync(details.manifestPath, `${JSON.stringify(legacyManifest)}\n`);

    const restored = WorkflowRunDetails.restore(details.manifestPath)!;
    assert.equal((restored.snapshot as any).budgetTotal, undefined);
    assert.equal(restored.snapshot.spentTokens, 5);
    assert.equal(restored.snapshot.newTokens, 15);
    assert.equal(restored.snapshot.replayedTokens, 7);
    assert.equal(restored.details.getTask(1)?.usage.totalTokens, 15);

    restored.details.close(restored.snapshot);
    const rewritten = JSON.parse(fs.readFileSync(restored.details.manifestPath, "utf8"));
    assert.equal(rewritten.snapshot.budgetTotal, undefined);
    assert.equal(rewritten.snapshot.spentTokens, 5);
    assert.equal(rewritten.snapshot.newTokens, 15);
    assert.equal(rewritten.snapshot.replayedTokens, 7);
    assert.equal(rewritten.tasks[0].usage.totalTokens, 15);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  const snapshot = createSnapshot({ name: "cap", description: "x" }, "wf_artifact_cap");
  details.close(snapshot);

  const stat = fs.statSync(summary.transcriptPath!);
  assert.ok(stat.size <= MAX_TASK_TRANSCRIPT_BYTES, `${stat.size} exceeds the per-task artifact cap`);
  const lines = fs.readFileSync(summary.transcriptPath!, "utf8").trim().split("\n");
  for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  assert.ok(lines.some((line) => JSON.parse(line).recordType === "omitted"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow rendering shows model, effort, turns, tools, and compact token use", () => {
  const snapshot = createSnapshot({ name: "stats", description: "x" }, "wf_stats");
  snapshot.newTokens = 141_000;
  snapshot.replayedTokens = 62_000;
  snapshot.spentTokens = 32_000;
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
  assert.match(text, /203k token \(141k new, 62k replayed\)/);
  assert.doesNotMatch(text, /\/500k out|\/\d+k out/);
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
  const firstJournal = RunJournal.create(root, { type: "run", projectTrusted: false, targetIdentity: resolveRepositoryContext(process.cwd()).identity, runId, name: "cache", scriptHash: "1", startedAt: 0 });
  const first = await runWorkflow(script, { projectTrusted: false, runner, journal: firstJournal });
  firstJournal.close();
  assert.equal(first.newTokens, 140);
  assert.equal(first.replayedTokens, 0);

  const secondJournal = RunJournal.resume(root, runId, { type: "run", projectTrusted: false, targetIdentity: resolveRepositoryContext(process.cwd()).identity, runId, name: "cache", scriptHash: "1", startedAt: 1 });
  const second = await runWorkflow(script, { projectTrusted: false,
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
  const registry = new WorkflowRegistry();
  const tool = createWorkflowTool({ runWorkflowFn, registry });
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
  const task = registry.get(runId)?.details?.getTask(1);
  assert.ok(task);
  assert.match(JSON.stringify(task), /LIVE_DELTA/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("high-frequency telemetry does not rewrite the durable manifest hot path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-telemetry-hotpath-"));
  try {
    const runWorkflowFn = (async (_script: string, options: any) => {
      options.onAgentStart?.({ id: 1, label: "hot", prompt: "p", cached: false });
      const runsDir = path.join(root, "ultracode-runs");
      const manifestPath = path.join(
        runsDir,
        fs.readdirSync(runsDir).find((entry) => entry.endsWith(".details.json"))!,
      );
      const before = fs.readFileSync(manifestPath, "utf8");
      for (let index = 0; index < 100; index++) {
        options.onAgentTelemetry?.({
          id: 1,
          label: "hot",
          kind: index % 2 === 0 ? "tool_start" : "tool_end",
          toolCallId: `tool-${Math.floor(index / 2)}`,
          toolName: "read",
        });
      }
      assert.equal(
        fs.readFileSync(manifestPath, "utf8"),
        before,
        "telemetry is retained in the bounded transcript without fsyncing the full manifest per event",
      );
      options.onAgentEnd?.({
        id: 1,
        label: "hot",
        status: "done",
        result: "done",
        usage: { outputTokens: 1, inputTokens: 1, totalTokens: 2, cost: 0 },
      });
      return {
        result: "done",
        agentCount: 1,
        cachedCount: 0,
        spentTokens: 1,
        newTokens: 2,
        replayedTokens: 0,
        durationMs: 1,
        logs: [],
        phases: [],
        meta: { name: "telemetry_hotpath" },
      };
    }) as any;
    const tool = createWorkflowTool({ runWorkflowFn });
    await tool.execute(
      "telemetry-hotpath",
      { script: `export const meta = { name: 'telemetry_hotpath', description: 'x' }\nreturn 'done'` } as any,
      undefined,
      undefined,
      { cwd: process.cwd(), sessionManager: { getSessionDir: () => root } } as any,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("details restore rejects a manifest whose runId does not match its filename", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-runid-"));
  try {
    const details = new WorkflowRunDetails({ runId: "wf_run_b", name: "B", runsDir: root });
    const snapshot = createSnapshot({ name: "B", description: "x" }, "wf_run_b");
    details.persist(snapshot);
    const mismatchedPath = path.join(root, "wf_run_a.details.json");
    fs.copyFileSync(details.manifestPath, mismatchedPath);
    assert.equal(WorkflowRunDetails.restore(mismatchedPath), undefined);
    assert.equal(fs.existsSync(path.join(root, "wf_run_a.tasks")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry restoration marks interrupted runs and tasks as cancelled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-stale-"));
  const details = new WorkflowRunDetails({ runId: "wf_stale", name: "stale", runsDir: root });
  details.startTask({ id: 1, label: "pending", prompt: "p" });
  let snapshot = createSnapshot({ name: "stale", description: "x" }, "wf_stale");
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

test("resume generations hide stale task summaries while retaining cached transcripts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-generation-"));
  try {
    const details = new WorkflowRunDetails({ runId: "wf_generation", name: "generation", runsDir: root });
    details.startTask({ id: 1, label: "A", prompt: "a" });
    details.finishTask(1, { status: "done", result: "a" });
    details.startTask({ id: 2, label: "B", prompt: "b" });
    details.finishTask(2, { status: "done", result: "b" });
    const firstTranscript = details.getTaskSummary(1)?.transcriptPath;
    let snapshot = createSnapshot({ name: "generation", description: "x" }, "wf_generation");
    snapshot.agents = [
      { id: 1, label: "A", status: "done" },
      { id: 2, label: "B", status: "done" },
    ];
    details.persist(recompute(snapshot));

    const restored = WorkflowRunDetails.restore(details.manifestPath)!.details;
    restored.beginGeneration();
    assert.deepEqual(restored.listTasks(), []);
    restored.startTask({ id: 1, label: "A", prompt: "a", cached: true });
    assert.deepEqual(restored.listTasks().map((task) => task.id), [1]);
    assert.equal(restored.getTaskSummary(1)?.transcriptPath, firstTranscript);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a resume failure before the first task preserves prior task summaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-empty-generation-"));
  try {
    const details = new WorkflowRunDetails({
      runId: "wf_empty_generation",
      name: "empty_generation",
      runsDir: root,
    });
    details.startTask({ id: 1, callPath: "$/a:0", label: "A", prompt: "a" });
    details.finishTask(1, { status: "done", result: "a" });
    let snapshot = createSnapshot({ name: "empty_generation", description: "x" }, "wf_empty_generation");
    snapshot.agents = [{ id: 1, callPath: "$/a:0", label: "A", status: "done" }];
    details.persist(recompute(snapshot));

    const resumed = WorkflowRunDetails.restore(details.manifestPath)!.details;
    resumed.beginGeneration();
    const failed = createSnapshot({ name: "empty_generation", description: "x" }, "wf_empty_generation");
    failed.status = "failed";
    resumed.close(recompute(failed));

    const restoredAgain = WorkflowRunDetails.restore(details.manifestPath)!.details;
    restoredAgain.beginGeneration();
    const replayed = restoredAgain.startTask({
      id: 1,
      callPath: "$/a:0",
      label: "A",
      prompt: "a",
      cached: true,
    });
    assert.equal(replayed.resultPreview, "a");
    assert.ok(replayed.transcriptPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume task transcripts follow stable callPath instead of completion-order ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-call-path-"));
  try {
    const details = new WorkflowRunDetails({ runId: "wf_call_path", name: "call_path", runsDir: root });
    details.startTask({ id: 1, callPath: "$/p:0/b:0/a:0", label: "A", prompt: "prompt A" });
    details.finishTask(1, { status: "done", result: "A" });
    details.startTask({ id: 2, callPath: "$/p:0/b:1/a:0", label: "B", prompt: "prompt B" });
    details.finishTask(2, { status: "done", result: "B" });
    const bTranscript = details.getTaskSummary(2)?.transcriptPath;
    let snapshot = createSnapshot({ name: "call_path", description: "x" }, "wf_call_path");
    snapshot.agents = [
      { id: 1, callPath: "$/p:0/b:0/a:0", label: "A", status: "done" },
      { id: 2, callPath: "$/p:0/b:1/a:0", label: "B", status: "done" },
    ];
    details.persist(recompute(snapshot));

    const restored = WorkflowRunDetails.restore(details.manifestPath)!.details;
    restored.beginGeneration();
    const replayed = restored.startTask({
      id: 1,
      callPath: "$/p:0/b:1/a:0",
      label: "B",
      prompt: "prompt B",
      cached: true,
    });
    assert.equal(replayed.transcriptPath, bTranscript);
    assert.equal(replayed.label, "B");
    assert.equal(replayed.id, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live reordered calls cannot overwrite another callPath transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-details-transcript-key-"));
  try {
    const details = new WorkflowRunDetails({ runId: "wf_transcript_key", name: "transcript_key", runsDir: root });
    details.startTask({ id: 1, callPath: "$/b", label: "B", prompt: "prompt B" });
    details.finishTask(1, { status: "done", result: "B" });
    details.startTask({ id: 2, callPath: "$/a", label: "A", prompt: "old prompt A" });
    details.finishTask(2, { status: "error", error: "failed" });
    let snapshot = createSnapshot({ name: "transcript_key", description: "x" }, "wf_transcript_key");
    snapshot.agents = [
      { id: 1, callPath: "$/b", label: "B", status: "done" },
      { id: 2, callPath: "$/a", label: "A", status: "error" },
    ];
    details.persist(recompute(snapshot));

    const resumed = WorkflowRunDetails.restore(details.manifestPath)!.details;
    resumed.beginGeneration();
    resumed.startTask({ id: 1, callPath: "$/a", label: "A", prompt: "new prompt A" });
    resumed.startTask({ id: 2, callPath: "$/b", label: "B", prompt: "prompt B", cached: true });
    assert.equal(resumed.getTask(2)?.prompt, "prompt B");
    assert.equal(fs.existsSync(resumed.getTaskSummary(2)?.transcriptPath ?? ""), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("independent registries keep active handles and abort ownership isolated", () => {
  const registryA = new WorkflowRegistry();
  const registryB = new WorkflowRegistry();
  let abortsA = 0;
  let abortsB = 0;
  registryA.register("wf_a", createSnapshot({ name: "a", description: "x" }, "wf_a"), () => { abortsA++; });
  registryB.register("wf_b", createSnapshot({ name: "b", description: "x" }, "wf_b"), () => { abortsB++; });

  assert.ok(registryA.get("wf_a"));
  assert.equal(registryA.get("wf_b"), undefined);
  assert.ok(registryB.get("wf_b"));
  assert.equal(registryB.get("wf_a"), undefined);
  registryA.abortAll();
  assert.equal(abortsA, 1);
  assert.equal(abortsB, 0);
});

test("workflow overlays are isolated by session registry", async () => {
  const firstRegistry = new WorkflowRegistry();
  const secondRegistry = new WorkflowRegistry();
  firstRegistry.register("wf-overlay-a", createSnapshot({ name: "a", description: "x" }, "wf-overlay-a"), () => {});
  secondRegistry.register("wf-overlay-b", createSnapshot({ name: "b", description: "x" }, "wf-overlay-b"), () => {});
  const resolvers: Array<() => void> = [];
  let customCalls = 0;
  const context = (): any => ({
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async () => {
        customCalls++;
        await new Promise<void>((resolve) => resolvers.push(resolve));
      },
    },
  });

  const first = openWorkflowOverlay(context(), firstRegistry);
  await new Promise((resolve) => setImmediate(resolve));
  const second = openWorkflowOverlay(context(), secondRegistry);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(customCalls, 2, "one session's open overlay must not block another session");
  for (const resolve of resolvers) resolve();
  await Promise.all([first, second]);
});

test("workflow overlay renders responsive task stats and routes navigation in regular and fullscreen TUI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-overlay-"));
  const registry = new WorkflowRegistry();
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
  let snapshot = createSnapshot({ name: "audit", description: "x" }, "wf_overlay");
  snapshot.agents = [{ id: 1, label: "payments", phase: "Verify", status: "running" }];
  snapshot = recompute(snapshot);
  registry.register("wf_overlay", snapshot, () => {}, details);

  let renders = 0;
  let closed = 0;
  const tui: any = { mode: "regular", terminal: { columns: 120, rows: 40 }, requestRender: () => { renders++; } };
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

  const narrowTui: any = { mode: "regular", terminal: { columns: 70, rows: 30 }, requestRender: () => {} };
  const narrow = new WorkflowOverlayComponent({ tui: narrowTui, theme: plainTheme, registry, preferredRunId: "wf_overlay", onClose: () => {} });
  assert.doesNotMatch(narrow.render(70).join("\n"), /streaming output/);
  narrow.handleInput("\r");
  assert.match(narrow.render(70).join("\n"), /streaming output/, "Enter opens the narrow detail page");
  narrow.handleInput("\u001b");
  assert.doesNotMatch(narrow.render(70).join("\n"), /streaming output/, "Escape returns to the narrow task list");
  narrow.dispose();

  for (let id = 2; id <= 12; id++) {
    details.startTask({ id, callPath: `$/task-${id}`, label: `task-${id}`, phase: "Verify", prompt: "p" });
    details.finishTask(id, { status: "done", result: `result-${id}` });
  }
  const fullscreenTui: any = {
    mode: "fullscreen",
    terminal: { columns: 120, rows: 40 },
    requestRender: () => {},
  };
  const fullscreen = new WorkflowOverlayComponent({
    tui: fullscreenTui,
    theme: plainTheme,
    registry,
    preferredRunId: "wf_overlay",
    onClose: () => {},
  });
  let fullscreenText = fullscreen.render(120).join("\n");
  assert.match(fullscreenText, /Ctrl\+PgUp\/Dn scroll.*Ctrl\+End follow/);
  assert.match(fullscreenText, /#1 payments/);
  fullscreen.handleInput("\u001b[6^");
  fullscreenText = fullscreen.render(120).join("\n");
  assert.match(fullscreenText, /#11 task-11/, "Ctrl+PageDown pages the fullscreen task list");

  fullscreen.handleInput("\t");
  fullscreen.handleInput("\u001b[5^");
  assert.match(fullscreen.render(120).join("\n"), /Ctrl\+End to follow/, "Ctrl+PageUp leaves follow mode");
  fullscreen.handleInput("\u001b[6^");
  assert.match(fullscreen.render(120).join("\n"), /Ctrl\+End to follow/, "Ctrl+PageDown keeps manual scrolling active");
  fullscreen.handleInput("\u001b[8^");
  assert.match(fullscreen.render(120).join("\n"), /Ctrl\+End follow/, "Ctrl+End restores fullscreen follow mode");
  fullscreen.dispose();

  fs.rmSync(root, { recursive: true, force: true });
});
