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
  createCodemodeExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Result, Scope } from "effect";
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
import { selectJevEfforts, type JevRuntime, type JevSelection } from "../jev.ts";

export type { ThinkingLevel } from "../thinking.ts";

const CHILD_ORCHESTRATION_TOOLS = ["workflow", "subagent", "subagent_wait"];
const PARENT_ONLY_CHILD_SKILLS = new Set(["pi-subagents"]);

export interface WorkflowChildResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  projectTrusted?: boolean;
  settingsManager?: SettingsManager;
}

/**
 * Build the sealed resource view used by workflow agent sessions.
 *
 * Ambient extension factories execute during discovery, so filtering an already
 * loaded extension result is too late: another in-process orchestrator may have
 * already replaced process-global lifecycle state. Disable ambient extensions at
 * the loader boundary while retaining project context and ordinary skills.
 */
export function createWorkflowChildResourceLoader(
  options: WorkflowChildResourceLoaderOptions,
): Promise<DefaultResourceLoader> {
  return runAtSdkBoundary(loadChildResources(options));
}

function loadChildResources(options: WorkflowChildResourceLoaderOptions) {
  return attempt(
    () =>
      options.settingsManager ??
      SettingsManager.create(options.cwd, options.agentDir, {
        projectTrusted: options.projectTrusted ?? false,
      }),
  ).pipe(
    Effect.flatMap((settingsManager) =>
      attempt(
        () =>
          new DefaultResourceLoader({
            cwd: options.cwd,
            agentDir: options.agentDir,
            settingsManager,
            noExtensions: true,
            extensionFactories: [createCodemodeExtension({ mode: "on", models: false })],
            skillsOverride: ({ skills, diagnostics }) => ({
              skills: skills.filter((skill) => !PARENT_ONLY_CHILD_SKILLS.has(skill.name)),
              diagnostics,
            }),
          }),
      ).pipe(
        Effect.flatMap((loader) =>
          fromSdk(() => loader.reload()).pipe(
            Effect.andThen(() =>
              attempt(() =>
                settingsManager.applyOverrides({
                  defaultTools: [...(settingsManager.getDefaultTools() ?? []), "+codemode"],
                }),
              ),
            ),
            Effect.as(loader),
          ),
        ),
      ),
    ),
  );
}

/** A minimal structural view of a Pi model (avoids importing the heavy generic type). */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
  /** Omitted only by structural hosts without capability metadata. */
  reasoning?: boolean;
  /** Extended levels are supported only when Pi exposes a non-null mapping. */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface ModelRegistryLike extends Partial<JevRuntime> {
  getAvailable(): ModelLike[];
  /** Legacy public projection retained for consumers of this structural type. */
  getAll?(): ModelLike[];
  getRegisteredProviderIds?(): readonly string[];
  getRegisteredProviderConfig?(provider: string): unknown;
  /** Pi 0.81+ complete provider registration, distinct from legacy config providers. */
  getRegisteredNativeProvider?(provider: string): any | undefined;
  getProviderAuthStatus?(provider: string): {
    configured: boolean;
    source?: string;
  };
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

/** Structural ModelRuntime seam for SDK hosts and test doubles. */
export interface ModelRuntimeLike extends Partial<JevRuntime> {
  getModel?(provider: string, modelId: string): ModelLike | undefined;
  registerProvider?(provider: string, config: any): void;
  /** Pi 0.81+ complete provider registration. */
  registerNativeProvider?(provider: any): void;
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
  getAvailableThinkingLevels(): ThinkingLevel[];
  setThinkingLevel(level: ThinkingLevel, options?: { persist?: boolean }): void;
  prompt(prompt: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void>;
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
  /** Parent session's immutable project-trust decision. */
  projectTrusted?: boolean;
  /** Host registry for model selection, state replay and native classification/auth. */
  modelRegistry?: ModelRegistryLike;
  /** Canonical runtime to share across child sessions when supplied by an SDK host. */
  modelRuntime?: ModelRuntimeLike;
  /** Default model used when an agent() call does not override it. */
  model?: ModelLike;
  /** Default thinking level for subagents. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Test seam for session construction and initialization races. Custom
   * factories own resource isolation; production uses the sealed Pi loader.
   */
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
  /** Scheduling hooks supplied only to runners declaring supportsSchedulingHooks. */
  selectEffort?: (task?: JevSelection) => Promise<ThinkingLevel | undefined>;
  /** Await after selectEffort and before execution; repeated calls share one permit. */
  acquireExecution?: () => Promise<void>;
  /** Safe compact activity stream used by the inline workflow status. */
  onActivity?: (event: AgentActivityInput) => void;
  /** Private detailed stream used by the task transcript store. */
  onTelemetry?: (event: AgentTelemetryEvent) => void;
}

export interface AgentRunner {
  /**
   * Opt in to preparation outside the execution limit. Before executing, run()
   * must await selectEffort exactly once (undefined skips classification), then
   * await acquireExecution. Forwarding wrappers must declare this capability
   * and forward both hooks. A runner without it receives no scheduling hooks;
   * the runtime admits its entire run() and excludes it from classification.
   */
  readonly supportsSchedulingHooks?: boolean;
  run(call: AgentRunCall): Promise<AgentRunResult>;
}

/** The constructor is the SDK compatibility boundary; all run state lives in closures. */
export class WorkflowAgentRunner implements AgentRunner {
  readonly supportsSchedulingHooks = true;
  readonly run: AgentRunner["run"];

  constructor(options: WorkflowAgentRunnerOptions) {
    this.run = makeAgentRunner(options);
  }
}

/** Keep foreign failures opaque, including rejection with undefined and custom properties. */
interface AgentRunnerFailure {
  readonly _tag: "AgentRunnerFailure";
  readonly cause: unknown;
}

const failure = (cause: unknown): AgentRunnerFailure => ({ _tag: "AgentRunnerFailure", cause });
const attempt = <A>(thunk: () => A) => Effect.try({ try: thunk, catch: failure });
const fromSdk = <A>(thunk: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: thunk, catch: failure });

function runAtSdkBoundary<A>(effect: Effect.Effect<A, AgentRunnerFailure>): Promise<A> {
  return Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    for (const reason of exit.cause.reasons) {
      if (Cause.isFailReason(reason)) throw reason.error.cause;
    }
    throw Cause.squash(exit.cause);
  });
}

