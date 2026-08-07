/**
 * Ambient globals available inside pi-ultracode workflow scripts.
 * Orchestration promises must be directly awaited or returned; native promise
 * chains/combinators and dynamic method calls are intentionally unavailable.
 * Helpers containing orchestration must be directly declared functions/function
 * variables or static methods on declared objects/stored class instances; aliases,
 * member assignment,
 * this-method forwarding, and temporary/awaited factory receivers fail closed.
 *
 * Add this to a saved workflow file for editor IntelliSense:
 *
 *   /// <reference types="pi-ultracode/workflow" />
 */

export {};

declare global {
  interface WorkflowMeta {
    name: string;
    description: string;
    whenToUse?: string;
    phases?: Array<{ title: string; detail?: string; model?: string }>;
  }

  interface JsonSchema {
    type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
      | Array<"object" | "array" | "string" | "number" | "integer" | "boolean" | "null">;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: unknown[];
    const?: unknown;
    anyOf?: JsonSchema[];
    allOf?: JsonSchema[];
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
    title?: string;
    description?: string;
    default?: unknown;
    /** Unsupported: exact-one unions are not normalized by the bounded subset. */
    oneOf?: never;
    /** Unsupported: external/internal references are not resolved in workflows. */
    $ref?: never;
    $recursiveRef?: never;
    $dynamicRef?: never;
    /** Unsupported: JavaScript regex validation has no reliable execution bound. */
    pattern?: never;
    patternProperties?: never;
    format?: never;
  }

  interface WorkflowAgentOptions {
    /** Short label shown in live progress (2-5 words). */
    label?: string;
    /** Assign this agent to a progress group explicitly. */
    phase?: string;
    /** Bounded JSON Schema subset (max 256 KiB / 64 levels); every agent output is capped at 2 MiB. */
    schema?: JsonSchema;
    /** Override model and optionally effort, e.g. "sonnet", "anthropic/...:high", or "gpt-5.6-sol:max". */
    model?: string;
    /** Run the agent in an isolated git worktree (for parallel file mutation). */
    isolation?: "worktree";
    /** Use a custom subagent role/system-prompt (built-in or discovered). */
    agentType?: string;
  }

  /** Spawn a subagent. Its strict JSON result is capped at 2 MiB; ordinary started-run failures resolve null. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T | null>;

  interface WorkflowParallelOptions {
    /**
     * Agent slots to reserve atomically before any thunk starts. Defaults to thunks.length.
     * Must be at least thunks.length. Raise it when branches need multiple agent() calls;
     * calls beyond the reserved amount fail the entire workflow instead of borrowing capacity.
     */
    reserveAgents?: number;
  }

  /**
   * Run independent tasks concurrently; infer values from thunks and represent a
   * branch throw as null. Workflow-wide cancellation/policy failures propagate and are
   * not downgraded to null. The whole panel reserves agent slots before any branch starts.
   */
  function parallel<T = string>(thunks: Array<() => T | Promise<T>>, options?: WorkflowParallelOptions): Promise<Array<Awaited<T> | null>>;

  /**
   * Fan items through sequential stages. A stage input can be null when a prior
   * stage (including agent()) returned null; an ordinary throwing item branch ends as null.
   * Workflow-wide cancellation and policy failures propagate and are not downgraded to null.
   */
  function pipeline<TItem = unknown, TResult = string>(
    items: TItem[],
    ...stages: Array<
      (previous: unknown | null, original: TItem, index: number) => TResult | Promise<TResult>
    >
  ): Promise<Array<Awaited<TResult> | null>>;

  /** Run a saved workflow with strict JSON args (1 MiB) and output (2 MiB); one level of nesting. */
  function workflow<T = unknown>(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<T>;

  /** Mark the current phase for progress grouping. */
  function phase(title: string): void;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** JSON value passed via the tool's `args` parameter (max 1 MiB serialized). */
  const args: unknown;

  /** Working directory for the workflow and its subagents. */
  const cwd: string;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };
}
