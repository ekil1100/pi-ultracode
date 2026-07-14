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
  VERSION as PI_VERSION,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.ts";
import { jsonSchemaToTypeBox } from "./json-schema.ts";
import {
  LEGACY_ULTRACODE_THINKING_LEVEL,
  ULTRACODE_THINKING_LEVEL,
  isThinkingLevel,
  piVersionSupportsMaxThinking,
  type ThinkingLevel,
} from "../thinking.ts";
import type { AgentTypeDef } from "./agent-types.ts";

export type { ThinkingLevel } from "../thinking.ts";

/** A minimal structural view of a Pi model (avoids importing the heavy generic type). */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  /** Extended levels are supported only when Pi exposes a non-null mapping. */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
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

export interface AgentSessionLike {
  thinkingLevel: ThinkingLevel;
  model?: ModelLike;
  supportsThinking(): boolean;
  prompt(
    prompt: string,
    options?: { preflightResult?: (success: boolean) => void },
  ): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  messages: unknown[];
  getSessionStats?(): unknown;
}

export type AgentSessionFactory = (
  options: Record<string, unknown>,
) => Promise<{ session: AgentSessionLike }>;

export interface WorkflowAgentRunnerOptions {
  cwd: string;
  modelRegistry?: ModelRegistryLike;
  /** Default model used when an agent() call does not override it. */
  model?: ModelLike;
  /** Default thinking level for subagents. */
  thinkingLevel?: ThinkingLevel;
  /** Test seam for session construction and initialization races. */
  createSession?: AgentSessionFactory;
  /** Override runtime feature detection for pre-max Pi compatibility tests. */
  supportsMaxThinking?: boolean;
}

/** Normalized activity signal forwarded from inside a running subagent. */
export interface AgentActivityInput {
  kind: "text" | "thinking" | "tool";
  detail?: string;
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
  /** Live activity stream from the subagent (text deltas / tool calls). */
  onActivity?: (event: AgentActivityInput) => void;
}

export class WorkflowAgentRunner {
  private readonly baseCwd: string;
  private readonly modelRegistry?: ModelRegistryLike;
  private readonly defaultModel?: ModelLike;
  private readonly defaultThinking?: ThinkingLevel;
  private readonly createSession: AgentSessionFactory;
  private readonly runtimeSupportsMaxThinking: boolean;

  constructor(options: WorkflowAgentRunnerOptions) {
    this.baseCwd = options.cwd;
    this.modelRegistry = options.modelRegistry;
    this.defaultModel = options.model;
    this.defaultThinking = options.thinkingLevel;
    this.createSession = options.createSession ?? (createAgentSession as unknown as AgentSessionFactory);
    this.runtimeSupportsMaxThinking = options.supportsMaxThinking ?? piVersionSupportsMaxThinking(PI_VERSION);
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
    const createSession = (level: ThinkingLevel | undefined) => this.createSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.create(cwd, agentDir),
      customTools,
      ...(model ? { model: model as any } : {}),
      ...(level ? { thinkingLevel: level as any } : {}),
      ...(toolAllowlist ? { tools: toolAllowlist } : {}),
      ...(this.modelRegistry ? { modelRegistry: this.modelRegistry as any } : {}),
    });

    const sessionThinking = resolveSessionThinkingLevel(thinkingLevel, model);
    let created = await createSession(sessionThinking);
    if (call.signal?.aborted) {
      disposeQuietly(created.session);
      throw abortedError();
    }
    const selectedModel = created.session.model;
    const selectedModelAdvertisesMax = (model ?? selectedModel)?.thinkingLevelMap?.max != null;
    if (
      thinkingLevel === ULTRACODE_THINKING_LEVEL &&
      sessionThinking === ULTRACODE_THINKING_LEVEL &&
      created.session.thinkingLevel !== ULTRACODE_THINKING_LEVEL &&
      created.session.supportsThinking() &&
      (!this.runtimeSupportsMaxThinking || selectedModelAdvertisesMax)
    ) {
      // A legacy runtime may clamp an unknown `max` to medium/high instead of
      // off. Recreate with xhigh; never mutate the user's global default effort.
      disposeQuietly(created.session);
      created = await createSession(LEGACY_ULTRACODE_THINKING_LEVEL);
      if (call.signal?.aborted) {
        disposeQuietly(created.session);
        throw abortedError();
      }
    }
    const { session } = created;

    let removeAbort: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let aborting: Promise<void> | undefined;
    let hasPrimaryError = false;
    try {
      if (call.signal) {
        const onAbort = () => {
          // Attach the rejection handler synchronously so a failing abort can
          // never become an unhandled rejection while prompt() is unwinding.
          aborting = session.abort().catch(() => {});
        };
        call.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => call.signal?.removeEventListener("abort", onAbort);
        // AbortSignal does not replay an abort that happened before listener
        // registration, so close the initialization race explicitly.
        if (call.signal.aborted) {
          onAbort();
          await aborting;
          throw abortedError();
        }
      }

      // Forward live activity (text deltas / tool calls) so the workflow
      // snapshot can show per-agent progress and detect stuck subagents.
      if (call.onActivity) {
        const onActivity = call.onActivity;
        unsubscribe = session.subscribe((event: unknown) => forwardActivity(event, onActivity));
      }

      await session.prompt(this.buildPrompt(call, Boolean(call.schema)), {
        // Pi invokes this after async input/before_agent_start preflight and
        // immediately before _runAgentPrompt(). Throwing here closes the window
        // where abort() sees an idle session and therefore cannot stop streaming.
        preflightResult: () => {
          if (call.signal?.aborted) throw abortedError();
        },
      });
      if (call.signal?.aborted) {
        await aborting;
        throw abortedError();
      }

      let value: unknown;
      if (call.schema) {
        if (!capture.called) throw new Error("Subagent finished without calling structured_output");
        value = capture.value;
      } else {
        value = lastAssistantText(session.messages as unknown[]);
      }

      return { value, usage: readUsage(session), cwd };
    } catch (error) {
      hasPrimaryError = true;
      throw error;
    } finally {
      let hasCleanupError = false;
      let cleanupError: unknown;
      const cleanup = (fn: (() => void) | undefined) => {
        if (!fn) return;
        try {
          fn();
        } catch (error) {
          if (!hasCleanupError) {
            hasCleanupError = true;
            cleanupError = error;
          }
        }
      };
      cleanup(removeAbort);
      // If cancellation started while prompt() was failing, let AgentSession
      // finish abort teardown before disposing resources underneath it.
      await aborting;
      cleanup(unsubscribe);
      cleanup(() => session.dispose());
      // Cleanup must always run to completion. Its first failure is surfaced only
      // when there is no prompt/abort failure (including reject(undefined)).
      if (!hasPrimaryError && hasCleanupError) throw cleanupError;
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

export function splitThinkingSuffix(pattern: string): { base: string; thinking?: ThinkingLevel } {
  const idx = pattern.lastIndexOf(":");
  if (idx === -1) return { base: pattern };
  const raw = pattern.slice(idx + 1).trim();
  if (isThinkingLevel(raw)) return { base: pattern.slice(0, idx).trim(), thinking: raw };
  // Trailing colon with no/invalid suffix (e.g. "sonnet:"): strip it so the base
  // is still matchable instead of silently falling back to the default model.
  if (raw === "") return { base: pattern.slice(0, idx).trim() };
  return { base: pattern };
}

/**
 * Avoid sending an unknown `max` value to runtimes/models that do not advertise
 * it. Requesting xhigh is equivalent to max for those models because Pi clamps
 * xhigh to their strongest supported level.
 */
export function resolveSessionThinkingLevel(
  requested: ThinkingLevel | undefined,
  model: ModelLike | undefined,
): ThinkingLevel | undefined {
  if (requested !== ULTRACODE_THINKING_LEVEL || !model) return requested;
  // Known models without max can skip a wasted session. For an unknown/default
  // model, pass max first; the post-create compatibility check retries xhigh on
  // pre-max Pi regardless of whether it clamped to off, medium, or high.
  return model.thinkingLevelMap?.max == null
    ? LEGACY_ULTRACODE_THINKING_LEVEL
    : ULTRACODE_THINKING_LEVEL;
}

function matchExactModelIn(models: ModelLike[] | undefined, pattern: string): ModelLike | undefined {
  if (!models || !pattern.trim()) return undefined;
  const lower = pattern.trim().toLowerCase();
  return models.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower)
    ?? models.find((m) => m.id.toLowerCase() === lower);
}

