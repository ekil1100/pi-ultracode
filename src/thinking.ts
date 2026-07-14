/** Shared thinking-level vocabulary for the mode, workflow agents, and config parser. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Ultracode always asks Pi for the strongest effort the selected model supports. */
export const ULTRACODE_THINKING_LEVEL: ThinkingLevel = "max";

/** Compatibility retry for Pi versions released before the `max` level existed. */
export const LEGACY_ULTRACODE_THINKING_LEVEL: ThinkingLevel = "xhigh";

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_SET.has(value);
}

/** Whether this Pi runtime recognizes `max` as a first-class thinking level. */
export function piVersionSupportsMaxThinking(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 0 || minor > 80 || (minor === 80 && patch >= 6);
}
