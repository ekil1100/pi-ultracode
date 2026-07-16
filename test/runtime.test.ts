import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { runWorkflow } from "../src/workflow/runtime.ts";
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
     await agent('b', { label: 'b' })`,
    { runner: mockRunner(), onPhase: (p) => phases.push(p), onLog: (l) => logs.push(l) },
  );
  assert.deepEqual(result.phases, ["Scan", "Verify"]);
  assert.deepEqual(phases, ["Scan", "Verify"]);
  assert.ok(logs.includes("starting"));
});

test("budget.remaining reflects real tokens and exhaustion throws", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'bud', description: 'x' }
       await agent('first', { label: 'first' })
       await agent('second', { label: 'second' })`,
      { runner: mockRunner(100), tokenBudget: 100 },
    ),
    /token budget exhausted/,
  );
});

test("budget loop pattern scales to budget", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'loop', description: 'x' }
     let n = 0
     while (budget.total && budget.remaining() > 50) { await agent('x' + n, { label: 'x' + n }); n++ }
     return n`,
    { runner: mockRunner(50), tokenBudget: 200 },
  );
  // 200/50 = budget allows remaining>50 at 0,50,100 -> 3 iterations (spent 0,50,100 then 150 stops at >50? 200-150=50 not >50)
  assert.equal(result.result, 3);
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

test("resume replays cached agent results for unchanged prefix", async () => {
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
  assert.equal(runner2.calls.length, 0, "resumed run should not call the runner for cached prefix");

  fs.rmSync(dir, { recursive: true, force: true });
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
      loadSavedWorkflow: () => ({
        meta: { name: "child", description: "y" },
        body: `return await agent('child-task', { label: 'c' })`,
      }),
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
      loadSavedWorkflow: (name) => ({
        meta: { name: String(name), description: "child" },
        body: `phase('${String(name)} phase'); return await agent('${String(name)}', { label: '${String(name)}' })`,
      }),
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

test("nested workflow() inside a child throws", async () => {
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'parent', description: 'x' }
       return await workflow('child')`,
      {
        runner: mockRunner(),
        loadSavedWorkflow: () => ({
          meta: { name: "child", description: "y" },
          body: `return await workflow('grandchild')`,
        }),
      },
    ),
    /one level deep/,
  );
});

test("rejects a workflow that never calls agent (structured-clone of undefined ok, but no agents)", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'noop', description: 'x' }\nphase('Plan')\nreturn { planned: true }`,
    { runner: mockRunner() },
  );
  // The runtime itself allows zero agents; the tool layer enforces "must call agent()".
  assert.equal(result.agentCount, 0);
  assert.deepEqual(result.result, { planned: true });
});
