/**
 * Ultracode mode controller.
 *
 * Ultracode is a session-scoped semantic analysis-depth mode. While active, it:
 *   - leaves the parent session's thinking level under user control,
 *   - keeps the `workflow` tool active,
 *   - injects the configured auto/focused/standard/deep policy on every turn,
 *   - persists branch-local mode state across reload, resume, fork, and compaction.
 */

import { Effect } from "effect";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isActiveUltracodeMode,
  type ActiveUltracodeMode,
  type UltracodeModeName,
} from "./depth.ts";
import { ULTRACODE_ACTIVE_REMINDER, ULTRACODE_TAGLINE, ultracodeSystemBlock } from "./prompts.ts";
import type { ThinkingLevel } from "./thinking.ts";

export type { ThinkingLevel } from "./thinking.ts";

export const MODE_ENTRY_TYPE = "ultracode-mode";

interface PersistedModeState {
  mode: UltracodeModeName;
}

/** @deprecated Ultracode no longer reads or writes the parent's effort preference. */
export interface ThinkingPreferenceSnapshot {
  global: ThinkingLevel | undefined;
  effective: ThinkingLevel | undefined;
}

/** @deprecated Ultracode no longer reads or writes the parent's effort preference. */
export interface ThinkingPreferenceStore {
  getThinkingPreference(): ThinkingPreferenceSnapshot;
  setDefaultThinkingLevel(level: ThinkingLevel | undefined): void | Promise<void>;
  flush?(): Promise<void>;
}

/** Public constructor retained for Pi hosts; state and operations live in closures. */
export interface UltracodeMode extends ReturnType<typeof makeUltracodeMode> {}
export class UltracodeMode {
  constructor(workflowToolName: string) {
    Object.assign(this, makeUltracodeMode(workflowToolName));
  }
}

function makeUltracodeMode(workflowToolName: string) {
  let mode: UltracodeModeName = "off";
  let suspended = false;
  const isEnabled = () => mode !== "off";
  const isEnforcing = () => isEnabled() && !suspended;
  const bestEffort = (thunk: () => void) => Effect.try(thunk).pipe(Effect.ignore);

  const syncTool = (pi: ExtensionAPI) =>
    bestEffort(() => {
      const active = pi.getActiveTools();
      if (isEnforcing()) {
        if (!active.includes(workflowToolName)) pi.setActiveTools([...active, workflowToolName]);
      } else if (active.includes(workflowToolName)) {
        pi.setActiveTools(active.filter((name) => name !== workflowToolName));
      }
      // The execution guard remains authoritative if host tool selection fails.
    });
  const syncWorkflowTool = (pi: ExtensionAPI) => Effect.runSync(syncTool(pi));
  const configure = (pi: ExtensionAPI, next: UltracodeModeName) =>
    Effect.sync(() => {
      mode = next;
      suspended = false;
    }).pipe(
      Effect.andThen(syncTool(pi)),
      Effect.andThen(
        bestEffort(() => pi.appendEntry(MODE_ENTRY_TYPE, { mode } satisfies PersistedModeState)),
      ),
    );
  // The no-argument form retains the programmatic deep default.
  const enable = (pi: ExtensionAPI, next: ActiveUltracodeMode = "deep") =>
    Effect.runSync(configure(pi, next));
  // Persist explicit off so startup defaults respect the session's choice.
  const disable = (pi: ExtensionAPI) => Effect.runSync(configure(pi, "off"));

  return {
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    bindThinkingPreferenceStore(_store: ThinkingPreferenceStore | undefined): void {},
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    setCurrentModelSupportsThinking(_supportsThinking: boolean | undefined): void {},
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    setRuntimeSupportsMaxThinking(_supportsMaxThinking: boolean): void {},
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    flushThinkingPreference: (): Promise<void> => Effect.runPromise(Effect.void),
    /** @deprecated Ultracode no longer applies a parent thinking level. */
    getAppliedThinking: (): ThinkingLevel | undefined => undefined,
    /** @deprecated Workflow agents select effort per call using child session defaults. */
    getSubagentThinkingLevel: (): ThinkingLevel | undefined => undefined,
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    reapplyConfiguredThinking: (_pi: ExtensionAPI): boolean => false,
    /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
    reapplyMaximumThinking: (_pi: ExtensionAPI): boolean => false,
    /** @deprecated Model changes do not alter Ultracode mode or parent effort. */
    handleModelSelect: (_pi: ExtensionAPI): boolean => false,
    /** @deprecated Parent effort is never restored because Ultracode never changes it. */
    restorePreviousThinking(_pi: ExtensionAPI): void {},
    /** @deprecated User-selected parent effort is accepted without interception. */
    handleThinkingLevelSelect: (_pi: ExtensionAPI, _level: ThinkingLevel): boolean => false,
    enable,
    disable,
    isEnabled,
    isEnforcing,
    isSuspended: () => suspended,
    getMode: () => mode,
    tagline: () => ULTRACODE_TAGLINE,
    syncWorkflowTool,
    toggle(pi: ExtensionAPI): boolean {
      const nowOn = !isEnabled();
      Effect.runSync(configure(pi, nowOn ? "auto" : "off"));
      return nowOn;
    },
    /** Quiesce tool and prompt enforcement before session teardown. */
    suspend(pi: ExtensionAPI): void {
      Effect.runSync(
        Effect.sync(() => {
          suspended = true;
        }).pipe(Effect.andThen(syncTool(pi))),
      );
    },
    /** Restore branch-local state; return whether a saved mode was found. */
    restore(
      pi: ExtensionAPI,
      entries: Array<{
        type?: string;
        customType?: string;
        data?: unknown;
        thinkingLevel?: unknown;
      }>,
    ): boolean {
      return Effect.runSync(
        Effect.sync(() => {
          let latestData: unknown;
          for (const entry of entries) {
            if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE && entry.data) {
              latestData = entry.data;
            }
          }
          const state = parsePersistedModeState(latestData);
          mode = state?.mode ?? "off";
          suspended = false;
          return state !== undefined;
        }).pipe(Effect.tap(() => syncTool(pi))),
      );
    },
    /** Update only our prompt section so Pi can persist and diff it across turns. */
    beforeAgentStart(
      event: { systemPromptOptions: { sections: Record<string, string> } },
      signal?: AbortSignal,
    ): void {
      const { sections } = event.systemPromptOptions;
      if (signal?.aborted || !isEnforcing() || !isActiveUltracodeMode(mode)) {
        delete sections.ultracode;
        return;
      }
      sections.ultracode = `${ultracodeSystemBlock(mode)}\n\n${ULTRACODE_ACTIVE_REMINDER}`;
    },
    statusLine(style: (text: string, color: "accent" | "dim") => string = (text) => text): string {
      return [style("ultracode", "accent"), style(mode, "dim")].join(" · ");
    },
  };
}

function parsePersistedModeState(data: unknown): PersistedModeState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as Record<string, unknown>;
  // Sessions written before semantic-depth modes stored only enabled:boolean.
  // Preserve their behavior by migrating enabled:true to the old deep mode.
  const mode: UltracodeModeName = isActiveUltracodeMode(value.mode)
    ? value.mode
    : value.mode === "off"
      ? "off"
      : value.enabled === true
        ? "deep"
        : "off";
  return { mode };
}
