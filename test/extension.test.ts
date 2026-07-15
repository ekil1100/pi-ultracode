import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import ultracodeExtension from "../extensions/ultracode.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { getRegistry } from "../src/workflow/registry.ts";
import { createSnapshot } from "../src/workflow/display.ts";

function extension(pi: any, extraDeps: Record<string, unknown> = {}): void {
  ultracodeExtension(pi, {
    createThinkingPreferenceStore: () => undefined,
    ...extraDeps,
  });
}

function makeMockPi(flagValues: Record<string, unknown> = {}) {
  const state = {
    tools: [] as any[],
    commands: new Map<string, any>(),
    flags: new Map<string, any>(),
    events: new Map<string, any[]>(),
    activeTools: [] as string[],
    thinking: "medium",
    entries: [] as any[],
    statuses: {} as Record<string, unknown>,
  };
  const pi: any = {
    registerTool: (t: any) => state.tools.push(t),
    registerCommand: (name: string, opts: any) => state.commands.set(name, opts),
    registerFlag: (name: string, opts: any) => state.flags.set(name, opts),
    getFlag: (name: string) => flagValues[name],
    on: (ev: string, h: any) => {
      const list = state.events.get(ev) ?? [];
      list.push(h);
      state.events.set(ev, list);
    },
    getThinkingLevel: () => state.thinking,
    setThinkingLevel: (l: string) => {
      state.thinking = l;
    },
    getActiveTools: () => state.activeTools,
    setActiveTools: (t: string[]) => {
      state.activeTools = t;
    },
    appendEntry: (type: string, data: unknown) => state.entries.push({ type: "custom", customType: type, data }),
    sendMessage: () => {},
    sendUserMessage: () => {},
  };
  return { pi, state };
}

function makeCtx(state: any) {
  const notifications: Array<{ m: string; l: string }> = [];
  const widgets: Record<string, unknown> = {};
  const ctx: any = {
    ui: {
      notify: (m: string, l: string) => notifications.push({ m, l }),
      setStatus: (k: string, v: unknown) => {
        state.statuses[k] = v;
      },
      setWidget: (k: string, v: unknown) => {
        widgets[k] = v;
      },
    },
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => state.entries,
      getBranch: () => state.entries,
    },
  };
  return { ctx, notifications, widgets };
}

test("extension registers the workflow tool, commands, and flag", () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].name, "workflow");
  assert.ok(state.commands.has("ultracode"));
  assert.ok(state.commands.has("workflows"));
  assert.ok(state.flags.has("ultracode"));
  assert.ok(state.events.has("session_start"));
  assert.ok(state.events.has("session_tree"));
  assert.ok(state.events.has("model_select"));
  assert.ok(state.events.has("thinking_level_select"));
  assert.ok(state.events.has("session_shutdown"));
  assert.ok(state.events.has("input"));
  assert.ok(state.events.has("tool_call"));
  assert.ok(state.events.has("before_agent_start"));
});

test("session_start keeps the workflow tool inactive until Ultracode is enabled", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  state.activeTools = ["read", "workflow"];
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  assert.deepEqual(state.activeTools, ["read"]);
});

test("SDK-style prompt barriers keep workflow disabled without session_start", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  state.activeTools = ["read", "workflow"];

  await state.events.get("input")![0]({ type: "input", text: "test", source: "interactive" });
  assert.deepEqual(state.activeTools, ["read"], "input preflight removes auto-activated extension tools");

  // Simulate a later input handler restoring a stale active-tools snapshot.
  state.activeTools = ["read", "grep", "workflow"];
  const turn = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.equal(turn, undefined, "a disabled turn injects no Ultracode prompt");
  assert.deepEqual(state.activeTools, ["read", "grep"], "the final barrier removes only workflow");

  const blocked = await state.events.get("tool_call")![0]({
    type: "tool_call",
    toolName: "workflow",
    toolCallId: "wf-off",
    input: {},
  });
  assert.equal(blocked?.block, true);
  assert.match(blocked?.reason ?? "", /disabled/);
  assert.equal(
    await state.events.get("tool_call")![0]({
      type: "tool_call",
      toolName: "read",
      toolCallId: "read-ok",
      input: { path: "README.md" },
    }),
    undefined,
    "the guard does not affect other tools",
  );
});

