/**
 * Ultracode mode controller.
 *
 * Ultracode is a session-scoped semantic analysis-depth mode. While active, it:
 *   - applies the configured mode's default thinking level while preserving the
 *     user's previous level,
 *   - keeps the `workflow` tool active,
 *   - injects the configured auto/focused/standard/deep policy on every turn,
 *   - persists branch-local mode state across reload, resume, fork, and compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isActiveUltracodeMode,
  thinkingLevelForMode,
  type ActiveUltracodeMode,
  type UltracodeModeName,
} from "./depth.ts";
import { ULTRACODE_ACTIVE_REMINDER, ULTRACODE_TAGLINE, ultracodeSystemBlock } from "./prompts.ts";
import {
  LEGACY_ULTRACODE_THINKING_LEVEL,
  ULTRACODE_THINKING_LEVEL,
  isThinkingLevel,
  type ThinkingLevel,
} from "./thinking.ts";

export type { ThinkingLevel } from "./thinking.ts";

export const MODE_ENTRY_TYPE = "ultracode-mode";

interface PersistedModeState {
  mode: UltracodeModeName;
  previousThinking?: ThinkingLevel;
  /** `null` records that the setting was originally absent (Pi defaults to medium). */
  previousDefaultThinking?: ThinkingLevel | null;
  /** Deferred when the selected model cannot represent the pre-mode level. */
  pendingPreviousThinking?: ThinkingLevel;
}

export interface ThinkingPreferenceSnapshot {
  /** Raw global value; undefined means Pi's implicit medium default. */
  global: ThinkingLevel | undefined;
  /** Global + project merged value used by Pi for model switches. */
  effective: ThinkingLevel | undefined;
}

/** Adapter for preserving Pi's raw global effort preference while this mode is active. */
export interface ThinkingPreferenceStore {
  getThinkingPreference(): ThinkingPreferenceSnapshot;
  setDefaultThinkingLevel(level: ThinkingLevel | undefined): void | Promise<void>;
  flush?(): Promise<void>;
}

export class UltracodeMode {
  private mode: UltracodeModeName = "off";
  private suspended = false;
  private previousThinking: ThinkingLevel | undefined;
  private previousDefaultThinking: ThinkingLevel | null | undefined;
  /** Restore a level later if the current non-reasoning model clamps it to off. */
  private pendingPreviousThinking: ThinkingLevel | undefined;
  /** The level Pi actually applied after clamping the configured request. */
  private appliedThinking: ThinkingLevel | undefined;
  /** Prevent mode-owned thinking changes from being mistaken for manual overrides. */
  private applyingThinking = false;
  private thinkingPreferenceStore: ThinkingPreferenceStore | undefined;
  private preferenceWriteQueue: Promise<void> = Promise.resolve();
  private preferenceWriteGeneration = 0;
  private legacyDefaultMigrationPending = false;
  private pendingClearGeneration = 0;
  private currentModelSupportsThinking: boolean | undefined;
  private runtimeSupportsMaxThinking = true;
  private readonly workflowToolName: string;

  constructor(workflowToolName: string) {
    this.workflowToolName = workflowToolName;
  }

  /** Bind the settings adapter once the session cwd is known. */
  bindThinkingPreferenceStore(store: ThinkingPreferenceStore | undefined): void {
    this.preferenceWriteGeneration++;
    this.thinkingPreferenceStore = store;
  }

  /** Track capability explicitly; `off` alone cannot distinguish clamp from intent. */
  setCurrentModelSupportsThinking(supportsThinking: boolean | undefined): void {
    this.currentModelSupportsThinking = supportsThinking;
  }

  /** Configure migration behavior for Pi versions released before `max`. */
  setRuntimeSupportsMaxThinking(supportsMaxThinking: boolean): void {
    this.runtimeSupportsMaxThinking = supportsMaxThinking;
  }

  /** Wait for queued preference restoration before teardown or command completion. */
  async flushThinkingPreference(): Promise<void> {
    try {
      await this.preferenceWriteQueue;
    } catch {
      // Pi owns settings error reporting; effort enforcement must remain usable.
    }
  }

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

