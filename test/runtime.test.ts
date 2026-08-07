import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { ABSOLUTE_MAX_AGENTS, DEFAULT_MAX_AGENTS, runWorkflow } from "../src/workflow/runtime.ts";
import { executeWorkflowScript } from "../src/workflow/script-executor.ts";
import { parseWorkflowScript } from "../src/workflow/parser.ts";
import { WorkflowStallError } from "../src/workflow/admission.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { WorkflowAgentRunner } from "../src/workflow/agent-runner.ts";

// Regression: the default runner is built from a STATIC import. A dynamic
// import() of agent-runner.ts broke under Pi's jiti loader
// ("WorkflowAgentRunner is not a constructor"). Guard the export shape.
test("WorkflowAgentRunner is a real constructor with a run() method", () => {
  assert.equal(typeof WorkflowAgentRunner, "function");
  const runner = new WorkflowAgentRunner({ cwd: process.cwd() });
  assert.equal(typeof runner.run, "function");
});

interface MockCall {
  prompt: string;
  label: string;
  schema?: unknown;
}

/** A deterministic runner that echoes the prompt and reports fixed token usage. */
function mockRunner(tokensPerCall = 10, calls: MockCall[] = []) {
  return {
    calls,
    run: async (call: any) => {
      calls.push({ prompt: call.prompt, label: call.label, schema: call.schema });
      return {
        value: call.schema ? { echoed: call.prompt } : `echo:${call.prompt}`,
        usage: { outputTokens: tokensPerCall, totalTokens: tokensPerCall, cost: 0 },
        cwd: call.cwd ?? "/tmp",
      };
    },
  };
}

test("runs a single agent and returns its value", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'one', description: 'x' }\nreturn await agent('hello', { label: 'greet' })`,
    { runner },
  );
  assert.equal(result.result, "echo:hello");
  assert.equal(result.agentCount, 1);
  assert.equal(result.spentTokens, 10);
  assert.equal(runner.calls[0].label, "greet");
});

test("ordinary agent preflight failures do not leave pending panel traces", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'panel_preflight', description: 'x' }
     return await parallel([async () => {
       try { await agent('bad', { label: 1 }) } catch (error) { return 'caught' }
     }])`,
    { runner: mockRunner() },
  );
  assert.deepEqual(result.result, ["caught"]);
  assert.equal(result.agentCount, 0);
});

test("native concurrent orchestration in one scope is rejected in favor of parallel", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'native_concurrency', description: 'x' }
       return await Promise.all([
         (async () => { await agent('A1'); return await agent('A2') })(),
         (async () => { await agent('B1'); return await agent('B2') })(),
       ])`,
      { runner, maxAgents: 4 },
    ),
    /native concurrent orchestration|use parallel/i,
  );
  assert.ok(runner.calls.length <= 1);
});

test("pure synchronous helpers do not inspect returned then properties", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'pure_helper_semantics', description: 'x' }
     function helper() {
       return { get then() { throw new Error('then getter touched') }, value: 1 }
     }
     return helper().value`,
    { runner: mockRunner() },
  );
  assert.equal(result.result, 1);
});

test("helper caller scopes retain the parent's native concurrency guard", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'helper_native_concurrency', description: 'x' }
       async function run(prompt) { return await agent(prompt) }
       const first = run('A')
       const second = run('B')
       return [await first, await second]`,
      { runner, maxAgents: 2 },
    ),
    /native concurrent orchestration|use parallel/i,
  );
  assert.ok(runner.calls.length <= 1);
});

test("parallel returns results in input order and nulls failures", async () => {
  const runner = {
    run: async (call: any) => {
      if (call.prompt === "boom") throw new Error("kaboom");
      return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
    },
  };
  const result = await runWorkflow(
    `export const meta = { name: 'par', description: 'x' }
     const out = await parallel(['a','boom','c'].map(p => () => agent(p, { label: p })))
     return out`,
    { runner },
  );
  assert.deepEqual(result.result, ["a", null, "c"]);
});

test("pipeline threads stages with (prev, original, index)", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'pipe', description: 'x' }
     const out = await pipeline(
       ['x','y'],
       (item) => agent('stage1:' + item, { label: 's1' }),
       (prev, original, index) => ({ prev, original, index })
     )
     return out`,
    { runner },
  );
  assert.deepEqual(result.result, [
    { prev: "echo:stage1:x", original: "x", index: 0 },
    { prev: "echo:stage1:y", original: "y", index: 1 },
  ]);
});

test("phase() and log() are captured", async () => {
  const phases: string[] = [];
  const logs: string[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'ph', description: 'x' }
     phase('Scan')
     log('starting')
     await agent('a', { label: 'a' })
     phase('Verify')
     await agent('b', { label: 'b' })
     return null`,
    { runner: mockRunner(), onPhase: (p) => phases.push(p), onLog: (l) => logs.push(l) },
  );
  assert.deepEqual(result.phases, ["Scan", "Verify"]);
  assert.deepEqual(phases, ["Scan", "Verify"]);
  assert.ok(logs.includes("starting"));
});

test("oversized dynamic schemas fail before admission or runner side effects", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'schema_limit', description: 'x' }
       return await agent('x', { schema: { type: 'string', description: 'x'.repeat(300000) } })`,
      { runner },
    ),
    /workflow schema exceeds 262144 bytes/,
  );
  assert.equal(runner.calls.length, 0);
});

