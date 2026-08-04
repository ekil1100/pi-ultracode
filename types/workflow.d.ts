/**
 * Ambient globals available inside pi-ultracode workflow scripts.
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
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema | JsonSchema[];
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    enum?: unknown[];
    const?: unknown;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    description?: string;
    [key: string]: unknown;
  }

  interface WorkflowAgentOptions {
    /** Short label shown in live progress (2-5 words). */
    label?: string;
    /** Assign this agent to a progress group explicitly. */
    phase?: string;
    /** JSON Schema for structured output; agent() then returns the validated object. */
    schema?: JsonSchema;
    /** Override model and optionally effort, e.g. "sonnet", "anthropic/...:high", or "gpt-5.6-sol:max". */
    model?: string;
    /** Run the agent in an isolated git worktree (for parallel file mutation). */
    isolation?: "worktree";
    /** Use a custom subagent role/system-prompt (built-in or discovered). */
    agentType?: string;
  }

  /** Spawn a subagent. Text is the default; use an explicit T with opts.schema. A started run failure resolves null. */
  function agent<T = string>(prompt: string, options?: WorkflowAgentOptions): Promise<T | null>;

  /**
   * Run independent tasks concurrently; infer values from thunks and represent a
   * branch throw as null. Workflow-wide external cancellation propagates and is
   * not downgraded to null.
   */
  function parallel<T = string>(thunks: Array<() => T | Promise<T>>): Promise<Array<Awaited<T> | null>>;

  /**
   * Fan items through sequential stages. A stage input can be null when a prior
   * stage (including agent()) returned null; a throwing item branch ends as null.
   * Workflow-wide external cancellation propagates and is not downgraded to null.
   */
  function pipeline<TItem = unknown, TResult = string>(
    items: TItem[],
    ...stages: Array<
      (previous: unknown | null, original: TItem, index: number) => TResult | Promise<TResult>
    >
  ): Promise<Array<Awaited<TResult> | null>>;

  /** Run a saved workflow (by name) or { scriptPath } inline; one level of nesting. */
  function workflow<T = unknown>(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<T>;

  /** Mark the current phase for progress grouping. */
  function phase(title: string): void;

  /** Append a workflow-level log line. */
  function log(message: unknown): void;

  /** JSON value passed via the tool's `args` parameter. */
  const args: unknown;

  /** Working directory for the workflow and its subagents. */
  const cwd: string;

  /** Deterministic process shim exposing only cwd(). */
  const process: { cwd(): string };
}
