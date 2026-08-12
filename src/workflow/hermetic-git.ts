/**
 * Shared hermetic Git environment for workflow Git plumbing.
 *
 * Strips ambient GIT_* influence and pins locale/config so identity and
 * worktree operations observe the same repository view.
 */

import * as os from "node:os";

/** Build a process env that isolates Git from ambient config and locale. */
export function hermeticGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase().startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.LC_ALL = "C";
  env.LANG = "C";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return { ...env, ...overrides };
}

/** Strip a single trailing LF or CRLF without touching other whitespace. */
export function stripOneLineEnding(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}
