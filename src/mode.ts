/**
 * Ultracode mode controller.
 *
 * Ultracode is a session-scoped semantic analysis-depth mode. While active, it:
 *   - leaves the parent session's thinking level under user control,
 *   - keeps the `workflow` tool active,
 *   - injects the configured auto/focused/standard/deep policy on every turn,
 *   - persists branch-local mode state across reload, resume, fork, and compaction.
 */

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

export class UltracodeMode {
  private mode: UltracodeModeName = "off";
  private suspended = false;
  private readonly workflowToolName: string;

  constructor(workflowToolName: string) {
    this.workflowToolName = workflowToolName;
  }

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  bindThinkingPreferenceStore(_store: ThinkingPreferenceStore | undefined): void {}

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  setCurrentModelSupportsThinking(_supportsThinking: boolean | undefined): void {}

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  setRuntimeSupportsMaxThinking(_supportsMaxThinking: boolean): void {}

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  async flushThinkingPreference(): Promise<void> {}

  /** Enable auto if off, otherwise disable. Returns the new enabled state. */
  toggle(pi: ExtensionAPI): boolean {
    if (this.isEnabled()) {
      this.disable(pi);
      return false;
    }
    this.enable(pi, "auto");
    return true;
  }

  getMode(): UltracodeModeName {
    return this.mode;
  }

  /** @deprecated Ultracode no longer applies a parent thinking level. */
  getAppliedThinking(): ThinkingLevel | undefined {
    return undefined;
  }

  /**
   * @deprecated Workflow agents now select effort per call. An omitted suffix
   * falls back to the child Pi session's normal user/model configuration rather
   * than a mode-owned default.
   */
  getSubagentThinkingLevel(): ThinkingLevel | undefined {
    return undefined;
  }

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  reapplyConfiguredThinking(_pi: ExtensionAPI): boolean {
    return false;
  }

  /** @deprecated Parent effort is user-owned; retained as a compatibility no-op. */
  reapplyMaximumThinking(_pi: ExtensionAPI): boolean {
    return false;
  }

  /** @deprecated Model changes do not alter Ultracode mode or parent effort. */
  handleModelSelect(_pi: ExtensionAPI): boolean {
    return false;
  }

  /** @deprecated Parent effort is never restored because Ultracode never changes it. */
  restorePreviousThinking(_pi: ExtensionAPI): void {}

  /** Quiesce tool and prompt enforcement before session teardown. */
  suspend(pi: ExtensionAPI): void {
    if (this.suspended) {
      this.syncWorkflowTool(pi);
      return;
    }
    this.suspended = true;
    this.syncWorkflowTool(pi);
  }

  /** @deprecated User-selected parent effort is accepted without interception. */
  handleThinkingLevelSelect(_pi: ExtensionAPI, _level: ThinkingLevel): boolean {
    return false;
  }

  isEnabled(): boolean {
    return this.mode !== "off";
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  /** Keep tool availability aligned with the current mode state. */
  syncWorkflowTool(pi: ExtensionAPI): void {
    if (this.isEnforcing()) this.activateWorkflowTool(pi);
    else this.deactivateWorkflowTool(pi);
  }

  tagline(): string {
    return ULTRACODE_TAGLINE;
  }

  /**
   * Enable or switch modes. The no-argument form retains the pre-0.5
   * programmatic deep behavior; user commands pass an explicit mode and bare
   * `/ultracode` uses toggle() to enter auto.
   */
  enable(pi: ExtensionAPI, mode: ActiveUltracodeMode = "deep"): void {
    this.suspended = false;
    this.mode = mode;
    this.syncWorkflowTool(pi);
    this.persist(pi);
  }

  /** Turn Ultracode off without changing the parent thinking level. */
  disable(pi: ExtensionAPI): void {
    if (!this.isEnabled()) {
      this.syncWorkflowTool(pi);
      return;
    }
    this.mode = "off";
    this.suspended = false;
    this.syncWorkflowTool(pi);
    this.persist(pi);
  }

  /** Restore mode state from the active session branch without touching effort. */
  restore(
    pi: ExtensionAPI,
    entries: Array<{
      type?: string;
      customType?: string;
      data?: unknown;
      thinkingLevel?: unknown;
    }>,
  ): void {
    let latestData: unknown;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE && entry.data) {
        latestData = entry.data;
      }
    }

    this.mode = parsePersistedModeState(latestData)?.mode ?? "off";
    this.suspended = false;
    this.syncWorkflowTool(pi);
  }

  /** Append the configured semantic-depth policy to the turn's system prompt. */
  beforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (!this.isEnforcing() || !isActiveUltracodeMode(this.mode)) return undefined;
    const block = ultracodeSystemBlock(this.mode);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}\n\n${ULTRACODE_ACTIVE_REMINDER}` };
  }

  statusLine(styleLabel: (label: string) => string = (label) => label): string {
    return [styleLabel("ultracode"), this.mode].join(" · ");
  }

  isEnforcing(): boolean {
    return this.isEnabled() && !this.suspended;
  }

  private activateWorkflowTool(pi: ExtensionAPI): void {
    try {
      const active = pi.getActiveTools();
      if (!active.includes(this.workflowToolName)) {
        pi.setActiveTools([...active, this.workflowToolName]);
      }
    } catch {
      // Prompt policy remains usable when tool selection is unavailable.
    }
  }

  private deactivateWorkflowTool(pi: ExtensionAPI): void {
    try {
      const active = pi.getActiveTools();
      if (active.includes(this.workflowToolName)) {
        pi.setActiveTools(active.filter((name) => name !== this.workflowToolName));
      }
    } catch {
      // The execution guards still fail closed when selection cannot be updated.
    }
  }

  private persist(pi: ExtensionAPI): void {
    const state: PersistedModeState = { mode: this.mode };
    try {
      pi.appendEntry(MODE_ENTRY_TYPE, state);
    } catch {
      // ignore persistence failures
    }
  }
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