const AgentSessions = Context.Service<{
  create(options: AgentSessionCreateOptions): Effect.Effect<AgentSessionLike, AgentRunnerFailure>;
}>("pi-ultracode/agent-runner/AgentSessions");

const ChildModels = Context.Service<{
  get(
    agentDir: string,
    signal?: AbortSignal,
  ): Effect.Effect<ModelRuntimeLike | undefined, AgentRunnerFailure>;
  classifierRuntime?: ModelRuntimeLike | ModelRegistryLike;
}>("pi-ultracode/agent-runner/ChildModels");

function makeAgentRunner(options: WorkflowAgentRunnerOptions): AgentRunner["run"] {
  // Capture configuration once, as the public constructor did before this adapter.
  const config = { ...options };
  const usesPiSessionFactory = config.createSession === undefined;
  const createSession =
    config.createSession ?? (createAgentSession as unknown as AgentSessionFactory);
  const sessions = AgentSessions.of({
    create: (input) =>
      fromSdk(() => createSession(input)).pipe(Effect.map(({ session }) => session)),
  });
  const models = makeChildModels(config, usesPiSessionFactory);
  const supportsMaxThinking =
    config.supportsMaxThinking ?? piVersionSupportsMaxThinking(PI_VERSION);
  return (call) =>
    runAtSdkBoundary(
      runAgent(call, config, usesPiSessionFactory, supportsMaxThinking).pipe(
        Effect.provideService(AgentSessions, sessions),
        Effect.provideService(ChildModels, models),
      ),
    );
}

function makeChildModels(options: WorkflowAgentRunnerOptions, usesPiSessionFactory: boolean) {
  const createRuntime =
    options.createModelRuntime ??
    (options.modelRuntime !== undefined || !usesPiSessionFactory
      ? undefined
      : createPiModelRuntime);
  let pending: Fiber.Fiber<ModelRuntimeLike | undefined, AgentRunnerFailure> | undefined;
  return ChildModels.of({
    classifierRuntime: options.modelRuntime ?? options.modelRegistry,
    get: (agentDir, signal) =>
      Effect.suspend(() => {
        if (options.modelRuntime) return Effect.succeed(options.modelRuntime);
        if (!createRuntime) return Effect.succeed(undefined);
        // The shared initialization belongs to this runner, not to any one call.
        // Start/cache atomically; cancelled waiters only detach from this fiber.
        if (!pending) {
          const started = Effect.runFork(
            // Publish the fiber before invoking the factory, so concurrent calls
            // also share a synchronous factory failure.
            Effect.yieldNow.pipe(
              Effect.andThen(() =>
                initializeModelRuntime(createRuntime, options.modelRegistry, agentDir),
              ),
            ),
          );
          pending = started;
          started.addObserver((exit) => {
            if (Exit.isFailure(exit) && pending === started) pending = undefined;
          });
        }
        return signal
          ? Effect.raceFirst(Fiber.join(pending), waitForAbort(signal))
          : Fiber.join(pending);
      }),
  });
}

