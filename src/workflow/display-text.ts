/** Terminal-safe, bounded text helpers for workflow progress UI. */

const OSC_SEQUENCE = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;
const STRING_SEQUENCE = /\u001b[P^_X](?:[^\u001b]|\u001b(?!\\))*(?:\u001b\\)/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ESC_SEQUENCE = /\u001b[ -/]*[@-~]/g;
const C0_C1_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const SAFE_SUBCOMMANDS = new Map<string, ReadonlySet<string>>([
  ["npm", new Set(["test", "install", "ci", "run", "exec"])],
  ["pnpm", new Set(["test", "install", "run", "exec"])],
  ["yarn", new Set(["test", "install", "run"])],
  ["bun", new Set(["test", "install", "run"])],
  ["git", new Set(["status", "diff", "log", "show", "branch", "grep"])],
  ["cargo", new Set(["test", "check", "build", "clippy"])],
  ["go", new Set(["test", "build", "vet"])],
]);
const SAFE_EXECUTABLES = new Set([
  ...SAFE_SUBCOMMANDS.keys(),
  "sleep", "curl", "wget", "node", "python", "python3", "pytest", "tsc", "make", "cmake",
  "rg", "grep", "find", "ls", "pwd",
]);

/** Remove terminal control sequences while preserving ordinary newlines/tabs. */
export function stripTerminalControls(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(STRING_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(ESC_SEQUENCE, "")
    .replace(C0_C1_CONTROL, "");
}

export function displayOneLine(value: string): string {
  return stripTerminalControls(value).replace(/\s+/g, " ").trim();
}

export function truncateDisplay(value: string, max: number): string {
  const text = displayOneLine(value);
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1)}…`;
}

/** Keep the newest end of a live-output tail. */
export function truncateDisplayTail(value: string, max: number): string {
  const text = displayOneLine(value);
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `…${text.slice(-(max - 1))}`;
}

/** Best-effort redaction for provider errors and other bounded status text. */
export function redactCommand(value: string): string {
  return displayOneLine(value)
    .replace(
      /((?:authorization|x-api-key|api-key|client-secret)\s*:\s*)(?:(?:bearer|basic)\s+)?[^'"\s]+/gi,
      "$1***",
    )
    .replace(
      /(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1***",
    )
    .replace(
      /(\B--?(?:api[-_]?key|token|access[-_]?token|password|passwd|secret|client-secret|user)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1***",
    )
    .replace(/(\s-u)(?:\s+)?(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1***")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|password|secret|client_secret)=)[^&\s'" ]+/gi, "$1***")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/g, "***");
}

/**
 * Commands can carry secrets in arbitrary shell syntax, so status uses a
 * whitelist synopsis instead of trying to display every argument safely.
 */
export function safeCommandPreview(value: string): string {
  const command = displayOneLine(value);
  if (!command) return "command";
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const index = 0;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) return "environment-prefixed command";
  const rawExecutable = tokens[index] ?? "command";
  const basename = rawExecutable.replace(/^['"]|['"]$/g, "").split("/").pop() || "command";
  const candidate = /^[A-Za-z0-9_.+-]+$/.test(basename) ? basename.toLowerCase() : "";
  if (!SAFE_EXECUTABLES.has(candidate)) return "command";
  const executable = truncateDisplay(basename, 32);
  const next = (tokens[index + 1] ?? "").replace(/^['"]|['"]$/g, "");

  const allowed = SAFE_SUBCOMMANDS.get(candidate);
  if (allowed?.has(next.toLowerCase())) return `${executable} ${truncateDisplay(next, 24)}`;
  if (executable.toLowerCase() === "sleep" && /^\d+(?:\.\d+)?[smhd]?$/.test(next)) {
    return `${executable} ${next}`;
  }
  return tokens.length > index + 1 ? `${executable} …` : executable;
}