  /** The thinking level Pi actually applied after model/runtime clamping. */
  getAppliedThinking(): ThinkingLevel | undefined {
    return this.appliedThinking;
  }

  /**
   * Return the configured raw effort request so every workflow subagent is
   * clamped independently against its own model.
   */
  getSubagentThinkingLevel(): ThinkingLevel | undefined {
    return this.isEnforcing() ? thinkingLevelForMode(this.mode) : undefined;
  }

  /** Reassert the configured mode effort before a turn or after a model change. */
  reapplyConfiguredThinking(pi: ExtensionAPI): boolean {
    if (!this.isEnforcing()) return false;
    this.applyConfiguredThinking(pi);
    return true;
  }

  /** @deprecated Use reapplyConfiguredThinking(). */
  reapplyMaximumThinking(pi: ExtensionAPI): boolean {
    return this.reapplyConfiguredThinking(pi);
  }

  /**
   * Handle model switches both while active and after a clamped restoration.
   * Returns true when Ultracode remains active and the UI should be refreshed.
   */
  handleModelSelect(pi: ExtensionAPI): boolean {
    if (this.suspended) return false;
    this.pendingClearGeneration++;
    if (this.isEnabled()) {
      this.applyConfiguredThinking(pi);
      return true;
    }
    if (this.pendingPreviousThinking) {
      const pending = this.pendingPreviousThinking;
      this.applyCompatibleThinking(pi, pending);
      if (this.pendingRestoreSucceeded(pending)) this.pendingPreviousThinking = undefined;
      this.persist(pi);
    }
    return false;
  }

  /** Restore the pre-mode effective effort without changing persisted mode state. */
  restorePreviousThinking(pi: ExtensionAPI): void {
    if (this.isEnabled() && this.previousThinking) this.applyCompatibleThinking(pi, this.previousThinking);
  }

  /** Stop enforcing synchronously, then restore effort before session teardown. */
  suspend(pi: ExtensionAPI): void {
    if (this.suspended) {
      this.syncWorkflowTool(pi);
      return;
    }
    this.suspended = true;
    this.restorePreviousThinking(pi);
    this.syncWorkflowTool(pi);
  }

  /**
   * Enforce the configured effort after an external thinking-level selection.
   * Stale events and events emitted by this mode are ignored to avoid recursion.
   */
  handleThinkingLevelSelect(pi: ExtensionAPI, level: ThinkingLevel): boolean {
    if (this.suspended || this.applyingThinking) return false;
    const current = safeGetThinking(pi);
    if (!current || current !== level) return false;
    if (!this.isEnabled()) {
      // Pi emits the same event for a user selection and an automatic model
      // re-clamp. Defer clearing until model_select has had a chance to consume it.
      if (this.pendingPreviousThinking) this.deferPendingClear(pi, level);
      return false;
    }
    if (current === this.appliedThinking) return false;
    this.applyConfiguredThinking(pi);
    return true;
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
   * Enable or switch modes without replacing the saved baseline. The no-argument
   * form retains the pre-0.5 programmatic deep behavior; user commands pass an
   * explicit mode and bare `/ultracode` uses toggle() to enter auto.
   */
  enable(pi: ExtensionAPI, mode: ActiveUltracodeMode = "deep"): void {
    this.suspended = false;
    this.pendingPreviousThinking = undefined;
    this.pendingClearGeneration++;
    if (!this.isEnabled()) {
      const current = safeGetThinking(pi);
      const preference = this.captureThinkingPreference();
      const effectivePreference = this.runtimeCompatibleThinking(preference.effective) as
        | ThinkingLevel
        | undefined;
      const maxIsUnknownToRuntime = !this.runtimeSupportsMaxThinking
        && preference.effective === ULTRACODE_THINKING_LEVEL;
      // A non-reasoning model exposes only `off`; preserve the merged default
      // that Pi would use when the user later selects a reasoning model. A
      // pre-max Pi also reports a persisted max preference as off.
      this.previousThinking = current === "off"
        && (this.currentModelSupportsThinking !== true || maxIsUnknownToRuntime)
        ? effectivePreference ?? current
        : current;
      this.previousDefaultThinking = this.runtimeCompatibleThinking(preference.global);
      this.legacyDefaultMigrationPending = false;
    }
    this.mode = mode;
    this.applyConfiguredThinking(pi);
    this.syncWorkflowTool(pi);
    this.persist(pi);
  }

  /** Turn Ultracode off, restoring the pre-mode thinking level. */
  disable(pi: ExtensionAPI): void {
    if (!this.isEnabled()) {
      this.syncWorkflowTool(pi);
      return;
    }
    const previous = this.previousThinking;
    this.restorePreviousThinking(pi);
    this.pendingPreviousThinking = previous && !this.pendingRestoreSucceeded(previous)
      ? previous
      : undefined;
    this.pendingClearGeneration++;
    this.mode = "off";
    this.suspended = false;
    this.syncWorkflowTool(pi);
    this.persist(pi);
  }


  /** Restore mode state from the active session branch. */
  restore(
    pi: ExtensionAPI,
    entries: Array<{
      type?: string;
      customType?: string;
      data?: unknown;
      thinkingLevel?: unknown;
    }>,
  ): void {
    const wasEnforcing = this.isEnforcing();
    this.pendingClearGeneration++;
    let latestData: unknown;
    let branchThinking: ThinkingLevel | undefined;
    let thinkingAfterLatestMode: ThinkingLevel | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE && entry.data) {
        latestData = entry.data;
        thinkingAfterLatestMode = undefined;
      } else if (entry.type === "thinking_level_change" && isThinkingLevel(entry.thinkingLevel)) {
        branchThinking = entry.thinkingLevel;
        if (latestData !== undefined) thinkingAfterLatestMode = entry.thinkingLevel;
      }
    }

