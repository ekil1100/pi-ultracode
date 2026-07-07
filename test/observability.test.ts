import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWorkflow } from "../src/workflow/runtime.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { forwardActivity } from "../src/workflow/agent-runner.ts";
import {
  createSnapshot,
  recompute,
  renderWorkflowLines,
  IDLE_THRESHOLD_S,
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

test("renderWorkflowLines shows duration for done, elapsed+activity for running, idle past threshold, and stream tail", () => {
  const snap = createSnapshot({ name: "obs", description: "x" }, "wf_obs", null);
  snap.phases = ["Work"];
  const now = 100_000;
  snap.agents = [
    { id: 1, label: "done-agent", phase: "Work", status: "done", durationMs: 45_000 },
    {
      id: 2,
      label: "running-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 23_000,
      lastActivityAt: now - 5_000,
      activity: "bash",
    },
    {
      id: 3,
      label: "idle-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 90_000,
      lastActivityAt: now - (IDLE_THRESHOLD_S + 30) * 1000,
      activity: "text",
    },
    {
      id: 4,
      label: "stream-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 2_000,
      lastActivityAt: now - 500,
      activity: "text",
      streamTail: "partial output here",
    },
  ];
  recompute(snap);

  const lines = renderWorkflowLines(snap, { showStream: true, now });
  const text = lines.join("\n");

  // Done agent shows its run duration.
  assert.match(text, /done-agent · 45s/);
  // Running agent shows elapsed seconds + current activity.
  assert.match(text, /running-agent · 23s · bash/);
  // Idle agent shows elapsed + idle warning (activity suppressed when idle).
  assert.match(text, /idle-agent · 90s · ⚠ idle \d+s/);
  // Stream tail renders under the agent only with showStream.
  assert.match(text, /stream-agent[\s\S]*┊ partial output here/);

  // Without showStream, the tail line is absent.
  const noStream = renderWorkflowLines(snap, { now }).join("\n");
  assert.doesNotMatch(noStream, /┊ partial output here/);
});

test("running agent with no activity shows elapsed only (no activity suffix)", () => {
  const snap = createSnapshot({ name: "na", description: "x" }, "wf_na", null);
  snap.phases = ["Work"];
  const now = 5_000;
  snap.agents = [{ id: 1, label: "fresh", phase: "Work", status: "running", startedAt: 0 }];
  recompute(snap);
  const text = renderWorkflowLines(snap, { now }).join("\n");
  assert.match(text, /fresh · 5s$/m);
});

// ---------------------------------------------------------------------------
// (3) Tool: onAgentActivity wires into snapshot fields (throttled),
//     onAgentStart/onAgentEnd stamp startedAt/durationMs
// ---------------------------------------------------------------------------

test("workflow tool stamps startedAt/durationMs and wires onAgentActivity to lastActivityAt/activity/streamTail", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-tool-"));
  const runner = {
    run: async (call: any) => {
      // Burst of text deltas (throttle coalesces re-renders, but fields mutate).
      for (let i = 0; i < 60; i++) call.onActivity?.({ kind: "text", detail: "x" });
      call.onActivity?.({ kind: "tool", detail: "bash" });
      return { value: "done", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
    },
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const updates: any[] = [];
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'obs', description: 'x' }\nreturn await agent('p', { label: 'a' })`;

  await tool.execute("tc", { script } as any, undefined, (u) => updates.push(u.details), ctx);
  assert.ok(updates.length > 0, "tool streamed progress updates");

  const final = updates[updates.length - 1] as any;
  const agent = final.agents[0];
  assert.equal(agent.status, "done");
  assert.ok(agent.startedAt != null, "startedAt stamped on start");
  assert.ok(agent.durationMs != null && agent.durationMs >= 0, "durationMs stamped on end");
  assert.equal(agent.activity, "bash", "last activity kind/detail wins");
  assert.match(agent.streamTail, /^x+$/, "streamTail accumulated text deltas (capped)");
  assert.ok(agent.streamTail.length <= 240, "streamTail respects the cap");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (4) forwardActivity: real AgentSessionEvent shapes (regression for field names)
// ---------------------------------------------------------------------------

test("forwardActivity maps real AgentSessionEvent shapes to normalized activity", () => {
  const events: Array<{ kind: string; detail?: string }> = [];
  const onActivity = (e: { kind: string; detail?: string }) => events.push(e);

  // text_delta -> text with the delta
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
    onActivity,
  );
  // thinking_delta -> thinking (no detail)
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "..." } },
    onActivity,
  );
  // toolcall_start carries toolName directly (NOT toolCall.name)
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" } },
    onActivity,
  );
  // tool_execution_start carries toolName (NOT tool)
  forwardActivity({ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: {} }, onActivity);

  // irrelevant events are ignored
  forwardActivity({ type: "agent_start" }, onActivity);
  forwardActivity(
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0 } },
    onActivity,
  );
  forwardActivity({ type: "tool_execution_end", toolCallId: "c1", toolName: "grep", result: {} }, onActivity);
  // malformed/unknown never throw
  forwardActivity(null, onActivity);
  forwardActivity({ type: "message_update" }, onActivity);

  assert.deepEqual(events, [
    { kind: "text", detail: "hi" },
    { kind: "thinking" },
    { kind: "tool", detail: "bash" },
    { kind: "tool", detail: "grep" },
  ]);
});
