import { describe, expect, test } from "vite-plus/test";
import {
  registerOneShot as registerUlt,
  parseOneShot as parseUlt,
  findOneShotMarkers,
  resolveOneShotModel as resolveUltModel,
} from "../src/one-shot.ts";
import { UltracodeMode } from "../src/mode.ts";

const sonnet = { provider: "gateway", id: "claude-sonnet-5", name: "Sonnet" };
const fable = { provider: "gateway", id: "claude-fable-5-1", name: "Fable" };
const external = { provider: "other", id: "claude-fable-5-1", name: "Fable" };

function setup(initialMode = "off", entries: any[] = [], initialModel = sonnet, actualMode?: any) {
  const handlers = new Map<string, Function[]>();
  const notices: string[] = [];
  let currentModel: any = initialModel;
  let thinking = "high";
  let currentMode = initialMode;
  let idle = true;
  let auth = true;
  let editor = "";
  let available = [sonnet, fable, external];
  const ctx: any = {
    get model() {
      return currentModel;
    },
    isIdle: () => idle,
    hasUI: true,
    modelRegistry: {
      getAvailable: () => available,
      find: (p: string, id: string) => available.find((m) => m.provider === p && m.id === id),
    },
    sessionManager: { getBranch: () => entries },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (s: string) => notices.push(s),
      setStatus() {},
      setEditorText: (s: string) => {
        editor = s;
      },
    },
  };
  const emit = async (name: string, event: any = {}) => {
    let result;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const pi: any = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string) {
      throw new Error(`unexpected command ${name}`);
    },
    appendEntry(customType: string, data: any) {
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
    getThinkingLevel: () => thinking,
    setThinkingLevel(level: string) {
      thinking = level;
      void emit("thinking_level_select", { level });
    },
    async setModel(model: any) {
      if (!auth) return false;
      currentModel = model;
      pi.setThinkingLevel("medium");
      await emit("model_select", { model });
      return true;
    },
    getActiveTools: () => [],
    setActiveTools() {},
  };
  const mode = actualMode ?? {
    getMode: () => currentMode,
    isEnabled: () => currentMode !== "off",
    statusLine: () => `ultracode · ${currentMode}`,
    enable(_pi: any, m: string) {
      currentMode = m;
    },
    disable() {
      currentMode = "off";
    },
  };
  registerUlt(pi, mode);
  const input = (text: string, extra: any = {}) =>
    emit("input", { text, source: "interactive", ...extra });
  const command = (args: string) => input(`:ult ${args}`);
  return {
    emit,
    command,
    input,
    ctx,
    pi,
    mode,
    entries,
    notices,
    get model() {
      return currentModel;
    },
    get thinking() {
      return thinking;
    },
    get editor() {
      return editor;
    },
    setIdle(v: boolean) {
      idle = v;
    },
    setAuth(v: boolean) {
      auth = v;
    },
    setAvailable(v: any[]) {
      available = v;
    },
  };
}

