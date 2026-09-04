import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import ultracodeExtension from "../extensions/ultracode.ts";
import { createWorkflowTool, workflowRunsDir } from "../src/workflow/tool.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import { createSnapshot } from "../src/workflow/display.ts";
import { activeWorkflowCount, clearWorkflowLeasesForTests } from "../src/workflow/leases.ts";
import { MAX_WORKFLOW_ARGS_BYTES } from "../src/workflow/value-limits.ts";

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
    shortcuts: new Map<string, any>(),
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
    registerShortcut: (key: string, opts: any) => state.shortcuts.set(key, opts),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCtx(state: any) {
  const notifications: Array<{ m: string; l: string }> = [];
  const widgets: Record<string, unknown> = {};
  const customCalls: unknown[] = [];
  const ctx: any = {
    mode: "tui",
    ui: {
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      },
      notify: (m: string, l: string) => notifications.push({ m, l }),
      setStatus: (k: string, v: unknown) => {
        state.statuses[k] = v;
      },
      setWidget: (k: string, v: unknown) => {
        widgets[k] = v;
      },
      custom: async (_factory: unknown, options: unknown) => {
        customCalls.push(options);
        return undefined;
      },
    },
    hasUI: true,
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () => state.entries,
      getBranch: () => state.entries,
      getSessionDir: () => undefined,
    },
  };
  return { ctx, notifications, widgets, customCalls };
}

test("extension registers the workflow tool, commands, and flag", () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  assert.equal(state.tools.length, 1);
  assert.equal(state.tools[0].name, "workflow");
  const removedParameter = "bud" + "get";
  assert.equal(state.tools[0].parameters.additionalProperties, false, "workflow tool schema rejects removed and unknown parameters");
  assert.equal(removedParameter in state.tools[0].parameters.properties, false, "workflow tool schema no longer exposes the removed parameter");
  assert.equal(state.tools[0].parameters.properties.maxAgents?.minimum, 1);
  assert.equal(state.tools[0].parameters.properties.maxAgents?.maximum, 1024);
  assert.ok(state.commands.has("ultracode"));
  const depthCompletions = state.commands.get("ultracode").getArgumentCompletions("").map((item: any) => item.value);
  assert.deepEqual(depthCompletions, ["auto", "focused", "standard", "deep", "off", "status"]);
  assert.equal(depthCompletions.includes("on"), false);
  assert.ok(state.commands.has("workflows"));
  assert.ok(state.flags.has("ultracode"));
  assert.ok(state.shortcuts.has("f6"));
  assert.ok(state.events.has("session_start"));
  assert.ok(state.events.has("session_tree"));
  assert.equal(state.events.has("model_select"), false, "parent model changes need no interception");
  assert.equal(state.events.has("thinking_level_select"), false, "parent effort remains user-controlled");
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
  await state.commands.get("ultracode").handler("deep", ctx);

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

test("/ultracode modes leave parent effort user-controlled and inject their policy", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx, notifications } = makeCtx(state);
  const command = state.commands.get("ultracode");
  state.thinking = "low";

  await command.handler("", ctx);
  assert.equal(state.thinking, "low");
  assert.equal(state.statuses.ultracode, "<accent>ultracode</accent> · auto");
  assert.equal(state.activeTools.includes("workflow"), true);
  assert.ok(notifications.some((n) => /Ultracode auto/.test(n.m)));

  for (const selected of ["focused", "standard", "deep"] as const) {
    state.thinking = selected === "deep" ? "max" : "minimal";
    await command.handler(selected, ctx);
    assert.equal(state.thinking, selected === "deep" ? "max" : "minimal");
    assert.equal(state.statuses.ultracode, `<accent>ultracode</accent> · ${selected}`);
  }

  const last = state.entries.filter((e) => e.customType === "ultracode-mode").pop();
  assert.deepEqual(last.data, { mode: "deep" });
  const result = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE PROMPT" });
  assert.ok(result?.systemPrompt.includes("Configured mode: deep."));
  assert.match(result.systemPrompt, /parent session's effort.*user control/i);
  assert.match(result.systemPrompt, /Select each workflow agent's effort/i);
});

test("/ultracode off and session shutdown never change parent effort", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  state.activeTools = ["read"];
  state.thinking = "high";
  const { ctx, notifications } = makeCtx(state);

  await state.commands.get("ultracode").handler("standard", ctx);
  state.thinking = "low";
  await state.commands.get("ultracode").handler("off", ctx);
  assert.equal(state.thinking, "low");
  assert.deepEqual(state.activeTools, ["read"]);
  assert.match(notifications.at(-1)?.m ?? "", /parent effort unchanged/i);
  assert.equal(await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }), undefined);

  await state.commands.get("ultracode").handler("deep", ctx);
  state.thinking = "max";
  await state.events.get("session_shutdown")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.activeTools.includes("workflow"), false);
  const latest = state.entries.filter((entry) => entry.customType === "ultracode-mode").pop();
  assert.equal(latest.data.mode, "deep");

  await state.events.get("session_start")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "max");
  assert.equal(state.activeTools.includes("workflow"), true);
});

