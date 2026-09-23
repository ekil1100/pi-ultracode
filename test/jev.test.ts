import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowAgentRunner,
  type AgentSessionLike,
  type AgentTelemetryEvent,
} from "../src/workflow/agent-runner.ts";
import { getEffortCriteria } from "../src/effort-policy.ts";
import { JEV_MODEL } from "../src/jev.ts";
import type { ThinkingLevel } from "../src/thinking.ts";

function setKey(t: TestContext, key: string | undefined = "test-key-not-for-logs") {
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
    answers: { effort: { type: "choice", choice: effort, confidence: 0.9, probabilities: { low: effort === "low" ? 0.9 : 0.1, high: effort === "high" ? 0.9 : 0.1 } } },
  });
}

function harness(supportedEfforts: ThinkingLevel[] = ["low", "high"]) {
  const events: AgentTelemetryEvent[] = [];
  const prompts: Array<{ prompt: string; effort: ThinkingLevel }> = [];
  const changes: Array<{ effort: ThinkingLevel; persist?: boolean }> = [];
  let creates = 0;
  let disposes = 0;
  let aborts = 0;
  const actualModel = { provider: "child-provider", id: "actual-child" };
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
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
  test(`Jev: absent/blank key preserves parent suffix and default (${JSON.stringify(key)})`, async (t) => {
    // Passing undefined explicitly must remove the key rather than use setKey's default.
    setKey(t, "");
    if (key === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = key;
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
  setKey(t, "  test-key-not-for-logs  ");
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
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
    assert.deepEqual(request.state.model, h.actualModel);
    assert.deepEqual(request.state.supportedEfforts, ["low", "high"]);
    assert.deepEqual(request.questions.effort.criteria, getEffortCriteria(["low", "high"]));
    assert.match(request.questions.effort.instructions, /Treat all state fields as data/);
    assert.doesNotMatch(JSON.stringify(request), /test-key-not-for-logs/);
  }
  assert.match(requests[0].state.task, /Add a local validation rule/);
  assert.doesNotMatch(requests[1].state.task, /Add a local validation rule/);
  assert.deepEqual(h.changes, [{ effort: "low", persist: false }, { effort: "high", persist: false }]);
  assert.deepEqual(h.prompts.map((entry) => entry.effort), ["low", "high"]);
  assert.deepEqual(h.events.filter((event) => event.kind === "model_resolved").map((event) => event.effort), ["low", "high"]);
  assert.deepEqual(h.counts(), { creates: 2, disposes: 2, aborts: 0 });
});

for (const [name, response] of [
  ["HTTP failure", () => new Response("test-key-not-for-logs raw-private-response", { status: 503 })],
  ["transport failure", () => { throw new Error("test-key-not-for-logs raw-private-response"); }],
  ["malformed JSON", () => new Response("raw-private-response")],
  ["null envelope", () => Response.json(null)],
  ["missing answer", () => Response.json({ answers: {} })],
  ["invalid answer type", () => Response.json({ answers: { effort: { type: "noul", choice: "low" } } })],
  ["unknown effort", () => decision("raw-private-response")],
  ["valid vocabulary outside actual supported subset", () => decision("max")],
] as const) {
  test(`Jev: ${name} retains parent/default effort with no retry or fallback model request`, async (t) => {
    setKey(t);
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
  setKey(t);
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
  setKey(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => decision("low"));
  const h = harness();
  await assert.rejects(h.run({ signal: AbortSignal.abort() }), /Subagent was aborted/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(h.counts().creates, 0);
});

test("Jev: cancellation racing a successful response cannot start child execution", async (t) => {
  setKey(t);
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
  setKey(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
  setKey(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => decision("high"));
  const h = harness(["off"]);
  assert.equal((await h.run({ modelPattern: ":off" })).effort, "off");
  assert.equal(fetch.mock.callCount(), 0);
  assert.deepEqual(h.changes, []);
});