test("before_agent_start restores workflow and the standing block in the same enabled turn", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("on", ctx);

  // Simulate another active-tool writer removing workflow after activation.
  state.activeTools = ["read", "grep"];
  const driftTurn = await state.events.get("before_agent_start")![0]({ systemPrompt: "CURRENT BASE" });
  assert.deepEqual(state.activeTools, ["read", "grep", "workflow"]);
  assert.ok(driftTurn?.systemPrompt.includes("CURRENT BASE"));
  assert.ok(driftTurn?.systemPrompt.includes("<ultracode>"));
  assert.equal(
    await state.events.get("tool_call")![0]({
      type: "tool_call",
      toolName: "workflow",
      toolCallId: "wf-on",
      input: {},
    }),
    undefined,
    "enabled workflow calls are allowed",
  );
});

test("/ultracode on raises thinking to max and injects the system block", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx, notifications } = makeCtx(state);

  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.statuses.ultracode, "ultracode: on · max");
  assert.equal(state.activeTools.includes("workflow"), true);
  assert.ok(notifications.some((n) => /Ultracode on/.test(n.m)));
  // Persisted enabled state.
  const last = state.entries.filter((e) => e.customType === "ultracode-mode").pop();
  assert.equal(last.data.enabled, true);

  // before_agent_start injects the ultracode block.
  const result = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE PROMPT" });
  assert.ok(result?.systemPrompt.includes("BASE PROMPT"));
  assert.ok(result.systemPrompt.includes("<ultracode>"));
  assert.ok(result.systemPrompt.includes("author and run a workflow"));
});

test("/ultracode off restores the previous thinking level", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  state.activeTools = ["read"];
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "max");
  await state.commands.get("ultracode").handler("off", ctx);
  assert.equal(state.thinking, "medium");
  assert.deepEqual(state.activeTools, ["read"]);
  // before_agent_start now injects nothing.
  assert.equal(await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }), undefined);
});

test("session shutdown restores effort without disabling persisted Ultracode state", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "max");

  await state.events.get("session_shutdown")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "medium", "max does not leak into another session");
  assert.equal(state.activeTools.includes("workflow"), false, "workflow does not leak from a quiescing runtime");
  const latest = state.entries.filter((entry) => entry.customType === "ultracode-mode").pop();
  assert.equal(latest.data.enabled, true, "shutdown does not persistently disable the mode");

  state.thinking = "high";
  await state.events.get("model_select")![0]({ model: {}, source: "set" }, ctx);
  assert.equal(state.thinking, "high", "late model events cannot reapply max after shutdown");
  await state.events.get("session_tree")![0]({ newLeafId: "late", oldLeafId: "old" }, ctx);
  assert.equal(state.thinking, "high", "late tree events cannot resume a quiescing runtime");
  assert.equal(
    await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }),
    undefined,
    "a quiescing runtime cannot start another Ultracode turn",
  );

  await state.events.get("session_start")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "max", "replacement session restores persisted mode state");
  assert.equal(state.activeTools.includes("workflow"), true, "replacement session reactivates workflow");
});

test("extension preserves the raw global effort preference while max is active", async () => {
  const { pi, state } = makeMockPi();
  state.thinking = "low";
  let rawDefault: string | undefined = "low";
  pi.setThinkingLevel = (level: string) => {
    state.thinking = level;
    rawDefault = level;
  };
  ultracodeExtension(pi, {
    createThinkingPreferenceStore: () => ({
      getThinkingPreference: () => ({
        global: rawDefault as any,
        effective: rawDefault as any,
      }),
      setDefaultThinkingLevel: (level) => {
        rawDefault = level ?? "medium";
      },
      flush: async () => {},
    }),
  });
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);

  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "max", "session effort is raised");
  assert.equal(rawDefault, "low", "global preference is restored immediately");

  await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx);
  assert.equal(rawDefault, "low", "stable max enforcement still restores the raw preference");

  state.thinking = "high";
  rawDefault = "high";
  await state.events.get("thinking_level_select")![0]({ level: "high", previousLevel: "max" }, ctx);
  assert.equal(state.thinking, "max", "manual lowering is overridden");
  assert.equal(rawDefault, "low", "enforcement still preserves the original preference");

  await state.events.get("session_shutdown")![0]({ reason: "quit" }, ctx);
  assert.equal(state.thinking, "low");
  assert.equal(rawDefault, "low");
});

