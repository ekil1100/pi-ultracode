import { test } from "node:test";
import assert from "node:assert/strict";
import extension from "../extensions/ultracode.ts";
import { ANALYSIS_DEPTHS, DEPTH_CRITERIA, DEPTH_SELECTION_RULES } from "../src/depth.ts";
import { ULTRACODE_ACTIVE_REMINDER, ultracodeSystemBlock } from "../src/prompts.ts";

function harness(signal?: AbortSignal, jevAvailable = false) {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  let activeTools = ["read"];
  const pi: any = {
    on: (name: string, handler: any) => events.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: () => {}, registerFlag: () => {}, registerShortcut: () => {},
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
    getThinkingLevel: () => "low",
    setThinkingLevel: () => { throw new Error("Parent effort must not change"); },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  };
  extension(pi, { preferences: { getDefaultEnabled: () => false, setDefaultEnabled: () => {} } });
  const ctx: any = {
    cwd: process.cwd(), signal, hasUI: false,
    modelRegistry: {
      getAvailable: () => [],
      getAvailableOfType: async () => jevAvailable ? [{ type: "classifier", provider: "typesafe", id: "jev-latest" }] : [],
      classify: async () => { throw new Error("Depth selection must not classify"); },
    },
    sessionManager: { getBranch: () => entries },
    ui: { notify: (message: string) => notifications.push(message), setStatus: () => {}, theme: { fg: (_: string, value: string) => value } },
  };
  const emit = (name: string) => events.get(name)!({}, ctx);
  const command = (mode: string) => commands.get("ultracode").handler(mode, ctx);
  const start = (prompt = "Add a specified validation rule and its regression test") => {
    const event = { prompt, images: [{ data: "private-image" }], systemPromptOptions: { sections: { other: "untouched", ultracode: "old", ultracode_effort: "old" } as Record<string, string> } };
    const pending = events.get("before_agent_start")!(event, ctx);
    return { event, pending, sections: event.systemPromptOptions.sections };
  };
  return { emit, command, start, entries, notifications, ctx, commands, activeTools: () => activeTools };
}

for (const jevAvailable of [false, true]) {
  test(`auto uses parent routing regardless of native Jev availability: ${jevAvailable}`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Depth selection must not use the network");
    });
    const h = harness(undefined, jevAvailable);
    const available = t.mock.method(h.ctx.modelRegistry, "getAvailableOfType");
    const classify = t.mock.method(h.ctx.modelRegistry, "classify");
    await h.command("auto");
    for (const prompt of ["Investigate interacting invariants", "Fix a typo", "What about that?", "   "]) {
      const turn = h.start(prompt);
      await turn.pending;
      assert.equal(turn.sections.ultracode, `${ultracodeSystemBlock("auto")}\n\n${ULTRACODE_ACTIVE_REMINDER}`);
      assert.match(turn.sections.ultracode, /silently route this task to focused, standard, or deep/);
      assert.match(turn.sections.ultracode, /relevant conversation and repository context/);
      assert.doesNotMatch(turn.sections.ultracode, /Initial analysis depth|Fixed analysis depth|initial selector/);
      assert.ok(turn.sections.ultracode.includes(DEPTH_SELECTION_RULES));
      for (const criteria of Object.values(DEPTH_CRITERIA)) assert.ok(turn.sections.ultracode.includes(criteria));
      assert.equal(turn.sections.other, "untouched");
      assert.notEqual(turn.sections.ultracode_effort, "old");
      assert.equal(fetch.mock.callCount(), 0);
    }
    assert.deepEqual(h.entries.at(-1).data, { mode: "auto" });
    assert.equal(available.mock.callCount(), 0);
    assert.equal(classify.mock.callCount(), 0);
  });
}

for (const mode of ["off", ...ANALYSIS_DEPTHS]) {
  test(`${mode} never requests depth selection or overrides the fixed policy`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      throw new Error("Depth selection must not use the network");
    });
    const h = harness(undefined, true);
    await h.command(mode);
    const turn = h.start();
    await turn.pending;
    assert.equal(fetch.mock.callCount(), 0);
    if (mode === "off") {
      assert.equal(turn.sections.ultracode, undefined);
      assert.equal(turn.sections.ultracode_effort, undefined);
    } else {
      assert.match(turn.sections.ultracode, new RegExp(`Fixed analysis depth: ${mode}`));
      assert.match(turn.sections.ultracode, /Never silently exceed a fixed mode/);
      assert.doesNotMatch(turn.sections.ultracode, /silently route this task|Initial analysis depth/);
    }
  });
}

test("an aborted Pi context removes active prompt sections", async () => {
  const controller = new AbortController();
  const h = harness(controller.signal);
  await h.command("auto");
  controller.abort();
  const turn = h.start();
  await turn.pending;
  assert.equal(turn.sections.ultracode, undefined);
  assert.equal(turn.sections.ultracode_effort, undefined);
  assert.equal(turn.sections.other, "untouched");
});

test("mode changes, branch restoration, and shutdown update prompt policy", async () => {
  const h = harness();
  for (const mode of ["auto", ...ANALYSIS_DEPTHS, "off", "auto"]) {
    await h.command(mode);
    const turn = h.start();
    await turn.pending;
    if (mode === "off") assert.equal(turn.sections.ultracode, undefined);
    else assert.match(turn.sections.ultracode, new RegExp(`Configured mode: ${mode}`));
  }
  h.entries.push({ type: "custom", customType: "ultracode-mode", data: { mode: "standard" } });
  await h.emit("session_tree");
  const restored = h.start();
  await restored.pending;
  assert.match(restored.sections.ultracode, /Fixed analysis depth: standard/);
  await h.emit("session_shutdown");
  const stopped = h.start();
  await stopped.pending;
  assert.equal(stopped.sections.ultracode, undefined);
  assert.equal(stopped.sections.ultracode_effort, undefined);
  assert.equal(h.activeTools().includes("workflow"), false);
});

test("help, completions, and status describe verification rather than effort", async () => {
  const h = harness();
  for (const depth of ANALYSIS_DEPTHS) {
    await h.command(depth);
    await h.command("status");
    assert.ok(h.notifications.at(-1)!.includes(DEPTH_CRITERIA[depth]));
    assert.match(h.notifications.at(-1)!, /independent of model effort/);
    const item = h.commands.get("ultracode").getArgumentCompletions(depth)[0];
    assert.ok(item.description.includes(DEPTH_CRITERIA[depth]));
  }
  await h.command("auto");
  await h.command("status");
  assert.match(h.notifications.at(-1)!, /the parent selects focused, standard, or deep using task and context/);
  await h.command("help");
  assert.match(h.notifications.at(-1)!, /Fixed modes never switch depth automatically/);
  assert.doesNotMatch(h.notifications.join("\n"), /lightweight|balanced|high-assurance/);
});
