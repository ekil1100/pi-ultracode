import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { WorkflowAgentRunner, type AgentSessionLike } from "../src/workflow/agent-runner.ts";
import { runWorkflow, type WorkflowRunOptions } from "../src/workflow/runtime.ts";
import { RunJournal } from "../src/workflow/journal.ts";
import { parseWorkflowScript } from "../src/workflow/parser.ts";
import { resolveRepositoryContext } from "../src/workflow/repository-context.ts";
import { createJevBatch, selectJevEfforts } from "../src/jev.ts";
import { getEffortCriteria } from "../src/effort-policy.ts";
import type { ThinkingLevel } from "../src/thinking.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function choice(effort: string) {
  return { type: "choice" as const, choice: effort, confidence: 1, probabilities: { [effort]: 1 } };
}

function response(request: any, effort = "low") {
  return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, choice(effort)])) });
}

const HEADER = `export const meta = { name: 'batch', description: 'Review and verify a bounded change' };`;
const PANEL = `${HEADER}
return await parallel([
  () => agent('First task', { label: 'first', model: ':high' }),
  () => agent('Second task', { label: 'second', model: ':medium' }),
  () => agent('Third task', { label: 'third', model: ':low' })
]);`;

type Prompt = { label: string; prompt: string; effort: ThinkingLevel; model: string };

async function harness(t: TestContext, config: {
  respond?: (request: any, init: RequestInit) => Response | Promise<Response>;
  supported?: Record<string, ThinkingLevel[]>;
  initialize?: (index: number) => Promise<void>;
  prompt?: (entry: Prompt) => Promise<void>;
} = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-jev-batch-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("typesafe", "fake-batch-key");
  const requests: any[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-batch-key");
    const request = JSON.parse(init.body as string);
    requests.push(request);
    return config.respond ? await config.respond(request, init) : response(request);
  });
  const available = t.mock.method(runtime, "getAvailableOfType", runtime.getAvailableOfType.bind(runtime));
  const classify = t.mock.method(runtime, "classify", runtime.classify.bind(runtime));
  const models = Object.keys(config.supported ?? { default: [] }).map((id) => ({ provider: "test", id }));
  const parentModel = models[0];
  const parentSnapshot = structuredClone(parentModel);
  const prompts: Prompt[] = [];
  const changes: Array<{ level: ThinkingLevel; persist?: boolean }> = [];
  let creates = 0;
  let disposes = 0;
  let aborts = 0;
  let active = 0;
  let maxActive = 0;
  const runner = new WorkflowAgentRunner({
    cwd, modelRuntime: runtime, modelRegistry: { getAvailable: () => models }, model: parentModel, thinkingLevel: "high",
    createSession: async (options) => {
      const index = creates++;
      await config.initialize?.(index);
      const requested = options.model!.id;
      const levels = config.supported?.[requested] ?? ["low", "medium", "high"];
      const session: AgentSessionLike = {
        model: { provider: "actual", id: `actual-${requested}` },
        thinkingLevel: options.thinkingLevel ?? "high",
        supportsThinking: () => levels.some((level) => level !== "off"),
        getAvailableThinkingLevels: () => levels,
        setThinkingLevel(level, options) {
          assert.ok(levels.includes(level));
          changes.push({ level, persist: options?.persist });
          this.thinkingLevel = level;
        },
        async prompt(prompt, preflight) {
          preflight?.preflightResult?.(true);
          const label = /Task label: ([^\n]+)/.exec(prompt)![1];
          const entry = { label, prompt, effort: session.thinkingLevel, model: session.model!.id };
          prompts.push(entry);
          maxActive = Math.max(maxActive, ++active);
          try {
            await config.prompt?.(entry);
            session.messages.push({ role: "assistant", content: [{ type: "text", text: `result:${label}` }] });
            const tool = options.customTools?.find((tool) => tool.name === "structured_output");
            if (tool) await (tool.execute as any)("output", { ok: true });
          } finally {
            active--;
          }
        },
        abort: async () => { aborts++; },
        dispose: () => { disposes++; },
        subscribe: () => () => {},
        messages: [],
      };
      return { session };
    },
  });
  const run = (script: string, options: WorkflowRunOptions = {}) => runWorkflow(script, {
    cwd, runner, model: parentModel, thinkingLevel: "high", projectTrusted: false,
    modelRegistry: { getAvailable: () => models }, ...options,
  });
  t.after(() => assert.deepEqual(parentModel, parentSnapshot, "parent model is never mutated"));
  return { cwd, runtime, requests, fetch, available, classify, prompts, changes, run,
    counts: () => ({ creates, disposes, aborts, maxActive }) };
}