function initializeModelRuntime(
  createRuntime: ModelRuntimeFactory,
  registry: ModelRegistryLike | undefined,
  agentDir: string,
) {
  return fromSdk(() =>
    createRuntime({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
    }),
  ).pipe(
    Effect.flatMap((runtime) => {
      if (!runtime) return Effect.succeed(undefined);
      const registerProviders = (providers: readonly string[]) =>
        attempt(() =>
          providers
            .map((provider) => {
              const nativeProvider = registry?.getRegisteredNativeProvider?.(provider);
              if (nativeProvider !== undefined && runtime.registerNativeProvider) {
                runtime.registerNativeProvider(nativeProvider);
                return true;
              }
              const config = registry?.getRegisteredProviderConfig?.(provider);
              if (config === undefined || !runtime.registerProvider) return false;
              runtime.registerProvider(provider, config);
              return true;
            })
            .some(Boolean),
        ).pipe(
          Effect.flatMap((changed) =>
            changed && runtime.refresh
              ? fromSdk(() => runtime.refresh!({ allowNetwork: false }))
              : Effect.void,
          ),
        );

      // Replay only runtime overrides. Stored/OAuth/env/model credentials remain
      // owned by the isolated runtime so that Pi can refresh them itself.
      const replayCredentials = (registeredProviderIds: readonly string[]) =>
        Effect.suspend(() => {
          if (
            !runtime.setRuntimeApiKey ||
            !registry?.getProviderAuthStatus ||
            !registry.getApiKeyForProvider
          )
            return Effect.void;
          const replayProvider = (provider: string) =>
            attempt(() => registry.getProviderAuthStatus!(provider)).pipe(
              Effect.flatMap((status) =>
                status.source !== "runtime"
                  ? Effect.void
                  : fromSdk(() => registry.getApiKeyForProvider!(provider)).pipe(
                      Effect.flatMap((apiKey) =>
                        apiKey
                          ? fromSdk(() => runtime.setRuntimeApiKey!(provider, apiKey))
                          : Effect.void,
                      ),
                    ),
              ),
            );
          return attempt(
            () =>
              new Set([
                ...registry.getAvailable().map((model) => model.provider),
                ...registeredProviderIds,
              ]),
          ).pipe(
            Effect.flatMap((providers) =>
              Effect.forEach(providers, replayProvider, { discard: true }),
            ),
          );
        });

      return attempt(() => registry?.getRegisteredProviderIds?.() ?? []).pipe(
        Effect.flatMap((providers) =>
          registerProviders(providers).pipe(Effect.andThen(() => replayCredentials(providers))),
        ),
        Effect.as(runtime),
      );
    }),
  );
}

function waitForAbort(signal: AbortSignal) {
  return Deferred.make<never, AgentRunnerFailure>().pipe(
    Effect.flatMap((cancelled) => {
      const onAbort = () => {
        Effect.runSync(Deferred.fail(cancelled, failure(abortedError())));
      };
      return Effect.acquireRelease(
        attempt(() => {
          signal.addEventListener("abort", onAbort, { once: true });
        }),
        () => attempt(() => signal.removeEventListener("abort", onAbort)).pipe(Effect.ignore),
      ).pipe(
        Effect.andThen(() => {
          if (signal.aborted) onAbort();
          return Deferred.await(cancelled);
        }),
      );
    }),
    Effect.scoped,
  );
}

const checkAborted = (signal?: AbortSignal) =>
  Effect.suspend(() => (signal?.aborted ? Effect.fail(failure(abortedError())) : Effect.void));

type Cleanup = (effect: Effect.Effect<unknown, AgentRunnerFailure>) => Effect.Effect<void>;