test("schema option passes through to the runner", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'sc', description: 'x' }
     return await agent('find', { label: 'f', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } })`,
    { runner },
  );
  assert.deepEqual(result.result, { echoed: "find" });
  assert.ok(runner.calls[0].schema);
});

test("resume replays cached agent results for unchanged stable call paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-"));
  const runId = "wf_test1";
  const script = `export const meta = { name: 'res', description: 'x' }
     const a = await agent('alpha', { label: 'a' })
     const b = await agent('beta', { label: 'b' })
     return [a, b]`;

  const j1 = RunJournal.create(dir, {
    type: "run",
    runId,
    name: "res",
    scriptHash: "1",
    startedAt: 0,
  });
  const first = await runWorkflow(script, { runner: mockRunner(7), journal: j1 });
  j1.close();
  assert.deepEqual(first.result, ["echo:alpha", "echo:beta"]);
  assert.equal(first.cachedCount, 0);

  // Resume: same script -> 100% cache hit, runner never called.
  const runner2 = mockRunner(7);
  const j2 = RunJournal.resume(dir, runId, {
    type: "run",
    runId,
    name: "res",
    scriptHash: "1",
    startedAt: 1,
  });
  const second = await runWorkflow(script, { runner: runner2, journal: j2 });
  j2.close();
  assert.deepEqual(second.result, ["echo:alpha", "echo:beta"]);
  assert.equal(second.cachedCount, 2);
  assert.equal(runner2.calls.length, 0, "resumed run should not call the runner for cached call paths");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("cached observer payloads cannot mutate the canonical replay value", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-cache-observer-isolation-"));
  const runId = "wf_cache_observer_isolation";
  const script = `export const meta = { name: 'cache_observer_isolation', description: 'x' }
    return await agent('same')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "cache_observer_isolation", scriptHash: "same", startedAt: 0,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      runner: {
        run: async () => ({
          value: { ok: true },
          usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
          cwd: process.cwd(),
        }),
      },
    });
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "cache_observer_isolation", scriptHash: "same", startedAt: 1,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      runner: { run: async () => { throw new Error("cache should replay"); } },
      onAgentStart: (event) => {
        if (event.cachedRecord) (event.cachedRecord.value as any).ok = false;
      },
      onAgentEnd: (event) => {
        (event.result as any).ok = false;
        if (event.cachedRecord) (event.cachedRecord.value as any).ok = false;
      },
    });
    assert.deepEqual(resumed.result, { ok: true });
    resumedJournal.close();
    const agentRecord = fs.readFileSync(path.join(dir, `${runId}.jsonl`), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line))
      .find((record) => record.type === "agent");
    assert.deepEqual(agentRecord.value, { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated executions of one source call site use stable occurrences", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-callsite-occurrence-"));
  const runId = "wf_callsite_occurrence";
  const script = `export const meta = { name: 'callsite_occurrence', description: 'x' }
    const values = []
    for (const item of ['A', 'B', 'C']) values.push(await agent(item))
    return values`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "callsite_occurrence", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    const first = await runWorkflow(script, { journal: firstJournal, maxAgents: 3, runner: mockRunner() });
    assert.deepEqual(first.result, ["echo:A", "echo:B", "echo:C"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "callsite_occurrence", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, first.result);
    assert.deepEqual(liveCalls, []);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper invocation sites preserve identical agent calls across conditional resume paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-helper-callsite-shift-"));
  const runId = "wf_helper_callsite_shift";
  const script = `export const meta = { name: 'helper_callsite_shift', description: 'x' }
    async function same() { return await agent('same') }
    const gate = await agent('gate')
    const values = []
    if (gate === null) values.push(await same())
    values.push(await same())
    return values`;
  try {
    let sameIndex = 0;
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "helper_callsite_shift", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "gate") throw new Error("gate failed once");
          return { value: `same-${sameIndex++}`, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["same-0", "same-1"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "helper_callsite_shift", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: "new", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["same-1"]);
    assert.deepEqual(liveCalls, ["gate"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("object helper invocation sites preserve this and cache identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-object-helper-callsite-"));
  const runId = "wf_object_helper_callsite";
  const script = `export const meta = { name: 'object_helper_callsite', description: 'x' }
    const helpers = {
      prompt: 'same',
      async same() { return await agent(this.prompt) },
    }
    const gate = await agent('gate')
    const values = []
    if (gate === null) values.push(await helpers.same())
    values.push(await helpers.same())
    return values`;
  try {
    let sameIndex = 0;
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "object_helper_callsite", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "gate") throw new Error("gate failed once");
          return { value: `same-${sameIndex++}`, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["same-0", "same-1"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "object_helper_callsite", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: "new", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["same-1"]);
    assert.deepEqual(liveCalls, ["gate"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("helper invocation sites keep panel definitions distinct", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-helper-panel-shift-"));
  const runId = "wf_helper_panel_shift";
  const script = `export const meta = { name: 'helper_panel_shift', description: 'x' }
    async function runPanel(reserveAgents, prompt) {
      return await parallel([() => agent(prompt)], { reserveAgents })
    }
    const gate = await agent('gate')
    if (gate === null) await runPanel(1, 'conditional')
    return await runPanel(2, 'always')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "helper_panel_shift", scriptHash: "same", startedAt: 0, maxAgents: 5,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "gate") throw new Error("gate failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["always"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "helper_panel_shift", scriptHash: "same", startedAt: 1, maxAgents: 5,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["always"]);
    assert.deepEqual(liveCalls, ["gate"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loop branch shifts retain request-specific source occurrences", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-loop-callsite-shift-"));
  const runId = "wf_loop_callsite_shift";
  const script = `export const meta = { name: 'loop_callsite_shift', description: 'x' }
    async function fallback() { return await agent('same-fallback') }
    const values = []
    for (let index = 0; index < 2; index++) {
      const primary = await agent('primary-' + index)
      values.push(primary === null ? await fallback() : primary)
    }
    return values`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "loop_callsite_shift", scriptHash: "same", startedAt: 0, maxAgents: 6,
    });
    let fallbackIndex = 0;
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 6,
      runner: {
        run: async (call: any) => {
          if (call.prompt.startsWith("primary")) throw new Error("primary failed");
          return { value: `fallback-${fallbackIndex++}`, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["fallback-0", "fallback-1"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "loop_callsite_shift", scriptHash: "same", startedAt: 1, maxAgents: 6,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 6,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          if (call.prompt === "primary-1") throw new Error("primary-1 still fails");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["primary-0", "fallback-1"]);
    assert.deepEqual(liveCalls, ["primary-0", "primary-1"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume identity includes the effective default model and thinking", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-model-identity-"));
  const runId = "wf_model_identity";
  const script = `export const meta = { name: 'model_identity', description: 'x' }
    return await agent('same')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "model_identity", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      model: { provider: "test", id: "model-a" },
      thinkingLevel: "low",
      runner: mockRunner(),
    });
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "model_identity", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    const liveCalls: string[] = [];
    await assert.rejects(
      runWorkflow(script, {
        journal: resumedJournal,
        maxAgents: 2,
        model: { provider: "test", id: "model-b" },
        thinkingLevel: "max",
        runner: {
          run: async (call: any) => {
            liveCalls.push(call.prompt);
            return { value: "new", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      }),
      /immutable agent input changed|resume diverged/i,
    );
    assert.deepEqual(liveCalls, []);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume identity includes the resolved Agent Type definition", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-agent-type-identity-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-agent-type-journal-"));
  const runId = "wf_agent_type_identity";
  const script = `export const meta = { name: 'agent_type_identity', description: 'x' }
    return await agent('role task', { agentType: 'custom' })`;
  const roleDir = path.join(cwd, ".pi", "ultracode", "agents");
  const rolePath = path.join(roleDir, "custom.md");
  try {
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(rolePath, "---\nname: custom\ndescription: custom role\n---\nFIRST\n");
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "agent_type_identity", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, {
      cwd,
      journal: firstJournal,
      maxAgents: 2,
      runner: {
        run: async (call: any) => ({
          value: call.agentTypeDef.systemPrompt,
          usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
          cwd,
        }),
      },
    });
    assert.equal(first.result, "FIRST");
    firstJournal.close();

    fs.writeFileSync(rolePath, "---\nname: custom\ndescription: custom role\n---\nSECOND\n");
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "agent_type_identity", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    const liveCalls: string[] = [];
    await assert.rejects(
      runWorkflow(script, {
        cwd,
        journal: resumedJournal,
        maxAgents: 2,
        runner: {
          run: async (call: any) => {
            liveCalls.push(call.prompt);
            return { value: "SECOND", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd };
          },
        },
      }),
      /immutable agent input changed|resume diverged/i,
    );
    assert.deepEqual(liveCalls, []);
    resumedJournal.close();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nested workflow args use the same strict 1 MiB input guard", async () => {
  const child = parseWorkflowScript(
    `export const meta = { name: 'child_args', description: 'x' }\nreturn 1`,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parent_args', description: 'x' }
       return await workflow('child', 'x'.repeat(1024 * 1024))`,
      { runner: mockRunner(), loadSavedWorkflow: () => child },
    ),
    /workflow args exceeds 1048576 bytes/,
  );
});

test("nested workflow output is strict JSON and bounded before the parent consumes it", async () => {
  const oversizedChild = parseWorkflowScript(
    `export const meta = { name: 'oversized_child', description: 'x' }\nreturn 'x'.repeat(3 * 1024 * 1024)`,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parent_child_limit', description: 'x' }
       const child = await workflow('child')
       return child.length`,
      { runner: mockRunner(), loadSavedWorkflow: () => oversizedChild },
    ),
    /nested workflow output exceeds 2097152 bytes/i,
  );

  const nonJsonChild = parseWorkflowScript(
    `export const meta = { name: 'non_json_child', description: 'x' }\nreturn new Map([['x', 1]])`,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parent_child_json', description: 'x' }
       const child = await workflow('child')
       return child.size`,
      { runner: mockRunner(), loadSavedWorkflow: () => nonJsonChild },
    ),
    /nested workflow output.*plain JSON/i,
  );
});

test("nested workflow validation and execution use the same immutable args snapshot", async () => {
  const child = parseWorkflowScript(
    `export const meta = { name: 'child_snapshot', description: 'x' }\nreturn args.value.length`,
  );
  const result = await runWorkflow(
    `export const meta = { name: 'parent_snapshot', description: 'x' }
     let reads = 0
     const input = {}
     Object.defineProperty(input, 'value', {
       enumerable: true,
       get() {
         reads++
         return reads === 1 ? 'ok' : 'x'.repeat(2 * 1024 * 1024)
       },
     })
     return await workflow('child', input)`,
    { runner: mockRunner(), loadSavedWorkflow: () => child },
  );
  assert.equal(result.result, 2);
});

test("workflow() runs a nested workflow inline sharing state", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'parent', description: 'x' }
     const child = await workflow('child', { from: 'parent' })
     const own = await agent('parent-task', { label: 'p' })
     return { child, own }`,
    {
      runner,
      loadSavedWorkflow: () => parseWorkflowScript(
        `export const meta = { name: 'child', description: 'y' }\nreturn await agent('child-task', { label: 'c' })`,
      ),
    },
  );
  assert.deepEqual(result.result, { child: "echo:child-task", own: "echo:parent-task" });
  assert.equal(result.agentCount, 2, "nested + parent agents share the counter");
});

test("concurrent sibling workflows keep independent breadcrumb paths", async () => {
  const paths = new Map<string, string[]>();
  const phases = new Map<string, string | undefined>();
  const result = await runWorkflow(
    `export const meta = { name: 'parent', description: 'x' }
     return await parallel([() => workflow('alpha'), () => workflow('beta')])`,
    {
      runner: {
        run: async (call: any) => {
          await new Promise((resolve) => setTimeout(resolve, call.label === "alpha" ? 5 : 1));
          return { value: call.label, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: "/tmp" };
        },
      },
      loadSavedWorkflow: (name) => parseWorkflowScript(
        `export const meta = { name: '${String(name)}', description: 'child' }\nphase('${String(name)} phase'); return await agent('${String(name)}', { label: '${String(name)}' })`,
      ),
      onAgentStart: (event) => {
        paths.set(event.label, event.workflowPath ?? []);
        phases.set(event.label, event.phase);
      },
    },
  );
  assert.deepEqual(result.result, ["alpha", "beta"]);
  assert.deepEqual(paths.get("alpha"), ["parent", "alpha"]);
  assert.deepEqual(paths.get("beta"), ["parent", "beta"]);
  assert.equal(phases.get("alpha"), "alpha phase");
  assert.equal(phases.get("beta"), "beta phase");
});

test("nested workflow identity follows request args across mutually exclusive resume paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nested-request-path-"));
  const runId = "wf_nested_request_path";
  const script = `export const meta = { name: 'nested_request_path', description: 'x' }
    const gate = await agent('gate')
    return await workflow('child', { item: gate === null ? 'fallback' : 'primary' })`;
  const loadSavedWorkflow = () => parseWorkflowScript(
    `export const meta = { name: 'child', description: 'x' }\nreturn args.item`,
  );
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "nested_request_path", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      loadSavedWorkflow,
      runner: { run: async () => { throw new Error("gate failed once"); } },
    });
    assert.equal(first.result, "fallback");
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "nested_request_path", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 2,
      loadSavedWorkflow,
      runner: mockRunner(),
    });
    assert.equal(resumed.result, "primary");
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nested workflow() inside a child throws", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parent', description: 'x' }
       return await workflow('child')`,
      {
        runner: mockRunner(),
        loadSavedWorkflow: () => parseWorkflowScript(
          `export const meta = { name: 'child', description: 'y' }\nreturn await workflow('grandchild')`,
        ),
      },
    ),
    /one level deep/,
  );
});

test("runWorkflow rejects non-JSON agent and workflow outputs before journaling", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_agent_output', description: 'x' }
       return await agent('bad')`,
      {
        runner: {
          run: async () => ({
            value: new Map([["x", 1]]),
            usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
            cwd: process.cwd(),
          }),
        },
      },
    ),
    /agent output.*plain JSON/i,
  );
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_workflow_output', description: 'x' }
       return new Map([['x', 1]])`,
      { runner: mockRunner() },
    ),
    /workflow output.*plain JSON/i,
  );
});

test("workflow args preserve an own __proto__ data property in the context realm", async () => {
  const args = JSON.parse('{"__proto__":{"marker":7},"ok":1}');
  const result = await runWorkflow(
    `export const meta = { name: 'proto_args', description: 'x' }
     return {
       own: Object.hasOwn(args, '__proto__'),
       keys: Object.keys(args),
       marker: args.__proto__.marker,
       ok: args.ok,
     }`,
    { args, runner: mockRunner() },
  );
  assert.deepEqual(result.result, {
    own: true,
    keys: ["__proto__", "ok"],
    marker: 7,
    ok: 1,
  });
});

test("runWorkflow rejects non-JSON args before creating a Worker", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'strict_args', description: 'x' }\nreturn 1`,
      { args: new Map([["payload", new ArrayBuffer(2 * 1024 * 1024)]]) },
    ),
    /workflow args.*plain JSON/i,
  );
});

