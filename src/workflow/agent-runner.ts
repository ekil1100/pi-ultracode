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

import * as path from "node:path";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  createCodingTools,
  getAgentDir,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { createStructuredOutputTool, type StructuredOutputCapture } from "./structured-output.ts";
import {
  DISPLAY_INPUT_LIMIT,
  displayOneLine,
  redactCommand,
  safeCommandPreview,
  safeDisplayText,
  safeTranscriptText,
  truncateDisplay,
} from "./display-text.ts";
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
  /** Legacy public projection retained for consumers of this structural type. */
  getAll?(): ModelLike[];
  getRegisteredProviderIds?(): readonly string[];
  getRegisteredProviderConfig?(provider: string): unknown;
  getProviderAuthStatus?(provider: string): {
    configured: boolean;
    source?: string;
  };
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

/** Structural ModelRuntime seam that remains loadable on pre-0.80.8 Pi. */
export interface ModelRuntimeLike {
  getModel?(provider: string, modelId: string): ModelLike | undefined;
  registerProvider?(provider: string, config: any): void;
  refresh?(options?: { allowNetwork?: boolean }): Promise<unknown>;
  setRuntimeApiKey?(provider: string, apiKey: string): Promise<void>;
}

export interface ModelRuntimeCreateOptions {
  authPath: string;
  modelsPath: string;
  /** Child sessions reuse the parent's catalog snapshot and must not refresh remotely. */
  allowModelNetwork: false;
}

export type ModelRuntimeFactory = (
  options: ModelRuntimeCreateOptions,
) => Promise<ModelRuntimeLike | undefined>;

export interface AgentTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AgentUsage {
  /** Optional on injected legacy runners; production runners always provide it. */
  inputTokens?: number;
  outputTokens: number;
  /** Compact token use: input + output, excluding cache traffic. */
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  /** Completed assistant messages. */
  turns?: number;
  /** Tool executions that reached tool_execution_start. */
  toolUses?: number;
  retries?: number;
  compactions?: number;
}

export interface AgentRunResult {
  value: unknown;
  usage: AgentUsage;
  /** Model id and effort actually applied by the child session. */
  modelId?: string;
  effort?: ThinkingLevel;
  /** cwd the agent actually ran in (differs from the shared cwd under worktree isolation). */
  cwd: string;
}

/** Detailed child-session events consumed by the private transcript store. */
export type AgentTelemetryEvent =
  | { kind: "model_requested"; modelId?: string; effort?: ThinkingLevel }
  | { kind: "model_resolved"; modelId?: string; effort: ThinkingLevel }
  | { kind: "turn_start"; turnIndex?: number }
  | { kind: "text_delta"; delta: string }
  | { kind: "message_end"; text: string; usage?: AgentTurnUsage; error?: string }
  | { kind: "thinking_start" | "thinking_end" }
  | { kind: "tool_start"; toolCallId: string; toolName: string; toolArgs?: string }
  | {
      kind: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      resultPreview?: string;
    }
  | { kind: "retry"; state: "start" | "end"; detail: string }
  | { kind: "compaction"; state: "start" | "end"; detail: string }
  | {
      kind: "run_error";
      error: string;
      usage: AgentUsage;
      modelId?: string;
      effort?: ThinkingLevel;
    };

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

export type AgentSessionCreateOptions = Omit<
  CreateAgentSessionOptions,
  "model" | "modelRegistry" | "modelRuntime"
> & {
  model?: ModelLike;
  /** Legacy Pi option, selected only when ModelRuntime is unavailable. */
  modelRegistry?: ModelRegistryLike;
  /** Pi 0.80.8+ canonical model/auth runtime. */
  modelRuntime?: ModelRuntimeLike;
};

export type AgentSessionFactory = (
  options: AgentSessionCreateOptions,
) => Promise<{ session: AgentSessionLike }>;

export interface WorkflowAgentRunnerOptions {
  cwd: string;
  /** Synchronous extension facade used only for model selection and state replay. */
  modelRegistry?: ModelRegistryLike;
  /** Canonical runtime to share across child sessions when supplied by an SDK host. */
  modelRuntime?: ModelRuntimeLike;
  /** Default model used when an agent() call does not override it. */
  model?: ModelLike;
  /** Default thinking level for subagents. */
  thinkingLevel?: ThinkingLevel;
  /** Test seam for session construction and initialization races. */
  createSession?: AgentSessionFactory;
  /** Test/compatibility seam for async ModelRuntime initialization. */
  createModelRuntime?: ModelRuntimeFactory;
  /** Override runtime feature detection for pre-max Pi compatibility tests. */
  supportsMaxThinking?: boolean;
}

