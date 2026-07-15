/** Terminal-safe, bounded text helpers for workflow progress UI. */

const ESC = 0x1b;
const BEL = 0x07;

/** Hard ceiling before any terminal scanning or redaction work. */
export const DISPLAY_INPUT_LIMIT = 16_384;
export const DISPLAY_OMITTED_TEXT = "[output omitted]";

function isInvisibleFormat(code: number): boolean {
  return code === 0x00ad
    || code === 0x034f
    || (code >= 0x0600 && code <= 0x0605)
    || code === 0x061c
    || code === 0x06dd
    || code === 0x070f
    || (code >= 0x0890 && code <= 0x0891)
    || code === 0x08e2
    || (code >= 0x17b4 && code <= 0x17b5)
    || (code >= 0x180b && code <= 0x180f)
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x206f)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || code === 0xfeff
    || (code >= 0xfff9 && code <= 0xfffb)
    || code === 0x110bd
    || code === 0x110cd
    || (code >= 0x13430 && code <= 0x1345f)
    || (code >= 0x1bca0 && code <= 0x1bca3)
    || (code >= 0x1d173 && code <= 0x1d17a)
    || code === 0xe0001
    || (code >= 0xe0020 && code <= 0xe007f)
    || (code >= 0xe0100 && code <= 0xe01ef);
}

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

/**
 * Remove terminal and invisible formatting controls in one pass while preserving
 * ordinary newlines/tabs. Work is capped before scanning. Unterminated OSC/DCS
 * strings consume the bounded remainder, avoiding injection and backtracking.
 */
