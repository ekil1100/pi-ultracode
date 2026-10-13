import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
  createModelSelector,
  showModelSelector,
  type SelectorModels,
} from "../src/model-selector.ts";
import { DEFAULT_SELECTOR_BACKEND, type SelectorBackend } from "../src/selector-backend.ts";

function picker(models?: SelectorModels, current: SelectorBackend = DEFAULT_SELECTOR_BACKEND) {
  const results: (SelectorBackend | undefined)[] = [];
  let renders = 0;
  const component = createModelSelector(
    models ?? {
      chat: [{ provider: "chat", id: "org/模型", name: "Chat model" }] as any,
      classifier: [
        { ...DEFAULT_SELECTOR_BACKEND, name: "Jev" },
        { provider: "typesafe", id: "other", name: "Other" },
      ] as any,
    },
    current,
    {
      requestRender: () => {
        renders++;
      },
    } as any,
    { fg: (_color: string, text: string) => text } as any,
    getKeybindings(),
    (backend) => results.push(backend),
  );
  return { component, results, renders: () => renders };
}

test("picker starts on saved tab, marks current model, supports search and tab selection", () => {
  const { component, results, renders } = picker();
  component.focused = true;
  assert.equal(component.focused, true);
  const rendered = component.render(90).join("\n");
  assert.match(rendered, /✓ jev-latest/);
  assert.match(rendered, /Chooses child effort; execution models stay unchanged\./);
  component.handleInput("\r");
  assert.deepEqual(results[0], DEFAULT_SELECTOR_BACKEND);
  component.handleInput("\t");
  component.handleInput("org");
  assert.match(component.render(90).join("\n"), /org\/模型/);
  component.handleInput("\r");
  assert.deepEqual(results[1], { type: "chat", provider: "chat", id: "org/模型" });
  assert.equal(renders(), 2);
});

test("picker wraps navigation and cancels without a selection", () => {
  const { component, results } = picker();
  component.handleInput("\x1b[A");
  component.handleInput("\r");
  assert.equal(results[0]?.id, "other");
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.equal(results[1]?.id, "jev-latest");
  component.handleInput("\x1b");
  assert.equal(results[2], undefined);
});

test("empty lists and no search matches provide recovery and Enter stays inert", () => {
  const { component, results } = picker({ chat: [], classifier: [] });
  assert.match(component.render(90).join("\n"), /No authenticated models/);
  assert.match(component.render(90).join("\n"), /Saved selector unavailable/);
  component.handleInput("\x1b[A");
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  component.handleInput("missing");
  assert.match(component.render(90).join("\n"), /Clear search or switch tabs/);
  component.handleInput("\r");
  assert.deepEqual(results, []);
});

test("rendering handles resize, unicode, control characters, and bounded scrolling", () => {
  const models = Array.from({ length: 15 }, (_, i) => ({
    provider: "p",
    id: `模型-${i}`,
    name: "Bad\x1b[2J\nName",
  }));
  const { component } = picker(
    { chat: models as any, classifier: [] },
    { type: "chat", provider: "missing", id: "missing" },
  );
  for (let i = 0; i < 12; i++) component.handleInput("\x1b[B");
  const full = component.render(90).join("\n");
  assert.match(full, /13\/15/);
  assert.ok(!full.includes("\x1b[2J"));
  assert.match(full, /Bad Name/);
  for (const width of [0, 1, 8, 24, 80]) {
    component.invalidate();
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("custom picker guards RPC even when it has UI", async () => {
  await assert.rejects(
    showModelSelector(
      { mode: "rpc", hasUI: true } as any,
      { chat: [], classifier: [] },
      DEFAULT_SELECTOR_BACKEND,
    ),
    /requires TUI/,
  );
});
