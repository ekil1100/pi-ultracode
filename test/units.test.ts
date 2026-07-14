import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { jsonSchemaToTypeBox } from "../src/workflow/json-schema.ts";
import { parseFrontmatter, parseAgentTypeFile, discoverAgentTypes, resolveAgentType } from "../src/workflow/agent-types.ts";
import { agentCallKey, hashString, stableStringify, RunJournal } from "../src/workflow/journal.ts";
import { parseBudget, UltracodeMode } from "../src/mode.ts";
import { piVersionSupportsMaxThinking } from "../src/thinking.ts";

/** Minimal ExtensionAPI stub with mutable per-request clamp behavior. */
function miniPi(clamps: Record<string, string> = {}) {
  const s = { thinking: "medium", active: [] as string[], entries: [] as any[] };
  const api: any = {
    getThinkingLevel: () => s.thinking,
    setThinkingLevel: (level: string) => {
      s.thinking = clamps[level] ?? level;
    },
    getActiveTools: () => s.active,
    setActiveTools: (t: string[]) => {
      s.active = t;
    },
    appendEntry: (type: string, data: unknown) => s.entries.push({ type, data }),
  };
  return { api, s, clamps };
}

test("jsonSchemaToTypeBox builds an object schema with required/optional", () => {
  const schema = jsonSchemaToTypeBox({
    type: "object",
    properties: { a: { type: "string", description: "the a" }, b: { type: "number" } },
    required: ["a"],
  }) as any;
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.a);
  assert.equal(schema.required?.includes("a"), true);
  // b is optional, so it should not be required.
  assert.equal((schema.required ?? []).includes("b"), false);
});

test("jsonSchemaToTypeBox maps enum to a union of literals", () => {
  const schema = jsonSchemaToTypeBox({ enum: ["x", "y"] }) as any;
  assert.ok(Array.isArray(schema.anyOf) || schema.const !== undefined || schema.enum);
});

test("jsonSchemaToTypeBox handles arrays", () => {
  const schema = jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }) as any;
  assert.equal(schema.type, "array");
  assert.equal(schema.items.type, "string");
});

test("parseFrontmatter parses key/values and block scalars", () => {
  const { frontmatter, body } = parseFrontmatter(
    `---\nname: reviewer\ndescription: hunts bugs\ntools: read, bash\nsystemPrompt: |\n  Line one\n  Line two\n---\nbody text`,
  );
  assert.equal(frontmatter.name, "reviewer");
  assert.equal(frontmatter.tools, "read, bash");
  assert.equal(frontmatter.systemPrompt, "Line one\nLine two");
  assert.equal(body.trim(), "body text");
});

test("parseAgentTypeFile builds an AgentTypeDef", () => {
  const def = parseAgentTypeFile(
    `---\nname: sec\ndescription: security\ntools: read,grep\nthinking: max\n---\nFind vulns.`,
    "fallback",
    "project",
  );
  assert.ok(def);
  assert.equal(def!.name, "sec");
  assert.deepEqual(def!.tools, ["read", "grep"]);
  assert.equal(def!.thinking, "max");
  assert.equal(def!.systemPrompt, "Find vulns.");
});

test("discoverAgentTypes includes built-ins and resolves case-insensitively", () => {
  const types = discoverAgentTypes(os.tmpdir());
  assert.ok(types.has("Explore"));
  assert.ok(types.has("code-reviewer"));
  assert.equal(resolveAgentType("explore", types)?.name, "Explore");
  assert.equal(resolveAgentType("nope", types), undefined);
});

test("hash + stableStringify are stable and key-order independent", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(agentCallKey("p", { a: 1, b: 2 }), agentCallKey("p", { b: 2, a: 1 }));
  assert.notEqual(agentCallKey("p", { a: 1 }), agentCallKey("p", { a: 2 }));
  assert.equal(typeof hashString("abc"), "string");
});

