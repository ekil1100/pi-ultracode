/** Explicit one-request deep mode and optional main-model selection. */
import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UltracodeMode } from "./mode.ts";
import type { UltracodeModeName } from "./depth.ts";
import type { ThinkingLevel } from "./thinking.ts";

export const ONE_SHOT_ENTRY_TYPE = "ultracode-one-shot";
const USAGE = "Usage: :ult [with <model>] <task>, anywhere in the message outside `code`";
type ModelRef = { provider: string; id: string; name?: string };
interface RequestState {
  version: 1;
  active: boolean;
  previousMode: UltracodeModeName;
  previousModel?: ModelRef;
  previousThinking: ThinkingLevel;
  selectedModel?: ModelRef;
  modelSuperseded?: boolean;
  thinkingSuperseded?: boolean;
}
const errorOf = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: errorOf });
const asyncAttempt = <A>(thunk: () => Promise<A>) =>
  Effect.tryPromise({ try: thunk, catch: errorOf });
const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  !!a && !!b && a.provider === b.provider && a.id === b.id;
const ref = (model: ModelRef | undefined): ModelRef | undefined =>
  model && { provider: model.provider, id: model.id };

// `:ult` or `:ult:` as a whole token: not glued to a word, path, or another
// colon before it (`a:ult`, `/:ult`, `::ult`), nor continued after it
// (`:ultra`, `:ult-x`, `:ult.ts`, `:ult:x`); punctuation, quotes and brackets
// around it are fine.
export const ONE_SHOT_TOKEN = /(?<![\w:/\\-]):ult:?(?![\w/\\-]|[.:]\w)/gi;
// A `with <model>` selector right after a marker; the model id stops before
// trailing punctuation (`with opus,`).
export const ONE_SHOT_SELECTOR = /^\s+with\s+([\w./@:-]*\w)/i;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

export interface OneShotMarker {
  start: number;
  /** End of the marker and its selector, if any. */
  end: number;
  /** Index among all marker tokens, including quoted ones. */
  nth: number;
  model?: string;
}

/** Every marker outside inline code and fenced blocks. */
export function findOneShotMarkers(text: string): OneShotMarker[] {
  const code = [...text.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length]);
  return [...text.matchAll(ONE_SHOT_TOKEN)].flatMap((m, nth) => {
    if (code.some(([a, b]) => m.index >= a && m.index < b)) return [];
    const sel = ONE_SHOT_SELECTOR.exec(text.slice(m.index + m[0].length));
    const end = m.index + m[0].length + (sel?.[0].length ?? 0);
    return [{ start: m.index, end, nth, model: sel?.[1] }];
  });
}

/** Removes every marker and its selector, leaving the task; the first selector picks the model. */
export function parseOneShot(text: string): { model?: string; task: string } {
  const markers = findOneShotMarkers(text);
  if (markers.some((m) => /^\s+with\s*$/i.test(text.slice(m.end)))) throw new Error(USAGE);
  const task = markers
    .reduceRight(
      (rest, m) => `${rest.slice(0, m.start).trimEnd()} ${rest.slice(m.end).trimStart()}`,
      text,
    )
    .trim();
  if (!task) throw new Error(USAGE);
  const model = markers.find((m) => m.model)?.model;
  return model ? { model, task } : { task };
}