/** Finalizers finish independently; only a successful body exposes the first cleanup failure. */
function withCleanup<A, R>(use: (cleanup: Cleanup) => Effect.Effect<A, AgentRunnerFailure, R>) {
  return Effect.suspend(() => {
    let firstFailure: AgentRunnerFailure | undefined;
    const cleanup = (effect: Effect.Effect<unknown, AgentRunnerFailure>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.sync(() => {
            firstFailure ??= error;
          }),
        ),
      );
    return Effect.exit(use(cleanup)).pipe(
      Effect.flatMap((result) => {
        if (Exit.isFailure(result)) return Effect.failCause(result.cause);
        return firstFailure ? Effect.fail(firstFailure) : Effect.succeed(result.value);
      }),
    );
  });
}

function reportFailure<A, R>(
  effect: Effect.Effect<A, AgentRunnerFailure, R>,
  call: AgentRunCall,
  details: () => Omit<Extract<AgentTelemetryEvent, { kind: "run_error" }>, "kind" | "error">,
) {
  return effect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() =>
        safeEmitTelemetry(call.onTelemetry, {
          kind: "run_error",
          error: safeDisplayText(errorText(error.cause), 512),
          ...details(),
        }),
      ),
    ),
  );
}

function runAgent(
  call: AgentRunCall,
  options: WorkflowAgentRunnerOptions,
  usesPiSessionFactory: boolean,
  supportsMaxThinking: boolean,
) {
  return checkAborted(call.signal).pipe(
    Effect.andThen(() => {
      const executionCwd = call.cwd ?? options.cwd;
      const capture: StructuredOutputCapture<unknown> = { called: false, value: undefined };
      const prepare = attempt(() => {
        const customTools: ToolDefinition[] = [...createCodingTools(executionCwd)];
        const tools = call.agentTypeDef?.tools ? [...call.agentTypeDef.tools] : undefined;
        if (call.schema) {
          customTools.push(
            createStructuredOutputTool({
              schema: jsonSchemaToTypeBox(call.schema),
              capture,
            }) as unknown as ToolDefinition,
          );
          tools?.push("structured_output");
        }
        return {
          customTools,
          tools,
          agentDir: getAgentDir(),
          selection: resolveModelSelection({
            pattern: call.modelPattern,
            roleModel: call.agentTypeDef?.model,
            roleThinking: call.agentTypeDef?.thinking,
            defaultModel: options.model,
            defaultThinking: options.thinkingLevel,
            models: options.modelRegistry?.getAvailable(),
          }),
        };
      });
      return prepare.pipe(
        Effect.flatMap((prepared) => {
          const runWithModels = (models: typeof ChildModels.Service) => {
            const runWithModel = ({
              modelRuntime,
              model,
            }: {
              modelRuntime: ModelRuntimeLike | undefined;
              model: ModelLike | undefined;
            }) => {
              const thinkingLevel = prepared.selection.thinkingLevel;
              const sessionThinking = resolveSessionThinkingLevel(thinkingLevel, model);
              safeEmitTelemetry(call.onTelemetry, {
                kind: "model_requested",
                modelId: model?.id,
                effort: thinkingLevel,
              });
              return AgentSessions.pipe(
                Effect.flatMap((sessions) => {
                  const create = (level: ThinkingLevel | undefined) =>
                    attempt(() =>
                      SettingsManager.create(options.cwd, prepared.agentDir, {
                        projectTrusted: options.projectTrusted ?? false,
                      }),
                    ).pipe(
                      Effect.flatMap((settingsManager) => {
                        const resources: Effect.Effect<
                          DefaultResourceLoader | undefined,
                          AgentRunnerFailure
                        > = usesPiSessionFactory
                          ? loadChildResources({
                              cwd: options.cwd,
                              agentDir: prepared.agentDir,
                              projectTrusted: options.projectTrusted,
                              settingsManager,
                            })
                          : Effect.succeed(undefined);
                        return resources.pipe(
                          Effect.flatMap((resourceLoader) =>
                            attempt((): AgentSessionCreateOptions => ({
                              cwd: executionCwd,
                              agentDir: prepared.agentDir,
                              sessionManager: SessionManager.inMemory(executionCwd),
                              settingsManager,
                              ...(resourceLoader ? { resourceLoader } : {}),
                              customTools: prepared.customTools,
                              excludeTools: [...CHILD_ORCHESTRATION_TOOLS],
                              ...(model ? { model } : {}),
                              ...(level ? { thinkingLevel: level } : {}),
                              ...(prepared.tools ? { tools: prepared.tools } : {}),
                              ...(modelRuntime
                                ? { modelRuntime }
                                : options.modelRegistry
                                  ? { modelRegistry: options.modelRegistry }
                                  : {}),
                            })),
                          ),
                          Effect.flatMap((input) => sessions.create(input)),
                        );
                      }),
                    );

                  const runSession = (level: ThinkingLevel | undefined, allowFallback: boolean) =>
                    withCleanup((cleanup) => {
                      let provisional = false;
                      const acquire = Effect.acquireRelease(create(level), (session) => {
                        const dispose = attempt(() => session.dispose());
                        return provisional ? dispose.pipe(Effect.ignore) : cleanup(dispose);
                      });
                      const useSession = (session: AgentSessionLike) => {
                        // Ownership is established before reading any SDK capability getters.
                        const fallback = checkAborted(call.signal).pipe(
                          Effect.andThen(() =>
                            attempt(
                              () =>
                                allowFallback &&
                                thinkingLevel === ULTRACODE_THINKING_LEVEL &&
                                sessionThinking === ULTRACODE_THINKING_LEVEL &&
                                session.thinkingLevel !== ULTRACODE_THINKING_LEVEL &&
                                session.supportsThinking() &&
                                (!supportsMaxThinking ||
                                  (model ?? session.model)?.thinkingLevelMap?.max != null),
                            ),
                          ),
                        );
                        return reportFailure(fallback, call, () => ({
                          usage: emptyAgentUsage(),
                        })).pipe(
                          Effect.flatMap((fallback) => {
                            if (fallback) {
                              provisional = true;
                              return Effect.succeed(undefined);
                            }
                            return executeSession(
                              session,
                              call,
                              capture,
                              model,
                              models.classifierRuntime ?? modelRuntime,
                              executionCwd,
                              cleanup,
                            );
                          }),
                        );
                      };
                      return reportFailure(acquire, call, () => ({
                        usage: emptyAgentUsage(),
                      })).pipe(Effect.flatMap(useSession), Effect.scoped);
                    });

                  return runSession(sessionThinking, true).pipe(
                    // The provisional scope closes before the compatibility replacement is acquired.
                    Effect.flatMap((result) =>
                      result
                        ? Effect.succeed(result)
                        : runSession(LEGACY_ULTRACODE_THINKING_LEVEL, false).pipe(
                            Effect.map((replacement) => replacement!),
                          ),
                    ),
                  );
                }),
              );
            };
            const resolveModel = models.get(prepared.agentDir, call.signal).pipe(
              Effect.flatMap((modelRuntime) =>
                checkAborted(call.signal).pipe(
                  Effect.andThen(() =>
                    attempt(() =>
                      prepared.selection.model && modelRuntime?.getModel
                        ? (modelRuntime.getModel(
                            prepared.selection.model.provider,
                            prepared.selection.model.id,
                          ) ?? prepared.selection.model)
                        : prepared.selection.model,
                    ),
                  ),
                  Effect.map((model) => ({ modelRuntime, model })),
                ),
              ),
            );

            return reportFailure(resolveModel, call, () => ({ usage: emptyAgentUsage() })).pipe(
              Effect.flatMap(runWithModel),
            );
          };
          return ChildModels.pipe(Effect.flatMap(runWithModels));
        }),
      );
    }),
  );
}