    const current = safeGetThinking(pi);
    const preference = this.captureThinkingPreference();
    const effectivePreference = this.runtimeCompatibleThinking(preference.effective) as
      | ThinkingLevel
      | undefined;
    const globalPreference = this.runtimeCompatibleThinking(preference.global);
    const latest = parsePersistedModeState(latestData);
    if (!latest) {
      const target = this.runtimeCompatibleThinking(
        branchThinking
          ?? (wasEnforcing ? this.previousThinking : undefined)
          ?? effectivePreference,
      ) as ThinkingLevel | undefined;
      this.mode = "off";
      this.suspended = false;
      this.pendingPreviousThinking = undefined;
      this.previousThinking = target;
      this.previousDefaultThinking = globalPreference;
      this.legacyDefaultMigrationPending = false;
      this.appliedThinking = current;
      this.syncWorkflowTool(pi);
      if (target && current !== target) this.applyCompatibleThinking(pi, target);
      if (target && !this.pendingRestoreSucceeded(target)) {
        this.pendingPreviousThinking = target;
        this.persist(pi);
      } else {
        this.previousThinking = undefined;
        this.previousDefaultThinking = undefined;
      }
      return;
    }

    this.suspended = false;
    this.mode = latest.mode;
    this.syncWorkflowTool(pi);
    const maxIsUnknownToRuntime = !this.runtimeSupportsMaxThinking
      && preference.effective === ULTRACODE_THINKING_LEVEL;
    this.previousThinking = latest.previousThinking
      ?? (current === "off"
        && (this.currentModelSupportsThinking !== true || maxIsUnknownToRuntime)
        ? effectivePreference ?? current
        : current);

    // Pre-preference-store releases persisted only previousThinking while their
    // active xhigh request polluted Pi's global default. Recover that baseline
    // once instead of treating the known Ultracode value as a user preference.
    const migratesLegacyDefault = latest.mode !== "off"
      && latest.previousDefaultThinking === undefined
      && latest.previousThinking !== undefined
      && (preference.global === LEGACY_ULTRACODE_THINKING_LEVEL
        || preference.global === ULTRACODE_THINKING_LEVEL);
    this.previousDefaultThinking = migratesLegacyDefault
      ? this.runtimeCompatibleThinking(latest.previousThinking)
      : preference.global !== undefined
        ? globalPreference
        : this.runtimeCompatibleThinking(latest.previousDefaultThinking);
    this.legacyDefaultMigrationPending = migratesLegacyDefault;

