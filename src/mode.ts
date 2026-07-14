/**
 * Ultracode mode controller.
 *
 * Ultracode is a session-scoped effort mode. While on, it:
 *   - raises the thinking level to the model's maximum (remembering the previous level),
 *   - keeps the `workflow` tool active,
 *   - injects a standing "author and run a workflow by default" system block on
 *     every turn, plus an optional token budget,
 *   - persists its on/off + budget state in session custom entries so it survives
 *     reload, resume, fork, and compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  enabled: boolean;
  budgetTotal: number | null;
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
  private enabled = false;
  private suspended = false;
  private budgetTotal: number | null = null;
  private previousThinking: ThinkingLevel | undefined;
  private previousDefaultThinking: ThinkingLevel | null | undefined;
  /** Restore a level later if the current non-reasoning model clamps it to off. */
  private pendingPreviousThinking: ThinkingLevel | undefined;
  /** The level Pi actually applied after clamping the maximum request. */
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

  /** Enable if off, disable if on. Returns the new enabled state. */
  toggle(pi: ExtensionAPI, opts: { budget?: number | null } = {}): boolean {
    if (this.enabled) {
      this.disable(pi);
      return false;
    }
    this.enable(pi, opts);
    return true;
  }

  /** The thinking level Pi actually applied (`max`, or the model/runtime fallback). */
  getAppliedThinking(): ThinkingLevel | undefined {
    return this.appliedThinking;
  }

  /**
   * Return the raw maximum request, not the parent's applied value, so every
   * workflow subagent is clamped independently against its own model.
   */
  getSubagentThinkingLevel(): ThinkingLevel | undefined {
    return this.isEnforcing() ? ULTRACODE_THINKING_LEVEL : undefined;
  }

  /** Reassert the maximum before a turn or after a model change. */
  reapplyMaximumThinking(pi: ExtensionAPI): boolean {
    if (!this.isEnforcing()) return false;
    this.applyUltracodeThinking(pi);
    return true;
  }

  /**
   * Handle model switches both while active and after a clamped restoration.
   * Returns true when Ultracode remains active and the UI should be refreshed.
   */
  handleModelSelect(pi: ExtensionAPI): boolean {
    if (this.suspended) return false;
    this.pendingClearGeneration++;
    if (this.enabled) {
      this.applyUltracodeThinking(pi);
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
    if (this.enabled && this.previousThinking) this.applyCompatibleThinking(pi, this.previousThinking);
  }

  /** Stop enforcing synchronously, then restore effort before session teardown. */
  suspend(pi: ExtensionAPI): void {
    if (this.suspended) return;
    this.suspended = true;
    this.restorePreviousThinking(pi);
  }

  /**
   * Enforce the mode after an external thinking-level selection. Stale events
   * and events emitted by this mode are ignored to avoid recursive updates.
   * Returns true when a manual selection was overridden.
   */
  handleThinkingLevelSelect(pi: ExtensionAPI, level: ThinkingLevel): boolean {
    if (this.suspended || this.applyingThinking) return false;
    const current = safeGetThinking(pi);
    if (!current || current !== level) return false;
    if (!this.enabled) {
      // Pi emits the same event for a user selection and an automatic model
      // re-clamp. Defer clearing until model_select has had a chance to consume it.
      if (this.pendingPreviousThinking) this.deferPendingClear(pi, level);
      return false;
    }
    if (current === this.appliedThinking) return false;
    this.applyUltracodeThinking(pi);
    return true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isSuspended(): boolean {
    return this.suspended;
  }

  getBudget(): number | null {
    return this.budgetTotal;
  }

  tagline(): string {
    return ULTRACODE_TAGLINE;
  }

  /** Turn ultracode on. Idempotent. */
  enable(pi: ExtensionAPI, opts: { budget?: number | null } = {}): void {
    if (opts.budget !== undefined) this.budgetTotal = opts.budget;
    this.suspended = false;
    this.pendingPreviousThinking = undefined;
    this.pendingClearGeneration++;
    if (!this.enabled) {
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
      this.enabled = true;
    }
    this.applyUltracodeThinking(pi);
    this.activateWorkflowTool(pi);
    this.persist(pi);
  }

  /** Turn ultracode off, restoring the previous thinking level. */
  disable(pi: ExtensionAPI): void {
    if (!this.enabled) return;
    const previous = this.previousThinking;
    this.restorePreviousThinking(pi);
    this.pendingPreviousThinking = previous && !this.pendingRestoreSucceeded(previous)
      ? previous
      : undefined;
    this.pendingClearGeneration++;
    this.enabled = false;
    this.suspended = false;
    this.persist(pi);
  }

  setBudget(pi: ExtensionAPI, budget: number | null): void {
    this.budgetTotal = budget;
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
      this.enabled = false;
      this.suspended = false;
      this.budgetTotal = null;
      this.pendingPreviousThinking = undefined;
      this.previousThinking = target;
      this.previousDefaultThinking = globalPreference;
      this.legacyDefaultMigrationPending = false;
      this.appliedThinking = current;
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
    this.enabled = latest.enabled;
    this.budgetTotal = latest.budgetTotal;
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
    const migratesLegacyDefault = latest.enabled
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

    this.pendingPreviousThinking = this.enabled ? undefined : latest.pendingPreviousThinking;
    if (this.enabled) {
      this.applyUltracodeThinking(pi);
      this.activateWorkflowTool(pi);
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

  /**
   * Build the before_agent_start result: appends the ultracode system block to the
   * turn's system prompt when enabled.
   */
  beforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (!this.isEnforcing()) return undefined;
    const block = ultracodeSystemBlock({ budgetTotal: this.budgetTotal });
    return { systemPrompt: `${event.systemPrompt}\n\n${block}\n\n${ULTRACODE_ACTIVE_REMINDER}` };
  }

  statusLine(): string {
    if (!this.enabled) return `ultracode: off`;
    const parts = ["ultracode: on"];
    // Show the level that actually applied, including compatibility/model fallback.
    if (this.appliedThinking) parts.push(this.appliedThinking);
    if (this.budgetTotal) parts.push(`budget ~${formatTokens(this.budgetTotal)}`);
    return parts.join(" · ");
  }

  private applyUltracodeThinking(pi: ExtensionAPI): void {
    const writeGeneration = this.preferenceWriteGeneration;
    this.applyCompatibleThinking(pi, ULTRACODE_THINKING_LEVEL);
    // Pi normally skips persistence when the effective level is unchanged, but
    // the extension API does not promise that. Defensively restore the raw
    // baseline even after a stable max -> max request.
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

  private isEnforcing(): boolean {
    return this.enabled && !this.suspended;
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
        || this.enabled
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
      // ignore
    }
  }

  private persist(pi: ExtensionAPI): void {
    const state: PersistedModeState = {
      enabled: this.enabled,
      budgetTotal: this.budgetTotal,
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
  const budget = value.budgetTotal;
  const previousDefault = value.previousDefaultThinking;
  return {
    enabled: value.enabled === true,
    budgetTotal: typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : null,
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Parse a budget token like "500k", "1m", "250000", "+500k". */
export function parseBudget(input: string): number | null {
  const match = input.trim().match(/^\+?\s*([0-9][0-9_.]*)\s*([kmKM])?$/);
  if (!match) return null;
  const value = Number(match[1].replace(/_/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[2]?.toLowerCase();
  if (unit === "k") return Math.round(value * 1_000);
  if (unit === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}