/** Normalized, valid-by-construction activity signals from a running subagent. */
export type AgentActivityInput =
  | { kind: "waiting" | "retry" | "compaction"; detail: string }
  | { kind: "thinking"; detail: string }
  | {
      kind: "text";
      detail: "responding";
      /** @deprecated Standard runners never emit raw assistant text. */
      streamDelta?: string;
    }
  | {
      kind: "tool";
      detail: string;
      toolCallId: string;
      toolName: string;
      toolArgs?: string;
      toolState: "start" | "update" | "end";
    };

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
  /** Safe compact activity stream used by the inline workflow status. */
  onActivity?: (event: AgentActivityInput) => void;
  /** Private detailed stream used by the task transcript store. */
  onTelemetry?: (event: AgentTelemetryEvent) => void;
}

export class WorkflowAgentRunner {
  private readonly baseCwd: string;
  private readonly modelRegistry?: ModelRegistryLike;
  private readonly providedModelRuntime?: ModelRuntimeLike;
  private readonly defaultModel?: ModelLike;
  private readonly defaultThinking?: ThinkingLevel;
  private readonly createSession: AgentSessionFactory;
  private readonly createModelRuntime?: ModelRuntimeFactory;
  private modelRuntimePromise?: Promise<ModelRuntimeLike | undefined>;
  private readonly runtimeSupportsMaxThinking: boolean;