    this.pendingPreviousThinking = this.isEnabled() ? undefined : latest.pendingPreviousThinking;
    if (this.isEnabled()) {
      this.applyConfiguredThinking(pi);
      if (migratesLegacyDefault) {
        this.queueDefaultThinkingRestore(() => {
          this.legacyDefaultMigrationPending = false;
          this.persist(pi);
        });
      }
      return;
    }

    if (this.pendingPreviousThinking) {
      if (thinkingAfterLatestMode !== undefined) {
        // A thinking entry after the disabled mode snapshot is an explicit user
        // choice and supersedes the older deferred restoration.
        const target = this.runtimeCompatibleThinking(thinkingAfterLatestMode) as ThinkingLevel;
        this.pendingPreviousThinking = undefined;
        this.previousThinking = target;
        this.appliedThinking = current;
        if (current !== target) this.applyCompatibleThinking(pi, target);
        if (!this.pendingRestoreSucceeded(target)) this.pendingPreviousThinking = target;
        this.persist(pi);
      } else if (this.currentModelSupportsThinking === true) {
        const pending = this.pendingPreviousThinking;
        this.applyCompatibleThinking(pi, pending);
        if (this.pendingRestoreSucceeded(pending)) this.pendingPreviousThinking = undefined;
        this.persist(pi);
      }
      return;
    }