for (const concurrency of [1, 2, 16]) {
  test(`Jev batch spans all ready calls beyond execution concurrency ${concurrency}`, { timeout: 10_000 }, async (t) => {
    const gate = deferred();
    const entered = deferred();
    let started = 0;
    const count = concurrency + 2;
    const h = await harness(t, {
      prompt: async () => { if (++started === concurrency) entered.resolve(); await gate.promise; },
    });
    const script = `${HEADER} const items = ${JSON.stringify(Array.from({ length: count }, (_, i) => i))};
      return await parallel(items.map(i => () => agent('task ' + i, {label: 'task-' + i})));`;
    const running = h.run(script, { concurrency });
    try {
      await entered.promise;
      assert.equal(h.requests.length, 1);
      assert.equal(Object.keys(h.requests[0].questions).length, count);
      assert.equal(h.available.mock.callCount(), 1);
      assert.equal(h.prompts.length, concurrency);
      assert.equal(h.counts().maxActive, concurrency);
    } finally {
      gate.resolve();
    }
    const result = await running;
    assert.equal(result.agentCount, count);
    assert.equal(result.agentsUsed, count);
    assert.equal(h.counts().disposes, count);
    assert.equal(h.requests.length, 1);
    assert.ok(h.changes.every((change) => change.persist === false));
  });
}

test("Jev batch maps full prompts, actual models, subsets and existing workflow background by question ID", async (t) => {
  const lastInitialized = deferred();
  const h = await harness(t, {
    supported: { small: ["low", "high"], large: ["low", "medium", "high"], fixed: ["off"] },
    initialize: async (index) => {
      if (index === 0) await lastInitialized.promise;
      if (index === 2) lastInitialized.resolve();
    },
    respond: (request) => Response.json({ answers: { task_1: choice("medium"), task_0: choice("low") } }),
  });
  const longPrompt = `Known upstream result: verified invariant. ${"full prompt ".repeat(2000)}`;
  const script = `export const meta = {
    name: 'context', description: 'Cross-module investigation', goal: 'Repair the verified defect',
    acceptance: ['Regression passes', 'No unrelated changes'], dependencies: { implement: ['verify'] },
    phases: [{title: 'Verify', detail: 'Check evidence'}]
  };
  phase('Verify');
  return await parallel([
    () => agent(args.prompt, {label: 'first', model: 'test/small:high', agentType: 'Plan',
      schema: {type: 'object', properties: {ok: {type: 'boolean'}}, required: ['ok']}}),
    () => agent('Wire a known option', {label: 'second', model: 'test/large:low'}),
    () => agent('Mechanical operation', {label: 'third', model: 'test/fixed:off'})
  ]);`;
  const result = await h.run(script, { args: { prompt: longPrompt, target: 'current branch' }, concurrency: 1 });
  assert.equal(h.requests.length, 1);
  const { state, questions } = h.requests[0];
  assert.deepEqual(state.workflow.meta, parseWorkflowScript(script).meta);
  assert.equal(state.workflow.args.target, "current branch");
  assert.equal(Object.keys(questions).length, 2);
  assert.deepEqual(state.tasks.task_0.model, { provider: "actual", id: "actual-small" });
  assert.deepEqual(state.tasks.task_1.model, { provider: "actual", id: "actual-large" });
  assert.deepEqual(state.tasks.task_0.supportedEfforts, ["low", "high"]);
  assert.deepEqual(questions.task_1.criteria, getEffortCriteria(["low", "medium", "high"]));
  assert.equal(state.tasks.task_0.prompt, h.prompts.find((p) => p.label === "first")!.prompt);
  assert.ok(state.tasks.task_0.prompt.includes(longPrompt));
  assert.match(state.tasks.task_0.prompt, /Role:|Role \(operate strictly as\):/);
  assert.match(state.tasks.task_0.prompt, /Final output contract/);
  assert.equal(state.tasks.task_0.context.phase, "Verify");
  assert.deepEqual(state.tasks.task_0.context.workflowPath, ["context"]);
  assert.equal(state.tasks.task_0.context.scheduling[0].kind, "parallel");
  assert.equal(state.tasks.task_0.context.scheduling[0].branchIndex, 0);
  assert.equal(state.tasks.task_1.context.scheduling[0].branchIndex, 1);
  assert.match(questions.task_0.instructions, /state.tasks.task_0 only/);
  assert.match(questions.task_1.instructions, /not a reason to raise all tasks/);
  assert.doesNotMatch(JSON.stringify(state), /export const meta|fake-batch-key/);
  assert.deepEqual(Object.fromEntries(h.prompts.map((p) => [p.label, p.effort])), { first: "low", second: "medium", third: "off" });
  assert.deepEqual(result.result, [{ ok: true }, "result:second", "result:third"]);
});