  constructor(options: WorkflowAgentRunnerOptions) {
    this.baseCwd = options.cwd;
    this.modelRegistry = options.modelRegistry;
    this.providedModelRuntime = options.modelRuntime;
    this.defaultModel = options.model;
    this.defaultThinking = options.thinkingLevel;
    const usesPiSessionFactory = options.createSession === undefined;
    this.createSession = options.createSession ?? (createAgentSession as unknown as AgentSessionFactory);
    this.createModelRuntime = options.createModelRuntime
      ?? (options.modelRuntime !== undefined || !usesPiSessionFactory ? undefined : createPiModelRuntime);
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

    const selection = this.resolveModel(call.modelPattern, call.agentTypeDef);
    const thinkingLevel = selection.thinkingLevel;
    const agentDir = getAgentDir();

    let modelRuntime: ModelRuntimeLike | undefined;
    let model: ModelLike | undefined;
    try {
      modelRuntime = await waitForSharedInitialization(
        this.getModelRuntime(agentDir),
        call.signal,
      );
      if (call.signal?.aborted) throw abortedError();
      model = selection.model && modelRuntime?.getModel
        ? modelRuntime.getModel(selection.model.provider, selection.model.id) ?? selection.model
        : selection.model;
    } catch (error) {
      safeEmitTelemetry(call.onTelemetry, {
        kind: "run_error",
        error: safeDisplayText(errorText(error), 512),
        usage: emptyAgentUsage(),
      });
      throw error;
    }

    const createSession = (level: ThinkingLevel | undefined) => this.createSession({
      cwd,
      agentDir,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.create(cwd, agentDir),
      customTools,
      ...(model ? { model: model as any } : {}),
      ...(level ? { thinkingLevel: level as any } : {}),
      ...(toolAllowlist ? { tools: toolAllowlist } : {}),
      ...(modelRuntime
        ? { modelRuntime }
        : this.modelRegistry
          ? { modelRegistry: this.modelRegistry as any }
          : {}),
    });

    const sessionThinking = resolveSessionThinkingLevel(thinkingLevel, model);
    safeEmitTelemetry(call.onTelemetry, {
      kind: "model_requested",
      modelId: model?.id,
      effort: thinkingLevel,
    });

    let created: { session: AgentSessionLike };
    try {
      created = await createSession(sessionThinking);
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
    } catch (error) {
      safeEmitTelemetry(call.onTelemetry, {
        kind: "run_error",
        error: safeDisplayText(errorText(error), 512),
        usage: emptyAgentUsage(),
      });
      throw error;
    }
    const { session } = created;
    const actualModelId = session.model?.id ?? model?.id;
    const actualEffort = session.thinkingLevel;
    const telemetryCounters = { retries: 0, compactions: 0, turns: 0, toolUses: 0, observing: false };
    safeEmitTelemetry(call.onTelemetry, {
      kind: "model_resolved",
      modelId: actualModelId,
      effort: actualEffort,
    });

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

      // One subscription feeds both compact status and the private transcript
      // stream. Telemetry callbacks are isolated so observability can never
      // change the child run's outcome.
      if (call.onActivity || call.onTelemetry) {
        telemetryCounters.observing = true;
        unsubscribe = session.subscribe((event: unknown) => {
          const sessionEvent = event as { type?: unknown; message?: { role?: unknown } };
          const eventType = sessionEvent?.type;
          if (eventType === "message_end" && sessionEvent.message?.role === "assistant") telemetryCounters.turns++;
          if (eventType === "tool_execution_start") telemetryCounters.toolUses++;
          if (eventType === "auto_retry_start") telemetryCounters.retries++;
          if (eventType === "compaction_start") telemetryCounters.compactions++;
          if (call.onActivity) forwardActivity(event, call.onActivity);
          if (call.onTelemetry) forwardTelemetry(event, call.onTelemetry);
        });
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

      return {
        value,
        usage: readUsage(session, telemetryCounters),
        modelId: actualModelId,
        effort: actualEffort,
        cwd,
      };
    } catch (error) {
      hasPrimaryError = true;
      safeEmitTelemetry(call.onTelemetry, {
        kind: "run_error",
        error: safeDisplayText(errorText(error), 512),
        usage: readUsage(session, telemetryCounters),
        modelId: actualModelId,
        effort: actualEffort,
      });
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

  private getModelRuntime(agentDir: string): Promise<ModelRuntimeLike | undefined> {
    if (this.providedModelRuntime) return Promise.resolve(this.providedModelRuntime);
    if (!this.createModelRuntime) return Promise.resolve(undefined);
    if (!this.modelRuntimePromise) {
      // Cache the in-flight promise so parallel agent() calls never initialize
      // separate runtimes or race provider/auth replay. Clear only this failed
      // attempt so a later serial agent can retry transient initialization errors.
      const pending = this.initializeModelRuntime(agentDir);
      this.modelRuntimePromise = pending;
      void pending.catch(() => {
        if (this.modelRuntimePromise === pending) this.modelRuntimePromise = undefined;
      });
    }
    return this.modelRuntimePromise;
  }

  private async initializeModelRuntime(agentDir: string): Promise<ModelRuntimeLike | undefined> {
    const runtime = await this.createModelRuntime?.({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    if (!runtime) return undefined;

    const registeredProviderIds = this.modelRegistry?.getRegisteredProviderIds?.() ?? [];
    let providersChanged = false;
    for (const provider of registeredProviderIds) {
      const config = this.modelRegistry?.getRegisteredProviderConfig?.(provider);
      if (config === undefined || !runtime.registerProvider) continue;
      runtime.registerProvider(provider, config);
      providersChanged = true;
    }
    if (providersChanged && runtime.refresh) {
      await runtime.refresh({ allowNetwork: false });
    }

    // Only replay CLI/SDK runtime overrides. Stored credentials, OAuth, env,
    // and models.json auth must stay owned by the new runtime so they can refresh.
    if (
      runtime.setRuntimeApiKey
      && this.modelRegistry?.getProviderAuthStatus
      && this.modelRegistry.getApiKeyForProvider
    ) {
      const providers = new Set(this.modelRegistry.getAvailable().map((model) => model.provider));
      for (const provider of registeredProviderIds) providers.add(provider);
      for (const provider of providers) {
        if (this.modelRegistry.getProviderAuthStatus(provider).source !== "runtime") continue;
        const apiKey = await this.modelRegistry.getApiKeyForProvider(provider);
        if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
      }
    }

    return runtime;
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

interface ModelRuntimeConstructorLike {
  create(options: ModelRuntimeCreateOptions): Promise<ModelRuntimeLike>;
}

/** Capability detection avoids importing a named export that Pi 0.80.7 lacks. */
async function createPiModelRuntime(
  options: ModelRuntimeCreateOptions,
): Promise<ModelRuntimeLike | undefined> {
  const runtimeClass = (PiCodingAgent as unknown as {
    ModelRuntime?: ModelRuntimeConstructorLike;
  }).ModelRuntime;
  return runtimeClass?.create ? runtimeClass.create(options) : undefined;
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

function waitForSharedInitialization<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortedError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortedError()));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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

function emptyAgentUsage(): AgentUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
    toolUses: 0,
    retries: 0,
    compactions: 0,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeEmitTelemetry(
  listener: ((event: AgentTelemetryEvent) => void) | undefined,
  event: AgentTelemetryEvent,
): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // Detailed observability is best-effort and must never affect execution.
  }
}

function normalizeTurnUsage(value: unknown): AgentTurnUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as any;
  const inputTokens = finiteNumber(usage.input) ?? finiteNumber(usage.inputTokens) ?? 0;
  const outputTokens = finiteNumber(usage.output) ?? finiteNumber(usage.outputTokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: finiteNumber(usage.cacheRead) ?? 0,
    cacheWriteTokens: finiteNumber(usage.cacheWrite) ?? 0,
    // Compact task stats intentionally exclude cache traffic from token use.
    totalTokens: inputTokens + outputTokens,
    cost: finiteNumber(usage.cost?.total) ?? finiteNumber(usage.cost) ?? 0,
  };
}

function assistantText(message: any): string {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("");
}

function resultText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function tailByUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(mid), "utf8") <= maxBytes) high = mid;
    else low = mid + 1;
  }
  return value.slice(low);
}

