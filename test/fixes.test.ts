import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  WorkflowAgentRunner,
  createWorkflowChildResourceLoader,
  resolveModelSelection,
  matchModelIn,
  splitThinkingSuffix,
  resolveSessionThinkingLevel,
  type AgentSessionLike,
  type ThinkingLevel,
} from "../src/workflow/agent-runner.ts";
import {
  writeRescuePatch,
  applyPatch,
  captureWorktreeDiff,
  createWorktree,
  removeWorktree,
  patchTmpPath,
  verifyAppliedPatch,
} from "../src/workflow/worktree.ts";

const MODELS = [
  { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
  { provider: "anthropic", id: "claude-opus", name: "Opus" },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
];
const DEFAULT = { provider: "anthropic", id: "claude-opus", name: "Opus" };

function fakeSession(overrides: Partial<AgentSessionLike> = {}): AgentSessionLike {
  return {
    thinkingLevel: "medium",
    supportsThinking: () => true,
    prompt: async () => {},
    abort: async () => {},
    subscribe: () => () => {},
    dispose: () => {},
    messages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// C1: a bare ":level" pattern must keep the default model, only override thinking.
// Regression: previously matchModel("") matched every model because
// "any-id".includes("") === true, silently returning the FIRST registered model.
// ---------------------------------------------------------------------------

test("splitThinkingSuffix: bare :level yields empty base", () => {
  const a = splitThinkingSuffix(":high");
  assert.equal(a.base, "");
  assert.equal(a.thinking, "high");
  const b = splitThinkingSuffix("anthropic/claude-sonnet:high");
  assert.equal(b.base, "anthropic/claude-sonnet");
  assert.equal(b.thinking, "high");
  const c = splitThinkingSuffix("gpt-5.6-sol:max");
  assert.equal(c.base, "gpt-5.6-sol");
  assert.equal(c.thinking, "max");
  const d = splitThinkingSuffix("sonnet");
  assert.equal(d.base, "sonnet");
  assert.equal(d.thinking, undefined);
});

test("splitThinkingSuffix: trailing colon (empty suffix) strips to a matchable base", () => {
  // Regression: "sonnet:" used to keep base "sonnet:" (no match -> default model).
  const r = splitThinkingSuffix("sonnet:");
  assert.equal(r.base, "sonnet");
  assert.equal(r.thinking, undefined);
});

test("splitThinkingSuffix: unknown suffix (e.g. 'groq:llama') is left intact", () => {
  // A colon in a model id that isn't a thinking suffix keeps the whole string.
  const r = splitThinkingSuffix("groq:llama");
  assert.equal(r.base, "groq:llama");
  assert.equal(r.thinking, undefined);
});

test("resolveModelSelection: bare :high keeps the default model, only overrides thinking", () => {
  const r = resolveModelSelection({ pattern: ":high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model, DEFAULT, "default model is kept for empty-base :level pattern");
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: no pattern and no role falls back to defaults", () => {
  const r = resolveModelSelection({
    defaultModel: DEFAULT,
    defaultThinking: "medium" as ThinkingLevel,
    models: MODELS,
  });
  assert.equal(r.model, DEFAULT);
  assert.equal(r.thinkingLevel, "medium");
});

test("resolveModelSelection: real pattern matches and applies the max thinking suffix", () => {
  const r = resolveModelSelection({ pattern: "sonnet:max", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model?.id, "claude-sonnet");
  assert.equal(r.thinkingLevel, "max");
});

test("resolveModelSelection: whitespace-padded pattern still matches (trim)", () => {
  // Regression: lower was untrimmed, so " sonnet " matched nothing -> default.
  const r = resolveModelSelection({ pattern: " sonnet :high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model?.id, "claude-sonnet");
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: unmatched pattern falls back to the default model", () => {
  const r = resolveModelSelection({ pattern: "nope:high", defaultModel: DEFAULT, models: MODELS });
  assert.equal(r.model, DEFAULT);
  assert.equal(r.thinkingLevel, "high");
});

test("resolveModelSelection: an exact model id ending in :max stays literal", () => {
  const base = { provider: "ollama", id: "coder", name: "Coder" };
  const literal = { provider: "ollama", id: "coder:max", name: "Coder Max Tag" };
  const r = resolveModelSelection({
    pattern: "ollama/coder:max",
    defaultModel: base,
    defaultThinking: "medium",
    models: [base, literal],
  });
  assert.equal(r.model, literal);
  assert.equal(r.thinkingLevel, "medium", "literal id does not imply an effort override");

  const withoutRegistry = resolveModelSelection({
    pattern: "ollama/coder:max",
    defaultModel: literal,
    defaultThinking: "low",
  });
  assert.equal(withoutRegistry.model, literal, "the default model is an exact-match candidate");
  assert.equal(withoutRegistry.thinkingLevel, "low");
});

test("resolveModelSelection: role model/thinking are used when no per-call pattern is given", () => {
  const r = resolveModelSelection({
    roleModel: "gpt-4o",
    roleThinking: "low" as ThinkingLevel,
    defaultModel: DEFAULT,
    models: MODELS,
  });
  assert.equal(r.model?.id, "gpt-4o");
  assert.equal(r.thinkingLevel, "low");
});

test("matchModelIn: empty/whitespace pattern does not match (returns undefined, not first)", () => {
  assert.equal(matchModelIn(MODELS, ""), undefined);
  assert.equal(matchModelIn(MODELS, "   "), undefined);
  assert.equal(matchModelIn(undefined, "sonnet"), undefined);
  assert.equal(matchModelIn(MODELS, " sonnet ")?.id, "claude-sonnet", "whitespace-padded matches");
  assert.equal(matchModelIn(MODELS, "sonnet")?.id, "claude-sonnet");
  assert.equal(matchModelIn(MODELS, "anthropic/claude-opus")?.id, "claude-opus");
});

test("bare exact model ids reject ambiguity across available providers", () => {
  const duplicated = [
    { provider: "alpha", id: "shared-model", name: "Alpha Shared" },
    { provider: "beta", id: "shared-model", name: "Beta Shared" },
  ];
  assert.throws(
    () => matchModelIn(duplicated, "shared-model"),
    /ambiguous.*alpha\/shared-model.*beta\/shared-model.*provider\/model/i,
  );
  assert.equal(matchModelIn(duplicated, "beta/shared-model"), duplicated[1]);
  assert.throws(
    () => resolveModelSelection({
      pattern: "shared-model:high",
      defaultModel: DEFAULT,
      models: duplicated,
    }),
    /ambiguous.*provider\/model/i,
    "a thinking suffix must not turn an ambiguous exact id into a catalog-order choice",
  );
});

test("resolveSessionThinkingLevel uses max only when the model advertises it", () => {
  const maxModel = {
    ...DEFAULT,
    thinkingLevelMap: { max: "max" },
  };
  assert.equal(resolveSessionThinkingLevel("max", maxModel), "max");
  assert.equal(resolveSessionThinkingLevel("max", { ...DEFAULT, thinkingLevelMap: { max: null } }), "xhigh");
  assert.equal(resolveSessionThinkingLevel("max", DEFAULT), "xhigh");
  assert.equal(resolveSessionThinkingLevel("max", undefined), "max");
  assert.equal(resolveSessionThinkingLevel("high", DEFAULT), "high");
});

test("workflow child resources exclude ambient orchestrators without dropping ordinary context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-child-resources-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const extensionDir = path.join(agentDir, "extensions");
  const orchestratorSkillDir = path.join(agentDir, "skills", "pi-subagents");
  const ordinarySkillDir = path.join(agentDir, "skills", "ordinary");
  const marker = "__ultracodeAmbientExtensionProbe";

  try {
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.mkdirSync(orchestratorSkillDir, { recursive: true });
    fs.mkdirSync(ordinarySkillDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "ambient.ts"),
      `export default function () { globalThis.${marker} = true; }\n`,
    );
    fs.writeFileSync(
      path.join(orchestratorSkillDir, "SKILL.md"),
      "---\nname: pi-subagents\ndescription: Parent-only orchestration.\n---\nDo not load.\n",
    );
    fs.writeFileSync(
      path.join(ordinarySkillDir, "SKILL.md"),
      "---\nname: ordinary\ndescription: Ordinary child guidance.\n---\nKeep this skill.\n",
    );
    const contextPath = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(contextPath, "Project child context.\n");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "SYSTEM.md"), "UNTRUSTED PROJECT SYSTEM\n");
    delete (globalThis as Record<string, unknown>)[marker];

    const loader = await createWorkflowChildResourceLoader({ cwd, agentDir, projectTrusted: false });

    assert.equal(
      (globalThis as Record<string, unknown>)[marker],
      undefined,
      "ambient extension factories must never run in workflow children",
    );
    assert.deepEqual(loader.getExtensions().extensions, []);
    assert.equal(loader.getSystemPrompt(), undefined, "untrusted project system prompts stay hidden");
    const skillNames = loader.getSkills().skills.map((skill) => skill.name);
    assert.ok(skillNames.includes("ordinary"), "ordinary user skills remain available");
    assert.equal(skillNames.includes("pi-subagents"), false, "parent-only orchestration skill is hidden");
    assert.ok(
      loader.getAgentsFiles().agentsFiles.some((file) => file.path === contextPath),
      "AGENTS context remains available under Pi's trust contract",
    );

    const trustedLoader = await createWorkflowChildResourceLoader({ cwd, agentDir, projectTrusted: true });
    assert.equal(trustedLoader.getSystemPrompt(), "UNTRUSTED PROJECT SYSTEM\n");
  } finally {
    delete (globalThis as Record<string, unknown>)[marker];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowAgentRunner separates execution cwd from project resource discovery", async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resource-project-"));
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "uc-resource-isolated-"));
  let sessionOptions: Record<string, any> | undefined;
  try {
    const messages: unknown[] = [];
    const runner = new WorkflowAgentRunner({
      cwd: project,
      createSession: async (options) => {
        sessionOptions = options;
        return {
          session: fakeSession({
            messages,
            prompt: async () => {
              messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
            },
          }),
        };
      },
    });
    await runner.run({ prompt: "inspect", label: "isolated", cwd: isolated });
    assert.equal(sessionOptions?.cwd, isolated, "tools execute in the isolated worktree");
    assert.equal(
      sessionOptions?.settingsManager?.storage?.projectSettingsPath,
      path.join(project, ".pi", "settings.json"),
      "project settings and context retain the original project identity",
    );
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});

test("WorkflowAgentRunner enforces the Explore read-only tool allowlist", async () => {
  const sessionOptions: Array<Record<string, any>> = [];
  const messages: unknown[] = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async (options) => {
      sessionOptions.push(options);
      return {
        session: fakeSession({
          messages,
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
          },
        }),
      };
    },
  });
  await runner.run({
    prompt: "inspect",
    label: "explore",
    agentTypeDef: {
      name: "Explore",
      description: "read only",
      systemPrompt: "Do not modify files.",
      systemPromptMode: "append",
      tools: ["read", "grep", "find", "ls"],
      source: "builtin",
    },
  });
  assert.deepEqual(sessionOptions[0].tools, ["read", "grep", "find", "ls"]);
  assert.equal(sessionOptions[0].tools.includes("bash"), false);
  assert.equal(sessionOptions[0].tools.includes("edit"), false);
  assert.equal(sessionOptions[0].tools.includes("write"), false);
});