test("allows a workflow that never calls agent", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'noop', description: 'x' }\nphase('Plan')\nreturn { planned: true }`,
    { runner: mockRunner() },
  );
  assert.equal(result.agentCount, 0);
  assert.deepEqual(result.result, { planned: true });
});

test("workflow context blocks indirect Function constructors from injected globals", async () => {
  for (const expression of [
    `process.cwd.constructor('return Date.now()')()`,
    `agent.constructor('return Date.now()')()`,
    `Math.max.constructor('return Date.now()')()`,
    `new Intl.DateTimeFormat().format()`,
  ]) {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'constructor_escape', description: 'x' }\nreturn ${expression}`,
        { runner: mockRunner() },
      ),
      /code generation|Function constructor|not a function|Cannot read properties of undefined|static method|dynamic method/i,
      expression,
    );
  }
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'result_escape', description: 'x' }
       const value = await agent('object')
       return value.constructor.constructor('return Date.now()')()`,
      {
        runner: {
          run: async () => ({
            value: { ok: true },
            usage: { outputTokens: 1, totalTokens: 1, cost: 0 },
            cwd: process.cwd(),
          }),
        },
      },
    ),
    /code generation|Function constructor|not a function/i,
  );
  const normal = await runWorkflow(
    `export const meta = { name: 'cwd_shim', description: 'x' }
     return {
       basics: process.cwd() === cwd && Math.max(1, 2) === 2 && Math.floor(1.9) === 1,
       arrayBuffer: typeof ArrayBuffer,
       webAssembly: typeof WebAssembly,
       fetch: typeof fetch,
       buffer: typeof Buffer,
     }`,
    { runner: mockRunner() },
  );
  assert.deepEqual(normal.result, {
    basics: true,
    arrayBuffer: "undefined",
    webAssembly: "undefined",
    fetch: "undefined",
    buffer: "undefined",
  });
});

test("workflow sandbox does not expose the removed budget global", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'no_budget_global', description: 'x' }\nreturn typeof budget`,
    { runner: mockRunner() },
  );
  assert.equal(result.agentCount, 0);
  assert.equal(result.result, "undefined");
});

test("concurrency must be a finite integer between 1 and 16", async () => {
  for (const concurrency of [0, 1.5, 17, Number.NaN]) {
    const runner = mockRunner();
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'bad_concurrency', description: 'x' }\nreturn await agent('a')`,
        { runner, concurrency },
      ),
      /concurrency.*between 1 and 16/,
    );
    assert.equal(runner.calls.length, 0);
  }
});

test("maxAgents defaults, bounds, and rejects invalid values before runner side effects", async () => {
  const ok = await runWorkflow(
    `export const meta = { name: 'max_default', description: 'x' }\nreturn await agent('a')`,
    { runner: mockRunner() },
  );
  assert.equal(ok.maxAgents, DEFAULT_MAX_AGENTS);

  const edge = await runWorkflow(
    `export const meta = { name: 'max_edge', description: 'x' }\nreturn await agent('a')`,
    { runner: mockRunner(), maxAgents: ABSOLUTE_MAX_AGENTS },
  );
  assert.equal(edge.maxAgents, ABSOLUTE_MAX_AGENTS);

  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bad_max', description: 'x' }\nreturn await agent('a')`,
      { runner, maxAgents: 0 },
    ),
    /maxAgents.*between 1 and 1024/,
  );
  assert.equal(runner.calls.length, 0);
});

