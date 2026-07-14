/**
 * Custom agent types for workflow subagents.
 *
 * An agent type gives a subagent a distinct role: a system prompt, an optional
 * tool allowlist, and optional model / thinking overrides. Types come from two
 * places:
 *   - Built-ins defined below (claude, Explore, Plan, general-purpose, code-reviewer).
 *   - Markdown files with YAML-ish frontmatter discovered under:
 *       <cwd>/.pi/ultracode/agents/*.md       (project)
 *       ~/.pi/ultracode/agents/*.md           (user)
 *       ~/.pi/agent/agents/*.md               (shared with other tools)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isThinkingLevel, type ThinkingLevel } from "../thinking.ts";

export interface AgentTypeDef {
  name: string;
  description: string;
  /** Extra system guidance for this subagent. */
  systemPrompt: string;
  /** "append" (default) merges with the base coding prompt; "replace" is advisory only. */
  systemPromptMode: "append" | "replace";
  /** Optional allowlist of built-in tool names (read, bash, edit, write, grep, find, ls). */
  tools?: string[];
  /** Optional model pattern override. */
  model?: string;
  /** Optional thinking level override. */
  thinking?: ThinkingLevel;
  source: "builtin" | "user" | "project";
}

const BUILTIN_AGENT_TYPES: AgentTypeDef[] = [
  {
    name: "claude",
    description: "General-purpose subagent with the full coding toolset.",
    systemPrompt: "You are a capable, autonomous coding subagent. Complete the task end-to-end and report concrete results.",
    systemPromptMode: "append",
    source: "builtin",
  },
  {
    name: "general-purpose",
    description: "Research and multi-step execution with all tools.",
    systemPrompt:
      "You are a general-purpose research-and-execution subagent. Search broadly, follow leads across files, and return a thorough, well-organized answer with file:line references where relevant.",
    systemPromptMode: "append",
    source: "builtin",
  },
  {
    name: "Explore",
    description: "Read-only fan-out search. Locates code; does not modify it.",
    systemPrompt:
      "You are a read-only exploration subagent. Sweep many files/directories and report the conclusion with precise file:line references. Read excerpts rather than whole files. Do NOT modify anything.",
    systemPromptMode: "append",
    tools: ["read", "grep", "find", "ls", "bash"],
    source: "builtin",
  },
  {
    name: "Plan",
    description: "Software architect. Designs an implementation plan; does not edit.",
    systemPrompt:
      "You are a software-architect subagent. Produce a concrete, step-by-step implementation plan: critical files, sequence, trade-offs, and risks. Do NOT modify files.",
    systemPromptMode: "append",
    tools: ["read", "grep", "find", "ls", "bash"],
    source: "builtin",
  },
  {
    name: "code-reviewer",
    description: "Adversarial reviewer that hunts for correctness, security, and reliability defects.",
    systemPrompt:
      "You are an adversarial code-review subagent. Default to skepticism: try to REFUTE the claim or find the bug. Cite exact file:line evidence. If you cannot find a concrete defect, say so plainly rather than inventing one.",
    systemPromptMode: "append",
    source: "builtin",
  },
];

export function discoverAgentTypes(cwd: string): Map<string, AgentTypeDef> {
  const map = new Map<string, AgentTypeDef>();
  for (const def of BUILTIN_AGENT_TYPES) map.set(def.name, def);

  const dirs: Array<{ dir: string; source: AgentTypeDef["source"] }> = [
    { dir: path.join(os.homedir(), ".pi", "agent", "agents"), source: "user" },
    { dir: path.join(os.homedir(), ".pi", "ultracode", "agents"), source: "user" },
    { dir: path.join(cwd, ".pi", "ultracode", "agents"), source: "project" },
  ];

  for (const { dir, source } of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = fs.readFileSync(path.join(dir, entry), "utf8");
        const def = parseAgentTypeFile(content, entry.replace(/\.md$/, ""), source);
        if (def) map.set(def.name, def); // project overrides user overrides builtin
      } catch {
        // ignore unreadable / malformed agent files
      }
    }
  }
  return map;
}

export function resolveAgentType(
  agentType: string | undefined,
  types: Map<string, AgentTypeDef>,
): AgentTypeDef | undefined {
  if (!agentType) return undefined;
  const found = types.get(agentType);
  if (found) return found;
  // Case-insensitive fallback.
  const lower = agentType.toLowerCase();
  for (const def of types.values()) {
    if (def.name.toLowerCase() === lower) return def;
  }
  return undefined;
}

export function parseAgentTypeFile(
  content: string,
  fallbackName: string,
  source: AgentTypeDef["source"],
): AgentTypeDef | undefined {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = (frontmatter.name ?? fallbackName).trim();
  if (!name) return undefined;
  const tools = frontmatter.tools
    ? frontmatter.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
  const rawThinking = frontmatter.thinking?.trim();
  const thinking = rawThinking && isThinkingLevel(rawThinking) ? rawThinking : undefined;
  const systemPromptMode = frontmatter.systemPromptMode === "replace" ? "replace" : "append";
  const systemPrompt = (frontmatter.systemPrompt ?? body ?? "").trim();
  return {
    name,
    description: (frontmatter.description ?? "").trim(),
    systemPrompt,
    systemPromptMode,
    tools,
    model: frontmatter.model?.trim() || undefined,
    thinking,
    source,
  };
}

/**
 * Minimal YAML-ish frontmatter parser: a leading `---` ... `---` block of
 * `key: value` pairs, supporting block scalars (`key: |`).
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: normalized };

  const frontmatter: Record<string, string> = {};
  const lines = match[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    let value = kv[2];
    if (value === "|" || value === ">" || value === "|-" || value === ">-") {
      // Block scalar: consume indented following lines.
      const block: string[] = [];
      i++;
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i].trim() === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      frontmatter[key] = block.join("\n").trim();
      continue;
    }
    value = value.trim().replace(/^["']|["']$/g, "");
    frontmatter[key] = value;
    i++;
  }
  return { frontmatter, body: match[2] ?? "" };
}
