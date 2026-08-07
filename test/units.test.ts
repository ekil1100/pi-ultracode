import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import { jsonSchemaToTypeBox } from "../src/workflow/json-schema.ts";
import { Check } from "typebox/value";
import { createStructuredOutputTool } from "../src/workflow/structured-output.ts";
import { parseFrontmatter, parseAgentTypeFile, discoverAgentTypes, resolveAgentType } from "../src/workflow/agent-types.ts";
import {
  agentCallKey,
  hashString,
  MAX_JOURNAL_BYTES,
  stableStringify,
  RunJournal,
} from "../src/workflow/journal.ts";
import { UltracodeMode } from "../src/mode.ts";
import { piVersionSupportsMaxThinking } from "../src/thinking.ts";
import { acquireWorkflowLease, activeWorkflowCount, clearWorkflowLeasesForTests } from "../src/workflow/leases.ts";
import { writeArtifactFile } from "../src/workflow/run-artifacts.ts";
import {
  assertStructuredOutputLimit,
  assertWorkflowArgsLimit,
  assertWorkflowSchemaLimit,
  MAX_STRUCTURED_OUTPUT_BYTES,
  MAX_WORKFLOW_ARGS_BYTES,
  MAX_WORKFLOW_SCHEMA_BYTES,
} from "../src/workflow/value-limits.ts";

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

test("workflow value limits bound args, schemas, patterns, and structured output", () => {
  assert.doesNotThrow(() => assertWorkflowArgsLimit({ value: "ok" }));
  assert.throws(
    () => assertWorkflowArgsLimit("x".repeat(MAX_WORKFLOW_ARGS_BYTES)),
    /args.*1048576 bytes/i,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ description: "x".repeat(MAX_WORKFLOW_SCHEMA_BYTES) }),
    /schema.*262144 bytes/i,
  );
  assert.throws(
    () => assertWorkflowArgsLimit(new Map([["large", "x".repeat(MAX_WORKFLOW_ARGS_BYTES)]])),
    /workflow args.*plain JSON/i,
  );
  assert.throws(
    () => assertWorkflowArgsLimit(new ArrayBuffer(MAX_WORKFLOW_ARGS_BYTES + 1)),
    /workflow args.*plain JSON/i,
  );
  assert.throws(
    () => assertWorkflowArgsLimit({ value: -0 }),
    /negative zero is unsupported/i,
  );
  assert.throws(
    () => assertWorkflowArgsLimit(new Array(1_000_000)),
    /arrays must not be sparse/,
  );
  assert.throws(
    () => assertWorkflowArgsLimit(new Array(65_537).fill(null)),
    /exceeds 65536 JSON nodes/,
  );
  let sharedDag: unknown = "x";
  for (let depth = 0; depth < 30; depth++) sharedDag = [sharedDag, sharedDag];
  assert.throws(
    () => assertWorkflowArgsLimit(sharedDag),
    /JSON tree.*repeated object references/,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ type: "string", pattern: "^(a+){20}$" }),
    /schema pattern is not supported/i,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ $ref: "https://example.com/schema.json" }),
    /\$ref.*not supported/i,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ patternProperties: { "^(a+)+$": { type: "string" } } }),
    /patternProperties.*not supported/i,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ $dynamicRef: "#node" }),
    /\$dynamicRef.*not supported/i,
  );
  assert.throws(
    () => assertWorkflowSchemaLimit({ type: "string", unknownConstraint: true }),
    /unsupported keyword unknownConstraint/i,
  );
  assert.doesNotThrow(() => assertWorkflowSchemaLimit({
    type: "object",
    properties: {
      pattern: { type: "string" },
      $ref: { type: "number" },
    },
  }));
  let deepSchema: unknown = { type: "string" };
  for (let depth = 0; depth < 70; depth++) deepSchema = { items: deepSchema };
  assert.throws(
    () => assertWorkflowSchemaLimit(deepSchema),
    /schema exceeds the 64-level nesting limit/i,
  );
  assert.throws(
    () => assertStructuredOutputLimit({ value: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) }),
    /structured output.*2097152 bytes/i,
  );
});

test("structured output rejects oversized values before capture", async () => {
  const capture: any = { called: false, value: undefined };
  const tool = createStructuredOutputTool({
    schema: jsonSchemaToTypeBox({ type: "object" }),
    capture,
  });
  await assert.rejects(
    (tool.execute as any)(
      "structured-limit",
      { value: "x".repeat(MAX_STRUCTURED_OUTPUT_BYTES) },
      undefined,
      undefined,
      {},
    ),
    /workflow structured output exceeds 2097152 bytes/,
  );
  assert.equal(capture.called, false);
});

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