test("production preference adapter wins Pi's independent settings write queue", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-pref-race-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const seed = SettingsManager.create(cwd, agentDir);
    seed.setDefaultThinkingLevel("low");
    await seed.flush();
    const primary = SettingsManager.create(cwd, agentDir);

    const { pi, state } = makeMockPi();
    state.thinking = "low";
    pi.setThinkingLevel = (level: string) => {
      state.thinking = level;
      primary.setDefaultThinkingLevel(level as any);
    };
    ultracodeExtension(pi);
    const { ctx } = makeCtx(state);
    ctx.cwd = cwd;
    ctx.model = { reasoning: true };
    await state.events.get("session_start")![0]({ reason: "startup" }, ctx);

    await state.commands.get("ultracode").handler("on", ctx);
    assert.equal(SettingsManager.create(cwd, agentDir).getDefaultThinkingLevel(), "low");

    pi.setThinkingLevel("high");
    await state.events.get("thinking_level_select")![0]({ level: "high", previousLevel: "max" }, ctx);
    await primary.flush();
    assert.equal(state.thinking, "max");
    assert.equal(
      SettingsManager.create(cwd, agentDir).getDefaultThinkingLevel(),
      "low",
      "fresh delayed writer restores the original value after Pi's max write",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production preference adapter treats an absent default as implicit medium", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-pref-default-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const primary = SettingsManager.create(cwd, agentDir);
    const { pi, state } = makeMockPi();
    state.thinking = "off";
    let reasoning = false;
    pi.setThinkingLevel = (level: string) => {
      const applied = reasoning ? level : "off";
      if (applied === state.thinking) return;
      state.thinking = applied;
      primary.setDefaultThinkingLevel(applied as any);
    };
    ultracodeExtension(pi);
    const { ctx } = makeCtx(state);
    ctx.cwd = cwd;
    ctx.model = { reasoning: false };
    await state.events.get("session_start")![0]({ reason: "startup" }, ctx);

    await state.commands.get("ultracode").handler("on", ctx);
    assert.equal(state.thinking, "off");

    reasoning = true;
    ctx.model = { reasoning: true };
    await state.events.get("model_select")![0]({ model: ctx.model, source: "set" }, ctx);
    assert.equal(state.thinking, "max");
    await state.commands.get("ultracode").handler("off", ctx);
    await primary.flush();
    assert.equal(state.thinking, "medium");
    assert.equal(
      SettingsManager.create(cwd, agentDir).getDefaultThinkingLevel(),
      "medium",
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/ultracode budget sets a budget reflected in the injected block", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("budget 500k", ctx);
  await state.commands.get("ultracode").handler("on", ctx);
  const result = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.ok(/Token budget/.test(result.systemPrompt));
  assert.ok(/500k/.test(result.systemPrompt));
});

test("mode state is restored from persisted entries on a fresh load", async () => {
  // Simulate a prior session that left ultracode enabled.
  const { pi, state } = makeMockPi();
  extension(pi);
  state.entries.push({
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, budgetTotal: 250000, previousThinking: "high" },
  });
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.activeTools.includes("workflow"), true);
  // before_agent_start injects (enabled restored).
  const result = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.ok(result?.systemPrompt.includes("<ultracode>"));
});

test("session restore ignores mode entries from discarded branches", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const enabled = {
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, budgetTotal: null, previousThinking: "low" },
  };
  state.entries.push(enabled, {
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: false, budgetTotal: null, previousThinking: "low" },
  });
  const { ctx } = makeCtx(state);
  ctx.sessionManager.getBranch = () => [enabled];
  await state.events.get("session_start")![0]({ reason: "resume" }, ctx);
  assert.equal(state.thinking, "max");
});

