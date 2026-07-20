import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  WorkflowAgentRunner,
  resolveModelSelection,
  matchModelIn,
  splitThinkingSuffix,
  resolveSessionThinkingLevel,
  type AgentSessionLike,
  type ThinkingLevel,
} from "../src/workflow/agent-runner.ts";
import { writeRescuePatch, applyPatch, captureWorktreeDiff, createWorktree, removeWorktree, reapStaleWorktrees, patchTmpPath } from "../src/workflow/worktree.ts";
import { createDeterministicMath } from "../src/workflow/runtime.ts";

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
  }
  assert.deepEqual(registered, [["custom", providerConfig]]);
  assert.deepEqual(refreshed, [{ allowNetwork: false }]);
  assert.deepEqual(apiKeyReads, ["anthropic"], "only runtime-sourced auth is copied");
  assert.deepEqual(runtimeKeys, [["anthropic", "runtime-secret"]]);
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
// H1: a patch that cannot be auto-applied (3-way conflict) is persisted to disk
// so the agent's work is recoverable, AND the shared tree is reverted (no
// conflict markers, no unmerged index) instead of being left corrupted.
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
    assert.equal(path.basename(p), "etcpasswd-7-abrm-rf.patch");
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

test("applyPatch: on 3-way conflict, reverts the shared tree (no markers, no UU)", () => {
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

test("applyPatch: on add/add conflict, reverts the shared tree to the shared version", () => {
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
  // Regression for the deletion-revert hole: git apply --3way is non-atomic and
  // applies the clean deletion before failing on the conflicting modify; the
  // deleted file must be restored too, not just the conflicted one.
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
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const base = gitIn(repo, ["rev-parse", "HEAD"]);
    // change the binary content + stage
    fs.writeFileSync(path.join(repo, "blob.bin"), Buffer.from([9, 9, 9, 9, 0, 7]));
    gitIn(repo, ["add", "."]);

    const diff = captureWorktreeDiff({ path: repo, agentCwd: repo, branch: "x", baseCommit: base });
    assert.ok(diff.filesChanged >= 1, "binary change is counted");
    assert.match(diff.patch, /diff --git a\/blob\.bin b\/blob\.bin/, "patch carries the blob.bin path");
    assert.match(diff.patch, /GIT binary patch/, "patch carries literal binary patch data");
    assert.doesNotMatch(diff.patch, /Binary files.*differ/, "no textless 'Binary files differ'");
    // The captured binary patch must be re-applicable on a clean tree.
    gitIn(repo, ["reset", "--hard", "-q", base]);
    assert.equal(applyPatch(repo, diff.patch), true, "binary patch applies on the clean base");
    assert.deepEqual(fs.readFileSync(path.join(repo, "blob.bin")), Buffer.from([9, 9, 9, 9, 0, 7]));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("applyPatch: on a binary 3-way conflict, reverts the shared tree to the shared bytes", () => {
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
// Nit fixes: tmp-filename collision, Math.random determinism, worktree GC.
// ---------------------------------------------------------------------------

// Covers same-thread uniqueness; cross-realm (worker-thread) uniqueness comes
// from crypto.randomBytes in patchTmpPath, which is collision-proof by construction.
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

test("createDeterministicMath: Math.max/min/floor work; Math.random throws", () => {
  const m = createDeterministicMath() as {
    max: (...a: number[]) => number;
    min: (...a: number[]) => number;
    floor: (n: number) => number;
    round: (n: number) => number;
    random: () => number;
  };
  assert.equal(m.max(1, 2), 2);
  assert.equal(m.min(4, 5), 4);
  assert.equal(m.floor(1.7), 1);
  assert.equal(m.round(2.5), 3);
  assert.throws(() => m.random(), /Math\.random.*forbidden/);
});

test("createDeterministicMath: copies every Math member + constants, preserves toStringTag", () => {
  const m = createDeterministicMath() as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === "random") continue;
    assert.equal(key in m, true, `Math.${key} should be present on the shim`);
  }
  assert.equal(m["PI"], Math.PI);
  assert.equal(m["E"], Math.E);
  assert.equal(m["SQRT2"], Math.SQRT2);
  const max = m["max"] as (...a: number[]) => number;
  const trunc = m["trunc"] as (n: number) => number;
  const hypot = m["hypot"] as (...a: number[]) => number;
  assert.equal(max.apply(null, [3, 1, 2]), 3, "max.apply works (this-binding ok after freeze)");
  assert.equal(trunc(-1.9), -1);
  assert.equal(hypot(3, 4), 5);
  // Symbol.toStringTag is copied (Object.getOwnPropertySymbols), so the shim
  // stringifies as [object Math] like the real Math.
  assert.equal(Object.prototype.toString.call(m), "[object Math]", "Symbol.toStringTag preserved");
});

test("reapStaleWorktrees: removes an orphaned (untracked) ultracode-wt-* dir", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-orphan-"));
  const orphan = path.join(os.tmpdir(), `ultracode-wt-gcorphan-${Date.now().toString(36)}`);
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.mkdirSync(orphan);
    // Age past the 24h threshold. Untracked dirs use the SAME threshold as tracked
    // worktrees so cross-repo in-flight/kept worktrees (which look untracked from
    // another repo) survive as long as same-repo ones.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(orphan, past, past);
    reapStaleWorktrees(repo);
    assert.equal(fs.existsSync(orphan), false, "stale orphaned ultracode-wt-* dir should be reaped");
  } finally {
    try { fs.rmSync(orphan, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: leaves a RECENT untracked ultracode-wt-* dir (cross-repo in-flight safety)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-cross-"));
  const dir = path.join(os.tmpdir(), `ultracode-wt-crossrepo-${Date.now().toString(36)}`);
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.mkdirSync(dir);
    // Recent + untracked by this repo (simulates a different repo's in-flight worktree):
    // must survive — the 24h threshold protects cross-repo in-flight worktrees.
    reapStaleWorktrees(repo);
    assert.ok(fs.existsSync(dir), "recent untracked ultracode-wt-* dir must survive (cross-repo in-flight)");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: removes a stale ultracode-patch-* tmp file (crash leak)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-patch-"));
  const pf = path.join(os.tmpdir(), `ultracode-patch-deadbeef-${Date.now().toString(36)}.patch`);
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    fs.writeFileSync(pf, "dummy patch\n");
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(pf, past, past);
    reapStaleWorktrees(repo);
    assert.equal(fs.existsSync(pf), false, "stale ultracode-patch-* file should be reaped");
  } finally {
    try { fs.rmSync(pf, { force: true }); } catch { /* ignore */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: removes a stale tracked worktree (kept from an old run)", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-stale-"));
  let wt: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    wt = createWorktree(repo, "gctest", 0);
    assert.ok(fs.existsSync(wt.path), "worktree created");
    // Age it past the 24h staleness threshold so it looks like a kept worktree from an old run.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(wt.path, past, past);
    reapStaleWorktrees(repo); // default maxAgeMs = 24h
    assert.equal(fs.existsSync(wt.path), false, "stale tracked worktree should be reaped");
    assert.equal(gitIn(repo, ["branch", "--list", "ultracode/gctest-0"]).trim(), "", "stale worktree branch should be deleted");
  } finally {
    if (wt) { try { removeWorktree(wt); } catch { /* ignore */ } }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: leaves a recent (in-flight) tracked worktree alone", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-live-"));
  let wt: ReturnType<typeof createWorktree> | undefined;
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    wt = createWorktree(repo, "gclive", 0);
    assert.ok(fs.existsSync(wt.path), "worktree created");
    reapStaleWorktrees(repo); // recent worktree, default 24h threshold -> not reaped
    assert.ok(fs.existsSync(wt.path), "recent in-flight worktree must not be reaped");
    assert.match(gitIn(repo, ["branch", "--list", "ultracode/gclive-0"]), /ultracode\/gclive-0/, "in-flight worktree branch must remain");
  } finally {
    if (wt) { try { removeWorktree(wt); } catch { /* ignore */ } }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reapStaleWorktrees: does not touch non-ultracode tmpdir entries", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-skip-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "other-dir-"));
  try {
    gitIn(repo, ["init", "-q"]);
    gitIn(repo, ["config", "user.email", "t@t"]);
    gitIn(repo, ["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "x.txt"), "x\n");
    gitIn(repo, ["add", "."]);
    gitIn(repo, ["commit", "-qm", "base"]);
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(other, past, past);
    reapStaleWorktrees(repo);
    assert.ok(fs.existsSync(other), "non-ultracode tmpdir entry must not be touched");
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