test("/ultracode rejects removed on and unknown arguments without enabling the mode", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx, notifications } = makeCtx(state);
  for (const invalid of ["on", "nonsense", "deep extra"]) {
    await state.commands.get("ultracode").handler(invalid, ctx);
    assert.equal(state.activeTools.includes("workflow"), false);
    assert.equal(state.statuses.ultracode, undefined);
    assert.equal(state.entries.length, 0, "invalid arguments must not persist mode state");
    assert.equal(notifications.at(-1)?.l, "error");
    assert.match(
      notifications.at(-1)?.m ?? "",
      /Usage: \/ultracode \[auto\|focused\|standard\|deep\|off\|status\]/,
    );
  }
});

test("mode state is restored from persisted entries on a fresh load", async () => {
  // Simulate a prior session that left ultracode enabled. Legacy budgetTotal is
  // ignored and is not re-persisted by new mode entries.
  const { pi, state } = makeMockPi();
  extension(pi);
  state.entries.push({
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, budgetTotal: 250_000, previousThinking: "high" },
  });
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "reload" }, ctx);
  assert.equal(state.thinking, "medium");
  assert.equal(state.activeTools.includes("workflow"), true);
  assert.equal(state.statuses.ultracode, "<accent>ultracode</accent> · deep");
  assert.doesNotMatch(String(state.statuses.ultracode), /budgetTotal|250000|250_000/i);
  // before_agent_start injects the migrated deep policy without the legacy token budget.
  const result = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" });
  assert.ok(result?.systemPrompt.includes("<ultracode>"));
  assert.ok(result?.systemPrompt.includes("Configured mode: deep."));
  assert.doesNotMatch(result?.systemPrompt ?? "", /budgetTotal|250000|250_000/i);

  await state.commands.get("ultracode").handler("off", ctx);
  assert.equal(state.entries.at(-1)?.data.mode, "off");
  assert.equal("enabled" in (state.entries.at(-1)?.data ?? {}), false, "new entries persist the mode enum");
  assert.equal("budgetTotal" in (state.entries.at(-1)?.data ?? {}), false, "new persisted mode entries omit legacy budgetTotal");
});

test("session restore ignores mode entries from discarded branches", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const enabled = {
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, previousThinking: "low" },
  };
  state.entries.push(enabled, {
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: false, previousThinking: "low" },
  });
  const { ctx } = makeCtx(state);
  ctx.sessionManager.getBranch = () => [enabled];
  await state.events.get("session_start")![0]({ reason: "resume" }, ctx);
  assert.equal(state.thinking, "medium");
});

test("session_tree rehydrates branch-local Ultracode state", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  let branch: any[] = [];
  ctx.sessionManager.getBranch = () => branch;

  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  await state.commands.get("ultracode").handler("deep", ctx);
  const enabledBranch = [...state.entries];
  assert.equal(state.thinking, "medium");

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
  assert.equal(state.thinking, "medium");
  assert.equal(state.activeTools.includes("workflow"), true);
  assert.equal(state.statuses.ultracode, "<accent>ultracode</accent> · deep");
  const restored = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx);
  assert.ok(restored?.systemPrompt.includes("<ultracode>"));
});

test("--ultracode flag enables auto mode at session_start", async () => {
  const { pi, state } = makeMockPi({ ultracode: true });
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.events.get("session_start")![0]({ reason: "startup" }, ctx);
  assert.equal(state.thinking, "medium");
  assert.equal(state.statuses.ultracode, "<accent>ultracode</accent> · auto");
  assert.equal(state.activeTools.includes("workflow"), true);
});

test("manual parent effort changes are not intercepted or rendered in status", async () => {
  const { pi, state } = makeMockPi();
  extension(pi);
  const { ctx } = makeCtx(state);
  await state.commands.get("ultracode").handler("deep", ctx);

  state.thinking = "low";
  const turn = await state.events.get("before_agent_start")![0]({ systemPrompt: "BASE" }, ctx);
  assert.equal(state.thinking, "low");
  assert.equal(state.statuses.ultracode, "<accent>ultracode</accent> · deep");
  assert.ok(turn?.systemPrompt.includes("<ultracode>"));
});

test("/workflows and F6 use the extension session's registry; abort remains isolated", async () => {
  const registry = new WorkflowRegistry();
  const otherRegistry = new WorkflowRegistry();
  const { pi, state } = makeMockPi();
  extension(pi, { registry });
  const { ctx, widgets, customCalls } = makeCtx(state);

  let otherAborted = false;
  const other = createSnapshot({ name: "other", description: "x" }, "wf_other");
  otherRegistry.register("wf_other", other, () => { otherAborted = true; });
  const snap = createSnapshot({ name: "demo", description: "x" }, "wf_overlaytest");
  snap.status = "completed";
  registry.register("wf_overlaytest", snap, () => {});

  const handler = state.commands.get("workflows").handler;
  await handler("wf_overlaytest", ctx);
  assert.equal(customCalls.length, 1, "explicit run opens the overlay");
  assert.deepEqual(widgets, {}, "the legacy static widget is not used");

  await state.shortcuts.get("f6").handler(ctx);
  assert.equal(customCalls.length, 2, "F6 opens the same overlay");

  let aborted = false;
  const active = createSnapshot({ name: "active", description: "x" }, "wf_aborttest");
  registry.register("wf_aborttest", active, () => { aborted = true; });
  await handler("abort", ctx);
  assert.equal(aborted, true);
  assert.equal(otherAborted, false, "abort cannot cross an extension-session registry");
});

