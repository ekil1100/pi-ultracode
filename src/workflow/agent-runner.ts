/**
 * In-memory subagent runner.
 *
 * Each agent() call in a workflow spins up a fresh in-memory Pi session with the
 * standard coding tools (and a terminating structured_output tool when a schema
 * is given), runs one prompt to completion, and returns the result plus token usage.
 *
 * Supports per-call model overrides, custom agent types (role system-prompt + tool
 * allowlist), and an alternate cwd for git-worktree isolation.
 */

import {
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.ts";
import { jsonSchemaToTypeBox } from "./json-schema.ts";
import type { AgentTypeDef } from "./agent-types.ts";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A minimal structural view of a Pi model (avoids importing the heavy generic type). */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

export interface ModelRegistryLike {
  getAvailable(): ModelLike[];
  getAll?(): ModelLike[];
}

export interface AgentUsage {
  outputTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AgentRunResult {
  value: unknown;
  usage: AgentUsage;
  /** cwd the agent actually ran in (differs from the shared cwd under worktree isolation). */
  cwd: string;
}

export interface WorkflowAgentRunnerOptions {
  cwd: string;
  modelRegistry?: ModelRegistryLike;
  /** Default model used when an agent() call does not override it. */
  model?: ModelLike;
  /** Default thinking level for subagents. */
  thinkingLevel?: ThinkingLevel;
}

export interface AgentRunCall {
  prompt: string;
  label: string;
  schema?: unknown;
  instructions?: string;
  signal?: AbortSignal;
  /** Resolved model pattern (e.g. "sonnet" or "anthropic/...:high"). */
  modelPattern?: string;
  agentTypeDef?: AgentTypeDef;
  /** Override cwd (worktree). */
  cwd?: string;
}

export class WorkflowAgentRunner {
  private readonly baseCwd: string;
  private readonly modelRegistry?: ModelRegistryLike;
  private readonly defaultModel?: ModelLike;
  private readonly defaultThinking?: ThinkingLevel;

  constructor(options: WorkflowAgentRunnerOptions) {
    this.baseCwd = options.cwd;
    this.modelRegistry = options.modelRegistry;
    this.defaultModel = options.model;
    this.defaultThinking = options.thinkingLevel;
  }

  async run(call: AgentRunCall): Promise<AgentRunResult> {
    if (call.signal?.aborted) throw new Error("Subagent was aborted");

    const cwd = call.cwd ?? this.baseCwd;
    const capture: StructuredOutputCapture<any> = { called: false, value: undefined };

    const customTools: ToolDefinition[] = [...createCodingTools(cwd)];
    let toolAllowlist: string[] | undefined = call.agentTypeDef?.tools
      ? [...call.agentTypeDef.tools]
      : undefined;

    let schemaTSchema: TSchema | undefined;
    if (call.schema) {
      schemaTSchema = jsonSchemaToTypeBox(call.schema);
      customTools.push(
        createStructuredOutputTool({ schema: schemaTSchema, capture }) as unknown as ToolDefinition,
      );
      if (toolAllowlist) toolAllowlist.push("structured_output");
    }

    const { model, thinkingLevel } = this.resolveModel(call.modelPattern, call.agentTypeDef);

    const agentDir = getAgentDir();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.create(cwd, agentDir),
      customTools,
      ...(model ? { model: model as any } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(toolAllowlist ? { tools: toolAllowlist } : {}),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry as any } : {}),
    });

    let removeAbort: (() => void) | undefined;
    try {
      if (call.signal) {
        const onAbort = () => void session.abort();
        call.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => call.signal?.removeEventListener("abort", onAbort);
      }

      await session.prompt(this.buildPrompt(call, Boolean(call.schema)));
      if (call.signal?.aborted) throw new Error("Subagent was aborted");

      let value: unknown;
      if (call.schema) {
        if (!capture.called) throw new Error("Subagent finished without calling structured_output");
        value = capture.value;
      } else {
        value = lastAssistantText(session.messages as unknown[]);
      }

      return { value, usage: readUsage(session), cwd };
    } finally {
      removeAbort?.();
      session.dispose();
    }
  }

  private buildPrompt(call: AgentRunCall, structured: boolean): string {
    const role = call.agentTypeDef;
    const parts: Array<string | undefined> = [];
    if (role?.systemPrompt) {
      const header = role.systemPromptMode === "replace" ? `Role (operate strictly as):` : `Role:`;
      parts.push(`${header}\n${role.systemPrompt}`);
    }
    parts.push(call.instructions);
    parts.push(call.label ? `Task label: ${call.label}` : undefined);
    parts.push(call.prompt);
    if (structured) {
      parts.push(
        [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
        ].join("\n"),
      );
    }
    return parts.filter(Boolean).join("\n\n");
  }

  private resolveModel(
    pattern: string | undefined,
    role: AgentTypeDef | undefined,
  ): { model?: ModelLike; thinkingLevel?: ThinkingLevel } {
    return resolveModelSelection({
      pattern,
      roleModel: role?.model,
      roleThinking: role?.thinking,
      defaultModel: this.defaultModel,
      defaultThinking: this.defaultThinking,
      models: this.modelRegistry?.getAvailable(),
    });
  }
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function splitThinkingSuffix(pattern: string): { base: string; thinking?: ThinkingLevel } {
  const idx = pattern.lastIndexOf(":");
  if (idx === -1) return { base: pattern };
  const raw = pattern.slice(idx + 1).trim();
  const suffix = raw as ThinkingLevel;
  if (THINKING_LEVELS.has(suffix)) return { base: pattern.slice(0, idx).trim(), thinking: suffix };
  // Trailing colon with no/invalid suffix (e.g. "sonnet:"): strip it so the base
  // is still matchable instead of silently falling back to the default model.
  if (raw === "") return { base: pattern.slice(0, idx).trim() };
  return { base: pattern };
}