function listenForCancellation(
  session: AgentSessionLike,
  signal: AbortSignal | undefined,
  cleanup: Cleanup,
) {
  return Effect.suspend(() => {
    if (!signal) return Effect.succeed(Effect.void);
    let aborting: Fiber.Fiber<void> | undefined;
    const drain = Effect.suspend(() => (aborting ? Fiber.join(aborting) : Effect.void));
    const onAbort = () => {
      // AbortSignal invokes callbacks synchronously. Start Effect's Promise adapter
      // here so synchronous throws and rejected abort promises are both contained.
      aborting ??= Effect.runFork(fromSdk(() => session.abort()).pipe(Effect.ignore));
    };
    return Effect.acquireRelease(Effect.succeed(onAbort), (listener) =>
      cleanup(attempt(() => signal.removeEventListener("abort", listener))).pipe(
        Effect.andThen(drain),
      ),
    ).pipe(
      // Establish cleanup before registration, including partially failed setup.
      Effect.andThen(() =>
        attempt(() => signal.addEventListener("abort", onAbort, { once: true })),
      ),
      Effect.andThen(() => {
        if (!signal.aborted) return Effect.void;
        onAbort();
        return drain;
      }),
      Effect.andThen(checkAborted(signal)),
      Effect.as(drain),
    );
  });
}