function toolResultPreview(result: unknown): string | undefined {
  const raw = resultText(result);
  if (!raw.trim()) return undefined;
  const safe = safeTranscriptText(raw, 64 * 1024);
  const lines = safe.split(/\r?\n/).filter((line) => line.trim()).slice(-20).join("\n");
  const bounded = tailByUtf8Bytes(lines, 8 * 1024);
  return bounded.trim() || undefined;
}

/** Convert child session events into the private task-detail stream. */
export function forwardTelemetry(
  event: unknown,
  onTelemetry: (event: AgentTelemetryEvent) => void,
): void {
  try {
    const e = event as any;
    switch (e?.type) {
      case "turn_start":
        safeEmitTelemetry(onTelemetry, {
          kind: "turn_start",
          turnIndex: finiteNumber(e.turnIndex),
        });
        return;
      case "message_update": {
        const update = e.assistantMessageEvent;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          safeEmitTelemetry(onTelemetry, { kind: "text_delta", delta: update.delta });
        } else if (update?.type === "thinking_start") {
          safeEmitTelemetry(onTelemetry, { kind: "thinking_start" });
        } else if (update?.type === "thinking_end") {
          safeEmitTelemetry(onTelemetry, { kind: "thinking_end" });
        }
        return;
      }
      case "message_end":
        if (e.message?.role === "assistant") {
          safeEmitTelemetry(onTelemetry, {
            kind: "message_end",
            text: assistantText(e.message),
            usage: normalizeTurnUsage(e.message.usage),
            error: typeof e.message.errorMessage === "string" ? e.message.errorMessage : undefined,
          });
        }
        return;
      case "tool_execution_start":
        if (typeof e.toolName === "string") {
          const args = toolArgsPreview(e.toolName, e.args);
          safeEmitTelemetry(onTelemetry, {
            kind: "tool_start",
            toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : `${e.toolName}:unknown`,
            toolName: e.toolName,
            ...(args ? { toolArgs: args } : {}),
          });
        }
        return;
      case "tool_execution_end":
        safeEmitTelemetry(onTelemetry, {
          kind: "tool_end",
          toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : `${String(e.toolName ?? "tool")}:unknown`,
          toolName: typeof e.toolName === "string" ? e.toolName : "tool",
          isError: Boolean(e.isError),
          resultPreview: toolResultPreview(e.result),
        });
        return;
      case "auto_retry_start": {
        const attempt = finiteNumber(e.attempt) ?? 0;
        const maxAttempts = finiteNumber(e.maxAttempts) ?? 0;
        const reason = typeof e.errorMessage === "string" ? safeDisplayText(e.errorMessage, 160) : "";
        safeEmitTelemetry(onTelemetry, {
          kind: "retry",
          state: "start",
          detail: `retry ${attempt}/${maxAttempts} in ${formatDelay(finiteNumber(e.delayMs) ?? 0)}${reason ? `: ${reason}` : ""}`,
        });
        return;
      }
      case "auto_retry_end": {
        const failure = typeof e.finalError === "string" ? safeDisplayText(e.finalError, 180) : "";
        safeEmitTelemetry(onTelemetry, {
          kind: "retry",
          state: "end",
          detail: e.success ? "retry succeeded" : failure ? `retry failed: ${failure}` : "retry failed",
        });
        return;
      }
      case "compaction_start":
        safeEmitTelemetry(onTelemetry, {
          kind: "compaction",
          state: "start",
          detail: compactionStartDetail(e.reason),
        });
        return;
      case "compaction_end":
        safeEmitTelemetry(onTelemetry, {
          kind: "compaction",
          state: "end",
          detail: e.aborted ? "compaction aborted" : e.errorMessage ? "compaction failed" : "compaction complete",
        });
        return;
      default:
        return;
    }
  } catch {
    // best-effort: malformed provider events must not affect the run
  }
}