/** Current provider wins, exact ID beats substring, ambiguity never chooses a model. */
export function resolveOneShotModel<T extends ModelRef>(
  selector: string,
  models: T[],
  provider?: string,
): T {
  const key = selector.toLowerCase();
  const exact = models.filter((model) => `${model.provider}/${model.id}`.toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  const candidates = selector.includes("/")
    ? []
    : models.filter(
        (model) => model.id.toLowerCase().includes(key) || model.name?.toLowerCase().includes(key),
      );
  const local = candidates.filter((model) => model.provider === provider);
  const preferred = local.length ? local : candidates;
  const exactIds = preferred.filter((model) => model.id.toLowerCase() === key);
  const pool = exactIds.length ? exactIds : preferred;
  if (pool.length === 1) return pool[0];
  if (!pool.length)
    throw new Error(
      `No authenticated model matches '${selector}'. Check /model or use provider/model-id.`,
    );
  throw new Error(
    `Ambiguous model '${selector}': ${pool.map((model) => `${model.provider}/${model.id}`).join(", ")}. Use provider/model-id.`,
  );
}

function savedRequest(entries: readonly unknown[]): RequestState | undefined {
  let latest: unknown;
  for (const entry of entries) {
    const item = entry as { type?: string; customType?: string; data?: unknown };
    if (item.type === "custom" && item.customType === ONE_SHOT_ENTRY_TYPE) latest = item.data;
  }
  const state = latest as RequestState | undefined;
  if (state?.version !== 1 || !state.active) return undefined;
  if (!["off", "auto", "focused", "standard", "deep"].includes(state.previousMode))
    throw new Error("Invalid saved one-shot mode.");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(state.previousThinking))
    throw new Error("Invalid saved one-shot thinking level.");
  for (const model of [state.previousModel, state.selectedModel]) {
    if (model && (typeof model.provider !== "string" || typeof model.id !== "string"))
      throw new Error("Invalid saved one-shot model.");
  }
  return { ...state };
}

