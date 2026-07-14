import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWorkflow } from "../src/workflow/runtime.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { forwardActivity, toolArgsPreview, type AgentActivityInput } from "../src/workflow/agent-runner.ts";
import {
  createSnapshot,
  recompute,
  renderWorkflowLines,
} from "../src/workflow/display.ts";

// ---------------------------------------------------------------------------
// (1) Per-agent duration + activity plumbing through the runtime
// ---------------------------------------------------------------------------

test("onAgentStart/onAgentEnd fire with timing; onAgentActivity is forwarded with id/label/phase", async () => {
  const starts: Array<{ id: number; label: string; phase?: string; cached: boolean }> = [];
  const ends: Array<{ id: number; label: string; status: string }> = [];
  const activity: Array<{ id: number; label: string; phase?: string; kind: string; detail?: string }> = [];

  const runner = {
    run: async (call: any) => {
      // Simulate a subagent that streams text, thinks, and calls a tool.
      call.onActivity?.({ kind: "text", detail: "hi" });
      call.onActivity?.({ kind: "thinking" });
      call.onActivity?.({ kind: "tool", detail: "bash" });
      return { value: `v:${call.label}`, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'act', description: 'x' }
     phase('Work')
     return await agent('p', { label: 'lbl' })`,
    {
      runner,
      onAgentStart: (e) => starts.push({ id: e.id, label: e.label, phase: e.phase, cached: e.cached }),
      onAgentEnd: (e) => ends.push({ id: e.id, label: e.label, status: e.status }),
      onAgentActivity: (e) => activity.push({ id: e.id, label: e.label, phase: e.phase, kind: e.kind, detail: e.detail }),
    },
  );

  assert.equal(result.result, "v:lbl");
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(starts[0].label, "lbl");
  assert.equal(starts[0].phase, "Work");
  assert.equal(starts[0].cached, false);
  assert.equal(ends[0].status, "done");

  assert.equal(activity.length, 3, "all three activity signals forwarded");
  assert.deepEqual(activity[0], { id: 1, label: "lbl", phase: "Work", kind: "text", detail: "hi" });
  assert.deepEqual(activity[1], { id: 1, label: "lbl", phase: "Work", kind: "thinking", detail: undefined });
  assert.deepEqual(activity[2], { id: 1, label: "lbl", phase: "Work", kind: "tool", detail: "bash" });
});

test("cached (resumed) agents do not emit onAgentActivity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-act-cache-"));
  const runId = "wf_actcache";
  const script = `export const meta = { name: 'c', description: 'x' }\nreturn await agent('a', { label: 'a' })`;

  // Live run: runner is called once and emits one activity event.
  let liveCalls = 0;
  let liveActivity = 0;
  const liveRunner = {
    run: async (call: any) => {
      liveCalls++;
      call.onActivity?.({ kind: "text", detail: "live" });
      return { value: "x", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
    },
  };
  const j1 = RunJournal.create(dir, { type: "run", runId, name: "c", scriptHash: "1", startedAt: 0 });
  await runWorkflow(script, { runner: liveRunner, journal: j1, onAgentActivity: () => liveActivity++ });
  j1.close();
  assert.equal(liveCalls, 1, "live run calls the runner once");
  assert.equal(liveActivity, 1, "live run emits one activity event");

  // Resume: cached prefix replays without calling the runner or emitting activity.
  let cachedCalls = 0;
  let cachedActivity = 0;
  const cachedRunner = {
    run: async (call: any) => {
      cachedCalls++;
      call.onActivity?.({ kind: "text" });
      return { value: "y", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
    },
  };
  const j2 = RunJournal.resume(dir, runId, { type: "run", runId, name: "c", scriptHash: "1", startedAt: 1 });
  await runWorkflow(script, { runner: cachedRunner, journal: j2, onAgentActivity: () => cachedActivity++ });
  j2.close();
  assert.equal(cachedCalls, 0, "cached replay must not call the runner");
  assert.equal(cachedActivity, 0, "cached replay must not emit activity");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("journal records per-agent startedAt/durationMs in the .jsonl log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-time-"));
  const runId = "wf_journaltime";
  const script = `export const meta = { name: 'jt', description: 'x' }\nreturn await agent('p', { label: 'a' })`;
  const runner = {
    run: async (call: any) => {
      call.onActivity?.({ kind: "text", detail: "x" });
      return { value: "v", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
    },
  };
  const j = RunJournal.create(dir, { type: "run", runId, name: "jt", scriptHash: "1", startedAt: 0 });
  await runWorkflow(script, { runner, journal: j });
  j.close();

  const log = fs
    .readFileSync(path.join(dir, `${runId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const agentRec = log.find((r: any) => r.type === "agent");
  assert.ok(agentRec, "agent record present");
  assert.equal(agentRec.label, "a");
  assert.ok(agentRec.startedAt != null, "startedAt persisted to journal");
  assert.ok(agentRec.durationMs != null && agentRec.durationMs >= 0, "durationMs persisted to journal");

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (2) Display: duration / elapsed / activity / idle / stream rendering
// ---------------------------------------------------------------------------

test("renderWorkflowLines keeps the last known state visible when an agent stops emitting events", () => {
  const snap = createSnapshot({ name: "obs", description: "x" }, "wf_obs", null);
  snap.phases = ["Work"];
  const now = 337_000;
  snap.agents = [
    { id: 1, label: "done-agent", phase: "Work", status: "done", durationMs: 45_000 },
    { id: 5, label: "boundary-agent", phase: "Work", status: "done", durationMs: 119_600 },
    {
      id: 2,
      label: "running-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 23_000,
      lastActivityAt: now - 5_000,
      activity: "waiting for model",
    },
    {
      id: 3,
      label: "silent-agent",
      phase: "Work",
      status: "running",
      startedAt: 0,
      lastActivityAt: now - 259_000,
      activity: "waiting for model",
      streamTail: "last model output",
    },
    {
      id: 4,
      label: "stream-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 2_000,
      lastActivityAt: now - 500,
      activity: "responding",
      streamTail: "partial output here",
    },
  ];
  const computed = recompute(snap);

  const lines = renderWorkflowLines(computed, { showStream: true, now });
  const text = lines.join("\n");

  assert.match(text, /done-agent · 45s/);
  assert.match(text, /boundary-agent · 2m/);
  assert.doesNotMatch(text, /1m 60s/);
  assert.match(text, /running-agent · 23s · waiting for model/);
  assert.match(text, /silent-agent · 337s · ⚠ no events 259s · last: waiting for model/);
  assert.match(text, /silent-agent[\s\S]*┊ last model output/);
  assert.match(text, /stream-agent[\s\S]*┊ partial output here/);

  // Compact rendering never exposes raw output without an explicit inspect view.
  const compact = renderWorkflowLines(computed, { now }).join("\n");
  assert.doesNotMatch(compact, /┊ last model output/);
  assert.doesNotMatch(compact, /┊ partial output here/);
});

test("renderWorkflowLines surfaces the stalest concurrent tool", () => {
  const now = 400_000;
  const snap = createSnapshot({ name: "tool", description: "x" }, "wf_tool", null);
  snap.agents = [{
    id: 1,
    label: "tests",
    status: "running",
    startedAt: now - 337_000,
    // A newer tool keeps the agent-level activity fresh while an older tool is stuck.
    lastActivityAt: now - 1_000,
    activity: "running tool",
    activeTools: [
      {
        id: "stuck",
        name: "bash",
        args: "npm test",
        startedAt: now - 300_000,
        lastUpdateAt: now - 259_000,
      },
      {
        id: "active",
        name: "read",
        args: "README.md",
        startedAt: now - 10_000,
        lastUpdateAt: now - 1_000,
      },
    ],
  }];

  const text = renderWorkflowLines(recompute(snap), { now }).join("\n");
  assert.match(text, /tests · 337s · running bash: npm test \(5m\) \+1 more · ⚠ no tool events 259s/);
  assert.doesNotMatch(text, /⚠ idle/);

  snap.agents[0].activeTools![0].lastUpdateAt = now - 20_000;
  const belowThreshold = renderWorkflowLines(recompute(snap), { now }).join("\n");
  assert.match(belowThreshold, /running bash: npm test/);
  assert.doesNotMatch(belowThreshold, /no tool events/);
});

test("renderWorkflowLines strips terminal controls and keeps the newest output tail", () => {
  const now = 40_000;
  const snap = createSnapshot({ name: "tail\u001b]52;c;name-spoof\u0007", description: "x" }, "wf_tail", null);
  snap.agents = [
    {
      id: 1,
      label: "worker\u001b]0;spoofed\u0007",
      status: "running",
      startedAt: 0,
      lastActivityAt: now,
      activity: "responding",
      streamTail: `${"old".repeat(60)}\u001b[2JLATEST`,
    },
    {
      id: 2,
      label: "tool-worker",
      status: "running",
      startedAt: 0,
      lastActivityAt: now,
      activity: "running tool",
      activeTools: [{
        id: "tool",
        name: "bash\u001b]0;tool-spoof\u0007",
        startedAt: now - 1_000,
        lastUpdateAt: now,
      }],
    },
  ];

  const text = renderWorkflowLines(recompute(snap), { now, showStream: true }).join("\n");
  assert.match(text, /worker/);
  assert.match(text, /….*LATEST/);
  assert.doesNotMatch(text, /spoofed|tool-spoof|name-spoof|\u001b|\u0007|\[2J/);
});

test("running agent with no activity shows elapsed only (no activity suffix)", () => {
  const snap = createSnapshot({ name: "na", description: "x" }, "wf_na", null);
  snap.phases = ["Work"];
  const now = 5_000;
  snap.agents = [{ id: 1, label: "fresh", phase: "Work", status: "running", startedAt: 0 }];
  const text = renderWorkflowLines(recompute(snap), { now }).join("\n");
  assert.match(text, /fresh · 5s$/m);
});

// ---------------------------------------------------------------------------
// (3) Tool: onAgentActivity wires into snapshot fields (throttled),
//     onAgentStart/onAgentEnd stamp startedAt/durationMs
// ---------------------------------------------------------------------------

test("workflow tool wires text and tool lifecycle into live snapshots", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-tool-"));
  const runner = {
    run: async (call: any) => {
      // Burst of text deltas (throttle coalesces re-renders, but fields mutate).
      for (let i = 0; i < 60; i++) call.onActivity?.({ kind: "text", detail: "x", streamDelta: "x" });
      call.onActivity?.({
        kind: "tool",
        detail: "bash: npm test",
        toolCallId: "c1",
        toolName: "bash",
        toolArgs: "npm test",
        toolState: "start",
      });
      // Cross the render throttle so the running-tool snapshot is observable.
      await new Promise((resolve) => setTimeout(resolve, 220));
      call.onActivity?.({
        kind: "tool",
        detail: "bash: npm test",
        toolCallId: "c1",
        toolName: "bash",
        toolArgs: "npm test",
        toolState: "update",
      });
      call.onActivity?.({
        kind: "tool",
        detail: "bash finished",
        toolCallId: "c1",
        toolName: "bash",
        toolState: "end",
      });
      return { value: "done", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
    },
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const updates: any[] = [];
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'obs', description: 'x' }\nreturn await agent('p', { label: 'a' })`;

  const result = await tool.execute(
    "tc",
    { script } as any,
    undefined,
    (update) => updates.push(structuredClone(update.details)),
    ctx,
  );
  assert.ok(updates.length > 0, "tool streamed progress updates");

  const runningTool = updates.find((update) => update.agents?.[0]?.activeTools?.length > 0);
  assert.equal(runningTool.agents[0].activeTools[0].name, "bash");
  assert.equal(runningTool.agents[0].activeTools[0].args, "npm test");
  assert.equal(runningTool.agents[0].streamTail, undefined, "tool output is not copied into status");

  const final = updates[updates.length - 1] as any;
  const agent = final.agents[0];
  assert.equal(agent.status, "done");
  assert.ok(agent.startedAt != null, "startedAt stamped on start");
  assert.ok(agent.durationMs != null && agent.durationMs >= 0, "durationMs stamped on end");
  assert.equal(agent.activity, "bash finished");
  assert.equal(agent.activeTools, undefined, "finished agents do not retain active tools");
  assert.equal(agent.streamTail, undefined, "live output is removed before final details are persisted");
  assert.equal((result.details as any).agents[0].streamTail, undefined);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("workflow tool does not append text lifecycle labels to the output tail", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-text-"));
  const runner = {
    run: async (call: any) => {
      call.onActivity?.({ kind: "text", detail: "responding" });
      call.onActivity?.({ kind: "text", detail: "hello", streamDelta: "hello" });
      await new Promise((resolve) => setTimeout(resolve, 220));
      call.onActivity?.({ kind: "text", detail: "responding" });
      return { value: "done", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
    },
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const updates: any[] = [];
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'text', description: 'x' }\nreturn await agent('p', { label: 'a' })`;

  await tool.execute(
    "tc-text",
    { script } as any,
    undefined,
    (update) => updates.push(structuredClone(update.details)),
    ctx,
  );

  const live = updates.find((update) => update.agents?.[0]?.streamTail === "hello");
  assert.ok(live, "text_start/text_end labels must not contaminate the streamed text tail");
  assert.equal(updates.at(-1).agents[0].streamTail, undefined);
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("toolArgsPreview uses a safe command synopsis and ignores free-form payloads", () => {
  const commands = [
    "curl --user alice:s3cret https://example.test",
    "curl -uuser:s3cret https://example.test",
    "curl -H 'X-Api-Key: qwerty' https://example.test",
    "curl 'https://example.test/?client_secret=hidden'",
  ];
  for (const command of commands) {
    const preview = toolArgsPreview({ command }, 200);
    assert.ok(preview);
    assert.match(preview, /^curl …$/);
    assert.doesNotMatch(preview, /alice|s3cret|user|qwerty|hidden|sk-secret|example/);
  }
  assert.equal(
    toolArgsPreview({ command: "OPENAI_API_KEY='sk-secret value' curl https://example.test" }, 200),
    "environment-prefixed command",
  );
  assert.equal(toolArgsPreview({ command: "npm test -- --runInBand" }), "npm test");
  assert.equal(toolArgsPreview({ command: "https://user:pass@example.test/?token=hidden --flag" }), "command");
  assert.equal(toolArgsPreview({ command: "constructor anything" }), "command");
  assert.equal(toolArgsPreview({ command: "./sk-abcdefgh" }), "command");
  assert.equal(toolArgsPreview({ query: "private search text" }), undefined);
});

test("late activity cannot repopulate a failed workflow snapshot", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-late-"));
  const notifications: string[] = [];
  const runWorkflowFn = (async (_script: string, options: any) => {
    options.onAgentStart?.({ id: 1, label: "late", prompt: "p", cached: false });
    setTimeout(() => options.onAgentActivity?.({
      id: 1,
      label: "late",
      kind: "tool",
      detail: "bash: late",
      toolCallId: "late-call",
      toolName: "bash",
      toolArgs: "late",
      toolState: "start",
    }), 10);
    throw new Error("script failed \u001b]52;c;error-spoof\u0007");
  }) as any;
  const tool = createWorkflowTool({ runWorkflowFn });
  const updates: any[] = [];
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: { getSessionDir: () => sessionDir },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const script = `export const meta = { name: 'late', description: 'x' }\nreturn await agent('p')`;

  await assert.rejects(
    tool.execute("tc-late", { script } as any, undefined, (update) => updates.push(structuredClone(update.details)), ctx),
    /script failed/,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  const final = updates.at(-1);
  assert.equal(final.status, "failed");
  assert.equal(final.agents[0].status, "skipped");
  assert.equal(final.agents[0].activeTools, undefined);
  assert.equal(final.agents[0].streamTail, undefined);
  assert.equal(notifications.length, 1);
  assert.doesNotMatch(notifications[0], /error-spoof|\u001b|\u0007/);
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("workflow sanitizes names in notifications and rejects unsafe resume ids", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-name-"));
  const notifications: string[] = [];
  const runner = {
    run: async () => ({
      value: "done",
      usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
      cwd: process.cwd(),
    }),
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: { getSessionDir: () => sessionDir },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const script = String.raw`export const meta = { name: 'safe\u001b]52;c;name-spoof\u0007', description: 'x' }
return await agent('p')`;

  const result = await tool.execute("tc-name", { script } as any, undefined, undefined, ctx);
  assert.doesNotMatch(notifications[0], /name-spoof|\u001b|\u0007/);
  assert.doesNotMatch((result.content[0] as any).text, /name-spoof|\u001b|\u0007/);
  assert.doesNotMatch((result.details as any).name, /name-spoof|\u001b|\u0007/);

  await assert.rejects(
    tool.execute("tc-id", { script, resumeFromRunId: "../escape\u001b]0;x\u0007" } as any, undefined, undefined, ctx),
    /resumeFromRunId must contain only/,
  );
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (4) forwardActivity: real AgentSessionEvent shapes (regression for field names)
// ---------------------------------------------------------------------------

test("forwardActivity preserves provider, tool, retry, and compaction state from real AgentSessionEvent shapes", () => {
  const events: AgentActivityInput[] = [];
  const onActivity = (event: AgentActivityInput) => events.push(event);
  const rawEvents: AgentSessionEvent[] = [
    { type: "agent_start" },
    { type: "turn_start" },
    {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "sleep 300" },
    },
    {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "sleep 300" },
      partialResult: { content: [{ type: "text", text: "still running" }] },
    },
    {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    },
    {
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 8_000,
      errorMessage: "overloaded_error",
    },
    { type: "compaction_start", reason: "overflow" },
  ];

  for (const event of rawEvents) forwardActivity(event, onActivity);

  assert.deepEqual(events[0], { kind: "waiting", detail: "starting agent" });
  assert.deepEqual(events[1], { kind: "waiting", detail: "waiting for model" });
  assert.deepEqual(events[2], {
    kind: "tool",
    detail: "bash: sleep 300",
    toolCallId: "c1",
    toolName: "bash",
    toolArgs: "sleep 300",
    toolState: "start",
  });
  const toolUpdate = events[3];
  const toolEnd = events[4];
  assert.ok(toolUpdate.kind === "tool");
  assert.ok(toolEnd.kind === "tool");
  assert.equal(toolUpdate.toolState, "update");
  assert.equal(toolEnd.toolState, "end");
  assert.equal("streamSnapshot" in toolUpdate, false, "raw tool output must not enter activity status");
  assert.equal("streamSnapshot" in toolEnd, false, "raw tool output must not enter activity status");
  assert.deepEqual(events[5], {
    kind: "retry",
    detail: "retry 2/3 in 8s: overloaded_error",
  });
  assert.deepEqual(events[6], {
    kind: "compaction",
    detail: "context overflow; compacting",
  });
});

test("forwardActivity maps streaming message blocks using the installed SDK field shapes", () => {
  const events: AgentActivityInput[] = [];
  const onActivity = (event: AgentActivityInput) => events.push(event);

  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
    onActivity,
  );
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "..." } },
    onActivity,
  );
  // toolcall_start has no toolName in Pi 0.80.6; the completed tool call does.
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } },
    onActivity,
  );
  forwardActivity(
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "c1", name: "read", arguments: { path: "README.md" } },
      },
    },
    onActivity,
  );

  forwardActivity(null, onActivity);
  forwardActivity({ type: "message_update" }, onActivity);

  assert.deepEqual(events, [
    { kind: "text", detail: "hi", streamDelta: "hi" },
    { kind: "thinking", detail: "thinking" },
    { kind: "waiting", detail: "preparing tool call" },
    { kind: "waiting", detail: "preparing read: README.md" },
  ]);
});
