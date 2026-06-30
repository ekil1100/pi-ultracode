import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { jsonSchemaToTypeBox } from "../src/workflow/json-schema.ts";
import { parseFrontmatter, parseAgentTypeFile, discoverAgentTypes, resolveAgentType } from "../src/workflow/agent-types.ts";
import { agentCallKey, hashString, stableStringify, RunJournal } from "../src/workflow/journal.ts";
import { parseBudget, UltracodeMode } from "../src/mode.ts";

/** Minimal ExtensionAPI stub; `clampXhighTo` simulates a model whose max < xhigh. */
function miniPi(clampXhighTo?: string) {
  const s = { thinking: "medium", active: [] as string[], entries: [] as any[] };
  const api: any = {
    getThinkingLevel: () => s.thinking,
    setThinkingLevel: (l: string) => {
      s.thinking = l === "xhigh" && clampXhighTo ? clampXhighTo : l;
    },
    getActiveTools: () => s.active,
    setActiveTools: (t: string[]) => {
      s.active = t;
    },
    appendEntry: (type: string, data: unknown) => s.entries.push({ type, data }),
  };
  return { api, s };
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
    `---\nname: sec\ndescription: security\ntools: read,grep\nthinking: high\n---\nFind vulns.`,
    "fallback",
    "project",
  );
  assert.ok(def);
  assert.equal(def!.name, "sec");
  assert.deepEqual(def!.tools, ["read", "grep"]);
  assert.equal(def!.thinking, "high");
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

test("mode.toggle flips enabled state and restores the prior thinking level", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.thinking = "low";
  assert.equal(m.toggle(api), true);
  assert.equal(m.isEnabled(), true);
  assert.equal(s.thinking, "xhigh");
  assert.ok(s.active.includes("workflow"), "toggle on activates the workflow tool");
  assert.equal(m.toggle(api), false);
  assert.equal(m.isEnabled(), false);
  assert.equal(s.thinking, "low", "toggle off restores the prior level");
});

test("status reports xhigh when the model supports it", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi().api);
  assert.match(m.statusLine(), /thinking xhigh/);
});

test("status reports the clamped level for models without xhigh", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi("high").api);
  assert.equal(m.getAppliedThinking(), "high");
  assert.match(m.statusLine(), /thinking high/);
  assert.doesNotMatch(m.statusLine(), /unsupported|model max/);
});

test("status reports 'off' for non-reasoning models (xhigh clamps to off)", () => {
  const m = new UltracodeMode("workflow");
  m.enable(miniPi("off").api);
  assert.equal(m.getAppliedThinking(), "off");
  assert.match(m.statusLine(), /thinking off/);
});

test("parseBudget understands k/m/raw and + prefix", () => {
  assert.equal(parseBudget("500k"), 500_000);
  assert.equal(parseBudget("+500k"), 500_000);
  assert.equal(parseBudget("1m"), 1_000_000);
  assert.equal(parseBudget("250000"), 250_000);
  assert.equal(parseBudget("1.5m"), 1_500_000);
  assert.equal(parseBudget("garbage"), null);
});

test("UltracodeMode.getSubagentThinkingLevel: xhigh when enabled, undefined when off", () => {
  const m = new UltracodeMode("workflow");
  assert.equal(m.getSubagentThinkingLevel(), undefined, "off before enable");
  m.enable(miniPi().api);
  assert.equal(m.getSubagentThinkingLevel(), "xhigh", "xhigh to forward when on");
  m.disable(miniPi().api);
  assert.equal(m.getSubagentThinkingLevel(), undefined, "undefined again after disable");
});