test("jsonSchemaToTypeBox preserves object and array enum/const values", () => {
  const objectConst = jsonSchemaToTypeBox({ const: { a: 1 } }) as any;
  assert.equal(Check(objectConst, { a: 1 }), true);
  assert.equal(Check(objectConst, { a: 2 }), false);

  const arrayEnum = jsonSchemaToTypeBox({ enum: [[1, 2], { kind: "ok" }] }) as any;
  assert.equal(Check(arrayEnum, [1, 2]), true);
  assert.equal(Check(arrayEnum, [1, 3]), false);
  assert.equal(Check(arrayEnum, { kind: "ok" }), true);
});

test("tuple-form items retain JSON Schema's default extra-item semantics", () => {
  const schema = jsonSchemaToTypeBox({
    type: "array",
    items: [{ type: "string" }],
  }) as any;
  assert.equal(schema.additionalItems, true);
  assert.equal(Check(schema, []), true);
  assert.equal(Check(schema, ["ok", 42]), true);
  assert.equal(Check(schema, [1]), false);
});

test("jsonSchemaToTypeBox preserves every supported numeric constraint", () => {
  const schema = jsonSchemaToTypeBox({
    type: "number",
    minimum: 1,
    maximum: 9,
    exclusiveMinimum: 0,
    exclusiveMaximum: 10,
    multipleOf: 0.5,
  }) as any;
  assert.equal(schema.minimum, 1);
  assert.equal(schema.maximum, 9);
  assert.equal(schema.exclusiveMinimum, 0);
  assert.equal(schema.exclusiveMaximum, 10);
  assert.equal(schema.multipleOf, 0.5);
});

test("jsonSchemaToTypeBox preserves the __proto__ property as an own constraint", () => {
  const properties = JSON.parse('{"__proto__":{"type":"string"}}');
  const schema = jsonSchemaToTypeBox({
    type: "object",
    properties,
    required: ["__proto__"],
    additionalProperties: false,
  }) as any;
  assert.equal(Object.hasOwn(schema.properties, "__proto__"), true);
  assert.equal(Check(schema, JSON.parse('{"__proto__":"ok"}')), true);
  assert.equal(Check(schema, {}), false);
  assert.equal(Check(schema, JSON.parse('{"__proto__":42}')), false);
});