test("Jev pipeline classifies later dependencies without waiting for a slow sibling", { timeout: 10_000 }, async (t) => {
  const slow = deferred();
  const later = deferred();
  const h = await harness(t, { prompt: async ({ label }) => {
    if (label === "slow") await slow.promise;
    if (label === "after-fast") later.resolve();
  } });
  const running = h.run(`${HEADER} return await pipeline(['fast', 'slow'],
    item => agent('Inspect ' + item, {label: item}),
    (previous, item) => agent('Use upstream: ' + previous, {label: 'after-' + item})
  );`, { concurrency: 2 });
  try {
    await later.promise;
    assert.deepEqual(h.requests.map((r) => Object.keys(r.questions).length), [2, 1]);
    const next = h.requests[1].state.tasks.task_0;
    assert.match(next.prompt, /Use upstream: result:fast/);
    assert.equal(next.context.scheduling[0].stageIndex, 1);
    assert.equal(next.context.scheduling[0].itemIndex, 0);
    assert.equal(h.prompts.some((p) => p.label === "after-slow"), false);
  } finally {
    slow.resolve();
  }
  await running;
  assert.deepEqual(h.requests.map((r) => Object.keys(r.questions).length), [2, 1, 1]);
});

test("Jev seals synchronous fan-out rather than waiting for post-await or nested workflow calls", async (t) => {
  const h = await harness(t);
  const child = parseWorkflowScript(`export const meta = {name:'child', description:'Nested verification'};
    return await parallel([
      () => agent('Nested one', {label:'child-one'}),
      () => agent('Nested two', {label:'child-two'})
    ]);`);
  await h.run(`${HEADER} return await parallel([
    () => agent('Ready now', {label:'direct'}),
    async () => { await 0; return await agent('Ready after await', {label:'later'}); },
    () => workflow('child', {goal:'Verify provided evidence'})
  ], {reserveAgents:4});`, { loadSavedWorkflow: () => child });
  const groups = h.requests.map((r) => Object.values(r.state.tasks).map((task: any) => /Task label: ([^\n]+)/.exec(task.prompt)![1]));
  assert.ok(groups.some((g) => JSON.stringify(g) === JSON.stringify(["direct"])));
  assert.ok(groups.some((g) => JSON.stringify(g) === JSON.stringify(["later"])));
  assert.ok(groups.some((g) => JSON.stringify(g) === JSON.stringify(["child-one", "child-two"])));
  const nested = h.requests.find((r) => r.state.tasks.task_0.prompt.includes("child-one"));
  assert.deepEqual(nested.state.tasks.task_0.context.workflow.meta, child.meta);
  assert.equal(nested.state.tasks.task_0.context.workflow.args.goal, "Verify provided evidence");
  assert.deepEqual(nested.state.tasks.task_0.context.workflowPath, ["batch", "child"]);
  assert.deepEqual(nested.state.tasks.task_0.context.scheduling.map((s: any) => s.kind), ["parallel", "parallel"]);
});

test("Jev maps unsupported individual wire choices without discarding valid sibling answers", async (t) => {
  const h = await harness(t, { respond: () => Response.json({ answers: {
    task_2: choice("medium"), task_0: choice("low"), task_1: choice("max"), extra: choice("high"),
  } }) });
  await h.run(PANEL);
  assert.deepEqual(h.prompts.map((p) => p.effort), ["low", "medium", "medium"]);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.changes.map((c) => c.level), ["low", "medium"]);
});