test("RunJournal records and looks up cached agents on resume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-"));
  const runId = "wf_x";
  const j = RunJournal.create(dir, { type: "run", runId, name: "n", scriptHash: "1", startedAt: 0 });
  j.recordAgent({ seq: 1, key: "k1", label: "a", value: "v1", outputTokens: 5 });
  j.recordAgent({ seq: 2, key: "k2", label: "b", value: { x: 1 }, outputTokens: 6 });
  j.close();

  const r = RunJournal.resume(dir, runId, { type: "run", runId, name: "n", scriptHash: "1", startedAt: 1 });
  assert.equal(r.lookup(1, "k1")?.value, "v1");
  assert.deepEqual(r.lookup(2, "k2")?.value, { x: 1 });
  assert.equal(r.lookup(1, "different-key"), undefined, "key mismatch is a cache miss");
  assert.equal(r.lookup(3, "k3"), undefined);
  r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mode.toggle requests max and restores the prior thinking level", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.thinking = "low";
  assert.equal(m.toggle(api), true);
  assert.equal(m.isEnabled(), true);
  assert.equal(s.thinking, "max");
  assert.ok(s.active.includes("workflow"), "toggle on activates the workflow tool");
  assert.equal(m.toggle(api), false);
  assert.equal(m.isEnabled(), false);
  assert.equal(s.thinking, "low", "toggle off restores the prior level");
});

test("restore migrates an enabled entry that lacks a previous effort", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.thinking = "low";
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true, budgetTotal: null },
  }]);
  assert.equal(s.thinking, "max");
  m.disable(api);
  assert.equal(s.thinking, "low", "missing legacy baseline is captured before max is applied");
});

test("an explicit off baseline is not rewritten by later thinking events", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "off", effective: "off" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "off";
  m.enable(api);
  s.thinking = "low";
  assert.equal(m.handleThinkingLevelSelect(api, "low"), true);
  m.disable(api);
  assert.equal(s.thinking, "off", "the original explicit off level is restored");
});

test("a non-reasoning baseline survives automatic re-clamp ordering and persistence", async () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "off", xhigh: "off", high: "off" });
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "low", effective: "high" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(false);
  s.thinking = "off";
  m.enable(api);
  m.disable(api);
  const disabledEntry = s.entries.at(-1)?.data;
  assert.equal(disabledEntry.pendingPreviousThinking, "high");

  // Pi emits thinking_level_select before model_select during a model switch.
  delete clamps.high;
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "low";
  assert.equal(m.handleThinkingLevelSelect(api, "low"), false);
  assert.equal(m.handleModelSelect(api), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(s.thinking, "high", "automatic re-clamp does not cancel restoration");

  // A disabled persisted entry carries a deferred restoration across reload.
  const restored = new UltracodeMode("workflow");
  restored.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "low", effective: "high" }),
    setDefaultThinkingLevel: () => {},
  });
  restored.setCurrentModelSupportsThinking(false);
  s.thinking = "off";
  restored.restore(api, [{ type: "custom", customType: "ultracode-mode", data: disabledEntry }]);
  restored.setCurrentModelSupportsThinking(true);
  s.thinking = "low";
  restored.handleModelSelect(api);
  assert.equal(s.thinking, "high");
});

test("unknown-model startup preserves the effective default instead of temporary off", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "low", effective: "low" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(undefined);
  s.thinking = "off";
  m.enable(api);
  m.setCurrentModelSupportsThinking(true);
  m.disable(api);
  assert.equal(s.thinking, "low");
});

test("an implicit default restores medium after a non-reasoning model", () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "off", xhigh: "off", medium: "off" });
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: undefined, effective: "medium" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(false);
  s.thinking = "off";
  m.enable(api);

  delete clamps.max;
  delete clamps.xhigh;
  delete clamps.medium;
  m.setCurrentModelSupportsThinking(true);
  m.handleModelSelect(api);
  m.disable(api);
  assert.equal(s.thinking, "medium");
});