test("maxAgents stops the N+1 agent before any runner side effect", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'max_stop', description: 'x' }
       await agent('one', { label: 'one' })
       await agent('two', { label: 'two' })`,
      { runner, maxAgents: 1 },
    ),
    /maxAgents=1|no agent slots remain/,
  );
  assert.deepEqual(runner.calls.map((c) => c.label), ["one"]);
});

test("resume inherits or raises maxAgents, rejects decreases, and cache replay does not recharge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-max-"));
  try {
    const runId = "wf_max";
    const script = `export const meta = { name: 'max_resume', description: 'x' }
       const a = await agent('a', { label: 'a' })
       const b = await agent('b', { label: 'b' })
       return [a, b]`;
    const j1 = RunJournal.create(dir, { type: "run", runId, name: "max_resume", scriptHash: "1", startedAt: 0, maxAgents: 2 });
    await runWorkflow(script, { runner: mockRunner(1), journal: j1, maxAgents: 2 });
    assert.equal(j1.agentsUsed, 2);
    j1.close();

    const inheritedJournal = RunJournal.resume(dir, runId, { type: "run", runId, name: "max_resume", scriptHash: "1", startedAt: 1 });
    const inherited = await runWorkflow(script, { runner: mockRunner(1), journal: inheritedJournal });
    assert.equal(inherited.maxAgents, 2);
    assert.equal(inherited.cachedCount, 2);
    assert.equal(inheritedJournal.agentsUsed, 2);
    inheritedJournal.close();

    const raisedJournal = RunJournal.resume(dir, runId, { type: "run", runId, name: "max_resume", scriptHash: "1", startedAt: 2, maxAgents: 5 });
    const raised = await runWorkflow(script, { runner: mockRunner(1), journal: raisedJournal });
    assert.equal(raised.maxAgents, 5);
    assert.equal(raisedJournal.agentsUsed, 2);
    raisedJournal.close();

    assert.throws(
      () => RunJournal.resume(dir, runId, { type: "run", runId, name: "max_resume", scriptHash: "1", startedAt: 3, maxAgents: 1 }),
      /cannot decrease/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("maxAgents is a run-lifetime cap across resume and cached calls do not recharge it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-lifetime-cap-"));
  const runId = "wf_lifetime_cap";
  const script = `export const meta = { name: 'lifetime_cap', description: 'x' }
    const a = await agent('A')
    const b = await agent('B')
    return [a, b]`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "lifetime_cap", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "B") throw new Error("first B failed");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["A", null]);
    firstJournal.close();

    const deniedCalls: string[] = [];
    const deniedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "lifetime_cap", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    await assert.rejects(
      runWorkflow(script, {
        journal: deniedJournal,
        maxAgents: deniedJournal.effectiveMaxAgents,
        runner: {
          run: async (call: any) => {
            deniedCalls.push(call.prompt);
            return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      }),
      /maxAgents=2|no agent slots remain/,
    );
    assert.deepEqual(deniedCalls, [], "an exhausted lifetime cap rejects before runner side effects");
    deniedJournal.close();

    const raisedCalls: string[] = [];
    const raisedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "lifetime_cap", scriptHash: "same", startedAt: 2, maxAgents: 3,
    });
    const raised = await runWorkflow(script, {
      journal: raisedJournal,
      maxAgents: raisedJournal.effectiveMaxAgents,
      runner: {
        run: async (call: any) => {
          raisedCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(raised.result, ["A", "B"]);
    assert.deepEqual(raisedCalls, ["B"]);
    assert.equal(raised.cachedCount, 1);
    assert.equal(raised.agentsUsed, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial panel resume reserves only uncached lifetime slots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-partial-panel-"));
  const runId = "wf_partial_panel";
  const script = `export const meta = { name: 'partial_panel', description: 'x' }
    return await parallel([() => agent('A'), () => agent('B')])`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "partial_panel", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "B") throw new Error("B failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["A", null]);
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "partial_panel", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["A", "B"]);
    assert.deepEqual(liveCalls, ["B"]);
    assert.equal(resumed.agentsUsed, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume rejects coordinated branch and panel records that omit a durable call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-corruption-"));
  const runId = "wf_panel_corruption";
  const script = `export const meta = { name: 'panel_corruption', description: 'x' }
    return await parallel([() => agent('A'), () => agent('B')])`;
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_corruption", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    await runWorkflow(script, {
      journal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "B") throw new Error("B failed");
          return { value: "A", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    journal.close();
    const records = fs.readFileSync(journal.filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const branch = records.find((record) =>
      record.type === "panel-branch" && record.calls.some((call: any) => call.status === "failed")
    );
    const complete = records.find((record) => record.type === "panel-complete");
    assert.ok(branch);
    assert.ok(complete);
    branch.calls = branch.calls.filter((call: any) => call.status !== "failed");
    complete.calls = complete.calls.filter((call: any) => call.status !== "failed");
    fs.writeFileSync(journal.filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    assert.throws(
      () => RunJournal.resume(dir, runId, {
        type: "run", runId, name: "panel_corruption", scriptHash: "same", startedAt: 1, maxAgents: 3,
      }),
      /invalid panel(?:-branch)? record/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupted panel replays completed branches without reserving their slots", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-interrupted-panel-"));
  const runId = "wf_interrupted_panel";
  const script = `export const meta = { name: 'interrupted_panel', description: 'x' }
    return await parallel([() => agent('A'), () => agent('B')])`;
  try {
    const controller = new AbortController();
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "interrupted_panel", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const firstRun = runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      signal: controller.signal,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "A") {
            return { value: "A", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          }
          return await new Promise((_resolve, reject) => {
            call.signal.addEventListener("abort", () => reject(new Error("B cancelled")), { once: true });
          });
        },
      },
    });

    let durableBranch = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const content = fs.readFileSync(firstJournal.filePath, "utf8");
      if (firstJournal.agentsUsed === 2 && content.includes('"type":"panel-branch"')) {
        durableBranch = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(durableBranch, true, "the completed branch is durable before abort");
    controller.abort();
    await assert.rejects(firstRun, /aborted/i);
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "interrupted_panel", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["A", "B"]);
    assert.deepEqual(liveCalls, ["B"]);
    assert.equal(resumed.cachedCount, 1);
    assert.equal(resumed.agentsUsed, 3);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a newer interrupted panel generation supersedes an older complete plan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-generation-"));
  const runId = "wf_panel_generation";
  const script = `export const meta = { name: 'panel_generation', description: 'x' }
    return await parallel([() => agent('A'), () => agent('B')])`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_generation", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      runner: { run: async () => { throw new Error("first generation failure"); } },
    });
    assert.deepEqual(first.result, [null, null]);
    firstJournal.close();

    const controller = new AbortController();
    const secondJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_generation", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const secondRun = runWorkflow(script, {
      journal: secondJournal,
      maxAgents: 4,
      signal: controller.signal,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "A") {
            return { value: "A", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          }
          return await new Promise((_resolve, reject) => {
            call.signal.addEventListener("abort", () => reject(new Error("B cancelled")), { once: true });
          });
        },
      },
    });
    let durablePartial = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const records = fs.readFileSync(secondJournal.filePath, "utf8");
      const latestOpen = records.lastIndexOf('"type":"panel-open"');
      const latestBranch = records.lastIndexOf('"type":"panel-branch"');
      if (secondJournal.agentsUsed === 4 && latestBranch > latestOpen) {
        durablePartial = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(durablePartial, true);
    controller.abort();
    await assert.rejects(secondRun, /aborted/i);
    secondJournal.close();

    const liveCalls: string[] = [];
    const thirdJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_generation", scriptHash: "same", startedAt: 2, maxAgents: 5,
    });
    const third = await runWorkflow(script, {
      journal: thirdJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(third.result, ["A", "B"]);
    assert.deepEqual(liveCalls, ["B"]);
    assert.equal(third.agentsUsed, 5);
    thirdJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an interrupted branch does not credit an old mutually exclusive fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-interrupted-fallback-"));
  const runId = "wf_interrupted_fallback";
  const script = `export const meta = { name: 'interrupted_fallback', description: 'x' }
    return await parallel([async () => {
      const primary = await agent('primary')
      if (primary === null) return await agent('fallback')
      return await agent('after-success')
    }], { reserveAgents: 2 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "interrupted_fallback", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "primary") throw new Error("primary failed once");
          return { value: "fallback", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const controller = new AbortController();
    const secondJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "interrupted_fallback", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const secondRun = runWorkflow(script, {
      journal: secondJournal,
      maxAgents: 4,
      signal: controller.signal,
      runner: {
        run: async (call: any) => await new Promise((_resolve, reject) => {
          call.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
      },
    });
    for (let attempt = 0; attempt < 200 && secondJournal.agentsUsed < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(secondJournal.agentsUsed, 3);
    controller.abort();
    await assert.rejects(secondRun, /aborted/i);
    secondJournal.close();

    const liveCalls: string[] = [];
    const thirdJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "interrupted_fallback", scriptHash: "same", startedAt: 2, maxAgents: 5,
    });
    const third = await runWorkflow(script, {
      journal: thirdJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(third.result, ["after-success"]);
    assert.deepEqual(liveCalls, ["primary", "after-success"]);
    thirdJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nested panel siblings retain independent safe cache credit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nested-panel-credit-"));
  const runId = "wf_nested_panel_credit";
  const script = `export const meta = { name: 'nested_panel_credit', description: 'x' }
    return await parallel([() => parallel([
      () => agent('retry'),
      () => agent('cached'),
    ])], { reserveAgents: 2 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "nested_panel_credit", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "retry") throw new Error("retry failed once");
          return { value: "cached", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, [[null, "cached"]]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "nested_panel_credit", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, [["retry", "cached"]]);
    assert.deepEqual(liveCalls, ["retry"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sequential cache and nested sibling credit compose conservatively", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nested-panel-mixed-credit-"));
  const runId = "wf_nested_panel_mixed_credit";
  const script = `export const meta = { name: 'nested_panel_mixed_credit', description: 'x' }
    return await parallel([async () => {
      const pre = await agent('pre')
      const inner = await parallel([() => agent('retry'), () => agent('cached')])
      return [pre, inner]
    }], { reserveAgents: 3 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "nested_panel_mixed_credit", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "retry") throw new Error("retry failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "nested_panel_mixed_credit", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, [["pre", ["retry", "cached"]]]);
    assert.deepEqual(liveCalls, ["retry"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("partial replay credits cached calls before a failure in the same branch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-partial-same-branch-"));
  const runId = "wf_partial_same_branch";
  const script = `export const meta = { name: 'partial_same_branch', description: 'x' }
    return await parallel([async () => {
      const a = await agent('A')
      const b = await agent('B')
      return [a, b]
    }], { reserveAgents: 2 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "partial_same_branch", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "B") throw new Error("B failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "partial_same_branch", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, [["A", "B"]]);
    assert.deepEqual(liveCalls, ["B"]);
    assert.equal(resumed.agentsUsed, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fully cached panels do not reacquire unused over-reservation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-overreserve-"));
  const runId = "wf_panel_overreserve";
  const script = `export const meta = { name: 'panel_overreserve', description: 'x' }
    const panel = await parallel([() => agent('inside')], { reserveAgents: 2 })
    const after = await agent('after')
    return { panel, after }`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_overreserve", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    const first = await runWorkflow(script, { journal: firstJournal, maxAgents: 2, runner: mockRunner() });
    assert.deepEqual(first.result, { panel: ["echo:inside"], after: "echo:after" });
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_overreserve", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 2,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, first.result);
    assert.deepEqual(liveCalls, []);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a successful retry may legitimately skip an old fallback call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-fallback-"));
  const runId = "wf_panel_fallback";
  const script = `export const meta = { name: 'panel_fallback', description: 'x' }
    return await parallel([async () => {
      const primary = await agent('primary')
      if (primary === null) return await agent('fallback')
      return primary
    }], { reserveAgents: 2 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_fallback", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "primary") throw new Error("primary failed once");
          return { value: "fallback", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["fallback"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_fallback", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: "primary", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["primary"]);
    assert.deepEqual(liveCalls, ["primary"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("source call sites keep mutually exclusive root agents distinct across resume", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-root-callsite-"));
  const runId = "wf_root_callsite";
  const script = `export const meta = { name: 'root_callsite', description: 'x' }
    const primary = await agent('primary')
    if (primary === null) return await agent('fallback')
    return await agent('after-success')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "root_callsite", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "primary") throw new Error("primary failed once");
          return { value: "fallback", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.equal(first.result, "fallback");
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "root_callsite", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.equal(resumed.result, "after-success");
    assert.deepEqual(liveCalls, ["primary", "after-success"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dynamic panel definitions receive distinct durable identities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-definition-path-"));
  const runId = "wf_panel_definition_path";
  const script = `export const meta = { name: 'panel_definition_path', description: 'x' }
    const gate = await agent('gate')
    const items = gate === null ? ['fallback'] : ['primary-a', 'primary-b']
    return await parallel(items.map((item) => () => agent(item)), { reserveAgents: items.length })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_definition_path", scriptHash: "same", startedAt: 0, maxAgents: 5,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "gate") throw new Error("gate failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["fallback"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_definition_path", scriptHash: "same", startedAt: 1, maxAgents: 5,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 5,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["primary-a", "primary-b"]);
    assert.deepEqual(liveCalls, ["gate", "primary-a", "primary-b"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replay credit can refill only a declared panel slot on an unexpected cache miss", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-refill-"));
  const runId = "wf_panel_refill";
  const script = `export const meta = { name: 'panel_refill', description: 'x' }
    const gate = await agent('gate')
    const item = gate === null ? 'fallback' : 'primary'
    return await parallel([() => agent(item)])`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_refill", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "gate") throw new Error("gate failed once");
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["fallback"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_refill", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["primary"]);
    assert.deepEqual(liveCalls, ["gate", "primary"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("failed panel paths reserve capacity for a mutually exclusive success path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-callsite-"));
  const runId = "wf_panel_callsite";
  const script = `export const meta = { name: 'panel_callsite', description: 'x' }
    return await parallel([async () => {
      const primary = await agent('primary')
      if (primary === null) return await agent('fallback')
      return await pipeline([1], async () => await agent('after-success'))
    }], { reserveAgents: 2 })`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "panel_callsite", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          if (call.prompt === "primary") throw new Error("primary failed once");
          return { value: "fallback", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(first.result, ["fallback"]);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "panel_callsite", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const liveCalls: string[] = [];
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, [["after-success"]]);
    assert.deepEqual(liveCalls, ["primary", "after-success"]);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a previously failed zero-agent branch retains a replay slot", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-zero-agent-branch-"));
  const runId = "wf_zero_agent_branch";
  const script = `export const meta = { name: 'zero_agent_branch', description: 'x' }
    return await parallel([() => workflow('child')])`;
  const child = parseWorkflowScript(
    `export const meta = { name: 'child', description: 'x' }\nreturn await agent('child-agent')`,
  );
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "zero_agent_branch", scriptHash: "same", startedAt: 0, maxAgents: 1,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 1,
      loadSavedWorkflow: () => { throw new Error("child temporarily unavailable"); },
      runner: mockRunner(),
    });
    assert.deepEqual(first.result, [null]);
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "zero_agent_branch", scriptHash: "same", startedAt: 1, maxAgents: 1,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 1,
      loadSavedWorkflow: () => child,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumed.result, ["child-agent"]);
    assert.deepEqual(liveCalls, ["child-agent"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("journal admission failure is fatal before runner side effects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-journal-admission-fail-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_admission_fail", name: "admission_fail", scriptHash: "same", startedAt: 0,
    });
    journal.close();
    const runner = mockRunner();
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'admission_fail', description: 'x' }\nreturn await agent('must-not-start')`,
        { journal, runner },
      ),
      /journal is already closed/,
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("panel replay lookup failures are sticky policy errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-replay-fail-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_panel_replay_fail", name: "panel_replay_fail", scriptHash: "same", startedAt: 0,
    });
    (journal as any).panelReplayPlan = () => { throw new Error("lookup exploded"); };
    const liveCalls: string[] = [];
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'panel_replay_fail', description: 'x' }
         try { await parallel([], { reserveAgents: 0 }) } catch (error) { log('caught ' + error.message) }
         return await agent('after')`,
        {
          journal,
          runner: {
            run: async (call: any) => {
              liveCalls.push(call.prompt);
              return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
            },
          },
        },
      ),
      /panel replay lookup failed.*lookup exploded/i,
    );
    assert.deepEqual(liveCalls, []);
    journal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("panel reservation journal failure is fatal before any thunk starts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-open-fail-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_panel_open_fail", name: "panel_open_fail", scriptHash: "same", startedAt: 0,
    });
    journal.close();
    let thunkStarted = false;
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'panel_open_fail', description: 'x' }\nreturn await parallel([() => { log('started'); return 1 }])`,
        { journal, runner: mockRunner(), onLog: () => { thunkStarted = true; } },
      ),
      /journal is already closed/,
    );
    assert.equal(thunkStarted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("panel completion journal failure is fatal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-journal-fail-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_panel_journal_fail", name: "panel_journal_fail", scriptHash: "same", startedAt: 0,
    });
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'panel_journal_fail', description: 'x' }
         return await parallel([() => { log('close-journal'); return 1 }])`,
        {
          journal,
          runner: mockRunner(),
          onLog: () => journal.close(),
        },
      ),
      /journal is already closed/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary panel-complete commit failures cannot be reported as success", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-panel-complete-ordinary-fail-"));
  try {
    const journal = RunJournal.create(dir, {
      type: "run", runId: "wf_panel_complete_ordinary_fail", name: "panel_complete_ordinary_fail", scriptHash: "same", startedAt: 0,
    });
    (journal as any).recordPanelComplete = () => { throw new Error("synthetic panel-complete write failure"); };
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'panel_complete_ordinary_fail', description: 'x' }
         return await parallel([() => 'ok'])`,
        { journal, runner: mockRunner() },
      ),
      /panel-complete write failure/,
    );
    journal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel permits an explicitly empty zero-slot panel", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'par_empty', description: 'x' }
     return await parallel([], { reserveAgents: 0 })`,
    { runner: mockRunner(), maxAgents: 1 },
  );
  assert.deepEqual(result.result, []);
  assert.equal(result.agentCount, 0);
});

test("parallel panel reservation is atomic when capacity is insufficient", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'par_atomic', description: 'x' }
       await parallel([() => agent('a', { label: 'a' }), () => agent('b', { label: 'b' })])`,
      { runner, maxAgents: 1 },
    ),
    /parallel\(\) needs 2 agent slot/,
  );
  assert.equal(runner.calls.length, 0, "no thunk may start when the panel cannot reserve all slots");
});

test("parallel reservations release unused slots for later ordinary agents", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'par_unused', description: 'x' }
     const panel = await parallel([() => 'no-agent', () => agent('inside', { label: 'inside' })])
     const after = await agent('after', { label: 'after' })
     return { panel, after }`,
    { runner, maxAgents: 2 },
  );
  assert.deepEqual(result.result, { panel: ["no-agent", "echo:inside"], after: "echo:after" });
  assert.deepEqual(runner.calls.map((c) => c.label), ["inside", "after"]);
});