test("workflow run artifacts are physically separated by Pi session id", () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-session-scope-"));
  try {
    const a = workflowRunsDir({
      cwd: process.cwd(),
      sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "session-a" },
    });
    const b = workflowRunsDir({
      cwd: process.cwd(),
      sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "session-b" },
    });
    assert.notEqual(a, b);
    assert.equal(path.dirname(a), path.join(sessionDir, "ultracode-runs"));
    assert.equal(path.dirname(b), path.join(sessionDir, "ultracode-runs"));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
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

test("workflow tool treats ordinary aborted-looking errors as failures", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-aborted-word-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async () => {
        throw new Error("ordinary aborted-looking failure");
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'aborted_word', description: 'x' }
agent('one', { label: 'one' })`;
    await assert.rejects(
      tool.execute("aborted-word", { script } as any, undefined, undefined, ctx),
      /Workflow aborted_word failed: ordinary aborted-looking failure/,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
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

test("workflow resume cannot replay across repository or cwd targets", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-target-session-"));
  const firstCwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-target-a-"));
  const secondCwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-target-b-"));
  let runnerCalls = 0;
  try {
    const tool = createWorkflowTool({
      testRunner: {
        run: async () => {
          runnerCalls++;
          return { value: "done", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: firstCwd };
        },
      },
    });
    const sessionManager = { getSessionDir: () => sessionDir };
    const script = `export const meta = { name: 'resume_target', description: 'x' }\nreturn await agent('one')`;
    const first = await tool.execute("target-a", { script } as any, undefined, undefined, {
      cwd: firstCwd,
      sessionManager,
    } as any);
    const runId = (first.details as any).runId as string;
    assert.equal(runnerCalls, 1);

    await assert.rejects(
      tool.execute("target-b", { script, resumeFromRunId: runId } as any, undefined, undefined, {
        cwd: secondCwd,
        sessionManager,
      } as any),
      /immutable repository\/cwd target/i,
    );
    assert.equal(runnerCalls, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(firstCwd, { recursive: true, force: true });
    fs.rmSync(secondCwd, { recursive: true, force: true });
  }
});

test("workflow tool validates completed worktree effects before resume", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-delivery-session-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-delivery-repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  let runnerCalls = 0;
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const tool = createWorkflowTool({
      testRunner: {
        run: async (call: any) => {
          runnerCalls++;
          fs.writeFileSync(path.join(call.cwd, "f.txt"), "agent\n");
          return { value: "done", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: call.cwd };
        },
      },
    });
    const ctx: any = { cwd: repo, sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'resume_delivery', description: 'x' }\nreturn await agent('write', { isolation: 'worktree' })`;
    const first = await tool.execute("delivery-first", { script } as any, undefined, undefined, ctx);
    const runId = (first.details as any).runId as string;
    assert.equal(runnerCalls, 1);
    git(["checkout", "--", "f.txt"]);

    await assert.rejects(
      tool.execute("delivery-resume", { script, resumeFromRunId: runId } as any, undefined, undefined, ctx),
      /delivery.*no longer present|verif/i,
    );
    assert.equal(runnerCalls, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("saved workflow names cannot traverse outside the workflows directory", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-name-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-name-session-"));
  let runtimeCalls = 0;
  try {
    const outside = path.join(cwd, ".pi", "ultracode", "outside.workflow.js");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, `export const meta = { name: 'outside', description: 'x' }\nreturn 1`);
    const tool = createWorkflowTool({
      runWorkflowFn: (async () => {
        runtimeCalls++;
        throw new Error("runtime should not start");
      }) as any,
    });
    const ctx: any = { cwd, sessionManager: { getSessionDir: () => sessionDir } };
    await assert.rejects(
      tool.execute("saved-name-traversal", { name: "../outside" } as any, undefined, undefined, ctx),
      /workflow name.*letters|invalid workflow name/i,
    );
    assert.equal(runtimeCalls, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("project saved workflows require project trust", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-trust-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-trust-session-"));
  const name = `project_only_${Date.now().toString(36)}`;
  let runtimeCalls = 0;
  try {
    const workflowsDir = path.join(cwd, ".pi", "ultracode", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, `${name}.workflow.js`),
      `export const meta = { name: '${name}', description: 'x' }\nreturn 1`,
    );
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        runtimeCalls++;
        return {
          meta: { name, description: "x" }, result: 1, logs: [], phases: [],
          agentCount: 0, agentsUsed: 0, cachedCount: 0, spentTokens: 0,
          newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: options.maxAgents,
        };
      }) as any,
    });
    const baseCtx = { cwd, sessionManager: { getSessionDir: () => sessionDir } };
    await assert.rejects(
      tool.execute("untrusted-name", { name } as any, undefined, undefined, {
        ...baseCtx,
        isProjectTrusted: () => false,
      } as any),
      /no accessible saved workflow/i,
    );
    assert.equal(runtimeCalls, 0);

    await tool.execute("trusted-name", { name } as any, undefined, undefined, {
      ...baseCtx,
      isProjectTrusted: () => true,
    } as any);
    assert.equal(runtimeCalls, 1);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("saved workflow names reject symlinked source files", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-symlink-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-symlink-session-"));
  try {
    const outside = path.join(cwd, "outside.workflow.js");
    fs.writeFileSync(outside, `export const meta = { name: 'outside', description: 'x' }\nreturn 1`);
    const workflowsDir = path.join(cwd, ".pi", "ultracode", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.symlinkSync(outside, path.join(workflowsDir, "linked.workflow.js"));
    const tool = createWorkflowTool();
    const ctx: any = {
      cwd,
      sessionManager: { getSessionDir: () => sessionDir },
      isProjectTrusted: () => true,
    };
    await assert.rejects(
      tool.execute("saved-symlink", { name: "linked" } as any, undefined, undefined, ctx),
      /symlink/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("saved workflow names reject symlinked parent directories", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-parent-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-parent-outside-"));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-workflow-parent-session-"));
  try {
    const workflowsDir = path.join(outside, "ultracode", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "linked.workflow.js"),
      `export const meta = { name: 'outside', description: 'x' }\nreturn 1`,
    );
    fs.symlinkSync(outside, path.join(cwd, ".pi"));
    const tool = createWorkflowTool();
    const ctx: any = {
      cwd,
      sessionManager: { getSessionDir: () => sessionDir },
      isProjectTrusted: () => true,
    };
    await assert.rejects(
      tool.execute("saved-parent-symlink", { name: "linked" } as any, undefined, undefined, ctx),
      /symlink/,
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow run fallback artifacts stay outside an untrusted repository", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-untrusted-cwd-"));
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), "uc-untrusted-victim-"));
  try {
    fs.symlinkSync(victim, path.join(cwd, ".pi"));
    const runsDir = workflowRunsDir({ cwd });
    assert.equal(runsDir.startsWith(`${cwd}${path.sep}`), false);
    assert.equal(runsDir.startsWith(`${path.resolve(victim)}${path.sep}`), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(victim, { recursive: true, force: true });
  }
});