test("jsonSchemaToTypeBox permits data fields named like forbidden schema keywords", () => {
  const schema = jsonSchemaToTypeBox({
    type: "object",
    properties: {
      pattern: { type: "string" },
      $ref: { type: "number" },
    },
    required: ["pattern", "$ref"],
  }) as any;
  assert.ok(schema.properties.pattern);
  assert.ok(schema.properties.$ref);
  assert.deepEqual(schema.required.sort(), ["$ref", "pattern"]);
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

test("artifact writes reject symlinked parent directories below their trusted root", {
  skip: process.platform === "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-artifact-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "uc-artifact-outside-"));
  try {
    fs.symlinkSync(outside, path.join(root, "bridge"), "dir");
    assert.throws(
      () => writeArtifactFile(
        path.join(root, "bridge", "nested", "value.json"),
        "value",
        { trustedRoot: root },
      ),
      /real directory|symlink/i,
    );
    assert.equal(fs.existsSync(path.join(outside, "nested")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("RunJournal records and looks up cached agents on resume", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-"));
  const runId = "wf_x";
  const j = RunJournal.create(dir, { type: "run", runId, name: "n", scriptHash: "1", startedAt: 0 });
  j.recordAdmission("$/a:0", "k1", 1);
  j.recordAgent({ callPath: "$/a:0", seq: 1, key: "k1", label: "a", value: "v1", outputTokens: 5 });
  j.recordAdmission("$/a:1", "k2", 2);
  j.recordAgent({ callPath: "$/a:1", seq: 2, key: "k2", label: "b", value: { x: 1 }, outputTokens: 6 });
  j.close();

  const r = RunJournal.resume(dir, runId, { type: "run", runId, name: "n", scriptHash: "1", startedAt: 1 });
  assert.equal(r.lookup("$/a:0", "k1")?.value, "v1");
  assert.deepEqual(r.lookup("$/a:1", "k2")?.value, { x: 1 });
  assert.throws(() => r.lookup("$/a:0", "different-key"), /diverged/);
  assert.equal(r.lookup("$/a:2", "k3"), undefined);
  r.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RunJournal treats JSON object key order as part of immutable args", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-args-order-"));
  const runId = "wf_args_order";
  try {
    const journal = RunJournal.create(dir, {
      type: "run",
      runId,
      name: "args_order",
      scriptHash: "1",
      args: { a: 1, b: 2 },
      startedAt: 0,
    });
    journal.close();
    assert.throws(
      () => RunJournal.resume(dir, runId, {
        type: "run",
        runId,
        name: "args_order",
        scriptHash: "1",
        args: { b: 2, a: 1 },
        startedAt: 1,
      }),
      /immutable args/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal rejects a conflicting panel definition before append", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-panel-definition-"));
  const runId = "wf_panel_definition";
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_definition", scriptHash: "1", startedAt: 0,
    });
    journal.recordPanelOpen("$/p:0", 1, 1);
    const before = fs.readFileSync(journal.filePath, "utf8");
    assert.throws(
      () => journal.recordPanelOpen("$/p:0", 2, 2),
      /immutable panel definition changed/i,
    );
    assert.equal(fs.readFileSync(journal.filePath, "utf8"), before);
    journal.close();
    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_definition", scriptHash: "1", startedAt: 1,
    });
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal rechecks final panel admissions before completion", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-panel-final-admission-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_panel_final_admission", name: "panel_final_admission", scriptHash: "1", startedAt: 0,
    });
    journal.recordPanelOpen("$/p:0", 2, 2);
    journal.recordPanelBranch("$/p:0", 0, "success", []);
    journal.recordPanelBranch("$/p:0", 1, "success", []);
    journal.recordAdmission("$/p:0/b:1/a:0", "k", 1);
    const before = fs.readFileSync(journal.filePath, "utf8");
    assert.throws(
      () => journal.recordPanelComplete("$/p:0", 2, ["success", "success"], []),
      /invalid panel-branch record/i,
    );
    assert.equal(fs.readFileSync(journal.filePath, "utf8"), before);
    journal.close();
    assert.throws(
      () => RunJournal.resume(dir, "wf_panel_final_admission", {
        type: "run",
        runId: "wf_panel_final_admission",
        name: "panel_final_admission",
        scriptHash: "1",
        startedAt: 1,
      }),
      /invalid panel-branch record/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal poisons the descriptor after a partial append failure", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-poison-"));
  const runId = "wf_poison";
  const journal = RunJournal.create(dir, {
    type: "run", runId, name: "poison", scriptHash: "1", startedAt: 0,
  });
  const originalWrite = fsDefault.writeFileSync;
  let injected = false;
  try {
    (fsDefault as any).writeFileSync = (target: any, data: any, ...rest: any[]) => {
      if (!injected && target === (journal as any).fd) {
        injected = true;
        const text = String(data);
        (originalWrite as any)(target, text.slice(0, Math.max(1, Math.floor(text.length / 2))), ...rest);
        throw new Error("synthetic partial write");
      }
      return (originalWrite as any).call(fsDefault, target, data, ...rest);
    };
    syncBuiltinESMExports();
    assert.throws(
      () => journal.recordAdmission("$/a:0", "k", 1),
      /journal write failed.*synthetic partial write/i,
    );
  } finally {
    (fsDefault as any).writeFileSync = originalWrite;
    syncBuiltinESMExports();
  }
  try {
    const poisonedSize = fs.statSync(journal.filePath).size;
    assert.throws(
      () => journal.recordResult({ ok: false, error: "must not append", agentCount: 0, durationMs: 0 }),
      /synthetic partial write/i,
    );
    assert.equal(fs.statSync(journal.filePath).size, poisonedSize);
    assert.throws(() => journal.close(), /synthetic partial write/i);

    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "poison", scriptHash: "1", startedAt: 1,
    });
    assert.equal(resumed.agentsUsed, 0);
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal preserves a close fsync failure across retries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-close-fsync-"));
  const journal = RunJournal.create(dir, {
    type: "run", runId: "wf_close_fsync", name: "close_fsync", scriptHash: "1", startedAt: 0,
  });
  const originalFsync = fsDefault.fsyncSync;
  let injected = false;
  try {
    (fsDefault as any).fsyncSync = (fd: number) => {
      if (!injected && fd === (journal as any).fd) {
        injected = true;
        throw new Error("synthetic close fsync failure");
      }
      return originalFsync.call(fsDefault, fd);
    };
    syncBuiltinESMExports();
    assert.throws(() => journal.close(), /synthetic close fsync failure/);
  } finally {
    (fsDefault as any).fsyncSync = originalFsync;
    syncBuiltinESMExports();
  }
  try {
    assert.throws(() => journal.close(), /synthetic close fsync failure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal rejects invalid metadata before writing a self-corrupting record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-invalid-write-"));
  try {
    assert.throws(
      () => RunJournal.create(dir, {
        type: "run",
        runId: "wf_invalid_create",
        name: "invalid_create",
        scriptHash: "1",
        startedAt: Number.NaN,
      }),
      /invalid run header/i,
    );
    assert.equal(fs.existsSync(path.join(dir, "wf_invalid_create.jsonl")), false);

    const runId = "wf_invalid_resume";
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "valid", scriptHash: "1", startedAt: 0,
    });
    journal.close();
    const before = fs.readFileSync(journal.filePath, "utf8");
    assert.throws(
      () => RunJournal.resume(dir, runId, {
        type: "run", runId, name: "valid", scriptHash: "1", startedAt: Number.NaN,
      }),
      /invalid run header|invalid resume/i,
    );
    assert.equal(fs.readFileSync(journal.filePath, "utf8"), before);
    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "valid", scriptHash: "1", startedAt: 1,
    });
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal rejects semantically corrupt cached agent records", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-corrupt-agent-"));
  const runId = "wf_corrupt_agent";
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "corrupt", scriptHash: "1", startedAt: 0,
    });
    journal.recordAdmission("$/a:0", "k", 1);
    journal.close();
    fs.appendFileSync(journal.filePath, `${JSON.stringify({
      type: "agent",
      callPath: "$/a:0",
      seq: 1,
      key: "k",
      label: "bad",
      value: "value",
      outputTokens: "not-a-number",
    })}\n`);
    assert.throws(
      () => RunJournal.resume(dir, runId, {
        type: "run", runId, name: "corrupt", scriptHash: "1", startedAt: 1,
      }),
      /invalid agent record/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal rejects an append before it would exceed the restore cap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-cap-"));
  const runId = "wf_cap";
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "cap", scriptHash: "1", startedAt: 0,
    });
    const sizeBefore = fs.statSync(journal.filePath).size;
    assert.throws(
      () => journal.recordResult({
        ok: false,
        error: "x".repeat(MAX_JOURNAL_BYTES),
        agentCount: 0,
        durationMs: 0,
      }),
      /journal full|exceed.*byte cap/i,
    );
    assert.equal(fs.statSync(journal.filePath).size, sizeBefore);
    journal.close();
    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "cap", scriptHash: "1", startedAt: 1,
    });
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal resume discards only a torn final JSONL record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-torn-"));
  const runId = "wf_torn";
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "torn", scriptHash: "1", startedAt: 0,
    });
    journal.close();
    fs.appendFileSync(journal.filePath, '{"type":"result","ok":');

    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "torn", scriptHash: "1", startedAt: 1,
    });
    resumed.close();
    const lines = fs.readFileSync(journal.filePath, "utf8").trim().split("\n");
    assert.doesNotThrow(() => lines.map((line) => JSON.parse(line)));
    assert.equal(lines.some((line) => line.includes('"type":"resume"')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal terminates a valid final record but rejects corruption before EOF", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-tail-rules-"));
  try {
    const validRunId = "wf_valid_tail";
    const valid = RunJournal.create(dir, {
      type: "run", runId: validRunId, name: "valid", scriptHash: "1", startedAt: 0,
    });
    valid.close();
    fs.appendFileSync(valid.filePath, JSON.stringify({
      type: "result", ok: true, result: 1, agentCount: 0, durationMs: 0,
    }));
    const resumed = RunJournal.resume(dir, validRunId, {
      type: "run", runId: validRunId, name: "valid", scriptHash: "1", startedAt: 1,
    });
    resumed.close();
    assert.doesNotThrow(() => fs.readFileSync(valid.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line)));

    const invalidRunId = "wf_invalid_middle";
    const invalid = RunJournal.create(dir, {
      type: "run", runId: invalidRunId, name: "invalid", scriptHash: "1", startedAt: 0,
    });
    invalid.close();
    fs.appendFileSync(invalid.filePath, "not-json\n");
    assert.throws(
      () => RunJournal.resume(dir, invalidRunId, {
        type: "run", runId: invalidRunId, name: "invalid", scriptHash: "1", startedAt: 1,
      }),
      /invalid JSON on line 2/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal follows the single-owner session model without lock artifacts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-single-owner-"));
  const runId = "wf_single_owner";
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "single-owner", scriptHash: "1", startedAt: 0,
    });
    assert.equal(fs.existsSync(`${journal.filePath}.lock`), false);
    journal.close();

    const resumed = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "single-owner", scriptHash: "1", startedAt: 1,
    });
    assert.equal(fs.existsSync(`${resumed.filePath}.lock`), false);
    resumed.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RunJournal fails closed on unsupported journal versions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-j-old-"));
  try {
    const runId = "wf_old";
    fs.writeFileSync(path.join(dir, `${runId}.jsonl`), `${JSON.stringify({
      type: "run", journalVersion: 2, runId, name: "old", scriptHash: "1", startedAt: 0, maxAgents: 128,
    })}\n`);
    assert.throws(
      () => RunJournal.resume(dir, runId, { type: "run", runId, name: "old", scriptHash: "1", startedAt: 1 }),
      /unsupported workflow journal version/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mode.toggle requests max and restores the prior thinking level", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.thinking = "low";
  s.active = ["read"];
  assert.equal(m.toggle(api), true);
  assert.equal(m.isEnabled(), true);
  assert.equal(s.thinking, "max");
  assert.ok(s.active.includes("workflow"), "toggle on activates the workflow tool");
  s.active.push("grep");
  assert.equal(m.toggle(api), false);
  assert.equal(m.isEnabled(), false);
  assert.equal(s.thinking, "low", "toggle off restores the prior level");
  assert.deepEqual(s.active, ["read", "grep"], "toggle off removes only the workflow tool");
});