test("WorkflowAgentRunner enforces the Plan read-only tool allowlist", async () => {
  const sessionOptions: Array<Record<string, any>> = [];
  const messages: unknown[] = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async (options) => {
      sessionOptions.push(options);
      return {
        session: fakeSession({
          messages,
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
          },
        }),
      };
    },
  });
  await runner.run({
    prompt: "design",
    label: "plan",
    agentTypeDef: {
      name: "Plan",
      description: "read only architect",
      systemPrompt: "Do not modify files.",
      systemPromptMode: "append",
      tools: ["read", "grep", "find", "ls"],
      source: "builtin",
    },
  });
  assert.deepEqual(sessionOptions[0].tools, ["read", "grep", "find", "ls"]);
  assert.equal(sessionOptions[0].tools.includes("bash"), false);
  assert.equal(sessionOptions[0].tools.includes("edit"), false);
  assert.equal(sessionOptions[0].tools.includes("write"), false);
});

test("production WorkflowAgentRunner wires sealed resources into the real Pi session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uc-production-child-resources-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const extensionDir = path.join(agentDir, "extensions");

  try {
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "ambient.ts"),
      "export default function () { globalThis.__ultracodeProductionWireProbe = true; }\n",
    );

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const runnerModuleUrl = new URL("../src/workflow/agent-runner.ts", import.meta.url).href;
    const script = `
      import { WorkflowAgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const controller = new AbortController();
      let sessionCreated = false;
      let error = '';
      try {
        await new WorkflowAgentRunner({ cwd: process.env.PROBE_CWD }).run({
          prompt: 'probe',
          label: 'production wire',
          signal: controller.signal,
          onTelemetry(event) {
            if (event.kind === 'model_resolved') {
              sessionCreated = true;
              controller.abort();
            }
          },
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      console.log(JSON.stringify({
        extensionLoaded: globalThis.__ultracodeProductionWireProbe === true,
        sessionCreated,
        error,
      }));
    `;
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "--eval", script],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PROBE_CWD: cwd,
        },
      },
    );
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1)!) as {
      extensionLoaded: boolean;
      sessionCreated: boolean;
      error: string;
    };

    assert.equal(result.sessionCreated, true, "the real Pi session must be created before the probe aborts");
    assert.equal(result.extensionLoaded, false, "production wiring must not initialize ambient extensions");
    assert.match(result.error, /Subagent was aborted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WorkflowAgentRunner shares one modern model runtime and replays public registry state", async () => {
  const runtimeModel = { ...DEFAULT, name: "Runtime Opus" };
  const providerConfig = { baseUrl: "https://proxy.example.test" };
  const registered: Array<[string, unknown]> = [];
  const refreshed: unknown[] = [];
  const runtimeKeys: Array<[string, string]> = [];
  const runtime = {
    getModel: (provider: string, id: string) =>
      provider === runtimeModel.provider && id === runtimeModel.id ? runtimeModel : undefined,
    registerProvider: (provider: string, config: unknown) => registered.push([provider, config]),
    refresh: async (options?: unknown) => { refreshed.push(options); },
    setRuntimeApiKey: async (provider: string, apiKey: string) => {
      runtimeKeys.push([provider, apiKey]);
    },
  };
  const apiKeyReads: string[] = [];
  const registry = {
    getAvailable: () => [DEFAULT, { provider: "custom", id: "custom-model" }],
    getRegisteredProviderIds: () => ["custom"],
    getRegisteredProviderConfig: (provider: string) => provider === "custom" ? providerConfig : undefined,
    getProviderAuthStatus: (provider: string) => ({
      configured: true,
      source: provider === "anthropic" ? "runtime" : "stored",
    }),
    getApiKeyForProvider: async (provider: string) => {
      apiKeyReads.push(provider);
      return provider === "anthropic" ? "runtime-secret" : "must-not-copy";
    },
  };
  let runtimeCreations = 0;
  const sessionOptions: Array<Record<string, unknown>> = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    model: DEFAULT,
    modelRegistry: registry,
    createModelRuntime: async (paths) => {
      runtimeCreations++;
      assert.match(paths.authPath, /auth\.json$/);
      assert.match(paths.modelsPath, /models\.json$/);
      assert.equal(paths.allowModelNetwork, false, "child runtime initialization stays offline");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return runtime;
    },
    createSession: async (options) => {
      sessionOptions.push(options);
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          model: runtimeModel,
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
          },
          messages,
        }),
      };
    },
  });

  await Promise.all([
    runner.run({ prompt: "one", label: "one" }),
    runner.run({ prompt: "two", label: "two" }),
  ]);

  assert.equal(runtimeCreations, 1, "parallel agents share the in-flight runtime initialization");
  assert.equal(sessionOptions.length, 2);
  for (const options of sessionOptions) {
    assert.equal(options.modelRuntime, runtime);
    assert.equal("modelRegistry" in options, false, "modern sessions never receive the removed option");
    assert.equal(options.model, runtimeModel, "the selected model is rebound to the target runtime");
    assert.deepEqual(
      options.excludeTools,
      ["workflow", "subagent", "subagent_wait"],
      "workflow children cannot launch any orchestration tool",
    );
  }
  assert.deepEqual(registered, [["custom", providerConfig]]);
  assert.deepEqual(refreshed, [{ allowNetwork: false }]);
  assert.deepEqual(apiKeyReads, ["anthropic"], "only runtime-sourced auth is copied");
  assert.deepEqual(runtimeKeys, [["anthropic", "runtime-secret"]]);
});

test("WorkflowAgentRunner replays native providers into the child model runtime", async () => {
  const parentModel = { provider: "native-test", id: "native-model", name: "Parent Native" };
  const runtimeModel = { ...parentModel, name: "Child Native" };
  const nativeProvider = { id: "native-test", name: "Native Test Provider" };
  const registeredNativeProviders: unknown[] = [];
  const refreshed: unknown[] = [];
  let nativeRegistered = false;
  const runtime = {
    getModel: (provider: string, id: string) =>
      nativeRegistered && provider === runtimeModel.provider && id === runtimeModel.id
        ? runtimeModel
        : undefined,
    registerNativeProvider: (provider: unknown) => {
      registeredNativeProviders.push(provider);
      nativeRegistered = true;
    },
    refresh: async (options?: unknown) => { refreshed.push(options); },
  };
  const registry = {
    getAvailable: () => [parentModel],
    getRegisteredProviderIds: () => [nativeProvider.id],
    getRegisteredNativeProvider: (provider: string) =>
      provider === nativeProvider.id ? nativeProvider : undefined,
    getRegisteredProviderConfig: () => undefined,
  };
  const sessionOptions: Array<Record<string, unknown>> = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    model: parentModel,
    modelRegistry: registry,
    createModelRuntime: async () => runtime,
    createSession: async (options) => {
      sessionOptions.push(options);
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          model: runtimeModel,
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "native" }] });
          },
          messages,
        }),
      };
    },
  });

  const result = await runner.run({ prompt: "test", label: "native provider" });

  assert.equal(result.value, "native");
  assert.deepEqual(registeredNativeProviders, [nativeProvider]);
  assert.deepEqual(refreshed, [{ allowNetwork: false }]);
  assert.equal(sessionOptions[0].model, runtimeModel, "the model is rebound after native provider replay");
});

test("WorkflowAgentRunner retains the legacy registry option when ModelRuntime is unavailable", async () => {
  const sessionOptions: Array<Record<string, unknown>> = [];
  const registry = { getAvailable: () => [DEFAULT] };
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    model: DEFAULT,
    modelRegistry: registry,
    createModelRuntime: async () => undefined,
    createSession: async (options) => {
      sessionOptions.push(options);
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "legacy" }] });
          },
          messages,
        }),
      };
    },
  });

  const result = await runner.run({ prompt: "test", label: "legacy registry" });
  assert.equal(result.value, "legacy");
  assert.equal(sessionOptions[0].modelRegistry, registry);
  assert.equal("modelRuntime" in sessionOptions[0], false);
});

