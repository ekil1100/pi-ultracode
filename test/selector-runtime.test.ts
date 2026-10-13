import { test, vi } from "vite-plus/test";
import { Deferred, Effect, Fiber } from "effect";
import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJevBatch, selectJevEfforts, type JevRuntime } from "../src/jev.ts";
import { getEffortCriteria } from "../src/effort-policy.ts";
import { WorkflowAgentRunner, type AgentSessionLike } from "../src/workflow/agent-runner.ts";
import { runWorkflow } from "../src/workflow/runtime.ts";

const tasks = [
  {
    task: "Local change",
    model: { provider: "child", id: "one" },
    supportedEfforts: ["low", "high"] as const,
  },
  {
    task: "Bounded implementation",
    model: { provider: "child", id: "two" },
    supportedEfforts: ["medium", "high"] as const,
  },
];
const backend = { type: "chat", provider: "judge", id: "judge/model" } as const;
function answerStream(
  text: string,
  stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop",
) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: backend.provider,
    model: backend.id,
    content: [{ type: "text", text }],
    stopReason,
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  if (stopReason === "error" || stopReason === "aborted") {
    message.errorMessage = "Selector request failed";
    stream.push({ type: "error", reason: stopReason, error: message });
  } else stream.push({ type: "done", reason: stopReason, message });
  stream.end();
  return stream;
}

function runtime(
  text: string,
  stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop",
) {
  const requests: any[] = [];
  const host = {
    getAvailableOfType: async (type: string, provider: string) => {
      assert.equal(type, "chat");
      assert.equal(provider, "judge");
      return [
        {
          provider: backend.provider,
          id: backend.id,
          reasoning: true,
          supportedThinkingLevels: ["low", "high"],
        },
      ];
    },
    streamSimple: (model: unknown, context: unknown, options: unknown) => {
      requests.push({ model, context, options });
      return answerStream(text, stopReason);
    },
    classify: async () => {
      throw new Error("Unexpected classifier call");
    },
  } as unknown as JevRuntime;
  return { host, requests };
}

test("chat selector batches distinct actual child capabilities into one request", async () => {
  const { host, requests } = runtime(
    '{"answers":{"task_0":{"type":"choice","choice":"low"},"task_1":{"type":"choice","choice":"medium"}}}',
  );
  const batch = createJevBatch(
    2,
    { meta: { name: "test" } },
    new AbortController().signal,
    backend,
  );
  assert.deepEqual(
    await Promise.all(batch.map((member, i) => member.select({ ...tasks[i], runtime: host }))),
    ["low", "medium"],
  );
  assert.equal(requests.length, 1);
  const context = JSON.parse(requests[0].context.messages[0].content);
  assert.deepEqual(context.state.tasks.task_1.model, tasks[1].model);
  assert.deepEqual(context.state.tasks.task_1.supportedEfforts, ["medium", "high"]);
  assert.equal(context.state.workflow.meta.name, "test");
  assert.equal(requests[0].options.maxRetries, 0);
});

test("chat selector validates each answer independently and retains fallback on invalid output", async () => {
  for (const text of [
    "invalid",
    "null",
    '{"answers":[]}',
    '{"answers":{"task_0":{"type":"choice","choice":"max"}}}',
  ]) {
    const { host } = runtime(text);
    assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), [
      undefined,
      undefined,
    ]);
  }
  const { host } = runtime(
    '```json\n{"answers":{"task_0":{"type":"choice","choice":"low"},"task_1":{"type":"choice","choice":"max"}}}\n```',
  );
  assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), ["low", undefined]);
});

test("chat errors, truncation and unavailable models preserve fallback without another request", async () => {
  for (const reason of ["length", "toolUse", "error", "aborted"] as const) {
    const { host, requests } = runtime(
      '{"answers":{"task_0":{"type":"choice","choice":"low"}}}',
      reason,
    );
    assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), [
      undefined,
      undefined,
    ]);
    assert.equal(requests.length, 1);
  }
  const { host, requests } = runtime("{}");
  host.streamSimple = () => {
    requests.push({});
    throw new Error("Provider secret");
  };
  assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), [
    undefined,
    undefined,
  ]);
  assert.equal(requests.length, 1);
  host.getAvailableOfType = async () => [];
  assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), [
    undefined,
    undefined,
  ]);
  assert.equal(requests.length, 1);
  host.getAvailableOfType = async () => {
    throw new Error("Provider secret");
  };
  assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend }), [
    undefined,
    undefined,
  ]);
});

