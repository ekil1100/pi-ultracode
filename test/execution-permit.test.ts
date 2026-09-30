import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { WorkflowAgentRunner, type AgentSessionLike } from "../src/workflow/agent-runner.ts";
import { runWorkflow, type WorkflowRunOptions } from "../src/workflow/runtime.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const LABELS = ["first", "second", "third", "fourth"];
const script = (labels: string[]) => `export const meta = { name: 'execution_permit', description: 'Permit reentry regression' };
return await parallel(${JSON.stringify(labels)}.map(label => () => agent(label, { label })));`;

async function harness(t: TestContext, onPrompt: (label: string) => Promise<void>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-execution-permit-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-permit-key");
    const request = JSON.parse(init.body as string);
    requests.push(request);
    return Response.json({ answers: Object.fromEntries(Object.keys(request.questions).map((id, index) => {
      const effort = index % 2 === 0 ? "low" : "medium";
      return [id, { type: "choice", choice: effort, confidence: 1, probabilities: { [effort]: 1 } }];
    })) });
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  await runtime.setRuntimeApiKey("typesafe", "fake-permit-key");
  const classify = t.mock.method(runtime, "classify", runtime.classify.bind(runtime));
  const model = runtime.getModels("anthropic").find((model) => model.reasoning)!;
  assert.ok(model);
  const efforts: string[] = [];

  let creates = 0;
  let disposes = 0;
  let aborts = 0;
  let active = 0;
  let maxActive = 0;
  const prompts: string[] = [];
  const realRunner = new WorkflowAgentRunner({
    cwd, modelRuntime: runtime, model,
    createSession: async () => {
      creates++;
      const session: AgentSessionLike = {
        model,
        thinkingLevel: "high",
        supportsThinking: () => true,
        getAvailableThinkingLevels: () => ["low", "medium", "high"],
        setThinkingLevel(level, options) {
          assert.equal(options?.persist, false);
          this.thinkingLevel = level;
        },
        async prompt(prompt) {
          const label = /Task label: ([^\n]+)/.exec(prompt)![1];
          prompts.push(label);
          efforts.push(session.thinkingLevel);
          maxActive = Math.max(maxActive, ++active);
          try {
            await onPrompt(label);
            session.messages.push({ role: "assistant", content: [{ type: "text", text: label }] });
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
  const run = (options: WorkflowRunOptions = {}, labels = LABELS) => runWorkflow(script(labels), {
    cwd,
    concurrency: 1,
    runner: { supportsSchedulingHooks: true, run: (call) => realRunner.run(call) },
    ...options,
    // Turn a self-deadlock into a bounded failure and drain all pending calls.
    signal: AbortSignal.any([t.signal, AbortSignal.timeout(2_000), ...(options.signal ? [options.signal] : [])]),
  });
  return { realRunner, run, prompts, efforts, requests, classify, counts: () => ({ creates, disposes, aborts, active, maxActive }) };
}

for (const concurrency of [1, 2]) {
  test(`forwarding injected runner completes without exceeding execution concurrency ${concurrency}`, { timeout: 5_000 }, async (t) => {
    const entered = deferred();
    const gate = deferred();
    let started = 0;
    const h = await harness(t, async () => {
      if (++started === concurrency) entered.resolve();
      await gate.promise;
    });
    const running = h.run({ concurrency });
    try {
      await Promise.race([entered.promise, running]);
      await setImmediate();
      assert.equal(h.classify.mock.callCount(), 1);
      assert.equal(Object.keys(h.requests[0].questions).length, LABELS.length);
      assert.equal(h.prompts.length, concurrency, "queued calls must not execute while permits are held");
    } finally {
      gate.resolve();
    }
    const result = await running;
    assert.deepEqual(result.result, LABELS);
    assert.equal(result.agentCount, LABELS.length);
    assert.deepEqual(h.counts(), {
      creates: LABELS.length, disposes: LABELS.length, aborts: 0, active: 0, maxActive: concurrency,
    });
  });
}

test("concurrent execution permit reentry shares pending and acquired admission", { timeout: 5_000 }, async (t) => {
  const h = await harness(t, async () => { await setImmediate(); });
  const result = await h.run({ runner: {
    supportsSchedulingHooks: true,
    run: (call) => h.realRunner.run({
      ...call,
      acquireExecution: async () => {
        // Reenter after classification, while admission may still be queued.
        await Promise.all([call.acquireExecution!(), call.acquireExecution!()]);
        await call.acquireExecution!();
      },
    }),
  } });
  assert.equal(h.classify.mock.callCount(), 1);
  assert.deepEqual(result.result, LABELS);
  assert.deepEqual(h.counts(), {
    creates: LABELS.length, disposes: LABELS.length, aborts: 0, active: 0, maxActive: 1,
  });
});

test("forwarding injected runner releases its permit after a prompt failure", { timeout: 5_000 }, async (t) => {
  const h = await harness(t, async (label) => {
    if (label === "first") throw new Error("Expected prompt failure");
    await setImmediate();
  });
  const result = await h.run();
  assert.deepEqual(result.result, [null, ...LABELS.slice(1)]);
  assert.match(result.logs.join("\n"), /Expected prompt failure/);
  assert.deepEqual(h.counts(), {
    creates: LABELS.length, disposes: LABELS.length, aborts: 0, active: 0, maxActive: 1,
  });
});

test("forwarding injected runner cancellation drains the active call without starting queued calls", { timeout: 5_000 }, async (t) => {
  const controller = new AbortController();
  const entered = deferred();
  const stopped = deferred();
  const h = await harness(t, async () => { entered.resolve(); await stopped.promise; });
  const running = h.run({ signal: controller.signal });
  const rejected = assert.rejects(running, /aborted/);
  try {
    await Promise.race([entered.promise, running]);
    controller.abort();
  } finally {
    stopped.resolve();
  }
  await rejected;
  assert.deepEqual(h.prompts, ["first"]);
  assert.deepEqual(h.counts(), { creates: LABELS.length, disposes: LABELS.length, aborts: LABELS.length, active: 0, maxActive: 1 });
});

test("execution permit reentry still checks cancellation after admission", { timeout: 5_000 }, async (t) => {
  const controller = new AbortController();
  const h = await harness(t, async () => {});
  let reentryRejected = false;
  await assert.rejects(h.run({
    signal: controller.signal,
    runner: {
      supportsSchedulingHooks: true,
      run: async (call) => {
        await call.selectEffort!();
        await call.acquireExecution!();
        controller.abort();
        await assert.rejects(call.acquireExecution!(), /aborted/);
        reentryRejected = true;
        return h.realRunner.run(call);
      },
    },
  }), /aborted/);
  assert.equal(reentryRejected, true);
  assert.deepEqual(h.counts(), { creates: 0, disposes: 0, aborts: 0, active: 0, maxActive: 0 });
});

test("forwarding scheduling runner classifies two real-model tasks once before serial execution", { timeout: 5_000 }, async (t) => {
  const h = await harness(t, async () => { await setImmediate(); });
  const result = await h.run({ concurrency: 1 }, LABELS.slice(0, 2));
  assert.deepEqual(result.result, LABELS.slice(0, 2));
  assert.equal(h.classify.mock.callCount(), 1);
  assert.equal(h.requests.length, 1);
  assert.equal(Object.keys(h.requests[0].questions).length, 2);
  assert.deepEqual(h.efforts, ["low", "medium"]);
  assert.deepEqual(h.counts(), { creates: 2, disposes: 2, aborts: 0, active: 0, maxActive: 1 });
});

test("runner without scheduling hooks completes under runtime-managed permits", { timeout: 5_000 }, async (t) => {
  const h = await harness(t, async () => { throw new Error("Unexpected child session"); });
  let active = 0;
  let maxActive = 0;
  const result = await h.run({ runner: {
    async run(call) {
      assert.equal(call.selectEffort, undefined);
      assert.equal(call.acquireExecution, undefined);
      maxActive = Math.max(maxActive, ++active);
      await setImmediate();
      active--;
      return { value: call.label, cwd: process.cwd(), usage: { outputTokens: 0, totalTokens: 0, cost: 0 } };
    },
  } });
  assert.deepEqual(result.result, LABELS);
  assert.equal(maxActive, 1);
  assert.equal(h.classify.mock.callCount(), 0);
  assert.equal(h.counts().creates, 0);
});

test("forwarding scheduling runner cancels classification before acquiring execution permits", { timeout: 5_000 }, async (t) => {
  const controller = new AbortController();
  const started = deferred();
  const h = await harness(t, async () => { throw new Error("Unexpected child execution"); });
  let requestSignal: AbortSignal | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requestSignal = init.signal!;
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  });
  const running = h.run({ signal: controller.signal });
  const rejected = assert.rejects(running, /aborted/);
  await Promise.race([started.promise, running]);
  controller.abort();
  await rejected;
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.classify.mock.callCount(), 1);
  assert.equal(requestSignal?.aborted, true);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.counts(), {
    creates: LABELS.length, disposes: LABELS.length, aborts: LABELS.length, active: 0, maxActive: 0,
  });
});