export function stripTerminalControls(value: string): string {
  const truncated = value.length > DISPLAY_INPUT_LIMIT;
  const source = truncated ? value.slice(0, DISPLAY_INPUT_LIMIT) : value;
  const output: string[] = [];
  let index = 0;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === ESC) {
      index++;
      if (index >= source.length) break;
      const kind = source.charCodeAt(index);
      if (kind === 0x5d) {
        // OSC: ESC ] ... BEL or ST (ESC \).
        index++;
        while (index < source.length) {
          const current = source.charCodeAt(index);
          if (current === BEL) {
            index++;
            break;
          }
          if (current === ESC && source.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }
      if (kind === 0x50 || kind === 0x5e || kind === 0x5f || kind === 0x58) {
        // DCS/SOS/PM/APC: ESC P/^/_/X ... ST (ESC \).
        index++;
        while (index < source.length) {
          if (source.charCodeAt(index) === ESC && source.charCodeAt(index + 1) === 0x5c) {
            index += 2;
            break;
          }
          index++;
        }
        continue;
      }
      if (kind === 0x5b) {
        // CSI: ESC [ parameters/intermediates final-byte.
        index++;
        while (index < source.length) {
          const current = source.charCodeAt(index++);
          if (current >= 0x40 && current <= 0x7e) break;
        }
        continue;
      }
      // Generic two-byte ESC sequence, with optional intermediates.
      while (index < source.length) {
        const current = source.charCodeAt(index);
        if (current >= 0x20 && current <= 0x2f) {
          index++;
          continue;
        }
        if (current >= 0x30 && current <= 0x7e) index++;
        break;
      }
      continue;
    }

    const codePoint = source.codePointAt(index) ?? code;
    const width = codePoint > 0xffff ? 2 : 1;
    const c0 = codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
    const c1 = codePoint >= 0x7f && codePoint <= 0x9f;
    if (!c0 && !c1 && !isInvisibleFormat(codePoint)) {
      output.push(source.slice(index, index + width));
    }
    index += width;
  }
  if (truncated) output.push("…");
  return output.join("");
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

/** Keep the newest end only when the complete input fits the safety window. */
export function truncateDisplayTail(value: string, max: number): string {
  if (value.length > DISPLAY_INPUT_LIMIT) return fitMarker(DISPLAY_OMITTED_TEXT, max);
  const text = displayOneLine(value);
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return `…${text.slice(-(max - 1))}`;
}

/** Best-effort redaction for provider errors and other bounded status text. */
export function redactCommand(value: string): string {
  const text = displayOneLine(value);
  if (value.length > DISPLAY_INPUT_LIMIT && hasPendingCredentialContextPrepared(text)) {
    return DISPLAY_OMITTED_TEXT;
  }
  return redactPrepared(text);
}

/** Terminal-safe, redacted, and bounded status text. */
export function safeDisplayText(value: string, max: number): string {
  return truncatePrepared(redactCommand(value), max, false);
}

/** Keep the newest terminal-safe text, or omit it when prior context was dropped. */
export function safeDisplayTail(value: string, max: number): string {
  if (value.length > DISPLAY_INPUT_LIMIT) return fitMarker(DISPLAY_OMITTED_TEXT, max);
  return truncatePrepared(redactCommand(value), max, true);
}

/**
 * Whether a bounded stream fragment ends inside a credential-shaped construct
 * whose safe rendering depends on a later delimiter.
 */
export function hasPendingCredentialContext(value: string): boolean {
  if (value.length > DISPLAY_INPUT_LIMIT) return true;
  if (hasPendingTerminalSequence(value)) return true;
  return hasPendingCredentialContextPrepared(stripTerminalControls(value));
}

function redactPrepared(value: string): string {
  const text = redactSensitiveHeaders(value);
  return text
    .replace(
      /(\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s]+)/gi,
      "$1***",
    )
    .replace(
      /(\B--?(?:api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|secret|client-secret|user)(?:=|\s+))(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s]+)/gi,
      "$1***",
    )
    .replace(/(\s-u)(?:\s+)?(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s]+)/gi, "$1***")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+:[^/@\s]*(?=$|[/?#\s])/g, "$1***")
    .replace(/([?&](?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|client_secret)=)[^&\s'" ]+/gi, "$1***")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{6,}\b/g, "***");
}

function truncatePrepared(value: string, max: number, tail: boolean): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…".slice(0, Math.max(0, max));
  return tail ? `…${value.slice(-(max - 1))}` : `${value.slice(0, max - 1)}…`;
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

const SENSITIVE_HEADER_NAME = "(?:proxy-authorization|authorization|x-auth-token|x-api-key|api-key|api_key|client-secret|client_secret|access-token|access_token|refresh-token|refresh_token|id-token|id_token|set-cookie|cookie|token|password|passwd|secret)";
const SENSITIVE_HEADER = new RegExp(
  `(^|[^A-Za-z0-9_-]|(?:^|\\s)-H\\s*["']?)((?:["']?${SENSITIVE_HEADER_NAME}["']?)\\s*:\\s*)`,
  "gi",
);
const PENDING_URI_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s@]*$/;

function hasPendingTerminalSequence(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) !== ESC) {
      index++;
      continue;
    }
    index++;
    if (index >= value.length) return true;
    const kind = value.charCodeAt(index++);
    if (kind === 0x5d) {
      let terminated = false;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current === BEL) {
          index++;
          terminated = true;
          break;
        }
        if (current === ESC && value.charCodeAt(index + 1) === 0x5c) {
          index += 2;
          terminated = true;
          break;
        }
        index++;
      }
      if (!terminated) return true;
      continue;
    }
    if (kind === 0x50 || kind === 0x5e || kind === 0x5f || kind === 0x58) {
      let terminated = false;
      while (index < value.length) {
        if (value.charCodeAt(index) === ESC && value.charCodeAt(index + 1) === 0x5c) {
          index += 2;
          terminated = true;
          break;
        }
        index++;
      }
      if (!terminated) return true;
      continue;
    }
    if (kind === 0x5b) {
      let terminated = false;
      while (index < value.length) {
        const current = value.charCodeAt(index++);
        if (current >= 0x40 && current <= 0x7e) {
          terminated = true;
          break;
        }
      }
      if (!terminated) return true;
      continue;
    }
    while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2f) {
      index++;
    }
    if (index >= value.length) return true;
    const final = value.charCodeAt(index);
    if (final >= 0x30 && final <= 0x7e) index++;
  }
  return false;
}