test("nested parallel panels transfer reservation slots and supplement without double-counting", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'par_nested', description: 'x' }
     return await parallel([
       () => agent('outer', { label: 'outer' }),
       () => parallel([
         () => agent('inner-a', { label: 'inner-a' }),
         () => agent('inner-b', { label: 'inner-b' }),
       ]),
     ], { reserveAgents: 2 })`,
    { runner, maxAgents: 3 },
  );
  assert.deepEqual(result.result, ["echo:outer", ["echo:inner-a", "echo:inner-b"]]);
  assert.equal(result.agentCount, 3);
});

test("nested-first parallel panels keep each sibling's branch slot and supplement from root", async () => {
  const runner = mockRunner();
  const result = await runWorkflow(
    `export const meta = { name: 'par_nested_first', description: 'x' }
     return await parallel([
       () => parallel([
         () => agent('inner-a', { label: 'inner-a' }),
         () => agent('inner-b', { label: 'inner-b' }),
       ]),
       () => agent('outer', { label: 'outer' }),
     ], { reserveAgents: 2 })`,
    { runner, maxAgents: 3 },
  );
  assert.deepEqual(result.result, [["echo:inner-a", "echo:inner-b"], "echo:outer"]);
  assert.equal(result.agentCount, 3);
});

test("parallel over-reservation is fatal and policy errors are not swallowed by parallel or pipeline", async () => {
  const runner = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'par_over', description: 'x' }
       return await parallel([() => agent('a'), () => agent('b')], { reserveAgents: 1 })`,
      { runner, maxAgents: 4 },
    ),
    /reserveAgents must be at least the number of thunks/,
  );

  const multiAgentBranch = mockRunner();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'par_branch_over', description: 'x' }
       return await parallel([async () => {
         await agent('first')
         return await agent('second')
       }])`,
      { runner: multiAgentBranch, maxAgents: 4 },
    ),
    /reservation has no agent slots left/,
  );
  assert.equal(multiAgentBranch.calls.length, 1, "a panel branch cannot consume undeclared root capacity");

  const declaredMultiAgentBranch = mockRunner();
  const declared = await runWorkflow(
    `export const meta = { name: 'par_branch_declared', description: 'x' }
     return await parallel([async () => {
       const first = await agent('first')
       const second = await agent('second')
       return [first, second]
     }], { reserveAgents: 2 })`,
    { runner: declaredMultiAgentBranch, maxAgents: 2 },
  );
  assert.deepEqual(declared.result, [["echo:first", "echo:second"]]);

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'pipe_policy', description: 'x' }
       return await pipeline([1, 2], (n) => agent('p' + n))`,
      { runner: mockRunner(), maxAgents: 1 },
    ),
    /maxAgents=1|no agent slots remain/,
  );
});

