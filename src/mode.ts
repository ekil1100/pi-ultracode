/**
 * Ultracode mode controller.
 *
 * Ultracode is a session-scoped effort mode. While on, it:
 *   - raises the thinking level to xhigh (remembering the previous level),
 *   - keeps the `workflow` tool active,
 *   - injects a standing "author and run a workflow by default" system block on
 *     every turn, plus an optional token budget,
 *   - persists its on/off + budget state in session custom entries so it survives
 *     reload, resume, fork, and compaction.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ULTRACODE_ACTIVE_REMINDER, ULTRACODE_TAGLINE, ultracodeSystemBlock } from "./prompts.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const MODE_ENTRY_TYPE = "ultracode-mode";

interface PersistedModeState {
  enabled: boolean;
  budgetTotal: number | null;
  previousThinking?: ThinkingLevel;
}

export class UltracodeMode {
  private enabled = false;
  private budgetTotal: number | null = null;
  private previousThinking: ThinkingLevel | undefined;
  /** The level pi actually applied after clamping "xhigh" to the model's capability. */
  private appliedThinking: ThinkingLevel | undefined;
  private readonly workflowToolName: string;

  constructor(workflowToolName: string) {
    this.workflowToolName = workflowToolName;
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

  /** The thinking level pi actually applied (xhigh, or clamped down for models that lack it). */
  getAppliedThinking(): ThinkingLevel | undefined {
    return this.appliedThinking;
  }

  isEnabled(): boolean {
    return this.enabled;
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
    if (!this.enabled) {
      this.previousThinking = safeGetThinking(pi);
      this.enabled = true;
    }
    this.applyThinking(pi, "xhigh");
    this.activateWorkflowTool(pi);
    this.persist(pi);
  }

  /** Turn ultracode off, restoring the previous thinking level. */
  disable(pi: ExtensionAPI): void {
    if (this.enabled && this.previousThinking) this.applyThinking(pi, this.previousThinking);
    this.enabled = false;
    this.persist(pi);
  }

  setBudget(pi: ExtensionAPI, budget: number | null): void {
    this.budgetTotal = budget;
    this.persist(pi);
  }

  /** Restore mode state from session entries (called on session_start). */
  restore(pi: ExtensionAPI, entries: Array<{ type?: string; customType?: string; data?: unknown }>): void {
    let latest: PersistedModeState | undefined;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE && entry.data) {
        latest = entry.data as PersistedModeState;
      }
    }
    if (!latest) return;
    this.budgetTotal = latest.budgetTotal ?? null;
    this.previousThinking = latest.previousThinking;
    if (latest.enabled) {
      this.enabled = true;
      this.applyThinking(pi, "xhigh");
      this.activateWorkflowTool(pi);
    }
  }

  /**
   * Build the before_agent_start result: appends the ultracode system block to the
   * turn's system prompt when enabled.
   */
  beforeAgentStart(event: { systemPrompt: string }): { systemPrompt: string } | undefined {
    if (!this.enabled) return undefined;
    const block = ultracodeSystemBlock({ budgetTotal: this.budgetTotal });
    return { systemPrompt: `${event.systemPrompt}\n\n${block}\n\n${ULTRACODE_ACTIVE_REMINDER}` };
  }

  statusLine(): string {
    if (!this.enabled) return `ultracode: off`;
    const parts = ["ultracode: on"];
    // Show the level that actually applied (xhigh, or whatever the model clamped to).
    if (this.appliedThinking) parts.push(`thinking ${this.appliedThinking}`);
    if (this.budgetTotal) parts.push(`budget ~${formatTokens(this.budgetTotal)}`);
    return parts.join(" · ");
  }

  private applyThinking(pi: ExtensionAPI, level: ThinkingLevel): void {
    try {
      // pi clamps the requested level down to the model's capability (e.g. "high",
      // or "off" for non-reasoning models); it never throws. Read back what stuck.
      pi.setThinkingLevel(level);
      this.appliedThinking = safeGetThinking(pi) ?? level;
    } catch {
      this.appliedThinking = safeGetThinking(pi);
    }
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
    };
    try {
      pi.appendEntry(MODE_ENTRY_TYPE, state);
    } catch {
      // ignore persistence failures
    }
  }
}

function safeGetThinking(pi: ExtensionAPI): ThinkingLevel | undefined {
  try {
    return pi.getThinkingLevel() as ThinkingLevel;
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
