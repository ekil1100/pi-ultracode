import { Effect } from "effect";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model, ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  Spacer,
  Text,
  fuzzyFilter,
  truncateToWidth,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import { backendLabel, type SelectorBackend } from "./selector-backend.ts";

export interface SelectorModels {
  chat: readonly Model<Api>[];
  classifier: readonly ClassifierModel<ClassifierApi>[];
}
type Item = { backend: SelectorBackend; name: string; provider: string; id: string };
const safe = (text: string) =>
  // oxlint-disable-next-line no-control-regex -- Model labels must not emit terminal controls.
  stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const equal = (a: SelectorBackend, b: SelectorBackend | undefined) =>
  a.type === b?.type && a.provider === b.provider && a.id === b.id;

export function showModelSelector(
  ctx: ExtensionContext,
  models: SelectorModels,
  current: SelectorBackend | undefined,
) {
  return Effect.runPromise(
    ctx.mode !== "tui"
      ? Effect.fail(new Error("The model picker requires TUI mode."))
      : Effect.tryPromise({
          // No overlay options: Pi mounts this component in the bottom editor container.
          try: () =>
            ctx.ui.custom<SelectorBackend | undefined>((tui, theme, kb, done) =>
              createModelSelector(models, current, tui, theme, kb, done),
            ),
          catch: (error) => error,
        }),
  );
}

/** Pi /model layout and row format, with backend tabs instead of scopes. */
export function createModelSelector(
  models: SelectorModels,
  current: SelectorBackend | undefined,
  tui: TUI,
  theme: Theme,
  kb: KeybindingsManager,
  done: (backend: SelectorBackend | undefined) => void,
) {
  const container = new Container();
  const input = new Input();
  let filtered: Item[] = [];
  let selected = 0;
  let tab = current?.type ?? "classifier";
  const items: Item[] = (["chat", "classifier"] as const)
    .flatMap((type) =>
      models[type].map((model) => ({
        backend: { type, provider: model.provider, id: model.id },
        name: safe(model.name),
        provider: safe(model.provider),
        id: safe(model.id),
      })),
    )
    .sort(
      (a, b) =>
        Number(equal(b.backend, current)) - Number(equal(a.backend, current)) ||
        a.provider.localeCompare(b.provider),
    );
  filter();
  return {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    handleInput,
    render,
    invalidate: () => container.invalidate(),
  };

  function filter(): void {
    const active = items.filter((item) => item.backend.type === tab);
    const query = input.getValue();
    // Match native /model's provider-prefixed fuzzy-search ranking.
    filtered = query
      ? fuzzyFilter(
          active,
          query,
          (item) =>
            `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id} ${item.name}`,
        )
      : active;
    selected = query
      ? 0
      : Math.max(
          0,
          filtered.findIndex((item) => equal(item.backend, current)),
        );
  }

  function handleInput(data: string): void {
    if (kb.matches(data, "tui.input.tab")) {
      tab = tab === "chat" ? "classifier" : "chat";
      filter();
    } else if (kb.matches(data, "tui.select.cancel")) {
      done(undefined);
      return;
    } else if (kb.matches(data, "tui.select.confirm")) {
      const item = filtered[selected];
      if (item) done(item.backend);
      return;
    } else if (kb.matches(data, "tui.select.up"))
      selected = (selected + filtered.length - 1) % Math.max(1, filtered.length);
    else if (kb.matches(data, "tui.select.down"))
      selected = (selected + 1) % Math.max(1, filtered.length);
    else {
      input.handleInput(data);
      filter();
    }
    tui.requestRender();
  }

  function render(width: number): string[] {
    if (width < 1) return [];
    container.clear();
    const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);
    container.addChild(new DynamicBorder((text) => fg("border", text)));
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        fg(tab === "chat" ? "accent" : "muted", "chat model") +
          fg("muted", " | ") +
          fg(tab === "classifier" ? "accent" : "muted", "classifier"),
        0,
        0,
      ),
    );
    container.addChild(
      new Text(fg("dim", "Chooses child effort; execution models stay unchanged."), 0, 0),
    );
    container.addChild(new Spacer(1));
    container.addChild(input);
    container.addChild(new Spacer(1));
    const start = Math.max(0, Math.min(selected - 5, filtered.length - 10));
    for (const [offset, item] of filtered.slice(start, start + 10).entries()) {
      const active = start + offset === selected;
      const cursor = active ? fg("accent", "→ ") : "  ";
      const marker = equal(item.backend, current) ? fg("accent", "✓ ") : "  ";
      const id = active ? fg("accent", item.id) : item.id;
      // Native /model uses fixed cursor/marker columns, then ID and muted provider.
      container.addChild(
        new Text(
          truncateToWidth(`${cursor}${marker}${id} ${fg("muted", `[${item.provider}]`)}`, width),
          0,
          0,
        ),
      );
    }
    if (filtered.length > 10)
      container.addChild(new Text(fg("muted", `  (${selected + 1}/${filtered.length})`), 0, 0));
    const selectedItem = filtered[selected];
    if (selectedItem) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(fg("muted", `  Model Name: ${selectedItem.name}`), 0, 0));
    } else
      container.addChild(
        new Text(
          fg(
            "muted",
            input.getValue()
              ? "  No matching models. Clear search or switch tabs."
              : "  No authenticated models. Use /login to configure providers.",
          ),
          0,
          0,
        ),
      );
    if (!current)
      container.addChild(
        new Text(fg("warning", "No selector saved. Choose a model and press Enter."), 0, 0),
      );
    else if (!items.some((item) => equal(item.backend, current)))
      container.addChild(
        new Text(fg("warning", `Saved selector unavailable: ${safe(backendLabel(current))}`), 0, 0),
      );
    container.addChild(new Spacer(1));
    const hint = (id: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      kb.getKeys(id).join("/") || "unbound";
    container.addChild(
      new Text(
        fg(
          "dim",
          `${hint("tui.input.tab")} switch tab · ${hint("tui.select.up")}/${hint("tui.select.down")} navigate · ${hint("tui.select.confirm")} save · ${hint("tui.select.cancel")} cancel`,
        ),
        0,
        0,
      ),
    );
    container.addChild(new DynamicBorder((text) => fg("border", text)));
    return container.render(width).map((line) => truncateToWidth(line, width));
  }
}