test("parallel branch call identity is stable across opposite completion order on resume", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-parallel-call-path-"));
  const runId = "wf_parallel_call_path";
  const script = `export const meta = { name: 'parallel_call_path', description: 'x' }
    return await parallel([
      async () => { await agent('A1'); return await agent('A2') },
      async () => { await agent('B1'); return await agent('B2') },
    ], { reserveAgents: 4 })`;
  try {
    const firstCalls: string[] = [];
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "parallel_call_path", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          firstCalls.push(call.prompt);
          await new Promise((resolve) => setTimeout(resolve, call.prompt === "A1" ? 60 : 1));
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(firstCalls, ["A1", "B1", "B2", "A2"]);
    firstJournal.close();

    const resumedCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "parallel_call_path", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          resumedCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(resumedCalls, [], "completion order must not change cache identity");
    assert.equal(resumed.cachedCount, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel branch phase races do not change root cache identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-phase-call-path-"));
  const runId = "wf_phase_call_path";
  const script = `export const meta = { name: 'phase_call_path', description: 'x' }
    await parallel([
      async () => { await agent('slow'); phase('A') },
      async () => { await agent('fast'); phase('B') },
    ])
    return await agent('root')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "phase_call_path", scriptHash: "same", startedAt: 0, maxAgents: 3,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          await new Promise((resolve) => setTimeout(resolve, call.prompt === "slow" ? 40 : 1));
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "phase_call_path", scriptHash: "same", startedAt: 1, maxAgents: 3,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 3,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(liveCalls, []);
    assert.equal(resumed.cachedCount, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resume rejects changed nested workflow source before replay", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nested-source-"));
  const runId = "wf_nested_source";
  const script = `export const meta = { name: 'nested_source', description: 'x' }\nreturn await workflow('child')`;
  const childV1 = parseWorkflowScript(
    `export const meta = { name: 'child', description: 'x' }\nreturn { version: 1, value: await agent('same') }`,
  );
  const childV2 = parseWorkflowScript(
    `export const meta = { name: 'child', description: 'x' }\nreturn { version: 2, value: await agent('same') }`,
  );
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "nested_source", scriptHash: "same", startedAt: 0, maxAgents: 1,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 1,
      loadSavedWorkflow: () => childV1,
      runner: mockRunner(),
    });
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "nested_source", scriptHash: "same", startedAt: 1, maxAgents: 1,
    });
    await assert.rejects(
      runWorkflow(script, {
        journal: resumedJournal,
        maxAgents: 1,
        loadSavedWorkflow: () => childV2,
        runner: {
          run: async (call: any) => {
            liveCalls.push(call.prompt);
            return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      }),
      /nested workflow source.*changed|immutable nested/i,
    );
    assert.deepEqual(liveCalls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-name nested workflows in sibling branches have distinct stable identities", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nested-call-path-"));
  const runId = "wf_nested_call_path";
  const script = `export const meta = { name: 'nested_call_path', description: 'x' }
    return await parallel([
      () => workflow('child', { id: 'A' }),
      () => workflow('child', { id: 'B' }),
    ], { reserveAgents: 2 })`;
  const child = parseWorkflowScript(
    `export const meta = { name: 'child', description: 'x' }\nreturn await agent('child-' + args.id)`,
  );
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "nested_call_path", scriptHash: "same", startedAt: 0, maxAgents: 2,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 2,
      loadSavedWorkflow: () => child,
      runner: {
        run: async (call: any) => {
          await new Promise((resolve) => setTimeout(resolve, call.prompt === "child-A" ? 40 : 1));
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "nested_call_path", scriptHash: "same", startedAt: 1, maxAgents: 2,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 2,
      loadSavedWorkflow: () => child,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(liveCalls, []);
    assert.equal(resumed.cachedCount, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline item and stage call identity is stable across completion order", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-pipeline-call-path-"));
  const runId = "wf_pipeline_call_path";
  const script = `export const meta = { name: 'pipeline_call_path', description: 'x' }
    return await pipeline(
      ['A', 'B'],
      async (_previous, item) => await agent(item + '1'),
      async (_previous, item) => await agent(item + '2'),
    )`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "pipeline_call_path", scriptHash: "same", startedAt: 0, maxAgents: 4,
    });
    await runWorkflow(script, {
      journal: firstJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          await new Promise((resolve) => setTimeout(resolve, call.prompt === "A1" ? 60 : 1));
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    firstJournal.close();

    const liveCalls: string[] = [];
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "pipeline_call_path", scriptHash: "same", startedAt: 1, maxAgents: 4,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      maxAgents: 4,
      runner: {
        run: async (call: any) => {
          liveCalls.push(call.prompt);
          return { value: call.prompt, usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    });
    assert.deepEqual(liveCalls, []);
    assert.equal(resumed.cachedCount, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parser checkpoints stop synchronous and awaited loops without using a timeout option", async () => {
  const bounded = await runWorkflow(
    `export const meta = { name: 'loops_ok', description: 'x' }
     let total = 0
     while (total < 3) total++
     for (let i = 0; i < 2; i++) { await Promise.resolve(); total++ }
     const f = async () => { await Promise.resolve(); return 1 }
     return total + await f()`,
    { runner: mockRunner() },
  );
  assert.equal(bounded.result, 6);

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'loop_limit', description: 'x' }
       let i = 0
       while (true) { i++ }`,
      { runner: mockRunner() },
    ),
    /script checkpoint limit/,
  );

  const awaitedLoop = parseWorkflowScript(
    `export const meta = { name: 'awaited_loop_limit', description: 'x' }
     while (true) { await Promise.resolve() }`,
  );
  await assert.rejects(
    executeWorkflowScript(awaitedLoop.body, emptyHost(), {
      cwd: process.cwd(),
      name: awaitedLoop.meta.name,
      signal: new AbortController().signal,
      checkpointLimit: 5,
      stallTimeoutMs: 200,
    }),
    /script checkpoint limit/,
  );
});

