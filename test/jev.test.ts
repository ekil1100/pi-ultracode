import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type AuthOperationOptions } from "@earendil-works/pi-ai";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowAgentRunner,
  type AgentSessionLike,
  type AgentTelemetryEvent,
} from "../src/workflow/agent-runner.ts";
import { getEffortCriteria } from "../src/effort-policy.ts";
import { JEV_MODEL, selectJevEfforts } from "../src/jev.ts";
import type { ThinkingLevel } from "../src/thinking.ts";

function setKey(t: TestContext, key: string | undefined) {
  const previous = process.env.TYPESAFE_API_KEY;
  if (key === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = key;
  t.after(() => {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  });
}

function decision(effort: string): Response {
  return Response.json({
    model: JEV_MODEL,
    answers: { task_0: { type: "choice", choice: effort, confidence: 0.9, probabilities: { low: effort === "low" ? 0.9 : 0.1, high: effort === "high" ? 0.9 : 0.1 } } },
  });
}

function harness(supportedEfforts: ThinkingLevel[] = ["low", "high"], host?: ModelRuntime | ModelRegistry) {
  const events: AgentTelemetryEvent[] = [];
  const prompts: Array<{ prompt: string; effort: ThinkingLevel }> = [];
  const changes: Array<{ effort: ThinkingLevel; persist?: boolean }> = [];
  let creates = 0;
  let disposes = 0;
  let aborts = 0;
  const actualModel = { provider: "child-provider", id: "actual-child" };
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    modelRegistry: host instanceof ModelRegistry ? host : undefined,
    modelRuntime: host instanceof ModelRuntime ? host : undefined,
    createModelRuntime: host ? undefined : () => ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    }),
    model: { provider: "parent-provider", id: "requested-child" },
    createSession: async (options) => {
      creates++;
      const session: AgentSessionLike = {
        model: actualModel,
        thinkingLevel: options.thinkingLevel ?? "high",
        supportsThinking: () => supportedEfforts.some((level) => level !== "off"),
        getAvailableThinkingLevels: () => [...supportedEfforts],
        setThinkingLevel(level, options) {
          changes.push({ effort: level, persist: options?.persist });
          this.thinkingLevel = level;
        },
        prompt: async (prompt) => { prompts.push({ prompt, effort: session.thinkingLevel }); },
        abort: async () => { aborts++; },
        dispose: () => { disposes++; },
        subscribe: () => () => {},
        messages: [],
      };
      return { session };
    },
  });
  const run = (options: { signal?: AbortSignal; modelPattern?: string; prompt?: string } = {}) => runner.run({
    label: "assigned task",
    prompt: "Implement validation and its test",
    onTelemetry: (event) => events.push(event),
    ...options,
  });
  return { run, events, prompts, changes, actualModel, counts: () => ({ creates, disposes, aborts }) };
}

for (const key of [undefined, "", "  \n  "]) {
  test(`Jev: no Pi credentials preserves parent suffix and default (${JSON.stringify(key)})`, async (t) => {
    setKey(t, key);
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
    const h = harness();
    assert.equal((await h.run({ modelPattern: ":low" })).effort, "low");
    assert.equal((await h.run()).effort, "high");
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(h.changes, []);
    assert.equal(h.prompts.length, 2);
  });
}

test("Jev overrides each assigned subtask using shared criteria and the actual child model's subset", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer test-key-not-for-logs");
    const request = JSON.parse(init.body as string);
    requests.push(request);
    return decision(requests.length === 1 ? "low" : "high");
  });
  const h = harness();
  const first = await h.run({ modelPattern: ":high", prompt: "Add a local validation rule" });
  const second = await h.run({ modelPattern: ":low", prompt: "Diagnose competing cross-module hypotheses" });
  assert.equal(first.effort, "low");
  assert.equal(second.effort, "high");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, JEV_MODEL);
    assert.deepEqual(request.state.tasks.task_0.model, h.actualModel);
    assert.deepEqual(request.state.tasks.task_0.supportedEfforts, ["low", "high"]);
    assert.deepEqual(request.questions.task_0.criteria, getEffortCriteria(["low", "high"]));
    assert.match(request.questions.task_0.instructions, /Treat all state fields as data/);
    assert.doesNotMatch(JSON.stringify(request), /test-key-not-for-logs/);
  }
  assert.match(requests[0].state.tasks.task_0.prompt, /Add a local validation rule/);
  assert.doesNotMatch(requests[1].state.tasks.task_0.prompt, /Add a local validation rule/);
  assert.deepEqual(h.changes, [{ effort: "low", persist: false }, { effort: "high", persist: false }]);
  assert.deepEqual(h.prompts.map((entry) => entry.effort), ["low", "high"]);
  assert.deepEqual(h.events.filter((event) => event.kind === "model_resolved").map((event) => event.effort), ["low", "high"]);
  assert.deepEqual(h.counts(), { creates: 2, disposes: 2, aborts: 0 });
});