function executeSession(
  session: AgentSessionLike,
  call: AgentRunCall,
  capture: StructuredOutputCapture<unknown>,
  requestedModel: ModelLike | undefined,
  classifierRuntime: Partial<JevRuntime> | undefined,
  executionCwd: string,
  cleanup: Cleanup,
) {
  return attempt(() => session.model?.id ?? requestedModel?.id).pipe(
    Effect.flatMap((actualModelId) =>
      attempt(() => session.thinkingLevel).pipe(
        Effect.flatMap((initialEffort) => {
          let actualEffort = initialEffort;
          const counters = { retries: 0, compactions: 0, turns: 0, toolUses: 0, observing: false };
          const selectEffort = (prompt: string) =>
            attempt((): JevSelection | undefined => {
              const supportedEfforts = session.model ? session.getAvailableThinkingLevels() : [];
              return session.model && supportedEfforts.length > 1
                ? {
                    runtime: classifierRuntime,
                    task: prompt,
                    model: session.model,
                    supportedEfforts,
                  }
                : undefined;
            }).pipe(
              Effect.flatMap((selectionTask) =>
                call.selectEffort
                  ? fromSdk(() => call.selectEffort!(selectionTask))
                  : selectionTask
                    ? fromSdk(() =>
                        selectJevEfforts({
                          ...selectionTask,
                          tasks: [selectionTask],
                          signal: call.signal,
                        }),
                      ).pipe(Effect.map((efforts) => efforts[0]))
                    : Effect.succeed(undefined),
              ),
              Effect.flatMap((effort) =>
                checkAborted(call.signal).pipe(
                  Effect.andThen(() =>
                    effort !== undefined
                      ? attempt(() => session.setThinkingLevel(effort, { persist: false }))
                      : Effect.void,
                  ),
                ),
              ),
            );
          const acquireExecution = Effect.suspend(() =>
            // The runtime owns and releases this permit after publication/worktree delivery.
            // Await even an in-flight admission on cancellation; never orphan its acquisition.
            call.acquireExecution ? fromSdk(() => call.acquireExecution!()) : Effect.void,
          ).pipe(
            Effect.andThen(checkAborted(call.signal)),
            Effect.andThen(() => attempt(() => session.thinkingLevel)),
            Effect.map((effort) => {
              actualEffort = effort;
              safeEmitTelemetry(call.onTelemetry, {
                kind: "model_resolved",
                modelId: actualModelId,
                effort: actualEffort,
              });
            }),
          );
          const subscribe = Effect.suspend(() => {
            if (!call.onActivity && !call.onTelemetry) return Effect.void;
            counters.observing = true;
            return Effect.acquireRelease(
              attempt(() =>
                session.subscribe((event: unknown) => {
                  const sessionEvent = event as { type?: unknown; message?: { role?: unknown } };
                  const type = sessionEvent?.type;
                  if (type === "message_end" && sessionEvent.message?.role === "assistant")
                    counters.turns++;
                  if (type === "tool_execution_start") counters.toolUses++;
                  if (type === "auto_retry_start") counters.retries++;
                  if (type === "compaction_start") counters.compactions++;
                  if (call.onActivity) forwardActivity(event, call.onActivity);
                  if (call.onTelemetry) forwardTelemetry(event, call.onTelemetry);
                }),
              ),
              (unsubscribe) => cleanup(attempt(unsubscribe)),
            ).pipe(Effect.asVoid);
          });
          const promptSession = (prompt: string, drainAbort: Effect.Effect<void>) =>
            checkAborted(call.signal).pipe(
              // Do not pass call.signal to runPromise: interrupting tryPromise would detach
              // from Pi's external prompt. Cancellation calls abort(), then joins BOTH SDK
              // operations before closing scopes, including asynchronous input preflight.
              Effect.andThen(
                fromSdk(() =>
                  session.prompt(prompt, {
                    preflightResult: () => {
                      if (call.signal?.aborted) throw abortedError();
                    },
                  }),
                ).pipe(Effect.uninterruptible),
              ),
              // Successful prompt completion can precede abort teardown and its last
              // usage events. Drain first so cancellation telemetry includes them.
              Effect.andThen(() => (call.signal?.aborted ? drainAbort : Effect.void)),
              Effect.andThen(checkAborted(call.signal)),
              Effect.andThen(() =>
                attempt(() => {
                  if (!call.schema) return lastAssistantText(session.messages);
                  if (!capture.called)
                    throw new Error("Subagent finished without calling structured_output");
                  return capture.value;
                }),
              ),
              Effect.map((value) => ({
                value,
                usage: readUsage(session, counters),
                modelId: actualModelId,
                effort: actualEffort,
                cwd: executionCwd,
              })),
            );

          // The abort listener scope is inner: remove it and drain abort() before
          // releasing the event subscription, then let the outer session scope dispose.
          return Effect.scopedWith((subscriptionScope) =>
            reportFailure(
              listenForCancellation(session, call.signal, cleanup).pipe(
                Effect.flatMap((drainAbort) => {
                  const prompt = buildPrompt(call, Boolean(call.schema));
                  return selectEffort(prompt).pipe(
                    Effect.andThen(acquireExecution),
                    Effect.andThen(
                      subscribe.pipe(Effect.provideService(Scope.Scope, subscriptionScope)),
                    ),
                    Effect.andThen(() => promptSession(prompt, drainAbort)),
                  );
                }),
              ),
              call,
              () => ({
                usage: readUsage(session, counters),
                modelId: actualModelId,
                effort: actualEffort,
              }),
            ).pipe(Effect.scoped),
          );
        }),
      ),
    ),
  );
}