test("workflow worker heap limits contain runaway dynamic allocation", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'heap_limit', description: 'x' }
       const values = []
       for (let i = 0; i < 500_000; i++) values.push({ value: 'value-' + i, index: i })
       return values.length`,
      { runner: mockRunner(), workerMemoryLimitMb: 16 },
    ),
    /memory limit|heap|out of memory/i,
  );
});

test("workflow host-call fuel terminates excessive orchestration events", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'host_call_fuel', description: 'x' }
       log('one')
       log('two')
       log('three')
       log('four')`,
      { runner: mockRunner(), hostCallLimit: 3 },
    ),
    /host-call limit.*3|exceeded.*3.*host/i,
  );
});

test("a responsive worker with no host RPC or checkpoint progress is terminated", async () => {
  const safetyAbort = new AbortController();
  const timer = setTimeout(() => safetyAbort.abort(), 250);
  try {
    await assert.rejects(
      runWorkflow(
        `export const meta = { name: 'local_async_stall', description: 'x' }\nawait new Promise(() => {})`,
        { runner: mockRunner(), signal: safetyAbort.signal, stallTimeoutMs: 50 },
      ),
      /no script progress|stalled|unresponsive/i,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("raw uninstrumented worker stalls are terminated while async waits keep heartbeating", async () => {
  const ac = new AbortController();
  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  await assert.rejects(
    executeWorkflowScript("while (true) {}", emptyHost(), {
      cwd: process.cwd(),
      name: "raw_stall",
      signal: ac.signal,
      stallTimeoutMs: 50,
    }),
    (error) => error instanceof WorkflowStallError,
  );
  clearTimeout(timer);
  assert.equal(timerFired, true, "main thread timer should fire while the worker is stuck");

  const slow = await runWorkflow(
    `export const meta = { name: 'slow_agent', description: 'x' }\nreturn await agent('slow')`,
    {
      stallTimeoutMs: 80,
      runner: {
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 140));
          return { value: "ok", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    },
  );
  assert.equal(slow.result, "ok");
});

test("external abort terminates a workflow awaiting a local never-settling promise", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30).unref?.();
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'abort_local_wait', description: 'x' }
       await new Promise(() => {})`,
      { runner: mockRunner(), signal: ac.signal, stallTimeoutMs: 1_000 },
    ),
    /aborted/,
  );
});

function emptyHost() {
  return {
    agent: async () => { throw new Error("unexpected agent call"); },
    reservePanel: async () => ({ panelReservationId: "res_1", branchReservationIds: [] }),
    completePanelBranch: async () => undefined,
    releasePanel: async () => undefined,
    loadWorkflow: async () => { throw new Error("unexpected workflow load"); },
    validateOutput: async () => undefined,
    log: () => undefined,
    phase: () => undefined,
  };
}

test("external abort while agent RPCs are running aborts children and prevents queued runner starts", async () => {
  const ac = new AbortController();
  let started = 0;
  let childAbortSeen = 0;
  const runner = {
    run: async (call: any) => {
      started++;
      if (started === 1) setImmediate(() => ac.abort());
      await new Promise((_resolve, reject) => {
        const fail = () => {
          childAbortSeen++;
          reject(new Error("child aborted"));
        };
        if (call.signal.aborted) fail();
        else call.signal.addEventListener("abort", fail, { once: true });
      });
      return { value: "never", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
    },
  };
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'abort_rpc', description: 'x' }
       return await parallel([() => agent('a'), () => agent('b'), () => agent('c')], { reserveAgents: 3 })`,
      {
        runner,
        concurrency: 1,
        signal: ac.signal,
        onAgentStart: () => undefined,
      },
    ),
    /aborted/,
  );
  assert.equal(started, 1, "all queued agents should reject without deadlocking or starting runner.run");
  assert.equal(childAbortSeen, 1, "started child received the abort signal");
});

test("external abort has a bounded drain when a runner ignores cancellation", async () => {
  const ac = new AbortController();
  let markStarted!: () => void;
  const runnerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const startedAt = Date.now();
  const execution = runWorkflow(
    `export const meta = { name: 'bounded_abort_drain', description: 'x' }\nreturn await agent('never')`,
    {
      signal: ac.signal,
      cleanupTimeoutMs: 30,
      runner: {
        run: async () => {
          markStarted();
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { value: "late", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
        },
      },
    },
  );
  await runnerStarted;
  ac.abort();
  await assert.rejects(execution, /cleanup.*30ms|drain.*30ms/i);
  assert.ok(Date.now() - startedAt < 250, "abort cleanup must not wait forever for an uncooperative runner");
});

test("dynamic promise method calls are rejected before orchestration starts", async () => {
  let runnerCalls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'dynamic_promise_chain', description: 'x' }
       const make = () => agent('never')
       const pending = make()
       const key = 'then'
       return Reflect.apply(pending[key], pending, [(value) => value])`,
      {
        runner: {
          run: async () => {
            runnerCalls++;
            return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /dynamic method|promise checks/i,
  );
  assert.equal(runnerCalls, 0);
});

test("tagged templates cannot receive orchestration promises", async () => {
  let runnerCalls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'tagged_promise_escape', description: 'x' }
       function unwrap(_strings, pending) {
         const key = 'then'
         return Reflect.apply(pending[key], pending, [(value) => value])
       }
       return await unwrap\`\${agent('never')}\``,
      {
        runner: {
          run: async () => {
            runnerCalls++;
            return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /dynamic method|promise checks/i,
  );
  assert.equal(runnerCalls, 0);
});

test("Promise combinators cannot be recovered through an instance constructor", async () => {
  let runnerCalls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'promise_constructor_alias', description: 'x' }
       const P = (new Promise((resolve) => resolve())).constructor
       const all = P.all.bind(P)
       const make = () => agent('never')
       return await all([make()])`,
      {
        runner: {
          run: async () => {
            runnerCalls++;
            return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /undefined|Promise|combinator|not a function/i,
  );
  assert.equal(runnerCalls, 0);
});

test("member access cannot bypass source call-site instrumentation", async () => {
  let runnerCalls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'member_orchestration', description: 'x' }
       return await globalThis.agent('never')`,
      {
        runner: {
          run: async () => {
            runnerCalls++;
            return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /globalThis|called directly|call sites/i,
  );
  assert.equal(runnerCalls, 0);
});

test("native detached promise chains are rejected before orchestration starts", async () => {
  let runnerStarts = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'detached_catch', description: 'x' }
       agent('never').catch(() => null)
       return 'done'`,
      {
        cleanupTimeoutMs: 30,
        runner: {
          run: async () => {
            runnerStarts++;
            return { value: "unexpected", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /promise chains|unawaited|pending orchestration|cleanup.*30ms/i,
  );
  assert.equal(runnerStarts, 0);
});

test("root completion with an unawaited host agent promise is fatal and aborts the child", async () => {
  let abortSeen = false;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'unawaited', description: 'x' }
       agent('background', { label: 'background' })
       return 'done'`,
      {
        runner: {
          run: async (call: any) => {
            await new Promise((_resolve, reject) => {
              const fail = () => {
                abortSeen = true;
                reject(new Error("aborted child"));
              };
              if (call.signal.aborted) fail();
              else call.signal.addEventListener("abort", fail, { once: true });
            });
            return { value: "never", usage: { outputTokens: 1, totalTokens: 1, cost: 0 }, cwd: process.cwd() };
          },
        },
      },
    ),
    /unawaited orchestration promise/,
  );
  assert.equal(abortSeen, true);
});