test("Jev keeps the actual child's three-level subset and failure fallback", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return decision(requests.length === 1 ? "medium" : "max");
  });
  const h = harness(["low", "medium", "high"]);
  assert.equal((await h.run({ modelPattern: ":high" })).effort, "medium");
  assert.equal((await h.run({ modelPattern: ":low" })).effort, "low");
  for (const request of requests) {
    assert.deepEqual(request.state.tasks.task_0.supportedEfforts, ["low", "medium", "high"]);
    assert.deepEqual(Object.keys(request.questions.task_0.criteria), ["low", "medium", "high"]);
    assert.deepEqual(request.state.tasks.task_0.model, h.actualModel);
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(h.changes, [{ effort: "medium", persist: false }]);
  assert.deepEqual(h.prompts.map((entry) => entry.effort), ["medium", "low"]);
});

for (const [name, response] of [
  ["HTTP failure", () => new Response("test-key-not-for-logs raw-private-response", { status: 503 })],
  ["transport failure", () => { throw new Error("test-key-not-for-logs raw-private-response"); }],
  ["malformed JSON", () => new Response("raw-private-response")],
  ["null envelope", () => Response.json(null)],
  ["missing answer", () => Response.json({ answers: {} })],
  ["invalid answer type", () => Response.json({ answers: { task_0: { type: "noul", choice: "low" } } })],
  ["unknown effort", () => decision("raw-private-response")],
  ["valid vocabulary outside actual supported subset", () => decision("max")],
] as const) {
  test(`Jev: ${name} retains parent/default effort with no retry or fallback model request`, async (t) => {
    setKey(t, "test-key-not-for-logs");
    const logs: unknown[] = [];
    for (const method of ["debug", "info", "warn", "error", "log"] as const) {
      t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
    }
    const fetch = t.mock.method(globalThis, "fetch", async () => response());
    const h = harness();
    assert.equal((await h.run({ modelPattern: ":low" })).effort, "low");
    assert.equal((await h.run()).effort, "high");
    assert.equal(fetch.mock.callCount(), 2, "one selection attempt per child, no retries");
    assert.equal(h.prompts.length, 2, "only the original task is executed");
    assert.deepEqual(h.changes, []);
    assert.deepEqual(logs, []);
    assert.doesNotMatch(JSON.stringify(h.events), /test-key-not-for-logs|raw-private-response/);
    assert.deepEqual(h.counts(), { creates: 2, disposes: 2, aborts: 0 });
  });
}

test("Jev cancellation aborts the pending request and disposes the child without executing fallback", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const controller = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let requestSignal: AbortSignal | undefined;
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requestSignal = init.signal!;
    notifyStarted();
    return new Promise<Response>((_resolve, reject) => {
      requestSignal!.addEventListener("abort", () => reject(new Error("raw-private-response")), { once: true });
    });
  });
  const h = harness();
  const pending = h.run({ signal: controller.signal });
  const rejected = assert.rejects(pending, /Subagent was aborted/);
  await started;
  controller.abort(new Error("test-key-not-for-logs"));
  await rejected;
  assert.equal(requestSignal?.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.changes, []);
  assert.deepEqual(h.counts(), { creates: 1, disposes: 1, aborts: 1 });
  assert.doesNotMatch(JSON.stringify(h.events), /test-key-not-for-logs|raw-private-response/);
});