describe("one-shot Ultracode", () => {
  test("parses multiline task and optional selector; rejects empty task", () => {
    expect(parseUlt(":ult: with fable investigate\nthen test")).toEqual({
      model: "fable",
      task: "investigate\nthen test",
    });
    expect(parseUlt(":ult review changes")).toEqual({ task: "review changes" });
    for (const text of [":ult", ":ult: with", ":ult with fable"])
      expect(() => parseUlt(text)).toThrow("Usage:");
  });
  test("markers count anywhere outside code, with punctuation around them", () => {
    expect(parseUlt("review this change :ult")).toEqual({ task: "review this change" });
    expect(parseUlt("please :ult: with fable inspect it")).toEqual({
      model: "fable",
      task: "please inspect it",
    });
    expect(parseUlt("fix :ult with fable, then :ult: with opus test")).toEqual({
      model: "fable",
      task: "fix , then test",
    });
    expect(parseUlt("the `:ult` form, then :ult go")).toEqual({
      task: "the `:ult` form, then go",
    });
    expect(findOneShotMarkers("(:ult) a, :ult! b").map((m) => m.nth)).toEqual([0, 1]);
    for (const text of [
      "mention `:ult:` in docs",
      "```\n:ult x\n```",
      ":ultracode: x",
      ":ultra x",
      "a:ult x",
      "::ult x",
      ":ult.ts x",
      ":ult-x y",
      ":ult:x y",
      "/ult x",
    ])
      expect(findOneShotMarkers(text)).toEqual([]);
  });
  test("short names prefer current provider; exact IDs disambiguate", () => {
    expect(resolveUltModel("fable", [sonnet, fable, external], "gateway")).toBe(fable);
    expect(resolveUltModel("other/claude-fable-5-1", [fable, external], "gateway")).toBe(external);
    expect(() => resolveUltModel("fable", [fable, external])).toThrow("Ambiguous");
    expect(() => resolveUltModel("unknown/fable", [fable])).toThrow("No authenticated");
    expect(() => resolveUltModel("typo", [fable])).toThrow("No authenticated");
    expect(
      resolveUltModel(fable.id, [fable, { ...fable, id: `${fable.id}-latest` }], "gateway"),
    ).toBe(fable);
  });
  test("marker selects Fable/deep then restores Sonnet/mode/thinking only at settlement", async () => {
    const s = setup("standard");
    expect(await s.command("with fable investigate")).toMatchObject({
      action: "transform",
      text: "investigate",
    });
    expect(s.model).toBe(fable);
    expect(s.mode.getMode()).toBe("deep");
    expect(s.thinking).toBe("medium");
    await s.emit("agent_end"); // Native retry/compaction may follow.
    expect(s.model).toBe(fable);
    await s.emit("agent_settled");
    expect(s.model).toBe(sonnet);
    expect(s.mode.getMode()).toBe("standard");
    expect(s.thinking).toBe("high");
    expect(s.entries.at(-1).data.active).toBe(false);
    await s.emit("agent_settled"); // Idempotent cleanup.
    expect(s.model).toBe(sonnet);
  });
  test("inline marker strips prefix and preserves images; no selector retains model", async () => {
    const s = setup();
    const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
    expect(await s.input(":ult: review this", { images })).toEqual({
      action: "transform",
      text: "review this",
      images,
    });
    expect(s.model).toBe(sonnet);
    expect(s.mode.getMode()).toBe("deep");
    await s.emit("agent_settled");
    expect(s.mode.getMode()).toBe("off");
  });
  test("marker anywhere triggers; quoted marker and extension-injected task do not", async () => {
    const s = setup();
    expect(await s.input("mention `:ult:` in documentation")).toEqual({ action: "continue" });
    expect(await s.input(":ultracode: inspect")).toEqual({ action: "continue" });
    expect(await s.input("inspect :ult: with fable")).toMatchObject({
      action: "transform",
      text: "inspect",
    });
    expect(await s.input(":ult: not a trigger", { source: "extension" })).toEqual({
      action: "continue",
    });
    expect(s.model).toBe(fable);
  });
  test("unknown model and empty prompt fail without modifying settings", async () => {
    const s = setup();
    expect(await s.input(":ult: with typo review")).toEqual({ action: "handled" });
    expect(s.editor).toBe(":ult: with typo review");
    expect(await s.command("with fable")).toEqual({ action: "handled" });
    expect(s.entries).toEqual([]);
    expect(s.mode.getMode()).toBe("off");
    expect(s.model).toBe(sonnet);
  });
  test("busy or nested invocation is rejected without disturbing active scope", async () => {
    const s = setup();
    s.setIdle(false);
    await s.command("with fable review");
    expect(s.model).toBe(sonnet);
    s.setIdle(true);
    await s.command("with fable review");
    s.setIdle(false);
    expect(await s.input(":ult: another")).toEqual({ action: "handled" });
    expect(s.model).toBe(fable);
    expect(s.mode.getMode()).toBe("deep");
  });
  test("authentication failure rolls back without sending task", async () => {
    const s = setup();
    s.setAuth(false);
    expect(await s.command("with fable review")).toEqual({ action: "handled" });
    expect(s.model).toBe(sonnet);
    expect(s.mode.getMode()).toBe("off");
    expect(s.entries.at(-1).data.active).toBe(false);
  });
  test("abort settlement and shutdown restore, including persisted recovery", async () => {
    const s = setup();
    await s.command("with fable review");
    const restart = setup("deep", structuredClone(s.entries), fable);
    await restart.emit("session_start");
    expect(restart.model).toBe(sonnet);
    expect(restart.mode.getMode()).toBe("off");
    expect(restart.thinking).toBe("high");
    await s.emit("session_shutdown");
    expect(s.model).toBe(sonnet);
    expect(s.mode.getMode()).toBe("off");
  });
  test("completed journal does not reset later session settings", async () => {
    const s = setup();
    await s.command("with fable review");
    await s.emit("agent_settled");
    const restart = setup("focused", structuredClone(s.entries), fable);
    await restart.emit("session_start");
    expect(restart.model).toBe(fable);
    expect(restart.mode.getMode()).toBe("focused");
  });
  test("explicit user model or thinking changes are preserved", async () => {
    const s = setup();
    await s.command("with fable review");
    await s.pi.setModel(external);
    await s.emit("agent_settled");
    expect(s.model).toBe(external);
    expect(s.thinking).toBe("medium");
    const t = setup();
    await t.command("with fable review");
    t.pi.setThinkingLevel("low");
    await t.emit("agent_settled");
    expect(t.model).toBe(sonnet);
    // Model restoration applies a model-specific level; explicit thinking must win.
    expect(t.thinking).toBe("low");
  });
  test("explicit non-deep mode selected during request survives", async () => {
    const s = setup();
    await s.command("review");
    s.mode.enable(s.pi, "focused");
    await s.emit("agent_settled");
    expect(s.mode.getMode()).toBe("focused");
  });
  test("selected-model policy is scoped and remains advisory", async () => {
    const s = setup();
    await s.command("with fable review");
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await s.emit("before_agent_start", event);
    expect(event.systemPromptOptions.sections["ultracode_one_shot"]).toContain(
      "gateway/claude-fable-5-1",
    );
    expect(event.systemPromptOptions.sections["ultracode_one_shot"]).toContain("Cheaper bounded");
    await s.emit("agent_settled");
    await s.emit("before_agent_start", event);
    expect(event.systemPromptOptions.sections["ultracode_one_shot"]).toBeUndefined();
  });
  test("stale idle scope from failed native preflight restores on new input", async () => {
    const s = setup();
    await s.command("with fable review");
    expect(await s.input("ordinary task")).toEqual({ action: "continue" });
    expect(s.model).toBe(sonnet);
    expect(s.mode.getMode()).toBe("off");
  });
  test("unavailable original model retains recovery intent and fails closed", async () => {
    const s = setup();
    await s.command("with fable review");
    s.setAvailable([fable]);
    await s.emit("agent_settled");
    expect(s.entries.at(-1).data.active).toBe(true);
    expect(await s.input("ordinary task")).toEqual({ action: "handled" });
    s.setAvailable([sonnet, fable]);
    await s.emit("agent_settled");
    expect(s.model).toBe(sonnet);
  });
});