test("Jev validates each answer exposed by the native runtime independently", async (t) => {
  const h = await harness(t);
  t.mock.method(h.runtime, "classify", async () => ({
    api: "typesafe-system-one", provider: "typesafe", model: "jev-latest", timestamp: 0, stopReason: "stop",
    answers: { task_0: choice("low"), task_1: { type: "bool", probability: 1 }, task_3: choice("high") },
  }));
  const efforts = await selectJevEfforts({ runtime: h.runtime, tasks: Array.from({ length: 4 }, () => ({
    task: "Task", model: { provider: "test", id: "model" }, supportedEfforts: ["low", "high"] as const,
  })) });
  assert.deepEqual(efforts, ["low", undefined, undefined, "high"]);
  assert.equal(h.fetch.mock.callCount(), 0);
});

for (const invalid of [undefined, { type: "bool", probability: 1 }, null]) {
  test(`Jev preserves all defaults when Pi discards a malformed wire batch: ${JSON.stringify(invalid)}`, async (t) => {
    const h = await harness(t, { respond: () => Response.json({ answers: {
      task_0: choice("low"), task_1: invalid, task_2: choice("high"),
    } }) });
    await h.run(PANEL);
    assert.deepEqual(h.prompts.map((p) => p.effort), ["high", "medium", "low"]);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.changes, []);
  });
}

test("Jev batch skips initialization failures without hanging or misassigning a surviving task", async (t) => {
  const h = await harness(t, { initialize: async (index) => { if (index === 1) throw new Error("Initialization failed"); } });
  const result = await h.run(PANEL, { concurrency: 1 });
  assert.deepEqual(result.result, ["result:first", null, "result:third"]);
  assert.equal(h.requests.length, 1);
  assert.equal(Object.keys(h.requests[0].questions).length, 2);
  assert.match(h.requests[0].state.tasks.task_1.prompt, /Task label: third/);
  assert.equal(h.counts().disposes, 2);
});

test("Jev cancellation aborts one batch and every idle child before any execution", { timeout: 10_000 }, async (t) => {
  const started = deferred();
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const h = await harness(t, { respond: async (_request, init) => {
    requestSignal = init.signal!;
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("private-response")), { once: true });
    });
  } });
  const rejected = assert.rejects(h.run(PANEL, { signal: controller.signal, concurrency: 1 }), /aborted/);
  await started.promise;
  controller.abort();
  await rejected;
  assert.equal(h.requests.length, 1);
  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.counts(), { creates: 3, disposes: 3, aborts: 3, maxActive: 0 });
});

test("Jev timeout falls back independently for the whole batch after 10 seconds with no retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 10_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const started = deferred();
  const h = await harness(t, { respond: async (_request, init) => {
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
    });
  } });
  const running = h.run(PANEL, { concurrency: 1 });
  await started.promise;
  t.mock.timers.tick(9_999);
  assert.equal(h.prompts.length, 0);
  t.mock.timers.tick(1);
  await running;
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.prompts.map((p) => p.effort), ["high", "medium", "low"]);
  assert.equal(h.counts().disposes, 3);
  assert.equal(h.classify.mock.calls[0].arguments[2]?.maxRetries, 0);
  assert.equal(Object.hasOwn(h.classify.mock.calls[0].arguments[2]!, "apiKey"), false);
});

test("Jev cancellation also removes classified children queued on the execution semaphore", async (t) => {
  const entered = deferred();
  const stopped = deferred();
  const controller = new AbortController();
  const h = await harness(t, { prompt: async () => { entered.resolve(); await stopped.promise; } });
  const rejected = assert.rejects(h.run(PANEL, { concurrency: 1, signal: controller.signal }), /aborted/);
  await entered.promise;
  controller.abort();
  stopped.resolve();
  await rejected;
  assert.equal(h.requests.length, 1);
  assert.equal(h.prompts.length, 1);
  assert.equal(h.counts().disposes, 3);
});

test("Jev does not classify or initialize when parallel admission fails", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run(PANEL, { maxAgents: 2 }), /agent|reserv/i);
  assert.equal(h.available.mock.callCount(), 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.counts().creates, 0);
});

test("Jev never executes tasks from an over-cap pipeline batch", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run(`${HEADER} return await pipeline([1, 2, 3],
    i => agent('Task ' + i, {label:'task-' + i}));`, { maxAgents: 2, concurrency: 1 }), /agent|admission/i);
  assert.equal(h.requests.length, 0);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.counts().disposes, h.counts().creates);
});