test("workflow resume rejects changed scripts before runtime side effects", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-immutable-resume-"));
  let runtimeCalls = 0;
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        runtimeCalls++;
        return {
          meta: { name: "immutable_resume", description: "x" },
          result: 1,
          logs: [],
          phases: [],
          agentCount: 0,
          cachedCount: 0,
          spentTokens: 0,
          newTokens: 0,
          replayedTokens: 0,
          durationMs: 1,
          maxAgents: options.maxAgents,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const original = `export const meta = { name: 'immutable_resume', description: 'x' }\nreturn 1`;
    const changed = `export const meta = { name: 'immutable_resume', description: 'x' }\nreturn 2`;
    const first = await tool.execute("immutable-1", { script: original } as any, undefined, undefined, ctx);
    const runId = (first.details as any).runId as string;
    const scriptPath = path.join(sessionDir, "ultracode-runs", `${runId}.workflow.js`);
    const before = fs.readFileSync(scriptPath, "utf8");

    await assert.rejects(
      tool.execute("immutable-2", { script: changed, resumeFromRunId: runId } as any, undefined, undefined, ctx),
      /immutable|does not match|changed script/i,
    );
    assert.equal(runtimeCalls, 1);
    assert.equal(fs.readFileSync(scriptPath, "utf8"), before);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow resume rejects changed args before runtime side effects", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-immutable-args-"));
  let runtimeCalls = 0;
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        runtimeCalls++;
        return {
          meta: { name: "immutable_args", description: "x" }, result: options.args,
          logs: [], phases: [], agentCount: 0, cachedCount: 0,
          spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: options.maxAgents,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'immutable_args', description: 'x' }\nreturn args`;
    const first = await tool.execute("immutable-args-1", { script, args: { value: 1 } } as any, undefined, undefined, ctx);
    const runId = (first.details as any).runId as string;
    await assert.rejects(
      tool.execute(
        "immutable-args-2",
        { script, args: { value: 2 }, resumeFromRunId: runId } as any,
        undefined,
        undefined,
        ctx,
      ),
      /immutable args|changed args/i,
    );
    assert.equal(runtimeCalls, 1);
    await tool.execute(
      "immutable-args-3",
      { script, args: { value: 1 }, resumeFromRunId: runId } as any,
      undefined,
      undefined,
      ctx,
    );
    assert.equal(runtimeCalls, 2, "rejected immutable args must release the process-local workflow lease");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool forwards an explicit host child-effort fallback and injected model runtime", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-think-"));
  try {
    const modelRuntime = { marker: "shared-runtime", getModel: () => undefined };
    let captured: { thinkingLevel?: string; modelRuntime?: unknown; projectTrusted?: boolean } = {};
    const fakeRun = async (_script: string, options: any) => {
      captured.thinkingLevel = options.thinkingLevel;
      captured.modelRuntime = options.modelRuntime;
      captured.projectTrusted = options.projectTrusted;
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
      modelRuntime,
      runWorkflowFn: fakeRun as any,
    });
    let trustReads = 0;
    const ctx: any = {
      cwd: process.cwd(),
      sessionManager: { getSessionDir: () => sessionDir },
      isProjectTrusted: () => {
        trustReads++;
        return false;
      },
    };
    const script = `export const meta = { name: 'x', description: 'x' }\nagent('a', { label: 'a' })`;
    await tool.execute("tc1", { script } as any, undefined, undefined, ctx);
    assert.equal(captured.thinkingLevel, "max", "explicit host fallback is forwarded to runWorkflow");
    assert.equal(captured.modelRuntime, modelRuntime, "SDK hosts can share their canonical runtime");
    assert.equal(captured.projectTrusted, false, "the parent project trust decision is forwarded unchanged");
    assert.equal(trustReads, 1, "project trust is captured once per tool invocation");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool forwards thinkingLevel=undefined when no host child default is wired", async () => {
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

test("registered workflow execution fails closed off and leaves child effort selection per call", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-think-ext-"));
  try {
    const capturedThinking: unknown[] = [];
    let runCalls = 0;
    const fakeRun = async (_script: string, options: any) => {
      runCalls++;
      capturedThinking.push(options.thinkingLevel);
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

    for (const selectedMode of ["auto", "focused", "standard", "deep"] as const) {
      await state.commands.get("ultracode").handler(selectedMode, ctx);
      await tool.execute(`tc-${selectedMode}`, { script } as any, undefined, undefined, execCtx);
      assert.equal(capturedThinking.at(-1), undefined, "mode does not supply a child effort default");
    }
    assert.equal(runCalls, 4);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool rejects missing resumeFromRunId without creating artifacts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-missing-resume-"));
  try {
    const tool = createWorkflowTool({ testRunner: { run: async () => { throw new Error("runner should not start"); } } });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'missing_resume', description: 'x' }\nreturn await agent('a')`;
    await assert.rejects(
      tool.execute("missing-resume", { script, resumeFromRunId: "wf_missing" } as any, undefined, undefined, ctx),
      /resumeFromRunId wf_missing was not found/,
    );
    const runsDir = path.join(sessionDir, "ultracode-runs");
    assert.equal(fs.existsSync(runsDir), false, "missing resume must not write script/journal/details artifacts");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow resume rejects symlink artifacts without overwriting their targets", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-symlink-"));
  try {
    const runsDir = path.join(sessionDir, "ultracode-runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const runId = "wf_resume_symlink";
    const target = path.join(sessionDir, "victim.txt");
    fs.writeFileSync(target, "sentinel");
    fs.symlinkSync(target, path.join(runsDir, `${runId}.workflow.js`));
    fs.writeFileSync(path.join(runsDir, `${runId}.jsonl`), `${JSON.stringify({
      type: "run",
      journalVersion: 2,
      runId,
      name: "resume_symlink",
      scriptHash: "legacy",
      startedAt: 0,
      maxAgents: 128,
    })}\n`);

    const tool = createWorkflowTool({
      runWorkflowFn: (async () => { throw new Error("runtime should not start"); }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'resume_symlink', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute("resume-symlink", { script, resumeFromRunId: runId } as any, undefined, undefined, ctx),
      /symlink|regular file|unsupported journal/i,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "sentinel");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow resume rejects a symlinked journal without appending to its target", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resume-journal-symlink-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => ({
        meta: { name: "journal_symlink", description: "x" }, result: 1,
        logs: [], phases: [], agentCount: 0, cachedCount: 0,
        spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: options.maxAgents,
      })) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'journal_symlink', description: 'x' }\nreturn 1`;
    const first = await tool.execute("journal-symlink-1", { script } as any, undefined, undefined, ctx);
    const runId = (first.details as any).runId as string;
    const runsDir = path.join(sessionDir, "ultracode-runs");
    const journalPath = path.join(runsDir, `${runId}.jsonl`);
    const victim = path.join(sessionDir, "journal-victim.txt");
    fs.writeFileSync(victim, "sentinel");
    fs.rmSync(journalPath, { force: true });
    fs.symlinkSync(victim, journalPath);

    await assert.rejects(
      tool.execute("journal-symlink-2", { script, resumeFromRunId: runId } as any, undefined, undefined, ctx),
      /journal.*regular file|journal.*symlink/i,
    );
    assert.equal(fs.readFileSync(victim, "utf8"), "sentinel");
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow resume rejects symlinked details and task directories", async () => {
  for (const artifact of ["details", "tasks"] as const) {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `uc-resume-${artifact}-symlink-`));
    let runtimeCalls = 0;
    try {
      const tool = createWorkflowTool({
        runWorkflowFn: (async (_script: string, options: any) => {
          runtimeCalls++;
          return {
            meta: { name: "artifact_symlink", description: "x" }, result: 1,
            logs: [], phases: [], agentCount: 0, cachedCount: 0,
            spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: options.maxAgents,
          };
        }) as any,
      });
      const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
      const script = `export const meta = { name: 'artifact_symlink', description: 'x' }\nreturn 1`;
      const first = await tool.execute(`artifact-${artifact}-1`, { script } as any, undefined, undefined, ctx);
      const runId = (first.details as any).runId as string;
      const runsDir = path.join(sessionDir, "ultracode-runs");
      const victim = path.join(sessionDir, `${artifact}-victim`);
      if (artifact === "details") {
        fs.writeFileSync(victim, "sentinel");
        const detailsPath = path.join(runsDir, `${runId}.details.json`);
        fs.rmSync(detailsPath, { force: true });
        fs.symlinkSync(victim, detailsPath);
      } else {
        fs.mkdirSync(victim);
        const taskDir = path.join(runsDir, `${runId}.tasks`);
        fs.rmSync(taskDir, { recursive: true, force: true });
        fs.symlinkSync(victim, taskDir);
      }

      await assert.rejects(
        tool.execute(`artifact-${artifact}-2`, { script, resumeFromRunId: runId } as any, undefined, undefined, ctx),
        /symlink|real directory|regular file/i,
      );
      assert.equal(runtimeCalls, 1);
      if (artifact === "details") {
        assert.equal(fs.readFileSync(victim, "utf8"), "sentinel");
        fs.rmSync(path.join(runsDir, `${runId}.details.json`), { force: true });
      } else {
        assert.deepEqual(fs.readdirSync(victim), []);
        const taskDir = path.join(runsDir, `${runId}.tasks`);
        fs.rmSync(taskDir, { force: true });
        fs.mkdirSync(taskDir);
      }
      await tool.execute(
        `artifact-${artifact}-recovered`,
        { script, resumeFromRunId: runId } as any,
        undefined,
        undefined,
        ctx,
      );
      assert.equal(runtimeCalls, 2, "setup failure must release the workflow lease and journal descriptor");
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
});

test("workflow tool rejects an already-aborted signal before artifacts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-abort-before-"));
  try {
    const tool = createWorkflowTool({ testRunner: { run: async () => { throw new Error("runner should not start"); } } });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const ac = new AbortController();
    ac.abort();
    const script = `export const meta = { name: 'abort_before', description: 'x' }\nreturn await agent('a')`;
    await assert.rejects(
      tool.execute("abort-before", { script } as any, ac.signal, undefined, ctx),
      /aborted before it started/,
    );
    assert.equal(fs.existsSync(path.join(sessionDir, "ultracode-runs")), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool abort listener observes a synchronous getThinkingLevel abort before artifacts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-thinking-abort-"));
  try {
    const ac = new AbortController();
    const tool = createWorkflowTool({
      getThinkingLevel: () => {
        ac.abort();
        return "max";
      },
      testRunner: { run: async () => { throw new Error("runner should not start"); } },
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'thinking_abort', description: 'x' }\nreturn await agent('a')`;
    await assert.rejects(
      tool.execute("thinking-abort", { script } as any, ac.signal, undefined, ctx),
      /aborted before it started/,
    );
    assert.equal(fs.existsSync(path.join(sessionDir, "ultracode-runs")), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool releases active-run lease after update callback exceptions", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lease-callback-"));
  let first = true;
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        if (first) {
          first = false;
          options.onLog("callback should throw");
        }
        return {
          meta: { name: "lease_callback", description: "x" },
          result: { ok: true },
          logs: [],
          phases: [],
          agentCount: 0,
          cachedCount: 0,
          spentTokens: 0,
          newTokens: 0,
          replayedTokens: 0,
          durationMs: 1,
          maxAgents: 128,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'lease_callback', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute("lease-callback-1", { script } as any, undefined, () => { throw new Error("update failed"); }, ctx),
      /update failed/,
    );
    const runsDir = path.join(sessionDir, "ultracode-runs");
    assert.equal(activeWorkflowCount(runsDir), 0, "failed callback released its lease");
    const [journal] = fs.readdirSync(runsDir).filter((name) => name.endsWith(".jsonl"));
    const runId = path.basename(journal, ".jsonl");
    const second = await tool.execute("lease-callback-2", { script, resumeFromRunId: runId } as any, undefined, undefined, ctx);
    assert.match((second.content[0] as any).text, /Workflow lease_callback completed/);
    assert.equal(activeWorkflowCount(runsDir), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool contains heartbeat callback failures and releases the lease", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-heartbeat-callback-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
        return {
          meta: { name: "heartbeat_callback", description: "x" },
          result: 1,
          logs: [],
          phases: [],
          agentCount: 0,
          cachedCount: 0,
          spentTokens: 0,
          newTokens: 0,
          replayedTokens: 0,
          durationMs: 1,
          maxAgents: 128,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'heartbeat_callback', description: 'x' }\nreturn 1`;
    let updates = 0;
    await assert.rejects(
      tool.execute("heartbeat-callback", { script } as any, undefined, () => {
        updates++;
        if (updates === 1) throw new Error("heartbeat update failed");
      }, ctx),
      /heartbeat update failed/,
    );
    assert.equal(updates, 1, "the first heartbeat fails once and disables the observer");
    const runsDir = path.join(sessionDir, "ultracode-runs");
    assert.equal(activeWorkflowCount(runsDir), 0);
    const manifestPath = fs.readdirSync(runsDir).find((name) => name.endsWith(".details.json"));
    assert.ok(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(path.join(runsDir, manifestPath), "utf8"));
    assert.equal(manifest.snapshot.status, "failed", "runtime success cannot overwrite heartbeat failure");
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool releases its lease after bounded cleanup of an uncooperative runner", { timeout: 2_000 }, async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-tool-cleanup-timeout-"));
  let markStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    const tool = createWorkflowTool({
      cleanupTimeoutMs: 30,
      testRunner: {
        run: async () => {
          markStarted();
          await new Promise(() => {});
          throw new Error("unreachable");
        },
      },
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'tool_cleanup_timeout', description: 'x' }\nreturn await agent('slow')`;
    const ac = new AbortController();
    const execution = tool.execute("tool-cleanup-timeout", { script } as any, ac.signal, undefined, ctx);
    await runnerStarted;
    ac.abort();
    await assert.rejects(execution, (error: any) => {
      assert.match(error.message, /was aborted/);
      assert.match(error.cause?.message ?? "", /cleanup.*30ms|drain.*30ms/i);
      return true;
    });
    assert.equal(activeWorkflowCount(path.join(sessionDir, "ultracode-runs")), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("detached promise chains are rejected before lease or journal acquisition", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-tool-detached-chain-"));
  let runnerStarts = 0;
  try {
    const tool = createWorkflowTool({
      cleanupTimeoutMs: 30,
      testRunner: {
        run: async () => {
          runnerStarts++;
          return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'detached_chain', description: 'x' }
agent('never').catch(() => null)
return 'done'`;
    const startedAt = Date.now();
    await assert.rejects(
      tool.execute("detached-chain", { script } as any, undefined, undefined, ctx),
      /promise chains|pending orchestration|cleanup.*30ms/i,
    );
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(runnerStarts, 0);
    const runsDir = path.join(sessionDir, "ultracode-runs");
    assert.equal(activeWorkflowCount(runsDir), 0);
    assert.equal(fs.existsSync(runsDir), false, "parse rejection happens before run artifacts are created");
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool cannot commit success after an external abort race", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-abort-success-race-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
        return {
          meta: { name: "abort_success_race", description: "x" },
          result: "must not commit",
          logs: [],
          phases: [],
          agentCount: 0,
          cachedCount: 0,
          spentTokens: 0,
          newTokens: 0,
          replayedTokens: 0,
          durationMs: 1,
          maxAgents: 128,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'abort_success_race', description: 'x' }\nreturn 1`;
    const ac = new AbortController();
    const execution = tool.execute("abort-success-race", { script } as any, ac.signal, undefined, ctx);
    setImmediate(() => ac.abort());
    await assert.rejects(execution, /was aborted/);
    assert.equal(activeWorkflowCount(path.join(sessionDir, "ultracode-runs")), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool publishes completed only after terminal journal commit", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-terminal-publication-"));
  const registry = new WorkflowRegistry();
  const statuses: string[] = [];
  registry.subscribe(() => {
    const status = registry.list()[0]?.snapshot.status;
    if (status) statuses.push(status);
  });
  try {
    const tool = createWorkflowTool({
      registry,
      runWorkflowFn: (async (_script: string, options: any) => {
        const recordResult = options.journal.recordResult.bind(options.journal);
        options.journal.recordResult = (record: any) => {
          if (record.ok) throw new Error("terminal commit failed");
          return recordResult(record);
        };
        return {
          meta: { name: "terminal_publication", description: "x" }, result: 1,
          logs: [], phases: [], agentCount: 0, agentsUsed: 0, cachedCount: 0,
          spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: 128,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'terminal_publication', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute("terminal-publication", { script } as any, undefined, undefined, ctx),
      /terminal commit failed/i,
    );
    assert.equal(statuses.includes("completed"), false);
    assert.equal(registry.list()[0]?.snapshot.status, "failed");
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool isolates observer mutations from its durable completed result", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-terminal-observer-isolation-"));
  const registry = new WorkflowRegistry();
  registry.subscribe(() => {
    const view = registry.list()[0];
    if (view?.snapshot.status === "completed") (view.snapshot.result as any).ok = false;
  });
  try {
    const tool = createWorkflowTool({
      registry,
      runWorkflowFn: (async () => ({
        meta: { name: "terminal_observer_isolation", description: "x" }, result: { ok: true },
        logs: [], phases: [], agentCount: 0, agentsUsed: 0, cachedCount: 0,
        spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: 128,
      })) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'terminal_observer_isolation', description: 'x' }\nreturn { ok: true }`;
    const output: any = await tool.execute(
      "terminal-observer-isolation",
      { script } as any,
      undefined,
      (update: any) => {
        if (update.details.status === "completed") update.details.result.ok = false;
      },
      ctx,
    );

    assert.deepEqual(output.details.result, { ok: true });
    assert.match(output.content[0].text, /"ok": true/);
    assert.deepEqual(registry.get(output.details.runId)?.snapshot.result, { ok: true });
    const records = fs.readFileSync(
      path.join(sessionDir, "ultracode-runs", `${output.details.runId}.jsonl`),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.findLast((record) => record.type === "result")?.result, { ok: true });
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool preserves primary failure across failed-state observers", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-failure-observer-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async () => { throw new Error("PRIMARY failure"); }) as any,
    });
    const ctx: any = {
      cwd: process.cwd(),
      sessionManager: { getSessionDir: () => sessionDir },
      ui: { notify: () => { throw new Error("NOTIFY secondary"); } },
    };
    const script = `export const meta = { name: 'failure_observer', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute(
        "failure-observer",
        { script } as any,
        undefined,
        () => { throw new Error("UPDATE secondary"); },
        ctx,
      ),
      /PRIMARY failure/i,
    );
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool keeps a durable success when final journal close reports an error", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-close-fail-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        const close = options.journal.close.bind(options.journal);
        options.journal.close = () => {
          close();
          throw new Error("synthetic journal close failure");
        };
        return {
          meta: { name: "journal_close_fail", description: "x" }, result: 1,
          logs: [], phases: [], agentCount: 0, agentsUsed: 0, cachedCount: 0,
          spentTokens: 0, newTokens: 0, replayedTokens: 0, durationMs: 1, maxAgents: 128,
        };
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'journal_close_fail', description: 'x' }\nreturn 1`;
    const result = await tool.execute("journal-close-fail", { script } as any, undefined, undefined, ctx);
    assert.match((result.content[0] as any).text, /Workflow journal_close_fail completed/);
    assert.equal(activeWorkflowCount(path.join(sessionDir, "ultracode-runs")), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool preserves a primary failure when journal close also fails", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-primary-fail-"));
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async (_script: string, options: any) => {
        const close = options.journal.close.bind(options.journal);
        options.journal.close = () => {
          close();
          throw new Error("secondary close failure");
        };
        throw new Error("primary execution failure");
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'journal_primary_fail', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute("journal-primary-fail", { script } as any, undefined, undefined, ctx),
      /primary execution failure/i,
    );
    assert.equal(activeWorkflowCount(path.join(sessionDir, "ultracode-runs")), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool caps active top-level runs at four and releases slots for later runs", async () => {
  clearWorkflowLeasesForTests();
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-tool-lease-cap-"));
  const controls: Array<ReturnType<typeof deferred<any>>> = [];
  try {
    const tool = createWorkflowTool({
      runWorkflowFn: (async () => {
        const control = deferred<any>();
        controls.push(control);
        return await control.promise;
      }) as any,
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'lease_cap', description: 'x' }\nreturn 1`;
    const success = () => ({
      meta: { name: "lease_cap", description: "x" },
      result: 1,
      logs: [],
      phases: [],
      agentCount: 0,
      cachedCount: 0,
      spentTokens: 0,
      newTokens: 0,
      replayedTokens: 0,
      durationMs: 1,
      maxAgents: 128,
    });
    const runs = [0, 1, 2, 3].map((i) => tool.execute(`lease-${i}`, { script } as any, undefined, undefined, ctx));
    while (controls.length < 4) await new Promise((resolve) => setImmediate(resolve));
    const runsDir = path.join(sessionDir, "ultracode-runs");
    assert.equal(activeWorkflowCount(runsDir), 4);
    await assert.rejects(
      tool.execute("lease-5", { script } as any, undefined, undefined, ctx),
      /too many active workflows/,
    );
    controls[0].resolve(success());
    await runs[0];
    assert.equal(activeWorkflowCount(runsDir), 3);

    const later = tool.execute("lease-later", { script } as any, undefined, undefined, ctx);
    while (controls.length < 5) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeWorkflowCount(runsDir), 4);
    controls[4].resolve(success());
    await later;

    for (const control of controls.slice(1, 4)) control.resolve(success());
    await Promise.all(runs.slice(1));
    assert.equal(activeWorkflowCount(runsDir), 0);
  } finally {
    for (const control of controls) control.resolve?.({
      meta: { name: "lease_cap", description: "x" },
      result: 1,
      logs: [],
      phases: [],
      agentCount: 0,
      cachedCount: 0,
      spentTokens: 0,
      newTokens: 0,
      replayedTokens: 0,
      durationMs: 1,
      maxAgents: 128,
    });
    clearWorkflowLeasesForTests();
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool rejects oversized args before artifacts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-tool-args-limit-"));
  let runnerStarts = 0;
  try {
    const tool = createWorkflowTool({
      testRunner: {
        run: async () => {
          runnerStarts++;
          throw new Error("runner should not start");
        },
      },
    });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'args_limit', description: 'x' }\nreturn 1`;
    await assert.rejects(
      tool.execute("args-limit", {
        script,
        args: "x".repeat(MAX_WORKFLOW_ARGS_BYTES),
      } as any, undefined, undefined, ctx),
      /workflow args exceeds 1048576 bytes/,
    );
    assert.equal(runnerStarts, 0);
    assert.equal(fs.existsSync(path.join(sessionDir, "ultracode-runs")), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test("workflow tool rejects invalid maxAgents before artifacts", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bad-max-"));
  try {
    const tool = createWorkflowTool({ testRunner: { run: async () => { throw new Error("runner should not start"); } } });
    const ctx: any = { cwd: process.cwd(), sessionManager: { getSessionDir: () => sessionDir } };
    const script = `export const meta = { name: 'bad_max_tool', description: 'x' }\nreturn await agent('a')`;
    await assert.rejects(
      tool.execute("bad-max", { script, maxAgents: 0 } as any, undefined, undefined, ctx),
      /maxAgents.*between 1 and 1024/,
    );
    assert.equal(fs.existsSync(path.join(sessionDir, "ultracode-runs")), false);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