/** Match a model pattern against a registry list: exact provider/id, then exact id, then substring. */
export function matchModelIn(models: ModelLike[] | undefined, pattern: string): ModelLike | undefined {
  if (!models) return undefined;
  // An empty pattern must never match: "any-id".includes("") === true would
  // otherwise silently return the FIRST registered model.
  if (!pattern.trim()) return undefined;
  const lower = pattern.trim().toLowerCase();
  const slash = lower.includes("/");
  // 1. exact provider/id, 2. exact id, 3. substring on id / provider/id / name.
  return (
    models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
    models.find((m) => m.id.toLowerCase() === lower) ??
    models.find((m) =>
      slash
        ? `${m.provider}/${m.id}`.toLowerCase().includes(lower)
        : m.id.toLowerCase().includes(lower) || (m.name?.toLowerCase().includes(lower) ?? false),
    )
  );
}

/**
 * Resolve the model + thinking level for an agent() call.
 *
 * `pattern` may carry a thinking suffix like "anthropic/claude:high". A bare
 * ":high" (empty base) means "keep the default model, only override thinking" —
 * it must NOT fall through to matching an empty string, which would silently
 * pick the first registered model (`id.includes("") === true`).
 */
export function resolveModelSelection(args: {
  pattern?: string;
  roleModel?: string;
  roleThinking?: ThinkingLevel;
  defaultModel?: ModelLike;
  defaultThinking?: ThinkingLevel;
  models?: ModelLike[];
}): { model?: ModelLike; thinkingLevel?: ThinkingLevel } {
  const { pattern, roleModel, roleThinking, defaultModel, defaultThinking, models } = args;
  const effectivePattern = pattern ?? roleModel;
  if (!effectivePattern) {
    return { model: defaultModel, thinkingLevel: roleThinking ?? defaultThinking };
  }
  const { base, thinking } = splitThinkingSuffix(effectivePattern);
  const model = base ? matchModelIn(models, base) ?? defaultModel : defaultModel;
  return { model, thinkingLevel: thinking ?? roleThinking ?? defaultThinking };
}

function readUsage(session: any): AgentUsage {
  try {
    const stats = session.getSessionStats?.();
    if (stats?.tokens) {
      return {
        outputTokens: stats.tokens.output ?? 0,
        totalTokens: stats.tokens.total ?? 0,
        cost: stats.cost ?? 0,
      };
    }
  } catch {
    // fall through to message-based estimate
  }
  // Fallback: sum assistant usage from messages.
  let output = 0;
  let total = 0;
  let cost = 0;
  for (const message of (session.messages ?? []) as Array<Partial<AssistantMessage>>) {
    if (message?.role === "assistant" && message.usage) {
      output += message.usage.output ?? 0;
      total += message.usage.totalTokens ?? 0;
      cost += message.usage.cost?.total ?? 0;
    }
  }
  return { outputTokens: output, totalTokens: total, cost };
}

function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Partial<AssistantMessage> | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part): part is TextContent => (part as TextContent).type === "text")
      .map((part) => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return "";
}