test("a branch effort clamped by the current model is restored on a later model", () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "high", xhigh: "high" });
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "high";
  m.restore(api, [{ type: "thinking_level_change", thinkingLevel: "max" }]);
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, "max");

  delete clamps.max;
  delete clamps.xhigh;
  s.thinking = "high";
  m.handleModelSelect(api);
  assert.equal(s.thinking, "max");
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);
});

test("an automatic off clamp does not erase pending restoration", () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "off", xhigh: "off", low: "off" });
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "low", effective: "low" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(false);
  s.thinking = "off";
  m.enable(api);
  m.disable(api);

  delete clamps.low;
  m.setCurrentModelSupportsThinking(true);
  m.handleModelSelect(api);
  assert.equal(s.thinking, "low");
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);
});

test("explicit scoped off clears pending while still on a non-reasoning model", async () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "off", xhigh: "off", low: "off" });
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: "low", effective: "low" }),
    setDefaultThinkingLevel: () => {},
  });
  m.setCurrentModelSupportsThinking(false);
  s.thinking = "off";
  m.enable(api);
  m.disable(api);

  m.handleThinkingLevelSelect(api, "off");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);

  delete clamps.max;
  delete clamps.xhigh;
  delete clamps.low;
  m.setCurrentModelSupportsThinking(true);
  m.handleModelSelect(api);
  assert.equal(s.thinking, "off", "the explicit :off selection prevents later restoration");
});

test("an intermediate xhigh-only model does not consume a pending max baseline", () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi();
  m.setRuntimeSupportsMaxThinking(true);
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "max";
  m.enable(api);

  clamps.max = "high";
  clamps.xhigh = "high";
  s.thinking = "high";
  m.handleModelSelect(api);
  m.disable(api);
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, "max");

  clamps.max = "xhigh";
  clamps.xhigh = "xhigh";
  s.thinking = "high";
  m.handleModelSelect(api);
  assert.equal(s.thinking, "xhigh");
  assert.equal(
    s.entries.at(-1)?.data.pendingPreviousThinking,
    "max",
    "model fallback must not replace the original max baseline",
  );

  delete clamps.max;
  delete clamps.xhigh;
  s.thinking = "xhigh";
  m.handleModelSelect(api);
  assert.equal(s.thinking, "max");
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);
});

test("an explicit branch off after a disabled mode snapshot clears pending restoration", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "off";
  m.restore(api, [
    {
      type: "custom",
      customType: "ultracode-mode",
      data: {
        enabled: false,
        budgetTotal: null,
        previousThinking: "high",
        pendingPreviousThinking: "high",
      },
    },
    { type: "thinking_level_change", thinkingLevel: "off" },
  ]);
  assert.equal(s.thinking, "off");
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);
});

test("restore consumes a pending level even when the reasoning model currently reports off", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "off";
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: {
      enabled: false,
      budgetTotal: null,
      previousThinking: "high",
      pendingPreviousThinking: "high",
    },
  }]);
  assert.equal(s.thinking, "high");
  assert.equal(s.entries.at(-1)?.data.pendingPreviousThinking, undefined);
});

test("legacy Pi restores a persisted max baseline through xhigh", () => {
  const m = new UltracodeMode("workflow");
  m.setRuntimeSupportsMaxThinking(false);
  const { api, s } = miniPi({ max: "off" });
  s.thinking = "medium";
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: {
      enabled: true,
      budgetTotal: null,
      previousThinking: "max",
    },
  }]);
  assert.equal(s.thinking, "xhigh");
  m.disable(api);
  assert.equal(s.thinking, "xhigh", "unknown max is normalized during restoration too");
});