export function registerOneShot(pi: ExtensionAPI, mode: UltracodeMode): void {
  let pending: RequestState | undefined;
  let changing = false;
  const journal = () => {
    if (pending) pi.appendEntry(ONE_SHOT_ENTRY_TYPE, { ...pending });
  };
  const updateStatus = (ctx: ExtensionContext) =>
    ctx.ui.setStatus(
      "ultracode",
      mode.isEnabled() ? mode.statusLine((text, color) => ctx.ui.theme.fg(color, text)) : undefined,
    );
  const report = (error: Error, text: string, ctx: ExtensionContext) =>
    attempt(() => {
      ctx.ui.notify(error.message, "error");
      if (ctx.hasUI) ctx.ui.setEditorText(text);
    });

  const restoreModel = (state: RequestState, ctx: ExtensionContext) =>
    Effect.suspend(() => {
      if (
        !state.selectedModel ||
        state.modelSuperseded ||
        !sameModel(ctx.model, state.selectedModel) ||
        !state.previousModel
      )
        return Effect.void;
      return attempt(() =>
        ctx.modelRegistry.find(state.previousModel!.provider, state.previousModel!.id),
      ).pipe(
        Effect.flatMap((model) =>
          model ? asyncAttempt(() => pi.setModel(model)) : Effect.succeed(false),
        ),
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(new Error("Original model is unavailable; check /model authentication.")),
        ),
      );
    });
  const restore = (ctx: ExtensionContext) =>
    Effect.suspend(() => {
      if (!pending) return Effect.succeed(true);
      const state = pending;
      const currentThinking = pi.getThinkingLevel();
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          changing = true;
        }),
        () =>
          restoreModel(state, ctx).pipe(
            Effect.andThen(
              attempt(() => {
                if (!state.modelSuperseded)
                  pi.setThinkingLevel(
                    state.thinkingSuperseded ? currentThinking : state.previousThinking,
                  );
                if (mode.getMode() === "deep") {
                  if (state.previousMode === "off") mode.disable(pi);
                  else mode.enable(pi, state.previousMode);
                }
                pending = { ...state, active: false };
                journal();
                pending = undefined;
                updateStatus(ctx);
                return true;
              }),
            ),
          ),
        () =>
          Effect.sync(() => {
            changing = false;
          }),
      ).pipe(
        Effect.catch((error) =>
          attempt(() => {
            ctx.ui.notify(`:ult restore failed: ${error.message}`, "error");
            return false;
          }),
        ),
      );
    });

  const begin = (text: string, ctx: ExtensionContext) =>
    Effect.suspend(() => {
      if (!ctx.isIdle())
        return Effect.fail(
          new Error(":ult requires an idle session. Wait or cancel the current run first."),
        );
      if (pending || changing)
        return Effect.fail(
          new Error(
            "A :ult request is already pending. Wait for settlement or restart to recover it.",
          ),
        );
      if (!ctx.model)
        return Effect.fail(new Error("Select your normal model with /model before using :ult."));
      return restore(ctx).pipe(
        Effect.flatMap((ok) =>
          ok
            ? attempt(() => {
                const request = parseOneShot(text);
                const selected = request.model
                  ? resolveOneShotModel(
                      request.model,
                      ctx.modelRegistry.getAvailable(),
                      ctx.model?.provider,
                    )
                  : undefined;
                pending = {
                  version: 1,
                  active: true,
                  previousMode: mode.getMode(),
                  previousModel: ref(ctx.model),
                  previousThinking: pi.getThinkingLevel(),
                  selectedModel: ref(selected),
                };
                journal(); // Record durable intent before switching anything.
                return { request, selected };
              })
            : Effect.fail(new Error("Resolve the previous :ult restore failure first.")),
        ),
        Effect.flatMap(({ request, selected }) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              changing = true;
            }),
            () =>
              (selected ? asyncAttempt(() => pi.setModel(selected)) : Effect.succeed(true)).pipe(
                Effect.flatMap((ok) =>
                  ok
                    ? attempt(() => {
                        mode.enable(pi, "deep");
                        updateStatus(ctx);
                        ctx.ui.notify(
                          `One-shot Ultracode deep${selected ? ` · ${selected.provider}/${selected.id}` : " · current model"}`,
                          "info",
                        );
                        return request.task;
                      })
                    : Effect.fail(new Error("Authentication unavailable for the selected model.")),
                ),
              ),
            () =>
              Effect.sync(() => {
                changing = false;
              }),
          ),
        ),
        Effect.catch((error) => restore(ctx).pipe(Effect.andThen(Effect.fail(error)))),
      );
    });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (findOneShotMarkers(event.text).length)
      return Effect.runPromise(
        begin(event.text, ctx).pipe(
          Effect.map((text) => ({ action: "transform" as const, text, images: event.images })),
          Effect.catch((error) =>
            report(error, event.text, ctx).pipe(Effect.as({ action: "handled" as const })),
          ),
        ),
      );
    // Native preflight can fail before a run starts; don't leak its idle override.
    if (pending && ctx.isIdle())
      return Effect.runPromise(
        restore(ctx).pipe(
          Effect.map((ok) => ({ action: ok ? ("continue" as const) : ("handled" as const) })),
        ),
      );
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    const { sections } = event.systemPromptOptions;
    if (!pending?.selectedModel) {
      delete sections.ultracode_one_shot;
      return;
    }
    const model = `${pending.selectedModel.provider}/${pending.selectedModel.id}`;
    sections.ultracode_one_shot = `The user selected ${model} for this one-shot request. Prefer it for substantive workflow agents, choosing only its supported task-appropriate effort. Cheaper bounded discovery/synthesis is allowed; explicit child model choices are not forced. Report material deviations. Do not change the parent model.`;
  });
  pi.on("model_select", () => {
    if (pending && !changing) {
      pending.modelSuperseded = true;
      pending.thinkingSuperseded = true;
      journal();
    }
  });
  pi.on("thinking_level_select", () => {
    if (pending && !changing) {
      pending.thinkingSuperseded = true;
      journal();
    }
  });
  // agent_end is intentionally NOT a cleanup boundary: retries/compaction can follow.
  pi.on("agent_settled", (_event, ctx) => Effect.runPromise(restore(ctx).pipe(Effect.asVoid)));
  pi.on("session_shutdown", (_event, ctx) => Effect.runPromise(restore(ctx).pipe(Effect.asVoid)));
  const recover = (ctx: ExtensionContext) =>
    attempt(() => {
      pending = savedRequest(ctx.sessionManager.getBranch());
    }).pipe(Effect.andThen(restore(ctx)), Effect.asVoid);
  // Register after mode restoration so interrupted overrides recover on the active branch.
  pi.on("session_start", (_event, ctx) => Effect.runPromise(recover(ctx)));
  pi.on("session_tree", (_event, ctx) => Effect.runPromise(recover(ctx)));
}