function hasPendingCredentialContextPrepared(value: string): boolean {
  if (PENDING_URI_USERINFO.test(value)) return true;
  SENSITIVE_HEADER.lastIndex = 0;
  for (let match = SENSITIVE_HEADER.exec(value); match; match = SENSITIVE_HEADER.exec(value)) {
    const start = SENSITIVE_HEADER.lastIndex;
    if (!sensitiveValueIsComplete(value, start, /authorization|cookie/i.test(match[2]))) {
      SENSITIVE_HEADER.lastIndex = 0;
      return true;
    }
  }
  SENSITIVE_HEADER.lastIndex = 0;
  return false;
}

function sensitiveValueIsComplete(value: string, start: number, authorizationHeader: boolean): boolean {
  if (start >= value.length) return false;
  if (value.startsWith("***", start)) return true;
  const opener = value[start];
  if (opener === '"' || opener === "'") return quotedValueIsComplete(value, start, opener);
  if (opener === "[" || opener === "{") return structuredValueIsComplete(value, start, opener);
  const delimiters = authorizationHeader ? /[\r\n}\]]/ : /[,}\]\r\n]/;
  return delimiters.test(value.slice(start));
}

function quotedValueIsComplete(value: string, start: number, quote: string): boolean {
  for (let index = start + 1; index < value.length; index++) {
    if (value[index] === "\\") {
      index++;
      continue;
    }
    if (value[index] === quote) return true;
  }
  return false;
}

function structuredValueIsComplete(value: string, start: number, opener: string): boolean {
  const stack = [opener];
  let quote: string | undefined;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (quote) {
      if (character === "\\") {
        index++;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[" || character === "{") {
      stack.push(character);
    } else if (character === "]" || character === "}") {
      const expected = character === "]" ? "[" : "{";
      if (stack.pop() !== expected) return false;
      if (stack.length === 0) return true;
    }
  }
  return false;
}

function redactSensitiveHeaders(value: string): string {
  let cursor = 0;
  let output = "";
  SENSITIVE_HEADER.lastIndex = 0;
  for (let match = SENSITIVE_HEADER.exec(value); match; match = SENSITIVE_HEADER.exec(value)) {
    const valueStart = SENSITIVE_HEADER.lastIndex;
    const consumeUnquotedRemainder = /authorization|cookie/i.test(match[2]);
    const valueEnd = consumeSensitiveValue(value, valueStart, consumeUnquotedRemainder);
    output += value.slice(cursor, valueStart);
    output += "***";
    cursor = valueEnd;
    SENSITIVE_HEADER.lastIndex = valueEnd;
  }
  return output + value.slice(cursor);
}

function consumeSensitiveValue(value: string, start: number, consumeUnquotedRemainder: boolean): number {
  if (start >= value.length) return start;
  if (value.startsWith("***", start)) return start + 3;
  const opener = value[start];
  if (opener === '"' || opener === "'") return consumeQuoted(value, start, opener);
  if (opener === "[" || opener === "{") return consumeStructured(value, start, opener);
  if (consumeUnquotedRemainder) return value.length;

  let index = start;
  while (index < value.length && value[index] !== "," && value[index] !== "}" && value[index] !== "]") {
    index++;
  }
  return index;
}

function consumeQuoted(value: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < value.length) {
    if (value[index] === "\\") {
      index = Math.min(value.length, index + 2);
      continue;
    }
    if (value[index] === quote) return index + 1;
    index++;
  }
  return value.length;
}

function consumeStructured(value: string, start: number, opener: string): number {
  const stack = [opener];
  let quote: string | undefined;
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (quote) {
      if (character === "\\") {
        index = Math.min(value.length, index + 2);
        continue;
      }
      if (character === quote) quote = undefined;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index++;
      continue;
    }
    if (character === "[" || character === "{") {
      stack.push(character);
      index++;
      continue;
    }
    if (character === "]" || character === "}") {
      const expected = character === "]" ? "[" : "{";
      if (stack.at(-1) !== expected) return value.length;
      stack.pop();
      index++;
      if (stack.length === 0) return index;
      continue;
    }
    index++;
  }
  return value.length;
}

function fitMarker(marker: string, max: number): string {
  if (max <= 0) return "";
  if (marker.length <= max) return marker;
  if (max === 1) return "…";
  return `${marker.slice(0, max - 1)}…`;
}