test("pre-max Pi normalizes a persisted global max preference to xhigh", async () => {
  const m = new UltracodeMode("workflow");
  m.setRuntimeSupportsMaxThinking(false);
  const { api, s } = miniPi({ max: "off" });
  let global: string | undefined = "max";
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: global as any, effective: global as any }),
    setDefaultThinkingLevel: (level) => {
      global = level ?? "medium";
    },
  });
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "off";
  m.enable(api);
  assert.equal(s.thinking, "xhigh");
  m.disable(api);
  await m.flushThinkingPreference();
  assert.equal(s.thinking, "xhigh");
  assert.equal(global, "xhigh", "an old runtime must not write unknown max back to settings");
});

test("disable is idempotent and does not rebuild deferred state", async () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "off", xhigh: "off" });
  s.thinking = "xhigh";
  m.enable(api);
  m.disable(api);

  s.thinking = "low";
  m.handleThinkingLevelSelect(api, "low");
  await new Promise<void>((resolve) => setImmediate(resolve));
  m.disable(api);

  delete clamps.xhigh;
  m.handleModelSelect(api);
  assert.equal(s.thinking, "low", "a repeated off cannot resurrect the stale xhigh baseline");
});

test("legacy active entries recover the pre-mode default even without an effort change", async () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi({ max: "xhigh", xhigh: "xhigh" });
  let global: string | undefined = "xhigh";
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: global as any, effective: global as any }),
    setDefaultThinkingLevel: (level) => {
      global = level ?? "medium";
    },
  });
  m.setCurrentModelSupportsThinking(true);
  s.thinking = "xhigh";
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: {
      enabled: true,
      budgetTotal: null,
      previousThinking: "low",
    },
  }]);
  await m.flushThinkingPreference();
  assert.equal(global, "low", "legacy xhigh pollution is migrated to the saved baseline");
  assert.equal(s.entries.at(-1)?.data.previousDefaultThinking, "low");
  m.disable(api);
  await m.flushThinkingPreference();
  assert.equal(s.thinking, "low");
  assert.equal(global, "low");
});

test("restore adopts a newer global preference instead of an old persisted snapshot", async () => {
  const m = new UltracodeMode("workflow");
  const { api } = miniPi();
  let global: string | undefined = "high";
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: global as any, effective: global as any }),
    setDefaultThinkingLevel: (level) => {
      global = level ?? "medium";
    },
  });
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: {
      enabled: true,
      budgetTotal: null,
      previousThinking: "low",
      previousDefaultThinking: "low",
    },
  }]);
  await m.flushThinkingPreference();
  assert.equal(global, "high");
});

test("preference restoration runs after Pi's queued settings writes", async () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  let disk: string | undefined = "low";
  let piWrites = Promise.resolve();
  api.setThinkingLevel = (level: string) => {
    s.thinking = level;
    piWrites = piWrites.then(() => {
      disk = level;
    });
  };
  m.bindThinkingPreferenceStore({
    getThinkingPreference: () => ({ global: disk as any, effective: disk as any }),
    setDefaultThinkingLevel: async (level) => {
      disk = level ?? "medium";
    },
  });

  m.enable(api);
  await m.flushThinkingPreference();
  await piWrites;
  assert.equal(disk, "low");

  api.setThinkingLevel("high");
  m.handleThinkingLevelSelect(api, "high");
  await m.flushThinkingPreference();
  await piWrites;
  assert.equal(s.thinking, "max");
  assert.equal(disk, "low", "the restoration wins over the whole Pi write chain");
});

test("status reports max without a redundant thinking label", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi().api);
  assert.equal(m.statusLine(), "ultracode: on · max");
});

test("status reports the real model-clamped level", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi({ max: "high", xhigh: "high" }).api);
  assert.equal(m.getAppliedThinking(), "high");
  assert.equal(m.statusLine(), "ultracode: on · high");
});

test("status reports off for non-reasoning models", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi({ max: "off", xhigh: "off" }).api);
  assert.equal(m.getAppliedThinking(), "off");
  assert.equal(m.statusLine(), "ultracode: on · off");
});

