/** Ultracode's configured semantic analysis-depth modes. */

import type { ThinkingLevel } from "./thinking.ts";

export const ACTIVE_ULTRACODE_MODES = ["auto", "focused", "standard", "deep"] as const;

export type ActiveUltracodeMode = (typeof ACTIVE_ULTRACODE_MODES)[number];
export type UltracodeModeName = "off" | ActiveUltracodeMode;

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