test("WorkflowAgentRunner shares a concurrent runtime failure but retries later", async () => {
  let runtimeCreations = 0;
  let sessionCreations = 0;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createModelRuntime: async () => {
      runtimeCreations++;
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (runtimeCreations === 1) throw new Error("runtime init failed");
      return {};
    },
    createSession: async () => {
      sessionCreations++;
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "recovered" }] });
          },
          messages,
        }),
      };
    },
  });

  const settled = await Promise.allSettled([
    runner.run({ prompt: "one", label: "one" }),
    runner.run({ prompt: "two", label: "two" }),
  ]);
  assert.equal(runtimeCreations, 1);
  assert.equal(sessionCreations, 0);
  assert.ok(settled.every((result) => result.status === "rejected" && /runtime init failed/.test(String(result.reason))));

  const recovered = await runner.run({ prompt: "retry", label: "retry" });
  assert.equal(runtimeCreations, 2, "a transient initialization failure must not poison the runner");
  assert.equal(sessionCreations, 1);
  assert.equal(recovered.value, "recovered");
});

test("WorkflowAgentRunner cancels one runtime waiter without cancelling shared initialization", async () => {
  let releaseRuntime!: (runtime: object) => void;
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const runtimePending = new Promise<object>((resolve) => { releaseRuntime = resolve; });
  let runtimeCreations = 0;
  let sessionCreations = 0;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createModelRuntime: async () => {
      runtimeCreations++;
      markEntered();
      return runtimePending;
    },
    createSession: async () => {
      sessionCreations++;
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "shared" }] });
          },
          messages,
        }),
      };
    },
  });
  const controller = new AbortController();
  const cancelled = runner.run({ prompt: "cancel", label: "cancel", signal: controller.signal });
  await entered;
  controller.abort();

  let cancellationTimeout: ReturnType<typeof setTimeout> | undefined;
  const cancellationResult = await Promise.race([
    cancelled.then(
      () => new Error("cancelled run unexpectedly resolved"),
      (error) => error,
    ),
    new Promise<Error>((resolve) => {
      cancellationTimeout = setTimeout(() => resolve(new Error("cancellation timed out")), 100);
    }),
  ]);
  if (cancellationTimeout) clearTimeout(cancellationTimeout);
  releaseRuntime({});
  await cancelled.catch(() => {});

  assert.match(String(cancellationResult), /Subagent was aborted/);
  assert.equal(sessionCreations, 0, "the cancelled waiter never creates a session");
  const result = await runner.run({ prompt: "reuse", label: "reuse" });
  assert.equal(result.value, "shared", "the completed shared runtime remains reusable");
  assert.equal(runtimeCreations, 1, "cancelling a waiter does not restart shared initialization");
  assert.equal(sessionCreations, 1);
});

test("WorkflowAgentRunner lets a max-capable default model keep max", async () => {
  const createdLevels: unknown[] = [];
  const messages: unknown[] = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    thinkingLevel: "max",
    createSession: async (options) => {
      createdLevels.push(options.thinkingLevel);
      return {
        session: fakeSession({
          thinkingLevel: "max",
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "max" }] });
          },
          messages,
        }),
      };
    },
  });
  const result = await runner.run({ prompt: "test", label: "default max" });
  assert.equal(result.value, "max");
  assert.deepEqual(createdLevels, ["max"]);
});

test("WorkflowAgentRunner avoids rebuilding a current-Pi default model that clamps max", async () => {
  const currentLevels: unknown[] = [];
  const messages: unknown[] = [];
  const currentRunner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    thinkingLevel: "max",
    supportsMaxThinking: true,
    createSession: async (options) => {
      currentLevels.push(options.thinkingLevel);
      return {
        session: fakeSession({
          thinkingLevel: "xhigh",
          model: { ...DEFAULT, thinkingLevelMap: { xhigh: "xhigh" } },
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "xhigh" }] });
          },
          messages,
        }),
      };
    },
  });
  const current = await currentRunner.run({ prompt: "test", label: "current clamp" });
  assert.equal(current.value, "xhigh");
  assert.deepEqual(currentLevels, ["max"], "normal model clamp does not rebuild the session");

  const legacyLevels: unknown[] = [];
  const legacyRunner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    thinkingLevel: "max",
    supportsMaxThinking: false,
    createSession: async (options) => {
      const index = legacyLevels.length;
      legacyLevels.push(options.thinkingLevel);
      return {
        session: fakeSession({
          thinkingLevel: index === 0 ? "medium" : "xhigh",
        }),
      };
    },
  });
  await legacyRunner.run({ prompt: "test", label: "legacy default" });
  assert.deepEqual(legacyLevels, ["max", "xhigh"], "pre-max Pi still receives the compatibility retry");
});

test("WorkflowAgentRunner retries xhigh when a legacy runtime clamps max to medium", async () => {
  const createdLevels: unknown[] = [];
  const disposed: number[] = [];
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    model: { ...DEFAULT, thinkingLevelMap: { max: "max" } },
    thinkingLevel: "max",
    createSession: async (options) => {
      const index = createdLevels.length;
      createdLevels.push(options.thinkingLevel);
      const messages: unknown[] = [];
      return {
        session: fakeSession({
          thinkingLevel: index === 0 ? "medium" : "xhigh",
          prompt: async () => {
            messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
          },
          dispose: () => {
            disposed.push(index);
            if (index === 0) throw new Error("provisional cleanup failed");
          },
          messages,
          getSessionStats: () => ({ tokens: { output: 1, total: 1 }, cost: 0 }),
        }),
      };
    },
  });

  const result = await runner.run({ prompt: "test", label: "legacy" });
  assert.equal(result.value, "done");
  assert.deepEqual(createdLevels, ["max", "xhigh"]);
  assert.deepEqual(disposed, [0, 1], "both provisional and final sessions are disposed");
});

test("WorkflowAgentRunner does not prompt when aborted during session creation", async () => {
  const controller = new AbortController();
  let release!: (created: { session: AgentSessionLike }) => void;
  let markSessionCreationStarted!: () => void;
  const sessionCreationStarted = new Promise<void>((resolve) => {
    markSessionCreationStarted = resolve;
  });
  let promptCalls = 0;
  let disposeCalls = 0;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: () => new Promise((resolve) => {
      release = resolve;
      markSessionCreationStarted();
    }),
  });
  const session = fakeSession({
    prompt: async () => {
      promptCalls++;
    },
    dispose: () => {
      disposeCalls++;
    },
  });

  const pending = runner.run({ prompt: "test", label: "abort", signal: controller.signal });
  await sessionCreationStarted;
  controller.abort();
  release({ session });
  await assert.rejects(pending, /Subagent was aborted/);
  assert.equal(promptCalls, 0);
  assert.equal(disposeCalls, 1);
});

test("WorkflowAgentRunner aborts after asynchronous prompt preflight without streaming", async () => {
  const controller = new AbortController();
  let enteredPreflight!: () => void;
  let releasePreflight!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredPreflight = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releasePreflight = resolve;
  });
  let streamCalled = false;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async () => ({
      session: fakeSession({
        prompt: async (_prompt, options) => {
          enteredPreflight();
          await gate;
          options?.preflightResult?.(true);
          streamCalled = true;
        },
      }),
    }),
  });

  const pending = runner.run({ prompt: "test", label: "preflight", signal: controller.signal });
  await entered;
  controller.abort();
  releasePreflight();
  await assert.rejects(pending, /Subagent was aborted/);
  assert.equal(streamCalled, false);
});

test("WorkflowAgentRunner waits for an in-flight abort before disposal", async () => {
  const controller = new AbortController();
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve;
  });
  let disposed = false;
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async () => ({
      session: fakeSession({
        prompt: async () => {
          controller.abort();
          throw new Error("prompt failed");
        },
        abort: () => abortGate,
        dispose: () => {
          disposed = true;
        },
      }),
    }),
  });

  const pending = runner.run({ prompt: "test", label: "abort wait", signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, "abort teardown is still pending");
  releaseAbort();
  await assert.rejects(pending, /prompt failed/);
  assert.equal(disposed, true);
});

test("WorkflowAgentRunner preserves a prompt error when final cleanup also fails", async () => {
  const runner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async () => ({
      session: fakeSession({
        prompt: async () => {
          throw new Error("prompt failed");
        },
        dispose: () => {
          throw new Error("cleanup failed");
        },
      }),
    }),
  });

  await assert.rejects(
    runner.run({ prompt: "test", label: "cleanup" }),
    /prompt failed/,
  );
});

test("WorkflowAgentRunner contains abort rejection and preserves reject(undefined)", async () => {
  const controller = new AbortController();
  const abortingRunner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async () => ({
      session: fakeSession({
        prompt: async () => {
          controller.abort();
          await Promise.resolve();
        },
        abort: async () => {
          throw new Error("abort cleanup failed");
        },
      }),
    }),
  });
  await assert.rejects(
    abortingRunner.run({ prompt: "test", label: "abort rejection", signal: controller.signal }),
    /Subagent was aborted/,
  );

  let disposed = false;
  const undefinedRunner = new WorkflowAgentRunner({
    cwd: process.cwd(),
    createSession: async () => ({
      session: fakeSession({
        prompt: () => Promise.reject(undefined),
        subscribe: () => () => {
          throw new Error("unsubscribe failed");
        },
        dispose: () => {
          disposed = true;
          throw new Error("must not replace primary failure");
        },
      }),
    }),
  });
  let rejected = false;
  let reason: unknown = "not set";
  try {
    await undefinedRunner.run({
      prompt: "test",
      label: "undefined rejection",
      onActivity: () => {},
    });
  } catch (error) {
    rejected = true;
    reason = error;
  }
  assert.equal(rejected, true);
  assert.equal(reason, undefined);
  assert.equal(disposed, true, "unsubscribe failure cannot skip session disposal");
});