test("unawaited parallel, pipeline, and workflow promises are fatal even when locally stuck", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'unawaited_parallel', description: 'x' }
       parallel([() => new Promise(() => {})])
       return 'done'`,
      { runner: mockRunner() },
    ),
    /unawaited orchestration promise/,
  );

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'unawaited_pipeline', description: 'x' }
       pipeline([1], () => new Promise(() => {}))
       return 'done'`,
      { runner: mockRunner() },
    ),
    /unawaited orchestration promise/,
  );

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'unawaited_workflow', description: 'x' }
       workflow('child')
       return 'done'`,
      {
        runner: mockRunner(),
        loadSavedWorkflow: () => ({
          meta: { name: "child", description: "x" },
          body: `await new Promise(() => {})`,
        }),
      },
    ),
    /unawaited orchestration promise/,
  );
});

test("sticky local policy is fatal even if user code catches it and waits forever", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'local_policy_sticky', description: 'x' }
       try {
         await parallel([], { reserveAgents: 2048 })
       } catch (error) {
         await new Promise(() => {})
       }`,
      { runner: mockRunner(), stallTimeoutMs: 1_000 },
    ),
    /reserveAgents must be an integer between 0 and 1024/,
  );
});

test("sticky host policy is fatal even if user code catches it and waits forever", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'host_policy_sticky', description: 'x' }
       try {
         await agent('one')
         await agent('two')
       } catch (error) {
         await new Promise(() => {})
       }`,
      { runner: mockRunner(), maxAgents: 1, stallTimeoutMs: 1_000 },
    ),
    /maxAgents=1|no agent slots remain/,
  );
});

test("host log and phase callback exceptions reject under control", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'log_callback', description: 'x' }
       log('boom')`,
      { runner: mockRunner(), onLog: () => { throw new Error("log callback failed"); } },
    ),
    /log callback failed/,
  );

  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'phase_callback', description: 'x' }
       phase('boom')`,
      { runner: mockRunner(), onPhase: () => { throw new Error("phase callback failed"); } },
    ),
    /phase callback failed/,
  );
});

test("non-cloneable live agent results become ordinary agent failures without done journal records", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-clone-"));
  try {
    const runId = "wf_clone";
    const journal = RunJournal.create(dir, { type: "run", runId, name: "clone", scriptHash: "1", startedAt: 0 });
    const ended: any[] = [];
    const result = await runWorkflow(
      `export const meta = { name: 'clone', description: 'x' }
       return await agent('function-result', { label: 'bad' })`,
      {
        journal,
        runner: {
          run: async () => ({
            value: () => "not cloneable",
            usage: { outputTokens: 5, totalTokens: 7, cost: 0 },
            cwd: process.cwd(),
          }),
        },
        onAgentEnd: (event) => ended.push(event),
      },
    );
    journal.close();
    assert.equal(result.result, null);
    assert.equal(result.spentTokens, 5, "spent output tokens remain observable");
    assert.equal(result.newTokens, 7, "live usage remains observable even though the result was rejected");
    assert.equal(ended[0]?.status, "error");
    assert.match(ended[0]?.error ?? "", /agent result must be structured-cloneable/);
    const lines = fs.readFileSync(path.join(dir, `${runId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.some((record) => record.type === "agent"), false, "non-cloneable values are not journaled as done agents");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed runner usage is normalized before journal persistence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-usage-normalization-"));
  const runId = "wf_usage_normalization";
  const script = `export const meta = { name: 'usage_normalization', description: 'x' }
    return await agent('one')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "usage_normalization", scriptHash: "same", startedAt: 0,
    });
    const first = await runWorkflow(script, {
      journal: firstJournal,
      runner: {
        run: async () => ({
          value: "ok",
          usage: {
            inputTokens: -1,
            outputTokens: Number.NaN,
            totalTokens: Number.POSITIVE_INFINITY,
            cacheReadTokens: 1.5,
            cost: Number.NaN,
            turns: -2,
          },
          cwd: process.cwd(),
        }),
      },
    });
    assert.equal(first.result, "ok");
    assert.equal(first.spentTokens, 0);
    assert.equal(first.newTokens, 0);
    firstJournal.close();

    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "usage_normalization", scriptHash: "same", startedAt: 1,
    });
    const resumed = await runWorkflow(script, {
      journal: resumedJournal,
      runner: { run: async () => { throw new Error("cache should replay"); } },
    });
    assert.equal(resumed.result, "ok");
    assert.equal(resumed.cachedCount, 1);
    resumedJournal.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent observer failures are fatal inside parallel panels", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parallel_observer_failure', description: 'x' }
       return await parallel([() => agent('one')])`,
      {
        runner: mockRunner(),
        onAgentEnd: () => { throw new Error("parallel observer failed"); },
      },
    ),
    /parallel observer failed/,
  );
});

test("agent completion callback failures are not journaled as replayable successes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-callback-journal-"));
  const runId = "wf_callback_journal";
  const script = `export const meta = { name: 'callback_journal', description: 'x' }\nreturn await agent('one')`;
  try {
    const firstJournal = RunJournal.create(dir, {
      type: "run", runId, name: "callback_journal", scriptHash: "1", startedAt: 0,
    });
    await assert.rejects(
      runWorkflow(script, {
        journal: firstJournal,
        runner: mockRunner(),
        onAgentEnd: () => { throw new Error("completion observer failed"); },
      }),
      /completion observer failed/,
    );
    const afterFailure = fs.readFileSync(firstJournal.filePath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(afterFailure.some((record) => record.type === "agent"), false);
    firstJournal.close();

    const liveRunner = mockRunner();
    const resumedJournal = RunJournal.resume(dir, runId, {
      type: "run", runId, name: "callback_journal", scriptHash: "1", startedAt: 1,
    });
    const resumed = await runWorkflow(script, { journal: resumedJournal, runner: liveRunner });
    assert.equal(resumed.result, "echo:one");
    assert.equal(liveRunner.calls.length, 1, "resume reruns work that was not accepted by observers");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("user catch cannot convert a workflow policy error into success", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'catch_policy', description: 'x' }
       try {
         await agent('one')
         await agent('two')
       } catch (error) {
         log('caught ' + error.message)
       }
       return 'not ok'`,
      { runner: mockRunner(), maxAgents: 1 },
    ),
    /maxAgents=1|no agent slots remain/,
  );
});

test("workflow scripts may not use the reserved checkpoint identifier", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'reserved_checkpoint', description: 'x' }
       const __ultracodeCheckpoint = 1
       return __ultracodeCheckpoint`,
      { runner: mockRunner() },
    ),
    /reserved identifier __ultracodeCheckpoint/,
  );
});