test("session_tree rehydrates branch-local Ultracode state", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  let branch: any[] = [];
  ctx.sessionManager.getBranch = () => branch;

  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  await state.commands.get("ultracode").handler("on", ctx);
  const enabledBranch = [...state.entries];
  assert.equal(state.thinking, "max");

  branch = [];
  await state.events.get("session_tree")![0]({ newLeafId: null, oldLeafId: "enabled" }, ctx);
  assert.equal(state.thinking, "medium");
  assert.equal(state.activeTools.includes("workflow"), false);
  assert.equal(state.statuses.ultracode, undefined);
  assert.equal(
    await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx),
    undefined,
    "a branch before the mode entry must not inject Ultracode",
  );

  branch = enabledBranch;
  await state.events.get("session_tree")![0]({ newLeafId: "enabled", oldLeafId: null }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.activeTools.includes("workflow"), true);
  assert.equal(state.statuses.ultracode, "ultracode: on · max");
  const restored = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx);
  assert.ok(restored?.systemPrompt.includes("<ultracode>"));
});

test("--ultracode flag enables the mode at session_start", async () => {
  const { pi, state } = makeMockPi({ ultracode: true });
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.activeTools.includes("workflow"), true);
});

test("model and manual effort changes reassert max and refresh status", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("on", ctx);

  state.thinking = "xhigh";
  await state.events.get("model_select")![0]({ model: {}, source: "set" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.statuses.ultracode, "ultracode: on · max");

  state.thinking = "high";
  await state.events.get("thinking_level_select")![0]({ level: "high", previousLevel: "max" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.statuses.ultracode, "ultracode: on · max");

  state.thinking = "low";
  const turn = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx);
  assert.equal(state.thinking, "max", "before_agent_start is the final enforcement barrier");
  assert.ok(turn?.systemPrompt.includes("<ultracode>"));
});

test("/workflows toggles the run panel and /workflows clear hides it", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx, widgets } = makeCtx(state);

  const snap = createSnapshot({ name: "demo", description: "x" }, "wf_paneltest", null);
  snap.status = "completed";
  getRegistry().register("wf_paneltest", snap, () => {});

  const handler = state.commands.get("workflows").handler;
  const KEY = "ultracode-workflows";

  await handler("", ctx);
  assert.ok(Array.isArray(widgets[KEY]), "bare /workflows shows the panel");

  await handler("", ctx);
  assert.equal(widgets[KEY], undefined, "bare /workflows again hides the panel");

  await handler("", ctx); // show again
  assert.ok(Array.isArray(widgets[KEY]));
  await handler("clear", ctx);
  assert.equal(widgets[KEY], undefined, "/workflows clear hides the panel");
});