test("configured classifier uses exact provider and model", async () => {
  const selected = { type: "classifier", provider: "other", id: "custom/judge" } as const;
  let calls = 0;
  const host = {
    getAvailableOfType: async (type: string, provider: string) => {
      assert.equal(type, "classifier");
      assert.equal(provider, "other");
      return [{ provider: "other", id: "custom/judge" }];
    },
    classify: async (model: unknown) => {
      calls++;
      assert.deepEqual(model, { provider: "other", id: "custom/judge" });
      return { stopReason: "stop", answers: { task_0: { type: "choice", choice: "high" } } };
    },
  } as unknown as JevRuntime;
  assert.deepEqual(await selectJevEfforts({ runtime: host, tasks, backend: selected }), [
    "high",
    undefined,
  ]);
  assert.equal(calls, 1);
});

test("chat cancellation propagates instead of starting child execution", async () => {
  const controller = new AbortController();
  const { host } = runtime("{}");
  host.streamSimple = () => {
    controller.abort();
    throw new Error("Cancelled");
  };
  await assert.rejects(
    selectJevEfforts({ runtime: host, tasks, backend, signal: controller.signal }),
    /aborted/,
  );
});

for (const surface of ["runtime", "registry"] as const) {
  for (const cancelled of [false, true]) {
    test(`native ${surface} chat selection ${cancelled ? "propagates an aborted response before child execution" : "judges one batch using actual child subsets"}`, async (t) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-chat-selector-"));
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = path.join(cwd, "pi");
      t.onTestFinished(() => {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        fs.rmSync(cwd, { recursive: true, force: true });
      });
      const controller = new AbortController();
      const host = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const requests: any[] = [];
      // Keep native availability, auth, registry delegation and stream forwarding.
      // Only replace the provider's paid request and child session execution.
      host.registerProvider(backend.provider, {
        api: "openai-completions",
        baseUrl: "https://judge.invalid/v1",
        models: [
          {
            id: backend.id,
            name: "Effort judge",
            reasoning: true,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
        streamSimple: (model, context, options) => {
          requests.push({ model, context, options });
          if (cancelled) controller.abort();
          return answerStream(
            JSON.stringify({
              answers: {
                task_1: { type: "choice", choice: "medium" },
                task_0: { type: "choice", choice: "low" },
              },
            }),
            cancelled ? "aborted" : "stop",
          );
        },
      });
      await host.setRuntimeApiKey(backend.provider, "fake-host-judge-key");
      const registry = new ModelRegistry(host);
      const selector = surface === "registry" ? registry : host;
      const stream = vi.spyOn(selector, "streamSimple");
      const available = vi.spyOn(selector, "getAvailableOfType");
      const classify = vi.spyOn(selector, "classify");
      const parentModel = { provider: "parent", id: "requested-child" };
      const parentSnapshot = structuredClone(parentModel);
      const sessions: AgentSessionLike[] = [];
      const prompts: Array<{ prompt: string; effort: string }> = [];
      const changes: Array<{ level: string; persist?: boolean }> = [];
      let disposes = 0;
      let aborts = 0;
      const runner = new WorkflowAgentRunner({
        cwd,
        modelRegistry: registry,
        modelRuntime: surface === "runtime" ? host : undefined,
        model: parentModel,
        projectTrusted: false,
        createSession: async (options) => {
          assert.deepEqual(options.model, parentModel);
          const child = tasks[sessions.length];
          const session: AgentSessionLike = {
            model: child.model,
            thinkingLevel: options.thinkingLevel!,
            supportsThinking: () => child.supportedEfforts.length > 1,
            getAvailableThinkingLevels: () => [...child.supportedEfforts],
            setThinkingLevel(level, options) {
              changes.push({ level, persist: options?.persist });
              this.thinkingLevel = level;
            },
            async prompt(prompt) {
              prompts.push({ prompt, effort: this.thinkingLevel });
            },
            async abort() {
              aborts++;
            },
            dispose() {
              disposes++;
            },
            subscribe: () => () => {},
            messages: [],
          };
          sessions.push(session);
          return { session };
        },
      });
      const script = `export const meta = { name: 'chat-selector', description: 'Check child effort selection' };
        return await parallel([
          () => agent('Local change', { label: 'first', model: ':high' }),
          () => agent('Bounded implementation', { label: 'second', model: ':high' })
        ]);`;
      const running = runWorkflow(script, {
        cwd,
        runner,
        selectorBackend: backend,
        concurrency: 1,
        signal: controller.signal,
      });
      if (cancelled) await assert.rejects(running, /aborted/);
      else await running;
      assert.equal(stream.mock.calls.length, 1);
      assert.equal(available.mock.calls.length, 1);
      assert.deepEqual(available.mock.calls[0].slice(0, 2), ["chat", backend.provider]);
      assert.equal(classify.mock.calls.length, 0);
      assert.equal(
        requests.length,
        1,
        "one provider request covers every eligible child, with no retries",
      );
      assert.equal(requests[0].options.apiKey, "fake-host-judge-key");
      assert.equal(requests[0].options.maxRetries, 0);
      assert.equal(requests[0].options.timeoutMs, 10_000);
      assert.equal(requests[0].options.reasoning, "low");
      const [judge, context, options] = stream.mock.calls[0];
      assert.equal(judge.provider, backend.provider);
      assert.equal(judge.id, backend.id);
      assert.ok(options?.signal);
      assert.equal(options.signal.aborted, cancelled);
      assert.equal(
        Object.hasOwn(options, "apiKey"),
        false,
        "native runtime owns request authentication",
      );
      const user = context.messages[0];
      assert.equal(user.role, "user");
      assert.equal(typeof user.content, "string");
      const request = JSON.parse(user.content as string);
      assert.equal(request.state.workflow.meta.name, "chat-selector");
      assert.deepEqual(Object.keys(request.questions), ["task_0", "task_1"]);
      assert.deepEqual(Object.keys(request.state.tasks), ["task_0", "task_1"]);
      for (const [i, child] of tasks.entries()) {
        const id = `task_${i}`;
        assert.deepEqual(request.state.tasks[id].model, child.model);
        assert.deepEqual(request.state.tasks[id].supportedEfforts, child.supportedEfforts);
        assert.deepEqual(request.questions[id].criteria, getEffortCriteria(child.supportedEfforts));
        assert.ok(request.state.tasks[id].prompt.includes(child.task));
        if (!cancelled) assert.equal(request.state.tasks[id].prompt, prompts[i].prompt);
      }
      assert.deepEqual(
        prompts.map((entry) => entry.effort),
        cancelled ? [] : ["low", "medium"],
      );
      assert.deepEqual(
        changes,
        cancelled
          ? []
          : [
              { level: "low", persist: false },
              { level: "medium", persist: false },
            ],
      );
      assert.equal(
        (await stream.mock.results[0].value!.result()).stopReason,
        cancelled ? "aborted" : "stop",
      );
      assert.equal(sessions.length, 2);
      assert.equal(disposes, 2);
      assert.equal(aborts, cancelled ? 2 : 0);
      assert.deepEqual(
        sessions.map((session) => session.model),
        tasks.map((child) => child.model),
      );
      assert.deepEqual(parentModel, parentSnapshot);
    });
  }
}

for (const stage of ["availability", "response"] as const) {
  test(`pending chat ${stage} forwards cancellation and releases a sealed batch`, () => {
    const controller = new AbortController();
    const started = Deferred.makeUnsafe<void>();
    const { host } = runtime("{}");
    const available = vi.spyOn(host, "getAvailableOfType");
    const stream = vi.spyOn(host, "streamSimple");
    const waitForAbort = (signal?: AbortSignal) =>
      Effect.runPromise(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
        signal,
      });
    if (stage === "availability") {
      available.mockImplementation((_type, _provider, options) => waitForAbort(options?.signal));
    } else {
      stream.mockImplementation((_model, _context, options) => {
        const response = answerStream("{}");
        vi.spyOn(response, "result").mockImplementation(() => waitForAbort(options?.signal));
        return response;
      });
    }
    const members = createJevBatch(2, {}, controller.signal, backend);
    const outcomes = Effect.all(
      members.map((member, index) =>
        Effect.tryPromise({
          try: () => member.select({ ...tasks[index], runtime: host }),
          catch: (error) => error,
        }).pipe(Effect.match({ onSuccess: (value) => value, onFailure: (error) => error })),
      ),
      { concurrency: "unbounded" },
    );
    return Effect.runPromise(
      outcomes.pipe(
        Effect.forkScoped({ startImmediately: true }),
        Effect.tap(() => Deferred.await(started)),
        Effect.tap(() => Effect.sync(() => controller.abort())),
        Effect.flatMap(Fiber.join),
        Effect.map((errors) => {
          assert.deepEqual(errors, [
            new Error("Subagent was aborted"),
            new Error("Subagent was aborted"),
          ]);
          assert.equal(errors[0], errors[1], "every member joins the same selection failure");
          assert.equal(available.mock.calls.length, 1);
          assert.equal(stream.mock.calls.length, stage === "response" ? 1 : 0);
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        }),
        Effect.ensuring(Effect.sync(() => controller.abort())),
        Effect.scoped,
      ),
    );
  }, 5_000);
}