function buildPrompt(call: AgentRunCall, structured: boolean): string {
  const role = call.agentTypeDef;
  return [
    role?.systemPrompt
      ? `${role.systemPromptMode === "replace" ? "Role (operate strictly as):" : "Role:"}\n${role.systemPrompt}`
      : undefined,
    call.instructions,
    call.label ? `Task label: ${call.label}` : undefined,
    call.prompt,
    structured
      ? [
          "Final output contract:",
          "- Your final action MUST be a structured_output tool call.",
          "- The structured_output arguments are the return value of this subagent.",
          "- Do not emit a prose final answer instead of structured_output.",
        ].join("\n")
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

interface ModelRuntimeConstructorLike {
  create(options: ModelRuntimeCreateOptions): Promise<ModelRuntimeLike>;
}

/** Capability detection avoids importing a named export that Pi 0.80.7 lacks. */
function createPiModelRuntime(
  options: ModelRuntimeCreateOptions,
): Promise<ModelRuntimeLike | undefined> {
  const runtimeClass = (
    PiCodingAgent as unknown as {
      ModelRuntime?: ModelRuntimeConstructorLike;
    }
  ).ModelRuntime;
  return runtimeClass?.create ? runtimeClass.create(options) : Promise.resolve(undefined);
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

function matchExactModelIn(
  models: ModelLike[] | undefined,
  pattern: string,
): ModelLike | undefined {
  if (!models || !pattern.trim()) return undefined;
  const trimmed = pattern.trim();
  const lower = trimmed.toLowerCase();
  const canonicalMatches = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === lower,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) throw ambiguousModelReferenceError(trimmed, canonicalMatches);

  const idMatches = models.filter((model) => model.id.toLowerCase() === lower);
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) throw ambiguousModelReferenceError(trimmed, idMatches);
  return undefined;
}

function ambiguousModelReferenceError(pattern: string, matches: ModelLike[]): Error {
  const references = [...new Set(matches.map((model) => `${model.provider}/${model.id}`))]
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
  return new Error(
    `Model "${safeDisplayText(pattern, 80)}" is ambiguous across providers: ${safeDisplayText(references, 400)}. Use provider/model.`,
  );
}

/** Match a model pattern against a registry list: exact provider/id, then exact id, then substring. */
export function matchModelIn(
  models: ModelLike[] | undefined,
  pattern: string,
): ModelLike | undefined {
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
  const exactModel =
    matchExactModelIn(models, effectivePattern) ??
    matchExactModelIn(defaultModel ? [defaultModel] : undefined, effectivePattern);
  if (exactModel) {
    return { model: exactModel, thinkingLevel: roleThinking ?? defaultThinking };
  }
  const { base, thinking } = splitThinkingSuffix(effectivePattern);
  const model = base ? (matchModelIn(models, base) ?? defaultModel) : defaultModel;
  return { model, thinkingLevel: thinking ?? roleThinking ?? defaultThinking };
}

function abortedError(): Error {
  return new Error("Subagent was aborted");
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
  // Detailed observability is best-effort and must never affect execution.
  Effect.runSync(attempt(() => listener(event)).pipe(Effect.ignore));
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
  const lines = safe
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-20)
    .join("\n");
  const bounded = tailByUtf8Bytes(lines, 8 * 1024);
  return bounded.trim() || undefined;
}

