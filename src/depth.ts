/** Ultracode's configured semantic analysis-depth modes. */

import type { ThinkingLevel } from "./thinking.ts";

export const ACTIVE_ULTRACODE_MODES = ["auto", "focused", "standard", "deep"] as const;

export type ActiveUltracodeMode = (typeof ACTIVE_ULTRACODE_MODES)[number];
export type UltracodeModeName = "off" | ActiveUltracodeMode;

export const ANALYSIS_DEPTHS = ["focused", "standard", "deep"] as const;
export type AnalysisDepth = (typeof ANALYSIS_DEPTHS)[number];

/** Canonical applicability and evidence requirements for both the parent and Jev. */
export const DEPTH_CRITERIA: Record<AnalysisDepth, string> = {
  focused: "Bounded work with a known approach and locally verifiable results. Follow one line of inquiry and check the changed behavior or key claim directly (for example, a specified validation rule and its regression test). Do not skip verification; no broad investigation or adversarial panel by default.",
  standard: "Multiple independent dimensions or unresolved hypotheses can materially change the answer. Investigate those dimensions or compare plausible causes, then use targeted verification to resolve disputed or weakly evidenced claims (for example, diagnosing a fault with several plausible causes). Known multi-step work alone does not require this depth.",
  deep: "Tightly interacting hard constraints or critical invariants require independent evidence and counterexamples. Trace the interactions, test boundary and failure cases, and challenge the key claims with a distinct check (for example, cancellation racing a durable commit). Risk keywords, file count, or a request for a review alone do not qualify; deep does not mandate extra agents or repeated rounds.",
};

export const DEPTH_SELECTION_RULES = "Choose the smallest depth that can establish correctness from the stated task and available evidence. Missing information is not proof of hidden complexity. Risk determines which claims need verification; security, concurrency, data loss, and other risk keywords alone never mandate deep. Depth determines investigation and evidence requirements, not model effort, agent count, or a mandatory number of rounds.";

export const MODE_DESCRIPTIONS: Record<UltracodeModeName, string> = {
  off: "Workflow tool disabled; parent effort unchanged.",
  auto: "Adaptive depth: Jev with nonblank TYPESAFE_API_KEY; parent semantic routing if absent or selection fails. Evidence may escalate depth.",
  focused: `Fixed depth. ${DEPTH_CRITERIA.focused}`,
  standard: `Fixed depth. ${DEPTH_CRITERIA.standard}`,
  deep: `Fixed depth. ${DEPTH_CRITERIA.deep}`,
};

const ACTIVE_MODE_SET = new Set<string>(ACTIVE_ULTRACODE_MODES);

export function isActiveUltracodeMode(value: unknown): value is ActiveUltracodeMode {
  return typeof value === "string" && ACTIVE_MODE_SET.has(value);
}

export function isUltracodeModeName(value: unknown): value is UltracodeModeName {
  return value === "off" || isActiveUltracodeMode(value);
}

/**
 * @deprecated Legacy mode-to-effort mapping retained for API compatibility.
 * Ultracode no longer applies it to the parent or as a workflow child default;
 * each child selects effort per task and Pi clamps it to model capabilities.
 */
export function thinkingLevelForMode(mode: UltracodeModeName): ThinkingLevel | undefined {
  switch (mode) {
    case "focused":
      return "medium";
    case "auto":
    case "standard":
      return "high";
    case "deep":
      return "max";
    case "off":
      return undefined;
  }
}