test("legacy Pi fallback retries xhigh when max is not recognized", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi({ max: "off" }).api);
  assert.equal(m.getAppliedThinking(), "xhigh");
  assert.equal(m.statusLine(), "ultracode: on · xhigh");
});

test("model changes reapply max and manual effort changes are overridden", () => {
  const m = new UltracodeMode("workflow");
  const { api, s, clamps } = miniPi({ max: "xhigh" });
  m.enable(api);
  assert.equal(s.thinking, "xhigh");

  delete clamps.max;
  m.reapplyMaximumThinking(api);
  assert.equal(s.thinking, "max", "a newly selected max-capable model is raised to max");

  s.thinking = "high";
  assert.equal(m.handleThinkingLevelSelect(api, "high"), true);
  assert.equal(s.thinking, "max", "manual lowering is immediately overridden");
});

test("thinking selection handler ignores settled and stale events", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi({ max: "xhigh" });
  m.enable(api);
  assert.equal(m.handleThinkingLevelSelect(api, "xhigh"), false, "accepted fallback is settled");
  s.thinking = "xhigh";
  assert.equal(m.handleThinkingLevelSelect(api, "off"), false, "stale event is ignored");
});

test("mode-owned synchronous thinking events do not recurse", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi({ max: "off" });
  const setThinking = api.setThinkingLevel;
  let calls = 0;
  api.setThinkingLevel = (level: string) => {
    calls++;
    assert.ok(calls < 10, "thinking enforcement must not recurse indefinitely");
    setThinking(level);
    m.handleThinkingLevelSelect(api, s.thinking as any);
  };

  m.enable(api);
  assert.equal(s.thinking, "xhigh");
  assert.equal(calls, 2, "max plus one legacy fallback request");

  api.setThinkingLevel("high");
  assert.equal(s.thinking, "xhigh", "manual lowering is reasserted through the same event path");
  assert.equal(calls, 5);
});

test("Pi version detection gates max at 0.80.6", () => {
  assert.equal(piVersionSupportsMaxThinking("0.80.5"), false);
  assert.equal(piVersionSupportsMaxThinking("0.80.6"), true);
  assert.equal(piVersionSupportsMaxThinking("0.81.0"), true);
  assert.equal(piVersionSupportsMaxThinking("1.0.0"), true);
  assert.equal(piVersionSupportsMaxThinking("custom-build"), true);
});

test("parseBudget understands k/m/raw and + prefix", () => {
  assert.equal(parseBudget("500k"), 500_000);
  assert.equal(parseBudget("+500k"), 500_000);
  assert.equal(parseBudget("1m"), 1_000_000);
  assert.equal(parseBudget("250000"), 250_000);
  assert.equal(parseBudget("1.5m"), 1_500_000);
  assert.equal(parseBudget("garbage"), null);
});

test("UltracodeMode.getSubagentThinkingLevel: max when enabled, undefined when off", () => {
  const m = new UltracodeMode("workflow");
  const { api } = miniPi();
  assert.equal(m.getSubagentThinkingLevel(), undefined, "off before enable");
  m.enable(api);
  assert.equal(m.getSubagentThinkingLevel(), "max", "raw max request is forwarded when on");
  m.disable(api);
  assert.equal(m.getSubagentThinkingLevel(), undefined, "undefined again after disable");
});

test("suspend quiesces all effort and prompt enforcement", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  m.enable(api);
  m.suspend(api);
  assert.equal(s.thinking, "medium");
  assert.equal(m.getSubagentThinkingLevel(), undefined);
  s.thinking = "high";
  assert.equal(m.reapplyMaximumThinking(api), false);
  assert.equal(m.handleModelSelect(api), false);
  assert.equal(s.thinking, "high");
  assert.equal(m.beforeAgentStart({ systemPrompt: "BASE" }), undefined);
});