test("restore migrates an enabled entry that lacks a previous effort", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.thinking = "low";
  m.restore(api, [{
    type: "custom",
    customType: "ultracode-mode",
    data: { enabled: true },
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

test("UltracodeMode.getSubagentThinkingLevel: max when enabled, undefined when off", () => {
  const m = new UltracodeMode("workflow");
  const { api } = miniPi();
  assert.equal(m.getSubagentThinkingLevel(), undefined, "off before enable");
  m.enable(api);
  assert.equal(m.getSubagentThinkingLevel(), "max", "raw max request is forwarded when on");
  m.disable(api);
  assert.equal(m.getSubagentThinkingLevel(), undefined, "undefined again after disable");
});

test("suspend quiesces all effort, tool, and prompt enforcement", () => {
  const m = new UltracodeMode("workflow");
  const { api, s } = miniPi();
  s.active = ["read"];
  m.enable(api);
  m.suspend(api);
  assert.equal(s.thinking, "medium");
  assert.deepEqual(s.active, ["read"]);
  s.active.push("workflow");
  m.suspend(api);
  assert.deepEqual(s.active, ["read"], "repeated suspend removes externally restored workflow");
  assert.equal(m.getSubagentThinkingLevel(), undefined);
  s.thinking = "high";
  assert.equal(m.reapplyMaximumThinking(api), false);
  assert.equal(m.handleModelSelect(api), false);
  assert.equal(s.thinking, "high");
  assert.equal(m.beforeAgentStart({ systemPrompt: "BASE" }), undefined);
});

test("workflow leases cap top-level active runs per runsDir, isolate directories, and release idempotently", () => {
  clearWorkflowLeasesForTests();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lease-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lease-b-"));
  try {
    const leases = [1, 2, 3, 4].map((n) => acquireWorkflowLease(dirA, `wf_${n}`));
    assert.equal(activeWorkflowCount(dirA), 4);
    assert.throws(() => acquireWorkflowLease(dirA, "wf_5"), /too many active workflows/);
    assert.throws(() => acquireWorkflowLease(dirA, "wf_1"), /already active/);

    const other = acquireWorkflowLease(dirB, "wf_5");
    assert.equal(activeWorkflowCount(dirB), 1, "different runsDir scopes are independent");
    other.release();
    other.release();

    leases[0].release();
    assert.equal(activeWorkflowCount(dirA), 3);
    const replacement = acquireWorkflowLease(dirA, "wf_5");
    assert.equal(activeWorkflowCount(dirA), 4);
    replacement.release();
    leases.slice(1).forEach((lease) => lease.release());
    assert.equal(activeWorkflowCount(dirA), 0);
  } finally {
    clearWorkflowLeasesForTests();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test("workflow worker source file is present", () => {
  assert.equal(fs.existsSync(path.join(process.cwd(), "src", "workflow", "script-worker.mjs")), true);
});
