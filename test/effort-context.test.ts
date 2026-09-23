import { test } from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { workflowEffortContext } from "../src/workflow/effort-context.ts";
import {
  resolveModelSelection,
  WorkflowAgentRunner,
  type AgentSessionLike,
  type ModelLike,
} from "../src/workflow/agent-runner.ts";
import type { ThinkingLevel } from "../src/thinking.ts";

const threeLevel: ModelLike = {
  provider: "test", id: "three-level", reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
};
const extended: ModelLike = {
  provider: "other", id: "extended", reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};

function rows(context: string): Array<{ model: string; executionModel?: string; supportedEfforts: ThinkingLevel[] | "unknown" }> {
  return context.split("\n")
    .map((line) => line.replace(/^Default child: /, ""))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

test("parent effort context exposes exactly low/medium/high for a three-level default", () => {
  const context = workflowEffortContext({ model: threeLevel });
  assert.deepEqual(rows(context), [{ model: "test/three-level", supportedEfforts: ["low", "medium", "high"] }]);
  assert.deepEqual(rows(context)[0].supportedEfforts, getSupportedThinkingLevels(threeLevel as Model<Api>));
  assert.match(context, /Select directly within that set/);
  assert.match(context, /do not select an unsupported level and rely on clamping/);
});

test("override rows use available registered capabilities and agree with runner resolution", () => {
  const models = [extended, threeLevel, { ...threeLevel, provider: "second" }];
  const context = workflowEffortContext({ model: threeLevel, modelRegistry: { getAvailable: () => models } });
  const capabilities = rows(context);
  assert.deepEqual(capabilities[1].supportedEfforts, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(capabilities[2].supportedEfforts, ["low", "medium", "high"]);
  for (const pattern of [":low", "other/extended:max", "test/three-level:high", "second/three-level:medium"]) {
    const selection = resolveModelSelection({ pattern, defaultModel: threeLevel, models });
    const row = capabilities.find((entry) => entry.model === `${selection.model?.provider}/${selection.model?.id}`)!;
    assert.ok(row.supportedEfforts.includes(selection.thinkingLevel!));
  }
  assert.equal(resolveModelSelection({ roleModel: "other/extended", defaultModel: threeLevel, models }).model, extended);
  assert.match(context, /agentType model uses that model's row/);
  assert.throws(() => resolveModelSelection({ pattern: "three-level:low", models }), /ambiguous/);
  assert.equal(resolveModelSelection({ pattern: "unregistered:low", defaultModel: threeLevel, models }).model, threeLevel);
});

test("missing capability metadata is unknown, while non-reasoning and empty sets stay distinct", () => {
  const unknown = { provider: "test", id: "unknown" };
  const disabled = { ...threeLevel, id: "disabled", reasoning: false };
  const empty = { ...threeLevel, id: "empty", thinkingLevelMap: {
    off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null,
  } };
  assert.deepEqual(rows(workflowEffortContext({ modelRegistry: { getAvailable: () => [unknown, disabled, empty] } })), [
    { model: "test/unknown", supportedEfforts: "unknown" },
    { model: "test/disabled", supportedEfforts: ["off"] },
    { model: "test/empty", supportedEfforts: [] },
  ]);
  const context = workflowEffortContext({ modelRegistry: { getAvailable: () => [extended] } });
  assert.match(context, /Default child: unknown/);
  assert.match(context, /when capabilities are unknown, omit an automatic effort suffix/);
  assert.match(context, /unmatched patterns currently retain the default model/);
});

test("host runtime capability remapping matches execution and does not borrow missing metadata", () => {
  const runtime = { getModel: () => threeLevel };
  assert.deepEqual(rows(workflowEffortContext({ model: extended }, runtime)), [{
    model: "other/extended", executionModel: "test/three-level", supportedEfforts: ["low", "medium", "high"],
  }]);
  assert.deepEqual(rows(workflowEffortContext({ model: extended }, {
    getModel: () => ({ provider: "other", id: "extended" }),
  }))[0].supportedEfforts, "unknown");
});

test("capability snapshot refreshes registry contents without remote discovery", () => {
  let models = [threeLevel];
  const context = { modelRegistry: { getAvailable: () => models } };
  assert.equal(rows(workflowEffortContext(context))[0].model, "test/three-level");
  models = [extended];
  assert.equal(rows(workflowEffortContext(context))[0].model, "other/extended");
  assert.equal(rows(workflowEffortContext(context)).length, 1);
});

test("three-level parent suffixes execute unchanged without clamping or selection requests", async (t) => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected request"); });
  const allowed = rows(workflowEffortContext({ model: threeLevel }))[0].supportedEfforts as ThinkingLevel[];
  const received: Array<ThinkingLevel | undefined> = [];
  let prompts = 0;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(), model: threeLevel,
    createSession: async (options) => {
      assert.equal(options.model, threeLevel);
      received.push(options.thinkingLevel);
      if (options.thinkingLevel !== undefined) assert.ok(allowed.includes(options.thinkingLevel));
      const session: AgentSessionLike = {
        model: threeLevel,
        thinkingLevel: options.thinkingLevel ?? "medium",
        supportsThinking: () => true,
        getAvailableThinkingLevels: () => allowed,
        setThinkingLevel: () => { throw new Error("Unexpected effort mutation"); },
        prompt: async () => { prompts++; },
        abort: async () => {}, dispose: () => {}, subscribe: () => () => {}, messages: [],
      };
      return { session };
    },
  });
  for (const effort of allowed) {
    assert.equal((await runner.run({ label: "task", prompt: "Assigned task", modelPattern: `:${effort}` })).effort, effort);
  }
  assert.equal((await runner.run({ label: "default", prompt: "Assigned task" })).effort, "medium");
  assert.deepEqual(received, ["low", "medium", "high", undefined]);
  assert.equal(prompts, 4);
  assert.equal(fetch.mock.callCount(), 0);
});
