import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import extension from "../extensions/ultracode.ts";
import { createWorkflowTool } from "../src/workflow/tool.ts";
import { getRegistry } from "../src/workflow/registry.ts";
import { createSnapshot } from "../src/workflow/display.ts";

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
    sessionManager: { getEntries: () => state.entries },
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
  assert.ok(state.events.has("before_agent_start"));
});

test("session_start activates the workflow tool", () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  assert.ok(state.activeTools.includes("workflow"));
});

test("/ultracode on raises thinking to xhigh and injects the system block", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx, notifications } = makeCtx(state);

  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "xhigh");
  assert.ok(notifications.some((n) => /Ultracode on/.test(n.m)));
  // Persisted enabled state.
  const last = state.entries.filter((e) => e.customType === "ultracode-mode").pop();
  assert.equal(last.data.enabled, true);

  // before_agent_start injects the ultracode block.
  const result = state.events.get("before_agent_start")![0]({ systemPrompt: "BASE PROMPT" });
  assert.ok(result?.systemPrompt.includes("BASE PROMPT"));
  assert.ok(result.systemPrompt.includes("<ultracode>"));
  assert.ok(result.systemPrompt.includes("author and run a workflow"));
});

test("/ultracode off restores the previous thinking level", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("on", ctx);
  assert.equal(state.thinking, "xhigh");
  await state.commands.get("ultracode").handler("off", ctx);
  assert.equal(state.thinking, "medium");
  // before_agent_start now injects nothing.
  assert.equal(state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }), undefined);
});

test("/ultracode budget sets a budget reflected in the injected block", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("budget 500k", ctx);
  await state.commands.get("ultracode").handler("on", ctx);
  const result = state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.ok(/Token budget/.test(result.systemPrompt));
  assert.ok(/500k/.test(result.systemPrompt));
});

test("mode state is restored from persisted entries on a fresh load", () => {
  // Simulate a prior session that left ultracode enabled.
  const { pi, state } = makeMockPi();
  extension(pi);
  state.entries.push({
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, budgetTotal: 250000, previousThinking: "high" },
  });
  const { ctx } = makeCtx(state);
  state.events.get("session_start")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "xhigh");
  // before_agent_start injects (enabled restored).
  const result = state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.ok(result?.systemPrompt.includes("<ultracode>"));
});

test("--ultracode flag enables the mode at session_start", () => {
  const { pi, state } = makeMockPi({ ultracode: true });
  extension(pi);
  const { ctx } = makeCtx(state);
  state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  assert.equal(state.thinking, "xhigh");
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