/** Convert child session events into the private task-detail stream. */
export function forwardTelemetry(
  event: unknown,
  onTelemetry: (event: AgentTelemetryEvent) => void,
): void {
  Effect.runSync(
    attempt(() => {
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
              error:
                typeof e.message.errorMessage === "string" ? e.message.errorMessage : undefined,
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
            toolCallId:
              typeof e.toolCallId === "string"
                ? e.toolCallId
                : `${String(e.toolName ?? "tool")}:unknown`,
            toolName: typeof e.toolName === "string" ? e.toolName : "tool",
            isError: Boolean(e.isError),
            resultPreview: toolResultPreview(e.result),
          });
          return;
        case "auto_retry_start": {
          const attempt = finiteNumber(e.attempt) ?? 0;
          const maxAttempts = finiteNumber(e.maxAttempts) ?? 0;
          const reason =
            typeof e.errorMessage === "string" ? safeDisplayText(e.errorMessage, 160) : "";
          safeEmitTelemetry(onTelemetry, {
            kind: "retry",
            state: "start",
            detail: `retry ${attempt}/${maxAttempts} in ${formatDelay(finiteNumber(e.delayMs) ?? 0)}${reason ? `: ${reason}` : ""}`,
          });
          return;
        }
        case "auto_retry_end": {
          const failure =
            typeof e.finalError === "string" ? safeDisplayText(e.finalError, 180) : "";
          safeEmitTelemetry(onTelemetry, {
            kind: "retry",
            state: "end",
            detail: e.success
              ? "retry succeeded"
              : failure
                ? `retry failed: ${failure}`
                : "retry failed",
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
            detail: e.aborted
              ? "compaction aborted"
              : e.errorMessage
                ? "compaction failed"
                : "compaction complete",
          });
          return;
        default:
          return;
      }
    }).pipe(Effect.ignore),
  );
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
  const statsUsage = Result.try(() => {
    const stats = session.getSessionStats?.();
    if (stats?.tokens) {
      return {
        inputTokens: stats.tokens.input ?? 0,
        outputTokens: stats.tokens.output ?? 0,
        cacheReadTokens: stats.tokens.cacheRead ?? 0,
        cacheWriteTokens: stats.tokens.cacheWrite ?? 0,
        totalTokens: (stats.tokens.input ?? 0) + (stats.tokens.output ?? 0),
        cost: stats.cost ?? 0,
        turns: counters.observing ? (counters.turns ?? 0) : (stats.assistantMessages ?? 0),
        toolUses: counters.observing ? (counters.toolUses ?? 0) : (stats.toolCalls ?? 0),
        retries: counters.retries ?? 0,
        compactions: counters.compactions ?? 0,
      };
    }
  }).pipe(Result.getOrElse(() => undefined));
  if (statsUsage) return statsUsage;
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
  Effect.runSync(
    attempt(() => {
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
          const queued =
            (Array.isArray(e.steering) ? e.steering.length : 0) +
            (Array.isArray(e.followUp) ? e.followUp.length : 0);
          if (queued > 0)
            onActivity({
              kind: "waiting",
              detail: `${queued} queued message${queued === 1 ? "" : "s"}`,
            });
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
    }).pipe(Effect.ignore),
  );
}

function forwardMessageActivity(event: any, onActivity: (e: AgentActivityInput) => void): void {
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
    detail:
      state === "end" ? `${name} ${event.isError ? "failed" : "finished"}` : toolLabel(name, args),
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
    const sample = value.length > DISPLAY_INPUT_LIMIT ? value.slice(0, DISPLAY_INPUT_LIMIT) : value;
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