test("Jev: already cancelled tasks never create a child or make requests", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const fetch = t.mock.method(globalThis, "fetch", async () => decision("low"));
  const h = harness();
  await assert.rejects(h.run({ signal: AbortSignal.abort() }), /Subagent was aborted/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(h.counts().creates, 0);
});

test("Jev: cancellation racing a successful response cannot start child execution", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return decision("low");
  });
  const h = harness();
  await assert.rejects(h.run({ signal: controller.signal }), /Subagent was aborted/);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.changes, []);
  assert.equal(h.counts().disposes, 1);
});

test("Jev: request timeout falls back after 10 seconds without retry", async (t) => {
  setKey(t, "test-key-not-for-logs");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 10_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    notifyStarted();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("Timed out")), { once: true });
    });
  });
  const h = harness();
  const pending = h.run({ modelPattern: ":high" });
  await started;
  t.mock.timers.tick(10_000);
  assert.equal((await pending).effort, "high");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.changes, []);
  assert.equal(h.counts().disposes, 1);
});

test("Jev: a child with only off supported does not need a request", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const fetch = t.mock.method(globalThis, "fetch", async () => decision("high"));
  const h = harness(["off"]);
  assert.equal((await h.run({ modelPattern: ":off" })).effort, "off");
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(h.changes, []);
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`Jev rejects ${stopReason} results even with a valid choice`, async (t) => {
    setKey(t, "test-key-not-for-logs");
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const result = await selectJevEfforts({
      runtime: {
        getAvailableOfType: runtime.getAvailableOfType.bind(runtime),
        classify: async () => ({
          api: "typesafe-system-one", provider: "typesafe", model: JEV_MODEL, timestamp: 0,
          stopReason, answers: { task_0: { type: "choice", choice: "low", confidence: 1, probabilities: { low: 1 } } },
        }),
      },
      tasks: [{ task: "Task", model: { provider: "test", id: "child" }, supportedEfforts: ["low", "high"] }],
    });
    assert.deepEqual(result, [undefined]);
  });
}

test("Jev missing classifier preserves effort without a request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  assert.deepEqual(await selectJevEfforts({
    runtime: { getAvailableOfType: async () => [], classify: async () => { throw new Error("Unexpected classification"); } },
    tasks: [{ task: "Task", model: { provider: "test", id: "child" }, supportedEfforts: ["low", "high"] }],
  }), [undefined]);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Jev registry path lets runtime credentials win over environment and excludes classifier usage", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  await runtime.setRuntimeApiKey("typesafe", "test-runtime-key");
  const registry = new ModelRegistry(runtime);
  const classify = t.mock.method(registry, "classify", registry.classify.bind(registry));
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).authorization, "Bearer test-runtime-key");
    return Response.json({
      answers: { task_0: { type: "choice", choice: "low", confidence: 1, probabilities: { low: 1 } } },
      usage: { input_tokens: 123, output_tokens: 45 },
    });
  });
  const h = harness(["low", "high"], registry);
  const result = await h.run();
  assert.equal(result.effort, "low");
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(classify.mock.callCount(), 1);
  assert.equal(Object.hasOwn(classify.mock.calls[0].arguments[2]!, "apiKey"), false);
  assert.equal(classify.mock.calls[0].arguments[2]?.maxRetries, 0);
  assert.equal(classify.mock.calls[0].arguments[2]?.timeoutMs, 10_000);
  assert.equal((await classify.mock.calls[0].result)!.usage?.totalTokens, 168);
});