// ---------------------------------------------------------------------------
// H1: a patch that cannot be auto-applied is persisted to disk so the agent's
// work is recoverable, while the shared tree and index remain untouched.
// ---------------------------------------------------------------------------

test("writeRescuePatch: persists the patch with a sanitized filename and trailing newline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue-"));
  try {
    const p = writeRescuePatch(dir, "wf_run1", 1, "my agent", "diff --git a/x b/x\n+hello");
    assert.ok(fs.existsSync(p), "rescue patch file was written");
    assert.ok(p.endsWith(".patch"));
    assert.match(path.basename(p), /-1-/, "filename includes the agent id");
    assert.doesNotMatch(path.basename(p), /\s/, "filename has no spaces");
    assert.equal(fs.readFileSync(p, "utf8"), "diff --git a/x b/x\n+hello\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRescuePatch: different agent ids get separate files (no silent overwrite)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue2-"));
  try {
    const p1 = writeRescuePatch(dir, "wf_run2", 1, "verify", "patch-v1\n");
    const p2 = writeRescuePatch(dir, "wf_run2", 2, "verify", "patch-v2\n");
    assert.notEqual(p1, p2, "different ids produce different files");
    assert.equal(fs.readFileSync(p1, "utf8"), "patch-v1\n");
    assert.equal(fs.readFileSync(p2, "utf8"), "patch-v2\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRescuePatch: sanitizes hostile run/label input", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-rescue3-"));
  try {
    const p = writeRescuePatch(dir, "../etc/passwd", 7, "a;b && rm -rf", "x");
    assert.ok(fs.existsSync(p));
    assert.match(path.basename(p), /^etcpasswd-7-abrm-rf-[a-f0-9]{12}\.patch$/);
    assert.equal(fs.readFileSync(p, "utf8"), "x\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Helper: run git in a temp repo. */
function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("applyPatch: applies a clean patch and returns true", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-ok-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: append a line
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch at base, clean
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "line1\nline2\nline3\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch accepts deletion of the last file in a nested directory", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-nested-delete-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(path.join(repo, "nested"));
    fs.writeFileSync(path.join(repo, "nested", "only.txt"), "only\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.rmSync(path.join(repo, "nested", "only.txt"));
    gitIn(repo, ["add", "."]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);

    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.existsSync(path.join(repo, "nested")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: a conflicting patch leaves the shared tree untouched", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-conflict-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: change line2 to "line2-agent"
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2-agent\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch ALSO changes line2 (conflicting)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "f.txt"), "line1\nline2-shared\nline3\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "shared"]);
    const before = fs.readFileSync(path.join(repo, "f.txt"), "utf8");

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "conflicting patch must not report success");

    const after = fs.readFileSync(path.join(repo, "f.txt"), "utf8");
    assert.equal(after, before, "shared tree restored to its pre-apply content");
    assert.doesNotMatch(after, /<{7}|>{7}/, "no conflict markers left behind");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch rolls back earlier paths when the write phase fails midway", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-midway-"));
  const locked = path.join(repo, "locked");
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    fs.writeFileSync(path.join(locked, ".keep"), "keep\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    fs.writeFileSync(path.join(locked, "new.txt"), "new\n");
    gitIn(repo, ["add", "."]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);
    fs.chmodSync(locked, 0o555);

    assert.equal(applyPatch(repo, patch), false);
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(locked, "new.txt")), false);
  } finally {
    try { fs.chmodSync(locked, 0o755); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch rollback restores parent directory modes after a partial delete", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-directory-mode-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(path.join(repo, "aaa"));
    fs.mkdirSync(path.join(repo, "zzz-locked"));
    fs.writeFileSync(path.join(repo, "aaa", "only.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "zzz-locked", ".keep"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);

    fs.rmSync(path.join(repo, "aaa", "only.txt"));
    fs.writeFileSync(path.join(repo, "zzz-locked", "new.txt"), "new\n");
    gitIn(repo, ["add", "."]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", "HEAD"]);
    fs.rmSync(path.join(repo, "zzz-locked", "new.txt"), { force: true });
    fs.chmodSync(path.join(repo, "aaa"), 0o751);
    fs.chmodSync(path.join(repo, "zzz-locked"), 0o555);

    assert.equal(applyPatch(repo, patch), false);
    assert.equal(fs.readFileSync(path.join(repo, "aaa", "only.txt"), "utf8"), "base\n");
    assert.equal(fs.statSync(path.join(repo, "aaa")).mode & 0o777, 0o751);
    assert.equal(fs.existsSync(path.join(repo, "zzz-locked", "new.txt")), false);
  } finally {
    try { fs.chmodSync(path.join(repo, "zzz-locked"), 0o755); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: a rejected patch preserves the user's staged index exactly", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-index-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "f.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(repo, "f.txt"), "agent\n");
    gitIn(repo, ["add", "f.txt"]);
    const patch = gitIn(repo, ["diff", "--cached", "--binary", base]);
    gitIn(repo, ["reset", "--hard", "-q", base]);

    fs.writeFileSync(path.join(repo, "f.txt"), "user-staged\n");
    gitIn(repo, ["add", "f.txt"]);
    const indexPath = gitIn(repo, ["rev-parse", "--git-path", "index"]);
    const beforeIndex = fs.readFileSync(path.resolve(repo, indexPath));
    const beforeCached = gitIn(repo, ["diff", "--cached", "--binary"]);

    assert.equal(applyPatch(repo, patch), false);
    assert.deepEqual(fs.readFileSync(path.resolve(repo, indexPath)), beforeIndex);
    assert.equal(gitIn(repo, ["diff", "--cached", "--binary"]), beforeCached);
    assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "user-staged\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: an add/add conflict leaves the shared version untouched", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-addadd-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    gitIn(repo, ["add", "base.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch adds new.txt = "agent"
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "new.txt"), "agent\n");
    gitIn(repo, ["add", "new.txt"]);
    gitIn(repo, ["commit", "-qm", "agent-add"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch ALSO adds new.txt = "shared" (add/add conflict)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "new.txt"), "shared\n");
    gitIn(repo, ["add", "new.txt"]);
    gitIn(repo, ["commit", "-qm", "shared-add"]);

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "add/add conflict must not report success");
    const after = fs.readFileSync(path.join(repo, "new.txt"), "utf8");
    assert.equal(after, "shared\n", "shared version restored, no markers");
    assert.doesNotMatch(after, /<{7}|>{7}/);
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: multi-file patch (clean delete + conflicting modify) reverts BOTH", () => {
  // A multi-file preflight failure must not apply an otherwise-clean deletion
  // before reporting the conflicting modification.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-mix-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nkeep2\n");
    fs.writeFileSync(path.join(repo, "delete-me.txt"), "gone\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: modify keep.txt + delete delete-me.txt
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nagent-edit\n");
    fs.rmSync(path.join(repo, "delete-me.txt"));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "agent-mix"]);
    const patch = gitIn(repo, ["diff", "--cached", base]);
    // shared branch: conflicting modify to keep.txt (delete-me.txt untouched)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "keep.txt"), "keep1\nshared-edit\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "shared-mix"]);
    const beforeKeep = fs.readFileSync(path.join(repo, "keep.txt"), "utf8");

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "conflicting patch must not report success");
    // The conflicting modify is reverted...
    assert.equal(fs.readFileSync(path.join(repo, "keep.txt"), "utf8"), beforeKeep);
    // ...AND the clean deletion is rolled back (file restored, not staged-D).
    assert.ok(fs.existsSync(path.join(repo, "delete-me.txt")), "deleted file was restored");
    assert.equal(fs.readFileSync(path.join(repo, "delete-me.txt"), "utf8"), "gone\n");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA|D ) /m, "no unmerged or staged-delete entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff: captures binary changes as applicable binary patch data", () => {
  // Regression: `git diff --cached` without --binary emits only "Binary files
  // differ" with no path line / no data, so applyPatch could not apply it and
  // the rescue patch could not reconstruct the binary.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bin-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "binary", 0);
    fs.writeFileSync(path.join(worktree.path, "blob.bin"), Buffer.from([9, 9, 9, 9, 0, 7]));

    const diff = captureWorktreeDiff(worktree);
    const patchText = diff.patch.toString("latin1");
    assert.ok(diff.filesChanged >= 1, "binary change is counted");
    assert.match(patchText, /diff --git a\/blob\.bin b\/blob\.bin/, "patch carries the blob.bin path");
    assert.match(patchText, /GIT binary patch/, "patch carries literal binary patch data");
    assert.doesNotMatch(patchText, /Binary files.*differ/, "no textless 'Binary files differ'");
    assert.equal(applyPatch(repo, diff.patch), true, "binary patch applies on the clean base");
    assert.deepEqual(fs.readFileSync(path.join(repo, "blob.bin")), Buffer.from([9, 9, 9, 9, 0, 7]));
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: a binary conflict leaves the shared bytes untouched", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bin-conflict-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // agent branch: change bytes
    gitIn(repo, ["checkout", "-qb", "agent", base]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([9, 9, 9, 9, 0, 7]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "agent"]);
    const patch = gitIn(repo, ["-c", "core.quotepath=false", "diff", "--cached", "--binary", base]);
    // shared branch: change to DIFFERENT bytes (conflict)
    gitIn(repo, ["checkout", "-q", "-B", "main", base]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([5, 5, 5, 5, 0, 5]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "shared"]);
    const before = Buffer.from([5, 5, 5, 5, 0, 5]);

    const ok = applyPatch(repo, patch);
    assert.equal(ok, false, "binary conflict must not report success");
    assert.deepEqual(fs.readFileSync(path.join(repo, "blob.bin")), before, "shared bytes restored, no corruption");
    const status = gitIn(repo, ["status", "--porcelain"]);
    assert.doesNotMatch(status, /^(UU|AA) /m, "no unmerged index entries remain");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Nit fixes: tmp-filename collision and worktree GC.
// ---------------------------------------------------------------------------

// Covers same-thread uniqueness; cross-realm (worker-thread) uniqueness comes
// from crypto.randomBytes in patchTmpPath, which is collision-proof by construction.
test("applyPatch and verification handle file-symlink conversions on repeated paths", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-type-conversion-"));
  const repo = path.join(parent, "repo");
  try {
    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.symlinkSync("old-target", path.join(repo, "a"));
    fs.writeFileSync(path.join(repo, "z"), "old file\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.unlinkSync(path.join(repo, "a"));
    fs.writeFileSync(path.join(repo, "a"), "new file\n");
    fs.unlinkSync(path.join(repo, "z"));
    fs.symlinkSync("new-target", path.join(repo, "z"));
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", "--no-renames", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);

    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.lstatSync(path.join(repo, "a")).isFile(), true);
    assert.equal(fs.readFileSync(path.join(repo, "a"), "utf8"), "new file\n");
    assert.equal(fs.lstatSync(path.join(repo, "z")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(repo, "z")), "new-target");
    const patchPath = path.join(parent, "delivery.patch");
    fs.writeFileSync(patchPath, patch);
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("patchTmpPath: every call yields a unique path (no tmp collision)", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const p = patchTmpPath();
    assert.equal(seen.has(p), false, `duplicate tmp path on call ${i}: ${p}`);
    seen.add(p);
  }
  for (const p of seen) {
    assert.ok(p.startsWith(path.join(os.tmpdir(), "ultracode-patch-")), `unexpected path: ${p}`);
  }
});

test("createWorktree uses unique detached identities and preserves an existing tree", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-owner-"));
  let first: ReturnType<typeof createWorktree> | undefined;
  let second: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);

    first = createWorktree(repo, "same-run", 0);
    fs.writeFileSync(path.join(first.path, "x.txt"), "preserved\n");
    second = createWorktree(repo, "same-run", 0);

    assert.notEqual(first.path, second.path);
    assert.equal(fs.readFileSync(path.join(first.path, "x.txt"), "utf8"), "preserved\n");
    assert.equal(gitIn(repo, ["branch", "--list", "ultracode/*"]), "", "detached worktrees create no cleanup branches");
  } finally {
    if (first) removeWorktree(first);
    if (second) removeWorktree(second);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree cleans up when a checkout hook fails", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-hook-fail-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const before = gitIn(repo, ["worktree", "list", "--porcelain"]);
    const tempPrefix = "ultracode-wt-hook-failure-0-";
    const beforePaths = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tempPrefix)).sort();
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    fs.writeFileSync(
      hook,
      "#!/bin/sh\ngit worktree lock --reason 'hook lock' \"$PWD\" || exit 6\nprintf 'failed\\n' > hook-failed.txt\nexit 7\n",
    );
    fs.chmodSync(hook, 0o755);

    assert.throws(() => createWorktree(repo, "hook-failure", 0), /worktree|checkout|status 7/i);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]), before);
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(tempPrefix)).sort(), beforePaths);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree rejects a hook that redirects linked-worktree Git metadata", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-hook-gitdir-"));
  const created: string[] = [];
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "user staged\n");
    gitIn(repo, ["add", "f.txt"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    const indexPath = path.resolve(repo, gitIn(repo, ["rev-parse", "--git-path", "index"]));
    const indexBefore = fs.readFileSync(indexPath);
    const commonDir = gitIn(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const quotedCommon = `'${commonDir.replaceAll("'", "'\\''")}'`;
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nprintf 'gitdir: %s\\n' ${quotedCommon} > "$PWD/.git"\n`);
    fs.chmodSync(hook, 0o755);

    assert.throws(
      () => createWorktree(repo, "hook-gitdir", 0),
      /verified linked-worktree registration|Git metadata/i,
    );
    assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
    const list = gitIn(repo, ["worktree", "list", "--porcelain"]);
    for (const line of list.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const candidate = line.slice("worktree ".length);
      if (candidate !== fs.realpathSync(repo)) created.push(candidate);
    }
  } finally {
    for (const candidate of created) {
      try { gitIn(repo, ["worktree", "remove", "--force", "--force", candidate]); } catch { /* ignore */ }
      fs.rmSync(candidate, { recursive: true, force: true });
    }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree preserves a hook-created raw-object sidecar", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-hook-sidecar-"));
  let sidecar: string | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const before = gitIn(repo, ["worktree", "list", "--porcelain"]);
    const prefix = "ultracode-wt-sidecar-hook-0-";
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    fs.writeFileSync(
      hook,
      "#!/bin/sh\nmkdir \"$PWD.ultracode-objects\"\nprintf 'owned by hook\\n' > \"$PWD.ultracode-objects/marker\"\n",
    );
    fs.chmodSync(hook, 0o755);

    assert.throws(() => createWorktree(repo, "sidecar-hook", 0), /EEXIST|exist/i);
    const candidates = fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith(prefix) && name.endsWith(".ultracode-objects"));
    assert.equal(candidates.length, 1);
    sidecar = path.join(os.tmpdir(), candidates[0]!);
    assert.equal(fs.readFileSync(path.join(sidecar, "marker"), "utf8"), "owned by hook\n");
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]), before);
  } finally {
    if (sidecar) fs.rmSync(sidecar, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree does not expose the shared node_modules tree", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-modules-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.mkdirSync(path.join(repo, "node_modules", "dependency"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "dependency", "index.js"), "shared\n");

    worktree = createWorktree(repo, "modules", 0);
    assert.equal(fs.existsSync(path.join(worktree.path, "node_modules")), false);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("capture and cleanup reject a worktree path that changed ownership", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-swap-"));
  let original: ReturnType<typeof createWorktree> | undefined;
  let replacement: ReturnType<typeof createWorktree> | undefined;
  let movedOriginal: ReturnType<typeof createWorktree> | undefined;
  let movedReplacement: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    original = createWorktree(repo, "owner", 0);
    const originalPath = original.path;
    const movedPath = `${originalPath}-moved`;
    gitIn(repo, ["worktree", "move", originalPath, movedPath]);
    movedOriginal = { ...original, path: movedPath, agentCwd: movedPath };

    replacement = createWorktree(repo, "replacement", 0);
    gitIn(repo, ["worktree", "move", replacement.path, originalPath]);
    movedReplacement = { ...replacement, path: originalPath, agentCwd: originalPath };
    fs.writeFileSync(path.join(originalPath, "x.txt"), "replacement\n");

    assert.throws(() => captureWorktreeDiff(original!), /ownership|identity|replaced/i);
    removeWorktree(original!);
    assert.equal(fs.existsSync(originalPath), true, "cleanup must not remove the replacement worktree");
    fs.rmSync(originalPath, { recursive: true, force: true });
    removeWorktree(original!);
    assert.equal(
      gitIn(repo, ["worktree", "list", "--porcelain"]).includes(originalPath),
      true,
      "cleanup must not unregister a replacement after its root disappears",
    );
  } finally {
    if (movedOriginal) removeWorktree(movedOriginal);
    if (movedReplacement) removeWorktree(movedReplacement);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff enforces one end-to-end Git deadline", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-capture-deadline-"));
  const wrappers = fs.mkdtempSync(path.join(os.tmpdir(), "uc-git-wrapper-"));
  const originalPath = process.env.PATH;
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "capture-deadline", 0);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
    const wrapper = path.join(wrappers, "git");
    fs.writeFileSync(wrapper, `#!/bin/sh\nsleep 1\nexec ${quotedGit} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    process.env.PATH = `${wrappers}${path.delimiter}${originalPath ?? ""}`;

    const startedAt = Date.now();
    assert.throws(() => captureWorktreeDiff(worktree!, 50), /ownership|timed out|SIGKILL|ETIMEDOUT/i);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    process.env.PATH = originalPath;
    if (worktree) removeWorktree(worktree);
    fs.rmSync(wrappers, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree preserves repository paths with trailing whitespace", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-space-"));
  const repo = path.join(parent, "repo ");
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "space", 0);
    assert.equal(worktree.repoRoot, fs.realpathSync(repo));
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff never follows symlinked path ancestors", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-symlink-ancestor-"));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-symlink-external-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "file.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.writeFileSync(path.join(external, "file.txt"), "external secret\n");
    fs.chmodSync(path.join(external, "file.txt"), 0o600);
    worktree = createWorktree(repo, "symlink-ancestor", 0);
    fs.rmSync(path.join(worktree.path, "dir"), { recursive: true });
    fs.symlinkSync(external, path.join(worktree.path, "dir"));

    const diff = captureWorktreeDiff(worktree);
    assert.equal(diff.patch.includes(Buffer.from("external secret")), false);
    assert.equal(applyPatch(repo, diff.patch), true);
    assert.equal(fs.lstatSync(path.join(repo, "dir")).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(repo, "dir")), external);
    assert.equal(fs.statSync(path.join(external, "file.txt")).mode & 0o777, 0o600);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("capture and apply support file, directory, and symlink topology conversions", () => {
  const scenarios = ["file-to-directory", "directory-to-file", "symlink-to-directory", "directory-to-symlink"] as const;
  for (const scenario of scenarios) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `uc-worktree-${scenario}-`));
    let worktree: ReturnType<typeof createWorktree> | undefined;
    try {
      gitIn(repo, ["init", "-q"]);
      gitIn(repo, ["config", "user.email", "t@t"]);
      gitIn(repo, ["config", "user.name", "t"]);
      if (scenario.startsWith("file")) fs.writeFileSync(path.join(repo, "a"), "old file\n");
      else if (scenario.startsWith("symlink")) fs.symlinkSync("old-target", path.join(repo, "a"));
      else {
        fs.mkdirSync(path.join(repo, "a", "d0"), { recursive: true });
        fs.writeFileSync(path.join(repo, "a", "d0", "old"), "old child\n");
      }
      gitIn(repo, ["add", "."]);
      gitIn(repo, ["commit", "-qm", "base"]);
      worktree = createWorktree(repo, scenario, 0);
      fs.rmSync(path.join(worktree.path, "a"), { recursive: true, force: true });
      if (scenario.endsWith("directory")) {
        fs.mkdirSync(path.join(worktree.path, "a"));
        fs.writeFileSync(path.join(worktree.path, "a", "new"), "new child\n");
      } else if (scenario.endsWith("file")) {
        fs.writeFileSync(path.join(worktree.path, "a"), "new file\n");
      } else {
        fs.symlinkSync("new-target", path.join(worktree.path, "a"));
      }

      const diff = captureWorktreeDiff(worktree);
      assert.equal(applyPatch(repo, diff.patch), true, scenario);
      if (scenario.endsWith("directory")) {
        assert.equal(fs.readFileSync(path.join(repo, "a", "new"), "utf8"), "new child\n");
      } else if (scenario.endsWith("file")) {
        assert.equal(fs.readFileSync(path.join(repo, "a"), "utf8"), "new file\n");
      } else {
        assert.equal(fs.readlinkSync(path.join(repo, "a")), "new-target");
      }
    } finally {
      if (worktree) removeWorktree(worktree);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("applyPatch does not follow a final symlink while fsyncing directories", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-fsync-symlink-"));
  const repo = path.join(parent, "repo");
  const fifo = path.join(parent, "outside.fifo");
  try {
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      t.skip("mkfifo is unavailable on this platform");
      return;
    }
    fs.mkdirSync(path.join(repo, "a", "d0"), { recursive: true });
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "a", "d0", "old"), "old\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.rmSync(path.join(repo, "a"), { recursive: true });
    fs.symlinkSync(fifo, path.join(repo, "a"));
    gitIn(repo, ["add", "-A"]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", "--no-renames", base], { cwd: repo });
    const patchPath = path.join(parent, "delivery.patch");
    fs.writeFileSync(patchPath, patch);
    gitIn(repo, ["reset", "--hard", "-q", base]);
    const moduleUrl = new URL("../src/workflow/worktree.ts", import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      const { applyPatch } = await import(${JSON.stringify(moduleUrl)});
      console.log(applyPatch(${JSON.stringify(repo)}, fs.readFileSync(${JSON.stringify(patchPath)}), 1000));
    `;
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      script,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 3_000 });
    assert.equal(output.trim(), "true");
    assert.equal(fs.readlinkSync(path.join(repo, "a")), fifo);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff ignores diff config and preserves non-UTF8 text bytes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-raw-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "raw.txt"), Buffer.from([0xff, 0x31, 0x0a]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    gitIn(repo, ["config", "diff.noprefix", "true"]);
    gitIn(repo, ["config", "diff.external", "/bin/false"]);
    worktree = createWorktree(repo, "raw", 0);
    fs.writeFileSync(path.join(worktree.path, "raw.txt"), Buffer.from([0xfe, 0x32, 0x0a]));

    const diff = captureWorktreeDiff(worktree);
    assert.ok(Buffer.isBuffer(diff.patch));
    assert.equal(diff.patch.includes(Buffer.from([0xff])), true);
    assert.equal(diff.patch.includes(Buffer.from([0xfe])), true);
    assert.match(diff.patch.toString("latin1"), /diff --git a\/raw\.txt b\/raw\.txt/);
    gitIn(repo, ["config", "--unset", "diff.external"]);
    assert.equal(applyPatch(repo, diff.patch), true);
    assert.deepEqual(fs.readFileSync(path.join(repo, "raw.txt")), Buffer.from([0xfe, 0x32, 0x0a]));
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff ignores ambient Git index routing", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-index-env-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  const previousIndex = process.env.GIT_INDEX_FILE;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "index-env", 0);
    fs.writeFileSync(path.join(worktree.path, "f.txt"), "agent\n");
    fs.writeFileSync(path.join(worktree.path, "new.txt"), "new\n");
    gitIn(worktree.path, ["add", "new.txt"]);

    fs.writeFileSync(path.join(repo, "f.txt"), "staged-only\n");
    gitIn(repo, ["add", "f.txt"]);
    const indexPath = path.resolve(repo, gitIn(repo, ["rev-parse", "--git-path", "index"]));
    const indexBefore = fs.readFileSync(indexPath);
    process.env.GIT_INDEX_FILE = indexPath;
    const diff = captureWorktreeDiff(worktree);
    assert.equal(diff.filesChanged, 2);
    assert.match(diff.patch.toString("latin1"), /new\.txt/);
    assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
  } finally {
    if (previousIndex === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndex;
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff preserves raw bytes across clean filters", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-filter-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, ".gitattributes"), "*.txt filter=uppercase\n");
    fs.writeFileSync(path.join(repo, "f.txt"), "base bytes\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    gitIn(repo, ["config", "filter.uppercase.clean", "tr '[:lower:]' '[:upper:]'"]);
    gitIn(repo, ["config", "filter.uppercase.smudge", "cat"]);
    worktree = createWorktree(repo, "filter", 0);
    fs.writeFileSync(path.join(worktree.path, "f.txt"), "agent bytes\n");

    const diff = captureWorktreeDiff(worktree);
    assert.equal(applyPatch(repo, diff.patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "agent bytes\n");
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff fails closed on dirty nested submodules", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-submodule-"));
  const dependency = path.join(parent, "dependency");
  const repo = path.join(parent, "repo");
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    fs.mkdirSync(dependency);
    gitIn(dependency, ["init", "-q"]);
    gitIn(dependency, ["config", "user.email", "t@t"]);
    gitIn(dependency, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dependency, "inside.txt"), "base\n");
    gitIn(dependency, ["add", "."]);
    gitIn(dependency, ["commit", "-qm", "base"]);

    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    gitIn(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dep"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "submodule", 0);
    gitIn(worktree.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
    assert.equal(captureWorktreeDiff(worktree).filesChanged, 0);
    fs.writeFileSync(path.join(worktree.path, "dep", "inside.txt"), "agent\n");

    assert.throws(() => captureWorktreeDiff(worktree!), /dirty.*submodule|submodule.*dirty/i);
    gitIn(worktree.path, ["update-index", "--assume-unchanged", "dep"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /gitlink.*flags|submodule.*preserved/i);
    gitIn(worktree.path, ["update-index", "--no-assume-unchanged", "--skip-worktree", "dep"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /gitlink.*flags|submodule.*preserved/i);
    gitIn(worktree.path, ["update-index", "--no-skip-worktree", "dep"]);
    gitIn(path.join(worktree.path, "dep"), ["update-index", "--assume-unchanged", "inside.txt"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /submodule.*flags|submodule.*preserved/i);
    const submodule = path.join(worktree.path, "dep");
    gitIn(submodule, ["update-index", "--no-assume-unchanged", "--skip-worktree", "inside.txt"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /submodule.*flags|submodule.*preserved/i);

    gitIn(submodule, ["update-index", "--no-skip-worktree", "inside.txt"]);
    gitIn(submodule, ["checkout", "--", "inside.txt"]);
    const decoy = path.join(parent, "decoy");
    fs.mkdirSync(decoy);
    fs.writeFileSync(path.join(decoy, "inside.txt"), "base\n");
    gitIn(submodule, ["config", "core.worktree", decoy]);
    fs.writeFileSync(path.join(submodule, "inside.txt"), "hidden by decoy\n");
    assert.throws(() => captureWorktreeDiff(worktree!), /dirty submodule|submodule.*preserved/i);

    gitIn(submodule, ["config", "--unset", "core.worktree"]);
    gitIn(submodule, ["checkout", "--", "inside.txt"]);
    gitIn(submodule, ["config", "core.filemode", "false"]);
    fs.chmodSync(path.join(submodule, "inside.txt"), 0o755);
    assert.throws(() => captureWorktreeDiff(worktree!), /dirty submodule|submodule.*preserved/i);

    fs.chmodSync(path.join(submodule, "inside.txt"), 0o644);
    gitIn(submodule, ["config", "--unset", "core.filemode"]);
    gitIn(submodule, ["checkout", "--", "inside.txt"]);
    const submoduleGitDir = gitIn(submodule, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    fs.writeFileSync(path.join(submoduleGitDir, "info", "attributes"), "inside.txt filter=hide\n");
    gitIn(submodule, ["config", "filter.hide.clean", "printf 'base\\n'"]);
    fs.writeFileSync(path.join(submodule, "inside.txt"), "hidden by filter\n");
    assert.throws(() => captureWorktreeDiff(worktree!), /dirty submodule|submodule.*preserved/i);

    fs.rmSync(path.join(submoduleGitDir, "info", "attributes"));
    gitIn(submodule, ["config", "--unset", "filter.hide.clean"]);
    gitIn(submodule, ["checkout", "--", "inside.txt"]);
    const original = gitIn(submodule, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(submodule, "inside.txt"), "replacement commit\n");
    gitIn(submodule, ["add", "inside.txt"]);
    gitIn(submodule, ["commit", "-qm", "replacement"]);
    const replacement = gitIn(submodule, ["rev-parse", "HEAD"]);
    gitIn(submodule, ["replace", original, replacement]);
    gitIn(submodule, ["reset", "--soft", original]);
    assert.throws(() => captureWorktreeDiff(worktree!), /changed submodule index|dirty submodule|submodule.*preserved/i);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff rejects staged, committed, and deleted gitlink changes", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-gitlink-change-"));
  const dependency = path.join(parent, "dependency");
  const repo = path.join(parent, "repo");
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    fs.mkdirSync(dependency);
    gitIn(dependency, ["init", "-q"]);
    gitIn(dependency, ["config", "user.email", "t@t"]);
    gitIn(dependency, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dependency, "inside.txt"), "base\n");
    gitIn(dependency, ["add", "."]);
    gitIn(dependency, ["commit", "-qm", "base"]);

    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    gitIn(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "dep"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "gitlink-change", 0);
    gitIn(worktree.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);

    fs.writeFileSync(path.join(dependency, "inside.txt"), "next\n");
    gitIn(dependency, ["add", "."]);
    gitIn(dependency, ["commit", "-qm", "next"]);
    gitIn(path.join(worktree.path, "dep"), ["fetch", "-q", "origin"]);
    gitIn(path.join(worktree.path, "dep"), ["checkout", "-q", "FETCH_HEAD"]);
    gitIn(worktree.path, ["add", "dep"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /gitlink|submodule.*preserved/i);

    gitIn(worktree.path, ["commit", "-qm", "move gitlink"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /gitlink|submodule.*preserved/i);

    gitIn(worktree.path, ["reset", "--hard", "-q", worktree.baseCommit]);
    gitIn(worktree.path, ["rm", "-fq", "dep"]);
    assert.throws(() => captureWorktreeDiff(worktree!), /gitlink|submodule.*preserved/i);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff includes ignored files newly tracked by the agent", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-tracked-addition-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "tracked-addition", 0);
    fs.writeFileSync(path.join(worktree.path, "ignored.txt"), "agent\n");
    gitIn(worktree.path, ["add", "-f", "ignored.txt"]);
    gitIn(worktree.path, ["commit", "-qm", "track ignored file"]);

    const diff = captureWorktreeDiff(worktree);
    assert.equal(diff.filesChanged, 1);
    assert.equal(applyPatch(repo, diff.patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "ignored.txt"), "utf8"), "agent\n");
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff rejects non-ignored special filesystem nodes", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-special-node-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "special-node", 0);

    fs.rmSync(path.join(worktree.path, "f.txt"));
    execFileSync("mkfifo", [path.join(worktree.path, "f.txt")]);
    assert.throws(() => captureWorktreeDiff(worktree!), /unsupported filesystem node/i);

    fs.rmSync(path.join(worktree.path, "f.txt"));
    gitIn(worktree.path, ["checkout", "--", "f.txt"]);
    execFileSync("mkfifo", [path.join(worktree.path, "new.pipe")]);
    assert.throws(() => captureWorktreeDiff(worktree!), /unsupported filesystem node/i);

    fs.rmSync(path.join(worktree.path, "new.pipe"));
    fs.mkdirSync(path.join(worktree.path, "nested"));
    execFileSync("mkfifo", [path.join(worktree.path, "nested", ".git")]);
    assert.throws(() => captureWorktreeDiff(worktree!), /unsupported filesystem node/i);
    fs.rmSync(path.join(worktree.path, "nested", ".git"));
    fs.mkdirSync(path.join(worktree.path, "nested", ".git"));
    execFileSync("mkfifo", [path.join(worktree.path, "nested", ".git", "stealth.pipe")]);
    assert.throws(() => captureWorktreeDiff(worktree!), /unsupported filesystem node/i);
    fs.rmSync(path.join(worktree.path, "nested", ".git"), { recursive: true });
    const linkedGitDir = gitIn(worktree.path, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    fs.writeFileSync(path.join(worktree.path, "nested", ".git"), `gitdir: ${linkedGitDir}\n`);
    assert.throws(() => captureWorktreeDiff(worktree!), /unsupported filesystem node/i);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("captureWorktreeDiff observes executable mode with core.filemode disabled", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-filemode-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(repo, "run.sh"), 0o644);
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    gitIn(repo, ["config", "core.filemode", "false"]);
    worktree = createWorktree(repo, "filemode", 0);
    fs.chmodSync(path.join(worktree.path, "run.sh"), 0o755);

    const diff = captureWorktreeDiff(worktree);
    assert.equal(diff.filesChanged, 1);
    assert.equal(applyPatch(repo, diff.patch), true);
    assert.equal(fs.statSync(path.join(repo, "run.sh")).mode & 0o111, 0o111);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("capture and apply preserve tab, quote, backslash, and Unicode paths", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-paths-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  const names = ["tab\tname.txt", "quote\"name.txt", "back\\slash.txt", "unicodé.txt", "line\nbreak.txt"];
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    for (const name of names) fs.writeFileSync(path.join(repo, name), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "paths", 0);
    for (const name of names) fs.writeFileSync(path.join(worktree.path, name), "agent\n");

    const diff = captureWorktreeDiff(worktree);
    assert.equal(diff.filesChanged, names.length);
    assert.equal(applyPatch(repo, diff.patch), true);
    for (const name of names) assert.equal(fs.readFileSync(path.join(repo, name), "utf8"), "agent\n");
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch preserves whitespace despite hostile apply config", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-whitespace-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "base\ntrailing   \n");
    gitIn(repo, ["add", "."]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);
    gitIn(repo, ["config", "apply.whitespace", "fix"]);

    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "f.txt"), "utf8"), "base\ntrailing   \n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch preserves permission bits that Git patches do not represent", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-permissions-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "base\n");
    gitIn(repo, ["add", "secret.txt"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "secret.txt"), "agent\n");
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);
    fs.chmodSync(path.join(repo, "secret.txt"), 0o600);

    assert.equal(applyPatch(repo, patch), true);
    assert.equal(fs.readFileSync(path.join(repo, "secret.txt"), "utf8"), "agent\n");
    assert.equal(fs.statSync(path.join(repo, "secret.txt")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch respects umask for newly materialized files and directories", () => {
  const originalUmask = process.umask();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-umask-"));
  try {
    for (const mask of [0o077, 0o022]) {
      const repo = path.join(parent, mask.toString(8));
      fs.mkdirSync(repo);
      gitIn(repo, ["init", "-q"]);
      gitIn(repo, ["config", "user.email", "t@t"]);
      gitIn(repo, ["config", "user.name", "t"]);
      gitIn(repo, ["commit", "--allow-empty", "-qm", "base"]);
      fs.mkdirSync(path.join(repo, "nested"));
      fs.writeFileSync(path.join(repo, "nested", "new.txt"), "new\n");
      gitIn(repo, ["add", "."]);
      const patch = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", "HEAD"], { cwd: repo });
      gitIn(repo, ["reset", "--hard", "-q", "HEAD"]);
      process.umask(mask);

      assert.equal(applyPatch(repo, patch), true);
      assert.equal(fs.statSync(path.join(repo, "nested", "new.txt")).mode & 0o777, 0o666 & ~mask);
      assert.equal(fs.statSync(path.join(repo, "nested")).mode & 0o777, 0o777 & ~mask);
    }
  } finally {
    process.umask(originalUmask);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("applyPatch and verification ignore hostile global EOL and attributes config", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-global-config-"));
  const repo = path.join(parent, "repo");
  const hostileHome = path.join(parent, "home");
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    gitIn(parent, ["init", "-q"]);
    gitIn(parent, ["config", "user.email", "t@t"]);
    gitIn(parent, ["config", "user.name", "t"]);
    gitIn(parent, ["config", "core.autocrlf", "true"]);
    fs.writeFileSync(path.join(parent, ".gitattributes"), "*.txt text eol=crlf\n");
    gitIn(parent, ["add", ".gitattributes"]);
    gitIn(parent, ["commit", "-qm", "outer attributes"]);
    fs.mkdirSync(repo);
    fs.mkdirSync(hostileHome);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    gitIn(repo, ["commit", "--allow-empty", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "added.txt"), "alpha\nbeta\n");
    gitIn(repo, ["add", "added.txt"]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", "--full-index", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);

    const xdgConfigHome = path.join(hostileHome, "xdg");
    fs.mkdirSync(path.join(xdgConfigHome, "git"), { recursive: true });
    fs.writeFileSync(path.join(xdgConfigHome, "git", "attributes"), "*.txt text eol=crlf\n");
    fs.writeFileSync(path.join(hostileHome, ".gitconfig"), "[core]\n\tautocrlf = true\n");
    process.env.HOME = hostileHome;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;

    assert.equal(applyPatch(repo, patch), true);
    assert.deepEqual(fs.readFileSync(path.join(repo, "added.txt")), Buffer.from("alpha\nbeta\n"));
    const patchPath = path.join(parent, "delivery.patch");
    fs.writeFileSync(patchPath, patch);
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("verifyAppliedPatch rejects a reverted executable mode", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-verify-mode-"));
  const repo = path.join(parent, "repo");
  try {
    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    gitIn(repo, ["config", "core.filemode", "true"]);
    fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(repo, "run.sh"), 0o644);
    gitIn(repo, ["add", "run.sh"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.chmodSync(path.join(repo, "run.sh"), 0o755);
    const patch = execFileSync("git", ["diff", "--binary", "--full-index"], { cwd: repo });
    fs.chmodSync(path.join(repo, "run.sh"), 0o644);

    assert.equal(applyPatch(repo, patch), true);
    const patchPath = path.join(parent, "delivery.patch");
    fs.writeFileSync(patchPath, patch);
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), true);
    fs.chmodSync(path.join(repo, "run.sh"), 0o644);
    assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("delivery verification composes content and later executable-mode patches", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-verify-composed-"));
  const repo = path.join(parent, "repo");
  try {
    fs.mkdirSync(repo);
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    gitIn(repo, ["config", "core.filemode", "true"]);
    fs.writeFileSync(path.join(repo, "run.sh"), "base\n");
    fs.chmodSync(path.join(repo, "run.sh"), 0o644);
    gitIn(repo, ["add", "run.sh"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(repo, "run.sh"), "agent\n");
    const contentPatch = execFileSync("git", ["diff", "--binary", "--full-index", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);
    fs.chmodSync(path.join(repo, "run.sh"), 0o755);
    const modePatch = execFileSync("git", ["diff", "--binary", "--full-index", base], { cwd: repo });
    gitIn(repo, ["reset", "--hard", "-q", base]);

    assert.equal(applyPatch(repo, contentPatch), true);
    assert.equal(applyPatch(repo, modePatch), true);
    assert.equal(fs.readFileSync(path.join(repo, "run.sh"), "utf8"), "agent\n");
    assert.equal(fs.statSync(path.join(repo, "run.sh")).mode & 0o111, 0o111);
    for (const [name, patch] of [["content", contentPatch], ["mode", modePatch]] as const) {
      const patchPath = path.join(parent, `${name}.patch`);
      fs.writeFileSync(patchPath, patch);
      const hash = createHash("sha256").update(patch).digest("hex");
      assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), true);
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("applyPatch and verification support SHA-256 binary patches", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-sha256-"));
  const repo = path.join(parent, "repo");
  try {
    fs.mkdirSync(repo);
    try {
      execFileSync("git", ["init", "-q", "--object-format=sha256"], { cwd: repo, stdio: "pipe" });
    } catch {
      t.skip("installed Git does not support SHA-256 repositories");
      return;
    }
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    const baseBytes = Buffer.from([0, 1, 2, 3, 255, 10]);
    const nextBytes = Buffer.from([0, 9, 8, 7, 254, 10]);
    fs.writeFileSync(path.join(repo, "binary.dat"), baseBytes);
    gitIn(repo, ["add", "binary.dat"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    fs.writeFileSync(path.join(repo, "binary.dat"), nextBytes);
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", base], { cwd: repo });
    assert.equal(patch.includes(Buffer.from("GIT binary patch")), true);
    gitIn(repo, ["reset", "--hard", "-q", base]);

    assert.equal(applyPatch(repo, patch), true);
    assert.deepEqual(fs.readFileSync(path.join(repo, "binary.dat")), nextBytes);
    const patchPath = path.join(parent, "delivery.patch");
    fs.writeFileSync(patchPath, patch);
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.equal(verifyAppliedPatch(repo, patchPath, hash, parent), true);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("applyPatch materializes blobs larger than the generic Git output cap", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-large-blob-"));
  const size = 65 * 1024 * 1024;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    const baseBytes = Buffer.alloc(size);
    fs.writeFileSync(path.join(repo, "large.bin"), baseBytes);
    gitIn(repo, ["add", "large.bin"]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    baseBytes[size - 1] = 1;
    fs.writeFileSync(path.join(repo, "large.bin"), baseBytes);
    const patch = execFileSync("git", ["diff", "--binary", "--full-index", base], {
      cwd: repo,
      maxBuffer: 16 * 1024 * 1024,
    });
    gitIn(repo, ["reset", "--hard", "-q", base]);

    assert.equal(applyPatch(repo, patch), true);
    const fd = fs.openSync(path.join(repo, "large.bin"), "r");
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      assert.equal(last[0], 1);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch rejects unsupported gitlink delivery", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-apply-gitlink-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const first = "1111111111111111111111111111111111111111";
    const second = "2222222222222222222222222222222222222222";
    gitIn(repo, ["update-index", "--add", "--cacheinfo", `160000,${first},submodule`]);
    gitIn(repo, ["commit", "-qm", "gitlink-base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    gitIn(repo, ["update-index", "--cacheinfo", `160000,${second},submodule`]);
    const patch = execFileSync("git", ["diff", "--cached", "--binary", base], { cwd: repo });
    const indexBefore = fs.readFileSync(path.resolve(repo, gitIn(repo, ["rev-parse", "--git-path", "index"])));

    assert.equal(applyPatch(repo, patch), false);
    assert.deepEqual(fs.readFileSync(path.resolve(repo, gitIn(repo, ["rev-parse", "--git-path", "index"]))), indexBefore);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree removes a locked owned worktree and its registration", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-locked-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "locked", 0);
    gitIn(repo, ["worktree", "lock", "--reason", "agent lock", worktree.path]);

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), false);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), false);
  } finally {
    if (worktree) {
      try { gitIn(repo, ["worktree", "unlock", worktree.path]); } catch { /* ignore */ }
      removeWorktree(worktree);
    }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree repairs read-only directories after unregistering", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-readonly-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.mkdirSync(path.join(repo, "dir"));
    fs.writeFileSync(path.join(repo, "dir", "file"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "readonly", 0);
    fs.chmodSync(path.join(worktree.path, "dir"), 0o555);

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), false);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), false);
  } finally {
    if (worktree) {
      try { fs.chmodSync(path.join(worktree.path, "dir"), 0o755); } catch { /* ignore */ }
      removeWorktree(worktree);
    }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves a replaced raw-object sidecar", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-raw-replaced-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "raw-replaced", 0);
    fs.rmSync(worktree.path, { recursive: true, force: true });
    fs.rmSync(worktree.rawObjectDirectory, { recursive: true, force: true });
    fs.mkdirSync(worktree.rawObjectDirectory);
    fs.writeFileSync(path.join(worktree.rawObjectDirectory, "marker"), "replacement\n");

    removeWorktree(worktree);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), false);
    assert.equal(fs.readFileSync(path.join(worktree.rawObjectDirectory, "marker"), "utf8"), "replacement\n");
  } finally {
    if (worktree) fs.rmSync(worktree.rawObjectDirectory, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree follows a renamed admin directory only when identity still matches", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-admin-moved-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  let movedGitDir: string | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "admin-moved", 0);
    movedGitDir = `${worktree.gitDir}-moved`;
    fs.renameSync(worktree.gitDir, movedGitDir);
    fs.writeFileSync(path.join(worktree.path, ".git"), `gitdir: ${movedGitDir}\n`);

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), false);
    assert.equal(fs.existsSync(movedGitDir), false);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), false);
  } finally {
    if (worktree) removeWorktree(worktree);
    if (movedGitDir) fs.rmSync(movedGitDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves resources when the root .git file becomes a symlink", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-dotgit-link-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  let metadataFile: string | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "dotgit-link", 0);
    const dotGit = path.join(worktree.path, ".git");
    metadataFile = path.join(worktree.path, "saved-git-metadata");
    fs.renameSync(dotGit, metadataFile);
    fs.symlinkSync(metadataFile, dotGit);

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), true);
    assert.equal(fs.existsSync(worktree.gitDir), true);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), true);
  } finally {
    if (worktree && metadataFile) {
      try { fs.unlinkSync(path.join(worktree.path, ".git")); } catch { /* ignore */ }
      try { fs.renameSync(metadataFile, path.join(worktree.path, ".git")); } catch { /* ignore */ }
      removeWorktree(worktree);
    }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves a renamed admin when the forward pointer is stale", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-admin-stale-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  let movedGitDir: string | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "admin-stale", 0);
    movedGitDir = `${worktree.gitDir}-moved`;
    fs.renameSync(worktree.gitDir, movedGitDir);

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), true);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), true);
    assert.equal(fs.existsSync(movedGitDir), true);
    fs.writeFileSync(path.join(worktree.path, ".git"), `gitdir: ${movedGitDir}\n`);
    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(fs.existsSync(movedGitDir), false);
  } finally {
    if (worktree) removeWorktree(worktree);
    if (movedGitDir) fs.rmSync(movedGitDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves owned resources when Git cannot unregister them", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-unregister-fail-"));
  const wrappers = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-unregister-wrapper-"));
  const originalPath = process.env.PATH;
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "unregister-fail", 0);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const quotedGit = `'${realGit.replaceAll("'", "'\\''")}'`;
    const wrapper = path.join(wrappers, "git");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = remove ]; then exit 7; fi\nexec ${quotedGit} "$@"\n`,
    );
    fs.chmodSync(wrapper, 0o755);
    process.env.PATH = `${wrappers}${path.delimiter}${originalPath ?? ""}`;

    removeWorktree(worktree);
    assert.equal(fs.existsSync(worktree.path), true);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), true);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), true);
  } finally {
    process.env.PATH = originalPath;
    if (worktree) removeWorktree(worktree);
    fs.rmSync(wrappers, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree uses its saved repository root after the directory disappears", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-worktree-missing-"));
  let worktree: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    worktree = createWorktree(repo, "missing", 0);
    gitIn(repo, ["worktree", "lock", "--reason", "missing lock", worktree.path]);
    fs.rmSync(worktree.path, { recursive: true, force: true });
    removeWorktree(worktree);
    assert.equal(gitIn(repo, ["worktree", "list", "--porcelain"]).includes(worktree.path), false);
    assert.equal(fs.existsSync(worktree.rawObjectDirectory), false);
  } finally {
    if (worktree) removeWorktree(worktree);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
