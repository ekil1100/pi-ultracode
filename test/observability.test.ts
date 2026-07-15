import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_WORKFLOW_LOGS,
  WORKFLOW_LOG_OMITTED_TEXT,
  runWorkflow,
} from "../src/workflow/runtime.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { forwardActivity, toolArgsPreview, type AgentActivityInput } from "../src/workflow/agent-runner.ts";
import {
  DISPLAY_INPUT_LIMIT,
  DISPLAY_OMITTED_TEXT,
  redactCommand,
  safeDisplayTail,
  safeDisplayText,
  stripTerminalControls,
} from "../src/workflow/display-text.ts";
import {
  createSnapshot,
  preview,
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
      call.onActivity?.({ kind: "text", detail: "responding" });
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
  assert.deepEqual(activity[0], { id: 1, label: "lbl", phase: "Work", kind: "text", detail: "responding" });
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
      call.onActivity?.({ kind: "text", detail: "responding" });
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
    },
    {
      id: 4,
      label: "stream-agent",
      phase: "Work",
      status: "running",
      startedAt: now - 2_000,
      lastActivityAt: now - 500,
      activity: "responding",
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
  assert.match(text, /stream-agent · 2s · responding/);
  assert.doesNotMatch(text, /┊/);
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

test("renderWorkflowLines strips terminal controls and ignores deprecated stream tails", () => {
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
  assert.doesNotMatch(text, /LATEST|oldold|┊/);
  assert.doesNotMatch(text, /spoofed|tool-spoof|name-spoof|\u001b|\u0007|\[2J/);
});

test("display safety consumes structured, escaped, and unterminated secrets", () => {
  const redacted = [
    redactCommand('Authorization: "Bearer topsecret"'),
    redactCommand('Authorization: "Bearer unterminated-secret'),
    redactCommand("Authorization: 'Bearer unterminated-single"),
    redactCommand('{"Authorization":"Bearer jsonsecret"}'),
    redactCommand(String.raw`{"x-api-key":"prefix\"ESCAPED_SECRET"}`),
    redactCommand('{"Authorization":["Bearer ARRAY_SECRET"]}'),
    redactCommand('{"client-secret":{"value":"OBJECT_SECRET"}}'),
    redactCommand("postgres://alice:DSN_SECRET@db.example/app"),
    redactCommand("Author\u200Bization: Bearer ZERO_WIDTH_SECRET"),
    redactCommand("Author\u180Fization: Bearer MONGOLIAN_VARIATION_SECRET"),
    redactCommand('failed(Authorization:"Bearer PAREN_SECRET")'),
    redactCommand("{'Authorization':'Bearer SINGLE_KEY_SECRET'}"),
    redactCommand('Authorization: Digest username="alice", realm="r", response="DIGEST_SECRET"'),
    redactCommand('_postgres://alice:PREFIX_URI_SECRET@db.example/app'),
    redactCommand('X-Auth-Token: X_AUTH_SECRET'),
    redactCommand('Cookie: session=COOKIE_SECRET'),
    redactCommand('Set-Cookie: session=SET_COOKIE_SECRET'),
    redactCommand('?refresh_token=REFRESH_SECRET&id_token=ID_SECRET'),
    redactCommand("curl -HAuthorization: Bearer CURL_HEADER_SECRET"),
    redactCommand("curl -H 'Authorization: Bearer QUOTED_CURL_SECRET'"),
  ].join(" ");
  assert.doesNotMatch(
    redacted,
    /topsecret|unterminated-secret|unterminated-single|jsonsecret|ESCAPED_SECRET|ARRAY_SECRET|OBJECT_SECRET|DSN_SECRET|ZERO_WIDTH_SECRET|MONGOLIAN_VARIATION_SECRET|PAREN_SECRET|SINGLE_KEY_SECRET|DIGEST_SECRET|PREFIX_URI_SECRET|X_AUTH_SECRET|COOKIE_SECRET|SET_COOKIE_SECRET|REFRESH_SECRET|ID_SECRET|CURL_HEADER_SECRET|QUOTED_CURL_SECRET/,
  );
  assert.match(redacted, /Authorization:\s*\*\*\*/i);
  assert.match(redacted, /x-api-key"?:\s*\*\*\*/i);
  assert.match(redacted, /postgres:\/\/\*\*\*@db\.example/);
  assert.match(redacted, /_postgres:\/\/\*\*\*@db\.example/);
});

test("display helpers bound hostile input before scanning and omit unsafe tails", () => {
  const hostile = "\u001b]".repeat(DISPLAY_INPUT_LIMIT * 4) + "unterminated";
  assert.equal(stripTerminalControls(hostile), "…");
  assert.equal(stripTerminalControls("left\u202Eright\u2066end\u2069"), "leftrightend");
  assert.equal(stripTerminalControls("Author\u200Bization"), "Authorization");
  assert.equal(stripTerminalControls("Author\u180Fization"), "Authorization");

  const huge = "A".repeat(DISPLAY_INPUT_LIMIT * 4);
  const bounded = stripTerminalControls(huge);
  assert.equal(bounded.length, DISPLAY_INPUT_LIMIT + 1);
  assert.equal(bounded.endsWith("…"), true);
  assert.equal(safeDisplayTail(huge, 80), DISPLAY_OMITTED_TEXT);
  const pathPreview = toolArgsPreview("read", { path: huge }, 80);
  assert.ok(pathPreview);
  assert.ok(pathPreview.length <= 80);

  const hugeUri = `https://alice:${"URI_SECRET_".repeat(2_000)}@db.example`;
  assert.equal(safeDisplayText(hugeUri, 80), DISPLAY_OMITTED_TEXT);
  assert.doesNotMatch(safeDisplayText(hugeUri, 80), /URI_SECRET/);
  const hugeTokenUri = `https://${"TOKEN_SECRET_".repeat(2_000)}@db.example`;
  assert.equal(safeDisplayText(hugeTokenUri, 80), DISPLAY_OMITTED_TEXT);
  assert.doesNotMatch(safeDisplayText(hugeTokenUri, 80), /TOKEN_SECRET/);
});

test("public rendering redacts snapshot fields even when callers bypass constructors", () => {
  const snap = createSnapshot({ name: "safe", description: "x" }, "wf_public", null);
  snap.name = "visible\u202Espoof";
  snap.logs = ['Authorization: "Bearer logsecret"'];
  snap.agents = [{
    id: 1,
    label: "agent\u001b]0;label-spoof\u0007",
    status: "done",
    resultPreview: '{"x-api-key":"previewsecret"}',
  }];
  const text = renderWorkflowLines(recompute(snap), { showResultPreviews: true }).join("\n");
  assert.doesNotMatch(text, /logsecret|previewsecret|label-spoof|\u202E|\u001b|\u0007/);
  assert.match(text, /\*\*\*/);
});

test("result previews use a bounded projection for huge and circular values", () => {
  const value: any = {
    Authorization: "Bearer PREVIEW_SECRET",
    payload: "x".repeat(1_000_000),
    sparse: [],
  };
  value.sparse.length = 1_000_000_000;
  value.sparse[0] = "first";
  value.self = value;

  const text = preview(value, 80);
  assert.equal(text, "[Object]");
  assert.equal(value.Authorization, "Bearer PREVIEW_SECRET");
  assert.equal(value.self, value);
});

test("result previews never inspect object hooks or expand hostile primitives", () => {
  let getterCalls = 0;
  const prototype: Record<string, unknown> = {};
  for (let index = 0; index < 1_000; index++) prototype[`inherited_${index}`] = index;
  const value = Object.create(prototype) as Record<string, unknown>;
  value.safe = "visible";
  Object.defineProperty(value, "dangerous", {
    enumerable: true,
    get() {
      getterCalls++;
      value.mutated = true;
      return "must-not-run";
    },
  });
  assert.equal(preview(value, 160), "[Object]");
  assert.equal(getterCalls, 0);
  assert.equal(value.mutated, undefined);

  let functionNameReads = 0;
  const callable = () => {};
  Object.defineProperty(callable, "name", {
    configurable: true,
    get() {
      functionNameReads++;
      return "must-not-run";
    },
  });
  assert.equal(preview(callable, 80), "[Function]");
  assert.equal(functionNameReads, 0);
  assert.equal(preview(Symbol("x".repeat(100_000)), 80), "[Symbol]");
  assert.equal(preview(1n << 1_000_000n, 80), "[BigInt]");

  let trapCalls = 0;
  const arrayProxy = new Proxy([], {
    ownKeys() {
      trapCalls++;
      throw new Error("ownKeys trap");
    },
    getOwnPropertyDescriptor() {
      trapCalls++;
      throw new Error("descriptor trap");
    },
  });
  const objectProxy = new Proxy({}, {
    ownKeys() {
      trapCalls++;
      throw new Error("ownKeys trap");
    },
    getOwnPropertyDescriptor() {
      trapCalls++;
      throw new Error("descriptor trap");
    },
    getPrototypeOf() {
      trapCalls++;
      throw new Error("prototype trap");
    },
  });
  assert.equal(preview(arrayProxy, 80), "[Array]");
  assert.equal(preview(objectProxy, 80), "[Object]");
  assert.equal(trapCalls, 0);

  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => preview(revoked.proxy, 80));
  assert.equal(preview(revoked.proxy, 80), "[Uninspectable]");
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
  assert.equal(runningTool.agents[0].streamTail, undefined, "raw text is never captured");

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

test("workflow tool never exposes raw assistant text deltas", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-private-text-"));
  const runWorkflowFn = async (_script: string, options: any) => {
    options.onAgentStart?.({ id: 1, label: "private", prompt: "p", cached: false });
    options.onAgentActivity?.({
      id: 1,
      label: "private",
      kind: "text",
      detail: "responding",
      streamDelta: 'Authorization: "Bearer PRIVATE_STREAM_SECRET"',
    });
    options.onAgentActivity?.({
      id: 1,
      label: "private",
      kind: "tool",
      detail: "read: README.md",
      toolCallId: "tool-secret-id",
      toolName: "read",
      toolArgs: "README.md",
      toolState: "start",
    });
    options.onAgentActivity?.({
      id: 1,
      label: "private",
      kind: "text",
      detail: "responding",
      streamDelta: "sk-split-private-suffix",
    });
    options.onAgentEnd?.({ id: 1, label: "private", result: "done", status: "done" });
    return {
      meta: { name: "private", description: "x" },
      result: "done",
      logs: [],
      phases: [],
      agentCount: 1,
      cachedCount: 0,
      spentTokens: 0,
      durationMs: 1,
    };
  };
  const tool = createWorkflowTool({ runWorkflowFn: runWorkflowFn as any });
  const updates: any[] = [];
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'private', description: 'x' }\nreturn 'done'`;

  const result = await tool.execute(
    "tc-private-text",
    { script } as any,
    undefined,
    (update) => updates.push(structuredClone(update)),
    ctx,
  );

  const serialized = JSON.stringify([updates, result.details]);
  assert.doesNotMatch(serialized, /PRIVATE_STREAM_SECRET|split-private-suffix/);
  assert.equal(
    updates.every((update) => update.details?.agents?.every((agent: any) => agent.streamTail == null) ?? true),
    true,
  );
  const responding = updates.find((update) => update.details?.agents?.[0]?.activity === "responding");
  assert.ok(responding, "text events still expose a fixed lifecycle state");
  assert.equal(typeof responding.details.agents[0].lastActivityAt, "number");

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("completed agents reject late activity while peer agents are still running", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-peer-late-"));
  const runWorkflowFn = (async (_script: string, options: any) => {
    options.onAgentStart?.({ id: 1, label: "first", prompt: "a", cached: false });
    options.onAgentStart?.({ id: 2, label: "second", prompt: "b", cached: false });
    options.onAgentActivity?.({
      id: 1,
      label: "first",
      kind: "text",
      detail: "responding",
      streamDelta: "before",
    });
    options.onAgentEnd?.({ id: 1, label: "first", result: "done-a", status: "done" });
    await Promise.resolve();
    options.onAgentActivity?.({
      id: 1,
      label: "first",
      kind: "tool",
      detail: 'Authorization: "Bearer late-secret"',
      toolCallId: "late",
      toolName: "bash",
      toolArgs: "late-secret",
      toolState: "start",
    });
    options.onAgentActivity?.({
      id: 1,
      label: "first",
      kind: "text",
      detail: "late-secret",
      streamDelta: "late-secret",
    });
    options.onAgentEnd?.({ id: 2, label: "second", result: "done-b", status: "done" });
    return {
      result: ["done-a", "done-b"],
      agentCount: 2,
      cachedCount: 0,
      spentTokens: 2,
      durationMs: 1,
      logs: [],
      phases: [],
    };
  }) as any;
  const tool = createWorkflowTool({ runWorkflowFn });
  const updates: any[] = [];
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'peer_late', description: 'x' }\nreturn await agent('p')`;

  const result = await tool.execute(
    "tc-peer-late",
    { script } as any,
    undefined,
    (update) => updates.push(structuredClone(update.details)),
    ctx,
  );
  const first = (result.details as any).agents.find((agent: any) => agent.id === 1);
  assert.equal(first.status, "done");
  assert.equal(first.activity, "responding");
  assert.equal(first.activeTools, undefined);
  assert.equal(first.streamTail, undefined);
  assert.doesNotMatch(JSON.stringify(result.details), /late-secret/);
  assert.equal(updates.at(-1).agents.every((agent: any) => agent.activeTools == null && agent.streamTail == null), true);
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
    const preview = toolArgsPreview("bash", { command }, 200);
    assert.ok(preview);
    assert.match(preview, /^curl …$/);
    assert.doesNotMatch(preview, /alice|s3cret|user|qwerty|hidden|sk-secret|example/);
  }
  assert.equal(
    toolArgsPreview("bash", { command: "OPENAI_API_KEY='sk-secret value' curl https://example.test" }, 200),
    "environment-prefixed command",
  );
  assert.equal(toolArgsPreview("bash", { command: "npm test -- --runInBand" }), "npm test");
  assert.equal(toolArgsPreview("bash", { command: "https://user:pass@example.test/?token=hidden --flag" }), "command");
  assert.equal(toolArgsPreview("bash", { command: "constructor anything" }), "command");
  assert.equal(toolArgsPreview("bash", { command: "./sk-abcdefgh" }), "command");
  assert.equal(toolArgsPreview("bash", { query: "private search text" }), undefined);
  assert.equal(toolArgsPreview("read", { path: "/Users/alice/private/project/README.md" }), "README.md");
  assert.equal(
    toolArgsPreview("read", { path: "https://user:pass@example.test/file?token=hidden" }),
    "path",
  );
  assert.equal(
    toolArgsPreview("custom_tool", { path: "https://user:pass@example.test/file?token=hidden" }),
    undefined,
  );
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

test("runWorkflow routes log, console, and nested workflow messages through one safe stream", async () => {
  const callbackLogs: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'all_logs', description: 'x' }
     log('Authorization: "Bearer LOG_SECRET"')
     console.log('x-api-key: CONSOLE_LOG_SECRET')
     console.info('token: CONSOLE_INFO_SECRET')
     console.warn('password: CONSOLE_WARN_SECRET')
     console.error('client-secret: CONSOLE_ERROR_SECRET')
     return await workflow('child')`,
    {
      onLog: (message) => callbackLogs.push(message),
      loadSavedWorkflow: () => ({
        meta: { name: 'Authorization: "Bearer NESTED_NAME_SECRET"', description: "x" },
        body: `log('Authorization: Digest username="a", response="NESTED_LOG_SECRET"'); return 'child'`,
      }),
    },
  );

  assert.equal(result.result, "child");
  assert.deepEqual(callbackLogs, result.logs);
  assert.equal(result.logs.length, 7);
  assert.doesNotMatch(
    JSON.stringify(result.logs),
    /LOG_SECRET|CONSOLE_LOG_SECRET|CONSOLE_INFO_SECRET|CONSOLE_WARN_SECRET|CONSOLE_ERROR_SECRET|NESTED_NAME_SECRET|NESTED_LOG_SECRET/,
  );
  assert.equal(result.logs.every((entry) => entry.length <= 512), true);
});

test("runWorkflow bounds log retention and callback volume with one omission marker", async () => {
  const exact = await runWorkflow(
    `export const meta = { name: 'log_exact', description: 'x' }
     for (let i = 0; i < ${MAX_WORKFLOW_LOGS}; i++) log('line-' + i)
     return 'done'`,
  );
  assert.equal(exact.logs.length, MAX_WORKFLOW_LOGS);
  assert.doesNotMatch(exact.logs.join("\n"), /additional workflow logs omitted/);

  const callbackLogs: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'log_cap', description: 'x' }
     for (let i = 0; i < ${MAX_WORKFLOW_LOGS + 50}; i++) log('line-' + i)
     return 'done'`,
    { onLog: (message) => callbackLogs.push(message) },
  );

  assert.equal(result.logs.length, MAX_WORKFLOW_LOGS + 1);
  assert.deepEqual(callbackLogs, result.logs);
  assert.equal(result.logs.at(-1), WORKFLOW_LOG_OMITTED_TEXT);
  assert.equal(result.logs.filter((entry) => entry === WORKFLOW_LOG_OMITTED_TEXT).length, 1);
});

test("runWorkflow redacts agent failure logs before return and callback", async () => {
  const callbackLogs: string[] = [];
  const runner = {
    run: async () => {
      throw new Error('Authorization: "Bearer RUNTIME_LOG_SECRET"');
    },
  };
  const script = `export const meta = { name: 'runtime_log', description: 'x' }\nreturn await agent('p', { label: 'failed' })`;
  const result = await runWorkflow(script, {
    runner,
    onLog: (message) => callbackLogs.push(message),
  });

  assert.equal(result.result, null);
  assert.equal(result.logs.length, 1);
  assert.equal(callbackLogs.length, 1);
  assert.doesNotMatch(JSON.stringify(result.logs), /RUNTIME_LOG_SECRET/);
  assert.doesNotMatch(JSON.stringify(callbackLogs), /RUNTIME_LOG_SECRET/);
  assert.match(result.logs[0], /Authorization:\s*\*\*\*/i);
  assert.equal(callbackLogs[0], result.logs[0]);
});

test("agent failure logs are redacted before entering workflow snapshots", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-log-redact-"));
  const runner = {
    run: async () => {
      throw new Error('{"Authorization":"Bearer agent-log-secret"}');
    },
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'log_redact', description: 'x' }\nreturn await agent('p', { label: 'failed' })`;
  const result = await tool.execute("tc-log-redact", { script } as any, undefined, undefined, ctx);
  const serialized = JSON.stringify(result.details);
  assert.doesNotMatch(serialized, /agent-log-secret/);
  assert.match(serialized, /\*\*\*/);
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("workflow tool bounds logs from an injected runtime", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-tool-log-cap-"));
  const runWorkflowFn = (async (_script: string, options: any) => {
    for (let index = 0; index < MAX_WORKFLOW_LOGS + 50; index++) {
      options.onLog?.(`line-${index}`);
    }
    return {
      result: "done",
      agentCount: 0,
      cachedCount: 0,
      spentTokens: 0,
      durationMs: 1,
      logs: [],
      phases: [],
    };
  }) as any;
  const updates: any[] = [];
  const tool = createWorkflowTool({ runWorkflowFn });
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'tool_log_cap', description: 'x' }\nreturn 'done'`;
  const result = await tool.execute(
    "tc-tool-log-cap",
    { script } as any,
    undefined,
    (update) => updates.push(structuredClone(update.details)),
    ctx,
  );

  const logs = (result.details as any).logs as string[];
  assert.equal(logs.length, MAX_WORKFLOW_LOGS + 1);
  assert.equal(logs.at(-1), WORKFLOW_LOG_OMITTED_TEXT);
  assert.equal(logs.filter((entry) => entry === WORKFLOW_LOG_OMITTED_TEXT).length, 1);
  assert.equal(updates.every((update) => update.logs.length <= MAX_WORKFLOW_LOGS + 1), true);
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("public runWorkflow preserves structured-cloned results while UI projection stays safe", async () => {
  const runner = {
    run: async () => ({
      value: "agent-done",
      usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
      cwd: process.cwd(),
    }),
  };
  const result = await runWorkflow(
    `export const meta = { name: 'raw_runtime_result', description: 'x' }
     await agent('p')
     return {
       Authorization: 'Bearer VM_RESULT_SECRET',
       nested: { exact: 'unchanged' },
       list: [1, 2, 3]
     }`,
    { runner },
  );

  assert.deepEqual(result.result, {
    Authorization: "Bearer VM_RESULT_SECRET",
    nested: { exact: "unchanged" },
    list: [1, 2, 3],
  });
  const projected = preview(result.result, 80);
  assert.equal(projected, "[Object]");
  assert.doesNotMatch(projected, /VM_RESULT_SECRET/);
});

test("raw structured results are preserved while UI result previews stay safe and bounded", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-result-contract-"));
  const rawResult = {
    Authorization: "Bearer RESULT_SECRET",
    nested: { exact: "unchanged" },
  };
  const runWorkflowFn = (async (_script: string, options: any) => {
    options.onAgentStart?.({ id: 1, label: "result", prompt: "p", cached: false });
    options.onAgentEnd?.({ id: 1, label: "result", result: rawResult, status: "done" });
    return {
      result: rawResult,
      agentCount: 1,
      cachedCount: 0,
      spentTokens: 0,
      durationMs: 1,
      logs: [],
      phases: [],
    };
  }) as any;
  const tool = createWorkflowTool({ runWorkflowFn });
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'result_contract', description: 'x' }\nreturn await agent('p')`;
  const result = await tool.execute("tc-result-contract", { script } as any, undefined, undefined, ctx);
  const details = result.details as any;
  const rendered = renderWorkflowLines(details, { showResultPreviews: true }).join("\n");

  assert.deepEqual(details.result, rawResult, "snapshot result keeps the exact structured value");
  assert.match((result.content[0] as any).text, /RESULT_SECRET/, "parent tool content keeps the raw result");
  assert.doesNotMatch(details.agents[0].resultPreview, /RESULT_SECRET/);
  assert.doesNotMatch(rendered, /RESULT_SECRET/);
  assert.ok(details.agents[0].resultPreview.length <= 80);

  const journal = fs.readdirSync(path.join(sessionDir, "ultracode-runs"))
    .find((entry) => entry.endsWith(".jsonl"));
  assert.ok(journal);
  assert.match(
    fs.readFileSync(path.join(sessionDir, "ultracode-runs", journal), "utf8"),
    /RESULT_SECRET/,
    "journal preserves the raw result contract",
  );
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("top-level workflow errors expose redacted text and retain the original cause", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-obs-error-cause-"));
  const notifications: string[] = [];
  const original = new Error('request failed Authorization: "Bearer top-level-secret"');
  const runWorkflowFn = (async () => {
    throw original;
  }) as any;
  const tool = createWorkflowTool({ runWorkflowFn });
  const ctx: any = {
    cwd: process.cwd(),
    sessionManager: { getSessionDir: () => sessionDir },
    ui: { notify: (message: string) => notifications.push(message) },
  };
  const script = `export const meta = { name: 'error_cause', description: 'x' }\nreturn await agent('p')`;

  await assert.rejects(
    tool.execute("tc-error-cause", { script } as any, undefined, undefined, ctx),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, original);
      assert.doesNotMatch(error.message, /top-level-secret/);
      assert.match(error.message, /\*\*\*/);
      return true;
    },
  );
  assert.equal(notifications.length, 1);
  assert.doesNotMatch(notifications[0], /top-level-secret/);
  const runsDir = path.join(sessionDir, "ultracode-runs");
  const journalFile = fs.readdirSync(runsDir).find((entry) => entry.endsWith(".jsonl"));
  assert.ok(journalFile);
  assert.doesNotMatch(fs.readFileSync(path.join(runsDir, journalFile), "utf8"), /top-level-secret/);
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
  // toolcall_start has no toolName in the installed Pi SDK; the completed tool call does.
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
    { kind: "text", detail: "responding" },
    { kind: "thinking", detail: "thinking" },
    { kind: "waiting", detail: "preparing tool call" },
    { kind: "waiting", detail: "preparing read: README.md" },
  ]);
});