test("native controller enables workflow enforcement and restores its branch state", async () => {
  const mode = new UltracodeMode("workflow");
  const s = setup("off", [], sonnet, mode);
  await s.command("with fable review");
  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  mode.beforeAgentStart(event);
  expect(event.systemPromptOptions.sections.ultracode).toContain("Configured mode: deep");
  expect(mode.isEnforcing()).toBe(true);
  await s.emit("agent_settled");
  mode.beforeAgentStart(event);
  expect(mode.isEnforcing()).toBe(false);
  expect(event.systemPromptOptions.sections.ultracode).toBeUndefined();
});

test("active-branch navigation recovers an interrupted one-shot", async () => {
  const first = setup();
  await first.command("with fable review");
  const branch = setup("deep", structuredClone(first.entries), fable);
  await branch.emit("session_tree");
  expect(branch.model).toBe(sonnet);
  expect(branch.mode.getMode()).toBe("off");
});

test("nested invocation cannot restore an override awaiting its first run", async () => {
  const s = setup();
  expect(await s.command("with fable first request")).toMatchObject({ text: "first request" });
  expect(await s.command("with external second request")).toEqual({ action: "handled" });
  expect(s.model).toBe(fable);
  expect(s.mode.getMode()).toBe("deep");
  expect(await s.input(":ult: another request")).toEqual({ action: "handled" });
  expect(s.model).toBe(fable);
  await s.emit("agent_settled");
  expect(s.model).toBe(sonnet);
});

test("a normal model must exist before a reversible one-shot", async () => {
  const s = setup();
  await s.pi.setModel(undefined);
  expect(await s.command("with fable review")).toEqual({ action: "handled" });
  expect(s.entries).toEqual([]);
  expect(s.notices.at(-1)).toContain("Select your normal model");
});
