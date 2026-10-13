import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { registerCommands } from "../src/commands.ts";
import { UltracodeMode } from "../src/mode.ts";
import { WorkflowRegistry } from "../src/workflow/registry.ts";
import { DEFAULT_SELECTOR_BACKEND, type SelectorBackend } from "../src/selector-backend.ts";

function harness() {
  const commands = new Map<string, any>();
  const notices: { message: string; level: string }[] = [];
  const writes: SelectorBackend[] = [];
  let customCalls = 0;
  const mode = new UltracodeMode("workflow");
  const pi: any = {
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerShortcut() {},
  };
  const preferences = {
    getDefaultEnabled: () => false,
    setDefaultEnabled() {},
    getSelectorBackend: () => ({ ...DEFAULT_SELECTOR_BACKEND }),
    setSelectorBackend: (backend: SelectorBackend) => {
      writes.push(backend);
    },
  };
  registerCommands(pi, mode, new WorkflowRegistry(), preferences);
  const available = {
    chat: [{ provider: "chat-provider", id: "org/model", name: "Chat" }],
    classifier: [{ ...DEFAULT_SELECTOR_BACKEND, name: "Jev" }],
  };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    modelRegistry: { getAvailableOfType: async (type: keyof typeof available) => available[type] },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      custom: async () => {
        customCalls++;
        return undefined;
      },
    },
  };
  return {
    ctx,
    preferences,
    notices,
    writes,
    available,
    mode,
    commands,
    customCalls: () => customCalls,
    run: (args: string) => commands.get("ultracode").handler(args, ctx),
  };
}

test("explicit selector commands save authenticated chat and classifier models without changing execution", async () => {
  const h = harness();
  for (const mode of ["tui", "rpc", "json", "print"]) {
    h.ctx.mode = mode;
    await h.run("model chat-provider/org/model");
    await h.run("model typesafe/jev-latest");
  }
  assert.equal(h.writes.length, 8);
  assert.deepEqual(h.writes[0], { type: "chat", provider: "chat-provider", id: "org/model" });
  assert.equal(h.mode.getMode(), "off");
  assert.equal(h.customCalls(), 0);
  assert.ok(h.notices.every((n) => n.level === "info" && /saved globally/.test(n.message)));
  assert.deepEqual(
    h.commands
      .get("ultracode")
      .getArgumentCompletions("model")
      .map((c: any) => c.value),
    ["model"],
  );
});

test("invalid syntax, missing authentication, and non-TUI picker requests never save", async () => {
  const h = harness();
  for (const arg of [
    "model chat",
    "model /id",
    "model p/",
    "model p/id extra",
    "model p/id",
    "model chat chat-provider/org/model",
    "model classifier typesafe/jev-latest",
  ]) {
    await h.run(arg);
    assert.equal(h.notices.at(-1)?.level, "error");
  }
  for (const mode of ["rpc", "json", "print"]) {
    h.ctx.mode = mode;
    await h.run("model");
    assert.match(h.notices.at(-1)!.message, /requires TUI/);
  }
  assert.equal(h.writes.length, 0);
  assert.equal(h.customCalls(), 0);
});

test("picker cancellation is inert; selection is revalidated and saved", async () => {
  const h = harness();
  await h.run("model");
  assert.equal(h.customCalls(), 1);
  assert.equal(h.writes.length, 0);
  h.ctx.ui.custom = async () => DEFAULT_SELECTOR_BACKEND;
  await h.run("model");
  assert.deepEqual(h.writes, [DEFAULT_SELECTOR_BACKEND]);
  h.ctx.ui.custom = async () => {
    h.available.classifier = [];
    return DEFAULT_SELECTOR_BACKEND;
  };
  await h.run("model");
  assert.equal(h.writes.length, 1);
  assert.match(h.notices.at(-1)!.message, /unavailable/);
});

test("ambiguous models require a type selection and cancellation preserves preferences", async () => {
  const h = harness();
  h.available.chat.push({ provider: "typesafe", id: "jev-latest", name: "Dual model" });
  h.ctx.ui.select = async (_title: string, choices: string[]) => {
    assert.deepEqual(choices, ["chat", "classifier"]);
    return "classifier";
  };
  await h.run("model typesafe/jev-latest");
  assert.deepEqual(h.writes, [DEFAULT_SELECTOR_BACKEND]);
  h.ctx.ui.select = async () => undefined;
  await h.run("model typesafe/jev-latest");
  assert.equal(h.writes.length, 1);
  h.ctx.hasUI = false;
  await h.run("model typesafe/jev-latest");
  assert.equal(h.writes.length, 1);
  assert.match(h.notices.at(-1)!.message, /supports both/);
});

test("registry, preferences and UI failures are reported", async () => {
  for (const failure of ["registry", "read", "write", "ui"]) {
    const h = harness();
    const fail = () => {
      throw new Error(`${failure} failed`);
    };
    if (failure === "registry") h.ctx.modelRegistry.getAvailableOfType = fail;
    if (failure === "read") h.preferences.getSelectorBackend = fail;
    if (failure === "write") h.preferences.setSelectorBackend = fail;
    h.ctx.ui.custom = failure === "ui" ? fail : async () => DEFAULT_SELECTOR_BACKEND;
    await h.run("model");
    assert.equal(h.notices.at(-1)?.level, "error");
    assert.match(h.notices.at(-1)!.message, new RegExp(`${failure} failed`));
    assert.equal(h.writes.length, 0);
  }
});