/** Match a model pattern against a registry list: exact provider/id, then exact id, then substring. */
export function matchModelIn(models: ModelLike[] | undefined, pattern: string): ModelLike | undefined {
  if (!models) return undefined;
  // An empty pattern must never match: "any-id".includes("") === true would
  // otherwise silently return the FIRST registered model.
  if (!pattern.trim()) return undefined;
  const lower = pattern.trim().toLowerCase();
  const slash = lower.includes("/");
  return (
    matchExactModelIn(models, pattern) ??
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
  // A literal model id wins before suffix parsing, so ids/tags such as
  // `ollama/coder:max` remain addressable. Parse :level only without an exact hit.
  const exactModel = matchExactModelIn(models, effectivePattern)
    ?? matchExactModelIn(defaultModel ? [defaultModel] : undefined, effectivePattern);
  if (exactModel) {
    return { model: exactModel, thinkingLevel: roleThinking ?? defaultThinking };
  }
  const { base, thinking } = splitThinkingSuffix(effectivePattern);
  const model = base ? matchModelIn(models, base) ?? defaultModel : defaultModel;
  return { model, thinkingLevel: thinking ?? roleThinking ?? defaultThinking };
}

function abortedError(): Error {
  return new Error("Subagent was aborted");
}

function disposeQuietly(session: { dispose(): void }): void {
  try {
    session.dispose();
  } catch {
    // A failed provisional-session cleanup must not block compatibility fallback.
  }
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

/**
 * Map a raw AgentSessionEvent into a normalized activity signal and forward it.
 * Defensive: activity forwarding must never break the subagent run.
 */
export function forwardActivity(event: unknown, onActivity: (e: AgentActivityInput) => void): void {
  try {
    const e = event as any;
    if (e?.type === "message_update") {
      const ame = e.assistantMessageEvent;
      if (!ame) return;
      if (ame.type === "text_delta" && typeof ame.delta === "string") {
        onActivity({ kind: "text", detail: ame.delta });
      } else if (ame.type === "thinking_delta") {
        onActivity({ kind: "thinking" });
      } else if (ame.type === "toolcall_start" && ame.toolName) {
        onActivity({ kind: "tool", detail: String(ame.toolName) });
      }
      return;
    }
    if (e?.type === "tool_execution_start" && e.toolName) {
      onActivity({ kind: "tool", detail: String(e.toolName) });
    }
  } catch {
    // best-effort: never let observability break the run
  }
}
