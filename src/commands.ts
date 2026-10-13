/**
 * Slash commands: `/ultracode` (mode toggle) and `/workflows` (run manager).
 */

import { Effect, Result } from "effect";
import { showModelSelector, type SelectorModels } from "./model-selector.ts";
import { backendLabel, isSelectorBackend, type SelectorBackend } from "./selector-backend.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ACTIVE_ULTRACODE_MODES,
  MODE_DESCRIPTIONS,
  isActiveUltracodeMode,
  isUltracodeModeName,
} from "./depth.ts";
import type { UltracodeMode } from "./mode.ts";
import type { UltracodePreferenceStore } from "./preferences.ts";
import type { WorkflowRegistry } from "./workflow/registry.ts";
import { workflowRunsDir } from "./workflow/tool.ts";
import { openWorkflowOverlay } from "./workflow/workflow-overlay.ts";

const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: (error) => error });

export function registerCommands(
  pi: ExtensionAPI,
  mode: UltracodeMode,
  registry: WorkflowRegistry,
  preferences: UltracodePreferenceStore,
): void {
  pi.registerCommand("ultracode", {
    description:
      "Analysis depth: auto routing, focused local checks, standard targeted verification, deep invariant/counterexample checks; off|status|default on|off|model",
    getArgumentCompletions(prefix: string) {
      return [
        ...ACTIVE_ULTRACODE_MODES,
        "off",
        "status",
        "default",
        "default on",
        "default off",
        "model",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({
          value,
          label: value,
          description: isUltracodeModeName(value) ? MODE_DESCRIPTIONS[value] : undefined,
        }));
    },
    handler: (args: string, ctx) =>
      Effect.runPromise(
        Effect.suspend(() => {
          const parts = args.trim().split(/\s+/).filter(Boolean);
          const sub = (parts[0] ?? "").toLowerCase();

          if (sub === "model") return configureSelector(parts, ctx, preferences);
          return attempt(() => {
            // Bare `/ultracode` enables auto from off and disables any active mode.
            if (sub === "") {
              const nowOn = mode.toggle(pi);
              ctx.ui.notify(
                nowOn
                  ? `Ultracode auto — ${MODE_DESCRIPTIONS.auto}`
                  : "Ultracode off — workflow tool disabled; parent effort unchanged.",
                "info",
              );
              ctx.ui.setStatus(
                "ultracode",
                nowOn ? mode.statusLine((text, color) => ctx.ui.theme.fg(color, text)) : undefined,
              );
              return;
            }

            if (sub === "default") {
              const value = parts[1]?.toLowerCase();
              if (parts.length > 2 || (value !== undefined && value !== "on" && value !== "off")) {
                ctx.ui.notify("Usage: /ultracode default [on|off]", "error");
                return;
              }
              Result.try({
                try: () => {
                  if (value !== undefined) preferences.setDefaultEnabled(value === "on");
                  const enabled = preferences.getDefaultEnabled();
                  if (value === "on") {
                    if (!mode.isEnabled()) mode.enable(pi, "auto");
                    ctx.ui.setStatus(
                      "ultracode",
                      mode.statusLine((text, color) => ctx.ui.theme.fg(color, text)),
                    );
                  }
                  const sessionStatus =
                    value === "on"
                      ? `current session: ${mode.getMode()}`
                      : "current session unchanged";
                  ctx.ui.notify(
                    `Ultracode default ${enabled ? "on (auto)" : "off"} — global startup preference; ${sessionStatus}.`,
                    "info",
                  );
                },
                catch: (error) => error,
              }).pipe(
                Result.getOrElse((error) => {
                  ctx.ui.notify(
                    `Failed to ${value === undefined ? "read" : "save"} Ultracode default: ${String(error)}`,
                    "error",
                  );
                }),
              );
              return;
            }

            if (parts.length > 1) {
              ctx.ui.notify(ultracodeUsage(), "error");
              return;
            }

            if (sub === "status") {
              ctx.ui.notify(
                `${mode.statusLine()} — ${MODE_DESCRIPTIONS[mode.getMode()]} Depth is independent of model effort.`,
                "info",
              );
              return;
            }

            if (sub === "off") {
              mode.disable(pi);
              ctx.ui.notify(
                "Ultracode off — workflow tool disabled; parent effort unchanged.",
                "info",
              );
              ctx.ui.setStatus("ultracode", undefined);
              return;
            }

            if (!isActiveUltracodeMode(sub)) {
              ctx.ui.notify(ultracodeUsage(), "error");
              return;
            }

            mode.enable(pi, sub);
            ctx.ui.notify(`Ultracode ${sub} — ${MODE_DESCRIPTIONS[sub]}`, "info");
            ctx.ui.setStatus(
              "ultracode",
              mode.statusLine((text, color) => ctx.ui.theme.fg(color, text)),
            );
          });
        }),
      ),
  });

  const openWorkflows = (ctx: ExtensionContext, runId?: string) =>
    attempt(() => registry.restoreRuns(workflowRunsDir(ctx))).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => openWorkflowOverlay(ctx, registry, runId),
          catch: (error) => error,
        }),
      ),
    );

  pi.registerCommand("workflows", {
    description:
      "Open the interactive workflow/task detail overlay. Usage: /workflows [runId | abort]",
    getArgumentCompletions(prefix: string) {
      const values = [
        "abort",
        ...registry
          .list()
          .map((handle) => handle.snapshot.runId)
          .filter((runId): runId is string => Boolean(runId)),
      ];
      return [...new Set(values)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: (args: string, ctx) =>
      Effect.runPromise(
        Effect.suspend(() => {
          const arg = args.trim();
          return arg.toLowerCase() === "abort"
            ? attempt(() => {
                registry.abortAll();
                ctx.ui.notify("Requested abort of all active workflow runs.", "warning");
              })
            : openWorkflows(ctx, arg || undefined);
        }),
      ),
  });

  pi.registerShortcut("f6", {
    description: "Open workflow task details",
    handler: (ctx) => Effect.runPromise(openWorkflows(ctx)),
  });
}

function ultracodeUsage(): string {
  return [
    "Usage: /ultracode [auto|focused|standard|deep|off|status] or /ultracode default [on|off] or /ultracode model [<provider>/<id>]",
    ...ACTIVE_ULTRACODE_MODES.map((mode) => `${mode}: ${MODE_DESCRIPTIONS[mode]}`),
    "Depth is independent of model effort. Fixed modes never switch depth automatically.",
  ].join("\n");
}

const external = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

function configureSelector(
  parts: string[],
  ctx: ExtensionContext,
  preferences: UltracodePreferenceStore,
) {
  const usage = "Usage: /ultracode model [<provider>/<id>]";
  const reference = parts[1];
  const slash = reference?.indexOf("/") ?? -1;
  if (reference !== undefined) {
    if (
      parts.length !== 2 ||
      slash < 1 ||
      !isSelectorBackend({
        type: "chat",
        provider: reference.slice(0, slash),
        id: reference.slice(slash + 1),
      })
    )
      return attempt(() => ctx.ui.notify(usage, "error"));
  } else if (ctx.mode !== "tui") {
    return attempt(() => ctx.ui.notify(`The model picker requires TUI mode. ${usage}`, "error"));
  }
  return Effect.all(
    {
      chat: external(() => ctx.modelRegistry.getAvailableOfType("chat")),
      classifier: external(() => ctx.modelRegistry.getAvailableOfType("classifier")),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap((models) =>
      reference !== undefined
        ? resolveSelectorReference(ctx, models, reference, slash)
        : external(() => showModelSelector(ctx, models, preferences.getSelectorBackend())),
    ),
    Effect.flatMap((backend) => (backend ? saveSelector(ctx, preferences, backend) : Effect.void)),
    Effect.catch((error) =>
      attempt(() =>
        ctx.ui.notify(`Failed to configure Ultracode selector: ${String(error)}`, "error"),
      ),
    ),
  );
}

function resolveSelectorReference(
  ctx: ExtensionContext,
  models: SelectorModels,
  reference: string,
  slash: number,
) {
  const provider = reference.slice(0, slash);
  const id = reference.slice(slash + 1);
  const matches = (["chat", "classifier"] as const)
    .filter((type) => models[type].some((model) => model.provider === provider && model.id === id))
    .map((type) => ({ type, provider, id }));
  if (matches.length === 0) {
    return attempt(() => {
      ctx.ui.notify(
        `Selector unavailable: ${reference}. Use /login and choose an authenticated model.`,
        "error",
      );
      return undefined;
    });
  }
  if (matches.length === 1) return Effect.succeed(matches[0]);
  if (!ctx.hasUI) {
    return attempt(() => {
      ctx.ui.notify(
        `Selector ${reference} supports both chat and classifier. Run /ultracode model in TUI mode to choose a type.`,
        "error",
      );
      return undefined;
    });
  }
  return external(() =>
    ctx.ui.select(
      `Choose selector type for ${reference}`,
      matches.map((match) => match.type),
    ),
  ).pipe(Effect.map((type) => matches.find((match) => match.type === type)));
}

function saveSelector(
  ctx: ExtensionContext,
  preferences: UltracodePreferenceStore,
  backend: SelectorBackend,
) {
  // Recheck authentication after the picker closes, before persisting.
  return external(() => ctx.modelRegistry.getAvailableOfType(backend.type)).pipe(
    Effect.flatMap((available) =>
      attempt(() => {
        if (
          !available.some((model) => model.provider === backend.provider && model.id === backend.id)
        ) {
          ctx.ui.notify(
            `Selector unavailable: ${backendLabel(backend)}. Use /login and choose an authenticated model.`,
            "error",
          );
          return;
        }
        preferences.setSelectorBackend(backend);
        ctx.ui.notify(
          `Ultracode selector: ${backendLabel(backend)} — saved globally; execution models unchanged.`,
          "info",
        );
      }),
    ),
  );
}