test("workflow tool executes a script end-to-end with an injected runner", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-sess-"));
  const runner = {
    run: async (call: any) => ({
      value: `done:${call.label}`,
      usage: { outputTokens: 3, totalTokens: 3, cost: 0 },
      cwd: call.cwd ?? process.cwd(),
    }),
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const updates: any[] = [];
  const ctx: any = {
    cwd: process.cwd(),
    modelRegistry: undefined,
    model: undefined,
    sessionManager: { getSessionDir: () => sessionDir },
  };
  const script = `export const meta = { name: 'smoke', description: 'x' }
    phase('Work')
    const a = await agent('task a', { label: 'a' })
    const b = await agent('task b', { label: 'b' })
    return { a, b }`;

  const result = await tool.execute("tc1", { script } as any, undefined, (u) => updates.push(u), ctx);
  const text = (result.content[0] as any).text as string;
  assert.match(text, /Workflow smoke completed/);
  assert.match(text, /2 agent/);
  assert.match(text, /done:a/);
  assert.ok((result.details as any).runId.startsWith("wf_"));
  assert.ok(updates.length > 0, "tool streamed progress updates");

  // The script was persisted for resume.
  const persisted = (result.details as any).scriptPath as string;
  assert.ok(fs.existsSync(persisted));
  assert.match(fs.readFileSync(persisted, "utf8"), /export const meta/);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("workflow tool resumes a prior run from its journal", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-sess2-"));
  let calls = 0;
  const runner = {
    run: async (call: any) => {
      calls++;
      return { value: `r:${call.label}`, usage: { outputTokens: 2, totalTokens: 2, cost: 0 }, cwd: process.cwd() };
    },
  };
  const tool = createWorkflowTool({ testRunner: runner });
  const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
  const script = `export const meta = { name: 'res', description: 'x' }
    const a = await agent('one', { label: 'one' })
    const b = await agent('two', { label: 'two' })
    return [a, b]`;

  const first = await tool.execute("t1", { script } as any, undefined, undefined, ctx);
  const runId = (first.details as any).runId as string;
  assert.equal(calls, 2);

  calls = 0;
  const second = await tool.execute("t2", { script, resumeFromRunId: runId } as any, undefined, undefined, ctx);
  assert.equal(calls, 0, "resume should replay cached results without calling the runner");
  assert.match((second.content[0] as any).text, /cached from resume/);

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test("workflow tool forwards the raw ultracode max level to runWorkflow", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-think-"));
  try {
    let captured: { thinkingLevel?: string; budget?: number | null } = {};
    const fakeRun = async (_script: string, options: any) => {
      captured.thinkingLevel = options.thinkingLevel;
      captured.budget = options.tokenBudget;
      return {
        meta: { name: "x", description: "x" },
        result: { ok: true },
        logs: [],
        phases: [],
        agentCount: 1,
        cachedCount: 0,
        spentTokens: 0,
        durationMs: 1,
      };
    };
    const tool = createWorkflowTool({
      getThinkingLevel: () => "max",
      runWorkflowFn: fakeRun as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'x', description: 'x' }\nagent('a', { label: 'a' })`;
    await tool.execute("tc1", { script } as any, undefined, undefined, ctx);
    assert.equal(captured.thinkingLevel, "max", "raw max thinking level is forwarded to runWorkflow");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool forwards thinkingLevel=undefined when no getThinkingLevel is wired (ultracode off)", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-think2-"));
  try {
    let capturedThinking: unknown = "SENTINEL";
    const fakeRun = async (_script: string, options: any) => {
      capturedThinking = options.thinkingLevel;
      return {
        meta: { name: "x", description: "x" },
        result: {},
        logs: [],
        phases: [],
        agentCount: 0,
        cachedCount: 0,
        spentTokens: 0,
        durationMs: 1,
      };
    };
    const tool = createWorkflowTool({ runWorkflowFn: fakeRun as any });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'x', description: 'x' }\nreturn 1`;
    await tool.execute("tc2", { script } as any, undefined, undefined, ctx);
    assert.equal(capturedThinking, undefined, "no thinking override when ultracode is off");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("registered workflow execution fails closed off and forwards max when Ultracode is on", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-think-ext-"));
  try {
    let capturedThinking: unknown = "SENTINEL";
    let runCalls = 0;
    const fakeRun = async (_script: string, options: any) => {
      runCalls++;
      capturedThinking = options.thinkingLevel;
      return {
        meta: { name: "x", description: "x" },
        result: {},
        logs: [],
        phases: [],
        agentCount: 0,
        cachedCount: 0,
        spentTokens: 0,
        durationMs: 1,
      };
    };
    // Go through the real extension entrypoint so both mode wiring and the
    // registered tool's execution gate are exercised.
    const { pi, state } = makeMockPi();
    extension(pi, { runWorkflowFn: fakeRun as any });
    const { ctx } = makeCtx(state);
    const tool = state.tools[0];
    const execCtx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'x', description: 'x' }\nreturn 1`;

    await assert.rejects(
      tool.execute("tc-off", { script } as any, undefined, undefined, execCtx),
      /workflow tool is disabled/i,
    );
    assert.equal(runCalls, 0, "disabled execution is rejected before the runtime starts");

    await state.commands.get("ultracode").handler("on", ctx);
    await tool.execute("tc-on", { script } as any, undefined, undefined, execCtx);
    assert.equal(runCalls, 1);
    assert.equal(capturedThinking, "max", "enabled subagents inherit the Ultracode max request");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