function readUsage(
  session: any,
  counters: {
    retries?: number;
    compactions?: number;
    turns?: number;
    toolUses?: number;
    observing?: boolean;
  } = {},
): AgentUsage {
  try {
    const stats = session.getSessionStats?.();
    if (stats?.tokens) {
      return {
        inputTokens: stats.tokens.input ?? 0,
        outputTokens: stats.tokens.output ?? 0,
        cacheReadTokens: stats.tokens.cacheRead ?? 0,
        cacheWriteTokens: stats.tokens.cacheWrite ?? 0,
        totalTokens: (stats.tokens.input ?? 0) + (stats.tokens.output ?? 0),
        cost: stats.cost ?? 0,
        turns: counters.observing ? counters.turns ?? 0 : stats.assistantMessages ?? 0,
        toolUses: counters.observing ? counters.toolUses ?? 0 : stats.toolCalls ?? 0,
        retries: counters.retries ?? 0,
        compactions: counters.compactions ?? 0,
      };
    }
  } catch {
    // fall through to message-based estimate
  }
  // Fallback: sum assistant usage from messages.
  const usage = emptyAgentUsage();
  for (const message of (session.messages ?? []) as Array<any>) {
    if (message?.role === "assistant" && message.usage) {
      usage.turns = (usage.turns ?? 0) + 1;
      usage.inputTokens = (usage.inputTokens ?? 0) + (message.usage.input ?? 0);
      usage.outputTokens += message.usage.output ?? 0;
      usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (message.usage.cacheRead ?? 0);
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (message.usage.cacheWrite ?? 0);
      usage.cost += message.usage.cost?.total ?? 0;
    }
    if (message?.role === "toolResult") usage.toolUses = (usage.toolUses ?? 0) + 1;
  }
  if (counters.observing) {
    usage.turns = counters.turns ?? 0;
    usage.toolUses = counters.toolUses ?? 0;
  }
  usage.totalTokens = (usage.inputTokens ?? 0) + usage.outputTokens;
  usage.retries = counters.retries ?? 0;
  usage.compactions = counters.compactions ?? 0;
  return usage;
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
    switch (e?.type) {
      case "agent_start":
        onActivity({ kind: "waiting", detail: "starting agent" });
        return;
      case "turn_start":
        // Pi emits this immediately before authentication/request setup and then
        // waits for the provider's first stream event.
        onActivity({ kind: "waiting", detail: "waiting for model" });
        return;
      case "message_start":
        if (e.message?.role === "assistant") {
          onActivity({ kind: "waiting", detail: "model stream opened" });
        }
        return;
      case "message_update":
        forwardMessageActivity(e.assistantMessageEvent, onActivity);
        return;
      case "message_end":
        if (e.message?.role === "assistant") {
          const error = compactText(e.message.errorMessage, 100);
          onActivity({
            kind: "waiting",
            detail: error ? `model response ended: ${error}` : "model response complete",
          });
        }
        return;
      case "tool_execution_start":
        forwardToolActivity(e, "start", onActivity);
        return;
      case "tool_execution_update":
        forwardToolActivity(e, "update", onActivity);
        return;
      case "tool_execution_end":
        forwardToolActivity(e, "end", onActivity);
        return;
      case "turn_end":
        onActivity({ kind: "waiting", detail: "turn complete" });
        return;
      case "agent_end":
        onActivity({
          kind: "waiting",
          detail: e.willRetry ? "agent ended; retry pending" : "finishing agent",
        });
        return;
      case "agent_settled":
        onActivity({ kind: "waiting", detail: "agent settled" });
        return;
      case "auto_retry_start": {
        const attempt = finiteNumber(e.attempt) ?? 0;
        const maxAttempts = finiteNumber(e.maxAttempts) ?? 0;
        const delay = formatDelay(finiteNumber(e.delayMs) ?? 0);
        const error = compactText(e.errorMessage, 100);
        onActivity({
          kind: "retry",
          detail: `retry ${attempt}/${maxAttempts} in ${delay}${error ? `: ${error}` : ""}`,
        });
        return;
      }
      case "auto_retry_end": {
        const attempt = finiteNumber(e.attempt) ?? 0;
        const error = compactText(e.finalError, 100);
        onActivity({
          kind: "retry",
          detail: e.success
            ? `retry ${attempt} succeeded`
            : `retry ${attempt} failed${error ? `: ${error}` : ""}`,
        });
        return;
      }
      case "compaction_start":
        onActivity({ kind: "compaction", detail: compactionStartDetail(e.reason) });
        return;
      case "compaction_end": {
        const error = compactText(e.errorMessage, 100);
        onActivity({
          kind: "compaction",
          detail: error
            ? `compaction failed: ${error}`
            : e.aborted
              ? "compaction aborted"
              : e.willRetry
                ? "compaction complete; retrying model"
                : "compaction complete",
        });
        return;
      }
      case "queue_update": {
        const queued = (Array.isArray(e.steering) ? e.steering.length : 0)
          + (Array.isArray(e.followUp) ? e.followUp.length : 0);
        if (queued > 0) onActivity({ kind: "waiting", detail: `${queued} queued message${queued === 1 ? "" : "s"}` });
        return;
      }
      case "thinking_level_changed":
        if (typeof e.level === "string") {
          onActivity({ kind: "waiting", detail: `thinking level: ${e.level}` });
        }
        return;
      default:
        return;
    }
  } catch {
    // best-effort: never let observability break the run
  }
}

