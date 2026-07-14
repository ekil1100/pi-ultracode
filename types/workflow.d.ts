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

  interface WorkflowBudget {
    total: number | null;
    spent(): number;
    remaining(): number;
  }

  /** Spawn a subagent. Returns final text, or a validated object when opts.schema is set. */
  function agent<T = unknown>(prompt: string, options?: WorkflowAgentOptions): Promise<T>;

  /** Run independent tasks concurrently (a barrier). Pass functions, not promises. */
  function parallel<T = unknown>(thunks: Array<() => Promise<T>>): Promise<T[]>;

  /** Run each item through sequential stages while items fan out (no barrier). */
  function pipeline<TItem = unknown, TResult = unknown>(
    items: TItem[],
    ...stages: Array<(previous: unknown, original: TItem, index: number) => TResult | Promise<TResult>>
  ): Promise<TResult[]>;

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

  /** Real output-token budget tracker for the run. */
  const budget: WorkflowBudget;
}