    const target = this.runtimeCompatibleThinking(branchThinking ?? latest.previousThinking) as
      | ThinkingLevel
      | undefined;
    this.appliedThinking = current;
    if (target && current !== target) this.applyCompatibleThinking(pi, target);
    if (target && !this.pendingRestoreSucceeded(target)) {
      this.pendingPreviousThinking = target;
      this.persist(pi);
    }
  }

  /** Append the configured semantic-depth policy to the turn's system prompt. */
  beforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (!this.isEnforcing() || !isActiveUltracodeMode(this.mode)) return undefined;
    const block = ultracodeSystemBlock(this.mode);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}\n\n${ULTRACODE_ACTIVE_REMINDER}` };
  }

  statusLine(): string {
    if (!this.isEnabled()) return "ultracode: off";
    const parts = [`ultracode: ${this.mode}`];
    // Show the level that actually applied, including compatibility/model fallback.
    if (this.appliedThinking) parts.push(this.appliedThinking);
    return parts.join(" · ");
  }

  private applyConfiguredThinking(pi: ExtensionAPI): void {
    const target = thinkingLevelForMode(this.mode);
    if (!target) return;
    const writeGeneration = this.preferenceWriteGeneration;
    this.applyCompatibleThinking(pi, target);
    // Pi normally skips persistence when the effective level is unchanged, but
    // the extension API does not promise that. Defensively restore the raw
    // baseline even after a stable mode-owned request.
    if (writeGeneration === this.preferenceWriteGeneration) {
      this.queueDefaultThinkingRestore();
    }
  }

  /** Apply max compatibly and return the concrete level accepted as success. */
  private applyCompatibleThinking(pi: ExtensionAPI, level: ThinkingLevel): ThinkingLevel {
    this.applyThinking(pi, level);
    if (level === ULTRACODE_THINKING_LEVEL && this.appliedThinking !== level) {
      // Modern Pi clamps max per model. Pre-max Pi may treat it as unknown, so
      // retry xhigh for both activation and restoration of persisted max state.
      this.applyThinking(pi, LEGACY_ULTRACODE_THINKING_LEVEL);
      return LEGACY_ULTRACODE_THINKING_LEVEL;
    }
    return level;
  }

  private applyThinking(pi: ExtensionAPI, level: ThinkingLevel): void {
    const wasApplying = this.applyingThinking;
    const before = safeGetThinking(pi);
    this.applyingThinking = true;
    try {
      // Pi clamps the request and persists the effective level. Preference
      // restoration is queued after Pi's own SettingsManager chain drains.
      pi.setThinkingLevel(level as any);
      this.appliedThinking = safeGetThinking(pi) ?? level;
    } catch {
      this.appliedThinking = safeGetThinking(pi);
    } finally {
      if (this.appliedThinking !== before) this.queueDefaultThinkingRestore();
      this.applyingThinking = wasApplying;
    }
  }

  isEnforcing(): boolean {
    return this.isEnabled() && !this.suspended;
  }

  private pendingRestoreSucceeded(pending: ThinkingLevel): boolean {
    if (this.appliedThinking === pending) return true;
    return pending === ULTRACODE_THINKING_LEVEL
      && !this.runtimeSupportsMaxThinking
      && this.appliedThinking !== undefined
      && this.appliedThinking !== "off";
  }

  private runtimeCompatibleThinking(
    level: ThinkingLevel | null | undefined,
  ): ThinkingLevel | null | undefined {
    return level === ULTRACODE_THINKING_LEVEL && !this.runtimeSupportsMaxThinking
      ? LEGACY_ULTRACODE_THINKING_LEVEL
      : level;
  }

  private captureThinkingPreference(): {
    global: ThinkingLevel | null | undefined;
    effective: ThinkingLevel | undefined;
  } {
    if (!this.thinkingPreferenceStore) return { global: undefined, effective: undefined };
    try {
      const preference = this.thinkingPreferenceStore.getThinkingPreference();
      return {
        global: isThinkingLevel(preference.global) ? preference.global : null,
        effective: isThinkingLevel(preference.effective) ? preference.effective : undefined,
      };
    } catch {
      return { global: undefined, effective: undefined };
    }
  }

  private queueDefaultThinkingRestore(onSuccess?: () => void): void {
    const store = this.thinkingPreferenceStore;
    const baseline = this.runtimeCompatibleThinking(this.previousDefaultThinking);
    if (!store || baseline === undefined) return;
    const generation = ++this.preferenceWriteGeneration;
    this.preferenceWriteQueue = this.preferenceWriteQueue
      .catch(() => {})
      .then(waitForSettingsWrites)
      .then(async () => {
        if (generation !== this.preferenceWriteGeneration) return;
        const currentGlobal = this.captureThinkingPreference().global;
        if (currentGlobal !== baseline) {
          await store.setDefaultThinkingLevel(baseline ?? undefined);
          await store.flush?.();
        }
        if (generation === this.preferenceWriteGeneration) onSuccess?.();
      })
      .catch(() => {
        // Keep the session usable even when settings cannot be restored.
      });
  }

  private deferPendingClear(pi: ExtensionAPI, level: ThinkingLevel): void {
    const generation = ++this.pendingClearGeneration;
    setImmediate(() => {
      if (
        generation !== this.pendingClearGeneration
        || this.isEnabled()
        || this.suspended
        || safeGetThinking(pi) !== level
      ) return;
      this.pendingPreviousThinking = undefined;
      this.persist(pi);
    });
  }

  private activateWorkflowTool(pi: ExtensionAPI): void {
    try {
      const active = pi.getActiveTools();
      if (!active.includes(this.workflowToolName)) {
        pi.setActiveTools([...active, this.workflowToolName]);
      }
    } catch {
      // Mode enforcement remains usable when tool selection is unavailable.
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
    const state: PersistedModeState = {
      mode: this.mode,
      previousThinking: this.previousThinking,
      previousDefaultThinking: this.legacyDefaultMigrationPending
        ? undefined
        : this.previousDefaultThinking,
      pendingPreviousThinking: this.pendingPreviousThinking,
    };
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
  const previousDefault = value.previousDefaultThinking;
  // Sessions written before semantic-depth modes stored only enabled:boolean.
  // Preserve their behavior by migrating enabled:true to the old deep mode.
  const mode: UltracodeModeName = isActiveUltracodeMode(value.mode)
    ? value.mode
    : value.mode === "off"
      ? "off"
      : value.enabled === true
        ? "deep"
        : "off";
  return {
    mode,
    previousThinking: isThinkingLevel(value.previousThinking) ? value.previousThinking : undefined,
    previousDefaultThinking: previousDefault === null || isThinkingLevel(previousDefault)
      ? previousDefault
      : undefined,
    pendingPreviousThinking: isThinkingLevel(value.pendingPreviousThinking)
      ? value.pendingPreviousThinking
      : undefined,
  };
}

function waitForSettingsWrites(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function safeGetThinking(pi: ExtensionAPI): ThinkingLevel | undefined {
  try {
    const level = pi.getThinkingLevel();
    return isThinkingLevel(level) ? level : undefined;
  } catch {
    return undefined;
  }
}