function forwardMessageActivity(
  event: any,
  onActivity: (e: AgentActivityInput) => void,
): void {
  switch (event?.type) {
    case "text_start":
    case "text_end":
      onActivity({ kind: "text", detail: "responding" });
      return;
    case "text_delta":
      if (typeof event.delta === "string") {
        onActivity({ kind: "text", detail: "responding" });
      }
      return;
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
      onActivity({ kind: "thinking", detail: "thinking" });
      return;
    case "toolcall_start":
    case "toolcall_delta":
      // Current Pi events do not expose toolName until toolcall_end.
      onActivity({ kind: "waiting", detail: "preparing tool call" });
      return;
    case "toolcall_end": {
      const name = typeof event.toolCall?.name === "string" ? event.toolCall.name : "tool";
      const args = toolArgsPreview(name, event.toolCall?.arguments);
      onActivity({
        kind: "waiting",
        detail: `preparing ${toolLabel(name, args)}`,
      });
      return;
    }
  }
}

function forwardToolActivity(
  event: any,
  state: "start" | "update" | "end",
  onActivity: (e: AgentActivityInput) => void,
): void {
  if (typeof event.toolName !== "string") return;
  const name = event.toolName;
  const args = state === "end" ? undefined : toolArgsPreview(name, event.args);
  onActivity({
    kind: "tool",
    detail: state === "end"
      ? `${name} ${event.isError ? "failed" : "finished"}`
      : toolLabel(name, args),
    toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : `${name}:unknown`,
    toolName: name,
    ...(args ? { toolArgs: args } : {}),
    toolState: state,
  });
}

function toolLabel(name: string, args: string | undefined): string {
  const safeName = safeDisplayText(name, 40) || "tool";
  return args ? `${safeName}: ${args}` : safeName;
}

const PATH_PREVIEW_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

/** Keep tool status useful without displaying free-form payload bodies. */
export function toolArgsPreview(toolName: string, value: unknown, max = 80): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const args = value as Record<string, unknown>;
  const normalizedName = safeDisplayText(toolName, 40).toLowerCase();
  if (normalizedName === "bash") {
    const command = scalarPreview(args.command);
    if (command) return safeDisplayText(safeCommandPreview(command), max);
  }
  if (PATH_PREVIEW_TOOLS.has(normalizedName)) {
    for (const key of ["path", "file_path"]) {
      const filePath = scalarPreview(args[key]);
      if (filePath) return safePathPreview(filePath, max);
    }
  }
  return undefined;
}

function safePathPreview(value: string, max: number): string {
  const clean = displayOneLine(value);
  if (!clean || /:\/\/|[?&#@]/.test(clean)) return "path";
  const segments = clean.replace(/\\/g, "/").split("/").filter(Boolean);
  const basename = segments.at(-1) ?? clean;
  return safeDisplayText(basename, max) || "path";
}

function scalarPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    const sample = value.length > DISPLAY_INPUT_LIMIT
      ? value.slice(0, DISPLAY_INPUT_LIMIT)
      : value;
    if (sample.trim()) return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function compactionStartDetail(reason: unknown): string {
  if (reason === "overflow") return "context overflow; compacting";
  if (reason === "threshold") return "context threshold reached; compacting";
  return "compacting context";
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function compactText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return truncateDisplay(redactCommand(value), max);
}