test("Jev excludes cache hits from a resumed batch and does not classify fully restored work", async (t) => {
  let fail = true;
  const h = await harness(t, { prompt: async ({ label }) => {
    if (fail && label === "second") throw new Error("Retry on resume");
  } });
  const dir = path.join(h.cwd, "journal");
  const meta = {
    type: "run" as const, runId: "batch-resume", name: "batch", scriptHash: "unchanged", startedAt: 0,
    projectTrusted: false, targetIdentity: resolveRepositoryContext(h.cwd).identity,
  };
  const first = RunJournal.create(dir, meta);
  t.after(() => first.close());
  await h.run(PANEL, { journal: first, concurrency: 1 });
  first.close();
  fail = false;
  const second = RunJournal.resume(dir, meta.runId, meta);
  t.after(() => second.close());
  const resumed = await h.run(PANEL, { journal: second, concurrency: 1 });
  second.close();
  assert.equal(resumed.cachedCount, 2);
  assert.deepEqual(h.requests.map((r) => Object.keys(r.questions).length), [3, 1]);
  assert.match(h.requests[1].state.tasks.task_0.prompt, /Task label: second/);
  const creates = h.counts().creates;
  const third = RunJournal.resume(dir, meta.runId, meta);
  t.after(() => third.close());
  const restored = await h.run(PANEL, { journal: third, concurrency: 1 });
  third.close();
  assert.equal(restored.cachedCount, 3);
  assert.equal(restored.agentsUsed, resumed.agentsUsed);
  assert.equal(h.requests.length, 2);
  assert.equal(h.counts().creates, creates);
});

test("Jev skips an entire fixed-effort batch without even checking availability", async (t) => {
  const h = await harness(t, { supported: { fixed: ["off"] } });
  await h.run(`${HEADER} return await parallel([
    () => agent('Mechanical A', {label:'a', model:':off'}),
    () => agent('Mechanical B', {label:'b', model:':off'})
  ]);`, { concurrency: 1 });
  assert.equal(h.available.mock.callCount(), 0);
  assert.equal(h.classify.mock.callCount(), 0);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.prompts.map((p) => p.effort), ["off", "off"]);
});

test("Jev unavailable batches preserve distinct parent efforts", async (t) => {
  const h = await harness(t);
  t.mock.method(h.runtime, "getAvailableOfType", async () => []);
  await h.run(PANEL, { concurrency: 1 });
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.prompts.map((p) => p.effort), ["high", "medium", "low"]);
  assert.deepEqual(h.changes, []);
});

test("Jev shared background includes only provided metadata, never the workflow source", async (t) => {
  const h = await harness(t);
  await h.run(PANEL);
  assert.deepEqual(h.requests[0].state.workflow, { meta: parseWorkflowScript(PANEL).meta });
  assert.equal(Object.hasOwn(h.requests[0].state.workflow.meta, "goal"), false);
  assert.equal(Object.hasOwn(h.requests[0].state.workflow.meta, "acceptance"), false);
  assert.equal(Object.hasOwn(h.requests[0].state.workflow.meta, "dependencies"), false);
  assert.doesNotMatch(JSON.stringify(h.requests[0].state), /export const meta|return await parallel/);
});

test("Jev cancellation racing a successful batch cannot execute any child", async (t) => {
  const controller = new AbortController();
  const h = await harness(t, { respond: (request) => { controller.abort(); return response(request); } });
  await assert.rejects(h.run(PANEL, { signal: controller.signal }), /aborted/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.changes, []);
  assert.equal(h.counts().disposes, 3);
});

test("Jev already-aborted batches do not create sessions or check credentials", async (t) => {
  const h = await harness(t);
  await assert.rejects(h.run(PANEL, { signal: AbortSignal.abort() }), /aborted/);
  assert.equal(h.available.mock.callCount(), 0);
  assert.equal(h.counts().creates, 0);
  assert.equal(h.requests.length, 0);
});


test("Jev cancellation releases ready members even while another member is still initializing", async () => {
  const controller = new AbortController();
  let checked = false;
  const members = createJevBatch(2, { meta: { name: "cancel" } }, controller.signal);
  const pending = members[0].select({
    runtime: {
      getAvailableOfType: async () => { checked = true; return []; },
      classify: async () => { throw new Error("Unexpected classification"); },
    },
    task: "Ready", model: { provider: "test", id: "actual" }, supportedEfforts: ["low", "high"],
  });
  const rejected = assert.rejects(pending, /Subagent was aborted/);
  controller.abort();
  await rejected;
  assert.equal(checked, false);
  // A late initializer can still settle its member without reviving the batch.
  members[1].skip();
});
