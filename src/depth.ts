/** Ultracode's configured analysis modes and their default reasoning effort. */

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
 * Default effort for the parent turn and for child agents that do not override
 * it explicitly. Auto starts from the balanced standard effort; its prompt
 * policy can route individual workflow agents lower or higher as evidence
 * requires. Pi still clamps each request to the selected model's capabilities.
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