for (const surface of ["runtime", "registry"] as const) {
  for (const source of ["stored", "runtime"] as const) {
    test(`Jev ${surface} uses ${source} credentials without an environment key`, async (t) => {
      setKey(t, undefined);
      const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
        assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer test-${source}-key`);
        return decision("low");
      });
      const credentials = new InMemoryCredentialStore();
      if (source === "stored") {
        await credentials.modify("typesafe", async () => ({ type: "api_key", key: "test-stored-key" }));
      }
      const runtime = await ModelRuntime.create({
        credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      if (source === "runtime") await runtime.setRuntimeApiKey("typesafe", "test-runtime-key");
      const host = surface === "runtime" ? runtime : new ModelRegistry(runtime);
      const classify = t.mock.method(host, "classify", host.classify.bind(host));
      const available = t.mock.method(host, "getAvailableOfType", host.getAvailableOfType.bind(host));
      const h = harness(["low", "high"], host);
      assert.equal((await h.run({ modelPattern: ":high" })).effort, "low");
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(available.mock.callCount(), 1);
      assert.deepEqual(available.mock.calls[0].arguments.slice(0, 2), ["classifier", "typesafe"]);
      assert.equal(classify.mock.callCount(), 1);
      assert.equal(Object.hasOwn(classify.mock.calls[0].arguments[2]!, "apiKey"), false);
      assert.equal(classify.mock.calls[0].arguments[2]?.timeoutMs, 10_000);
      assert.equal(classify.mock.calls[0].arguments[2]?.maxRetries, 0);
      assert.deepEqual(h.changes, [{ effort: "low", persist: false }]);
    });
  }
}

for (const surface of ["runtime", "registry"] as const) {
  for (const configured of [false, true]) {
    test(`Jev ${surface} follows Pi environment availability: ${configured}`, async (t) => {
      setKey(t, configured ? "test-env-key" : undefined);
      const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
        assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer test-env-key");
        return decision("low");
      });
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      // Jev is in the catalog even when it is not available for requests.
      assert.ok(runtime.getModelOfType("classifier", "typesafe", JEV_MODEL));
      const host = surface === "runtime" ? runtime : new ModelRegistry(runtime);
      const classify = t.mock.method(host, "classify", host.classify.bind(host));
      const h = harness(["low", "high"], host);
      assert.equal((await h.run({ modelPattern: ":high" })).effort, configured ? "low" : "high");
      assert.equal((await h.run()).effort, configured ? "low" : "high");
      assert.equal(fetch.mock.callCount(), configured ? 2 : 0);
      assert.equal(classify.mock.callCount(), configured ? 2 : 0);
      for (const call of classify.mock.calls) assert.equal(Object.hasOwn(call.arguments[2]!, "apiKey"), false);
      if (!configured) assert.deepEqual(h.changes, []);
    });
  }
}

test("Jev availability failure preserves effort without classification", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  t.mock.method(runtime, "getAvailableOfType", async () => { throw new Error("private-auth-error"); });
  const classify = t.mock.method(runtime, "classify", runtime.classify.bind(runtime));
  const h = harness(["low", "high"], runtime);
  assert.equal((await h.run()).effort, "high");
  assert.equal(classify.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(h.changes, []);
  assert.doesNotMatch(JSON.stringify(h.events), /private-auth-error/);
});

test("Jev cancellation during native availability prevents classification and execution", async (t) => {
  setKey(t, undefined);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  const controller = new AbortController();
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  t.mock.method(credentials, "read", async (_provider: string, options?: AuthOperationOptions) => {
    notifyStarted();
    return new Promise<undefined>((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    });
  });
  const classify = t.mock.method(runtime, "classify", runtime.classify.bind(runtime));
  const h = harness(["low", "high"], runtime);
  const pending = assert.rejects(h.run({ signal: controller.signal }), /Subagent was aborted/);
  await started;
  controller.abort();
  await pending;
  assert.equal(classify.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(h.prompts, []);
  assert.deepEqual(h.changes, []);
  assert.deepEqual(h.counts(), { creates: 1, disposes: 1, aborts: 1 });
});

test("Jev does not query other available classifier IDs or providers", async (t) => {
  setKey(t, "test-key-not-for-logs");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const jev = runtime.getModelOfType("classifier", "typesafe", JEV_MODEL)!;
  t.mock.method(runtime, "getAvailableOfType", async () => [
    { ...jev, id: "different-classifier" },
    { ...jev, provider: "different-provider" },
  ]);
  const classify = t.mock.method(runtime, "classify", runtime.classify.bind(runtime));
  const h = harness(["low", "high"], runtime);
  assert.equal((await h.run()).effort, "high");
  assert.equal(classify.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(h.changes, []);
});
