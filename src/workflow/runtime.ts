/**
 * Deterministic workflow runtime.
 *
 * Parses a workflow script and runs its body inside a Node vm sandbox with the
 * orchestration globals: agent(), parallel(), pipeline(), phase(), log(),
 * workflow(), plus `args`, `cwd`, and `budget`. The sandbox deliberately omits
 * Date.now / Math.random / require / fs / network so runs are reproducible and
 * resumable.
 */

import vm from "node:vm";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseWorkflowScript, type WorkflowMeta } from "./parser.ts";
// Static import: a dynamic import() of this module misbehaves under Pi's jiti
// loader ("WorkflowAgentRunner is not a constructor"). Tests inject a runner, so
// they never construct this class; production builds it via getRunner().
import { WorkflowAgentRunner } from "./agent-runner.ts";
import type { AgentRunResult, ModelLike, ModelRegistryLike, ThinkingLevel } from "./agent-runner.ts";
import { discoverAgentTypes, resolveAgentType, type AgentTypeDef } from "./agent-types.ts";
import { agentCallKey, RunJournal } from "./journal.ts";
import {
  applyPatch,
  captureWorktreeDiff,
  createWorktree,
  hasChanges,
  isGitRepo,
  removeWorktree,
  writeRescuePatch,
  type Worktree,
  type WorktreeDiff,
} from "./worktree.ts";

const MAX_CONCURRENCY = 16;
const MAX_AGENTS_PER_RUN = 1000;
const MAX_ITEMS_PER_CALL = 4096;

export interface AgentEventBase {
  id: number;
  label: string;
  phase?: string;
}

export interface WorkflowRunOptions {
  cwd?: string;
  args?: unknown;
  signal?: AbortSignal;
  concurrency?: number;
  tokenBudget?: number | null;
  modelRegistry?: ModelRegistryLike;
  model?: ModelLike;
  thinkingLevel?: ThinkingLevel;
  /** Inject a runner (tests). */
  runner?: { run: WorkflowAgentRunner["run"] };
  journal?: RunJournal;
  /** Loads a saved workflow body by name; defaults to disk discovery. */
  loadSavedWorkflow?: (nameOrRef: string | { scriptPath: string }) => { meta: WorkflowMeta; body: string };
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: AgentEventBase & { prompt: string; cached: boolean }) => void;
  onAgentEnd?: (event: AgentEventBase & { result: unknown; status: "done" | "error" }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  cachedCount: number;
  spentTokens: number;
  durationMs: number;
}

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  agentCount: number; // number of agent() invocations (for ids / cap)
  cachedCount: number;
  spent: number; // real output tokens
}

export async function runWorkflow<T = unknown>(
  rawScript: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(rawScript);
  const runtime = new Runtime(options);
  const result = await runtime.runBody(body, options.args, 0, meta.name);
  await runtime.drain();
  // structuredClone both validates serialisability and lifts the value out of the
  // vm realm so callers get plain host-realm objects.
  const cloned = cloneResult(result, "workflow result");
  return {
    meta,
    result: cloned as T,
    logs: runtime.state.logs,
    phases: runtime.state.phases,
    agentCount: runtime.state.agentCount,
    cachedCount: runtime.state.cachedCount,
    spentTokens: runtime.state.spent,
    durationMs: Date.now() - started,
  };
}

class Runtime {
  readonly state: RuntimeState = { logs: [], phases: [], agentCount: 0, cachedCount: 0, spent: 0 };
  private readonly options: WorkflowRunOptions;
  private readonly cwd: string;
  private runnerInstance: { run: WorkflowAgentRunner["run"] } | undefined;
  private readonly agentTypes: Map<string, AgentTypeDef>;
  private readonly limiter: <R>(fn: () => Promise<R>) => Promise<R>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly tokenBudget: number | null;
  private readonly applyLock = new Mutex();
  private depth = 0;

  constructor(options: WorkflowRunOptions) {
    this.options = options;
    this.cwd = options.cwd ?? process.cwd();
    this.runnerInstance = options.runner;
    this.agentTypes = discoverAgentTypes(this.cwd);
    this.tokenBudget = options.tokenBudget ?? null;
    const cores = (globalThis as any).navigator?.hardwareConcurrency ?? os.cpus().length ?? 8;
    const concurrency = Math.max(1, Math.min(options.concurrency ?? Math.max(1, cores - 2), MAX_CONCURRENCY));
    this.limiter = createLimiter(concurrency);
  }

  get budget() {
    return Object.freeze({
      total: this.tokenBudget,
      spent: () => this.state.spent,
      remaining: () =>
        this.tokenBudget == null ? Infinity : Math.max(0, this.tokenBudget - this.state.spent),
    });
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  /** Lazily construct the default in-memory runner (skipped when a runner is injected). */
  private getRunner(): { run: WorkflowAgentRunner["run"] } {
    if (!this.runnerInstance) {
      this.runnerInstance = new WorkflowAgentRunner({
        cwd: this.cwd,
        modelRegistry: this.options.modelRegistry,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
      });
    }
    return this.runnerInstance;
  }

  /** Execute one workflow body (top-level or nested) with shared runtime state. */
  async runBody(body: string, args: unknown, depth: number, name: string): Promise<unknown> {
    const context = vm.createContext(this.buildSandbox(args));
    const wrapped = `(async () => {\n${body}\n})()`;
    return new vm.Script(wrapped, { filename: `${name || "workflow"}.js` }).runInContext(context);
  }

  private buildSandbox(args: unknown): Record<string, unknown> {
    const log = (message: unknown) => {
      const text = String(message);
      this.state.logs.push(text);
      this.options.onLog?.(text);
    };
    return {
      agent: this.agent.bind(this),
      parallel: this.parallel.bind(this),
      pipeline: this.pipeline.bind(this),
      phase: this.phase.bind(this),
      log,
      workflow: this.workflow.bind(this),
      args,
      cwd: this.cwd,
      process: Object.freeze({ cwd: () => this.cwd }),
      budget: this.budget,
      console: {
        log,
        info: log,
        warn: (m: unknown) => log(`[warn] ${String(m)}`),
        error: (m: unknown) => log(`[error] ${String(m)}`),
      },
      JSON,
      Math,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Set,
      Map,
      Promise,
      structuredClone,
    };
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) throw new Error("workflow aborted");
  }

  private phase(title: unknown): void {
    const text = requireString(title, "phase title");
    this.state.currentPhase = text;
    if (!this.state.phases.includes(text)) this.state.phases.push(text);
    this.options.onPhase?.(text);
  }

  private async agent(promptValue: unknown, optionsValue: unknown = {}): Promise<unknown> {
    this.throwIfAborted();
    if (this.tokenBudget != null && this.budget.remaining() <= 0) {
      throw new Error("workflow token budget exhausted");
    }
    const prompt = requireString(promptValue, "agent prompt");
    const opts = normalizeAgentOptions(optionsValue);
    const assignedPhase = opts.phase ?? this.state.currentPhase;

    const seq = ++this.state.agentCount;
    if (seq > MAX_AGENTS_PER_RUN) {
      throw new Error(`workflow exceeded the ${MAX_AGENTS_PER_RUN}-agent cap (runaway loop?)`);
    }
    const id = seq;
    const label = opts.label?.trim() || defaultLabel(assignedPhase, id);
    const key = agentCallKey(prompt, { ...opts, phase: assignedPhase });

    // Resume: cached prefix replay.
    const cached = this.options.journal?.lookup(seq, key);
    if (cached) {
      this.state.cachedCount++;
      this.state.spent += cached.outputTokens ?? 0;
      this.options.onAgentStart?.({ id, label, phase: assignedPhase, prompt, cached: true });
      this.options.onAgentEnd?.({ id, label, phase: assignedPhase, result: cached.value, status: "done" });
      return cached.value;
    }

    const run = this.limiter(async () => {
      this.options.onAgentStart?.({ id, label, phase: assignedPhase, prompt, cached: false });
      let worktree: Worktree | undefined;
      let keepWorktree = false;
      try {
        this.throwIfAborted();
        const agentTypeDef = resolveAgentType(opts.agentType, this.agentTypes);

        if (opts.isolation === "worktree") {
          worktree = this.tryCreateWorktree(id);
        }

        const runner = this.getRunner();
        const result: AgentRunResult = await runner.run({
          prompt,
          label,
          schema: opts.schema,
          signal: this.options.signal,
          instructions: buildInstructions(assignedPhase, opts),
          modelPattern: opts.model,
          agentTypeDef,
          cwd: worktree?.agentCwd,
        });
        this.throwIfAborted();

        if (worktree) keepWorktree = await this.integrateWorktree(worktree, id, label);

        this.state.spent += result.usage.outputTokens;
        this.options.journal?.recordAgent({
          seq,
          key,
          label,
          value: result.value,
          outputTokens: result.usage.outputTokens,
        });
        this.options.onAgentEnd?.({ id, label, phase: assignedPhase, result: result.value, status: "done" });
        return result.value;
      } catch (error) {
        if (this.options.signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.logLine(`agent ${label} failed: ${message}`);
        this.options.onAgentEnd?.({ id, label, phase: assignedPhase, result: null, status: "error" });
        return null;
      } finally {
        if (worktree && !keepWorktree) {
          try {
            removeWorktree(worktree);
          } catch {
            // ignore cleanup failures
          }
        }
      }
    });
    this.track(run);
    return run;
  }

  private async parallel(thunks: unknown): Promise<unknown[]> {
    this.throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`parallel() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${thunks.length})`);
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
      );
    }
    return Promise.all(
      (thunks as Array<() => Promise<unknown>>).map(async (thunk, index) => {
        try {
          return await thunk();
        } catch (error) {
          if (this.options.signal?.aborted) throw error;
          this.logLine(`parallel[${index}] failed: ${errorMessage(error)}`);
          return null;
        }
      }),
    );
  }

  private async pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
    this.throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new Error(`pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items (got ${items.length})`);
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    const fns = stages as Array<(prev: unknown, original: unknown, index: number) => unknown>;
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        for (const stage of fns) {
          try {
            this.throwIfAborted();
            value = await stage(value, item, index);
            this.throwIfAborted();
          } catch (error) {
            if (this.options.signal?.aborted) throw error;
            this.logLine(`pipeline[${index}] failed: ${errorMessage(error)}`);
            return null;
          }
        }
        return value;
      }),
    );
  }

  private async workflow(nameOrRef: unknown, args: unknown): Promise<unknown> {
    this.throwIfAborted();
    if (this.depth >= 1) {
      throw new Error("workflow() nesting is one level deep only; cannot call workflow() inside a child workflow");
    }
    const ref = normalizeWorkflowRef(nameOrRef);
    const loader = this.options.loadSavedWorkflow ?? ((r) => loadSavedWorkflowFromDisk(r, this.cwd));
    const { meta, body } = loader(ref);
    this.depth++;
    try {
      this.options.onLog?.(`▸ nested workflow: ${meta.name}`);
      const value = await this.runBody(body, args, this.depth, meta.name);
      return value;
    } finally {
      this.depth--;
    }
  }

  private tryCreateWorktree(index: number): Worktree | undefined {
    if (!isGitRepo(this.cwd)) {
      this.logLine(`agent #${index}: isolation:'worktree' ignored — not a git repository`);
      return undefined;
    }
    try {
      const runId = this.options.journal ? path.basename(this.options.journal.filePath, ".jsonl") : "run";
      return createWorktree(this.cwd, runId, index);
    } catch (error) {
      this.logLine(`agent #${index}: worktree setup failed (${errorMessage(error)}); running in shared cwd`);
      return undefined;
    }
  }

  /**
   * Fold a worktree's changes back into the shared working tree. Returns true
   * when the worktree must be KEPT (its changes are not safely preserved
   * elsewhere — e.g. apply conflicted AND the rescue write failed). Never throws:
   * a writeback failure must not discard the agent's already-completed result
   * or its token spend.
   */
  private async integrateWorktree(worktree: Worktree, id: number, label: string): Promise<boolean> {
    // Outer safety net: a writeback/integration failure (including a host
    // onUpdate callback throwing during a log line) must never discard the
    // agent's completed work. Fail-safe toward KEEPING the worktree.
    try {
      let diff: WorktreeDiff;
      try {
        diff = captureWorktreeDiff(worktree);
      } catch (error) {
        this.logLine(
          `worktree[${label}]: diff capture failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
        );
        return true;
      }
      if (!hasChanges(diff)) {
        this.logLine(`worktree[${label}]: no changes (auto-removed)`);
        return false;
      }
      // Apply patches back to the shared tree sequentially to avoid corruption.
      let keep = false;
      await this.applyLock.run(async () => {
        const applied = applyPatch(this.cwd, diff.patch);
        if (applied) {
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s), +${diff.insertions}/-${diff.deletions} applied to working tree`,
          );
          return;
        }
        // 3-way conflict: `applyPatch` already reverted the shared tree to its
        // pre-apply state. Persist the patch so the agent's work is recoverable
        // before the worktree is removed.
        const runId = this.options.journal
          ? path.basename(this.options.journal.filePath, ".jsonl")
          : "run";
        const rescueDir = this.rescueDir();
        try {
          const rescue = writeRescuePatch(rescueDir, runId, id, label, diff.patch);
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s), +${diff.insertions}/-${diff.deletions} could NOT be auto-applied (3-way conflict); patch saved to ${rescue} — review and apply with: git apply --3way ${rescue}`,
          );
        } catch (error) {
          // Rescue write failed (disk full / permission / bad path). Keep the
          // worktree so the user can recover the changes manually.
          keep = true;
          this.logLine(
            `worktree[${label}]: ${diff.filesChanged} file(s) could NOT be auto-applied (3-way conflict) AND rescue write failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
          );
        }
      });
      return keep;
    } catch (error) {
      try {
        this.logLine(
          `worktree[${label}]: integration failed (${errorMessage(error)}); worktree KEPT at ${worktree.path} (branch ${worktree.branch}) — recover with: git -C ${worktree.path} diff`,
        );
      } catch {
        // best-effort logging
      }
      return true;
    }
  }

  /** Where to write rescue patches: the session runs dir (co-located with the
   *  journal, never inside the repo working tree), or .pi/ultracode/patches. */
  private rescueDir(): string {
    const journalDir = this.options.journal ? path.dirname(this.options.journal.filePath) : undefined;
    if (journalDir) return path.join(journalDir, "patches");
    return path.join(this.cwd, ".pi", "ultracode", "patches");
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
  }

  private logLine(text: string): void {
    this.state.logs.push(text);
    this.options.onLog?.(text);
  }
}

export interface AgentOptions {
  label?: string;
  phase?: string;
  schema?: unknown;
  model?: string;
  isolation?: "worktree";
  agentType?: string;
}

function normalizeAgentOptions(value: unknown): AgentOptions {
  if (value == null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as AgentOptions;
  return {
    label: optionalString(options.label, "agent label"),
    phase: optionalString(options.phase, "agent phase"),
    schema: options.schema,
    model: optionalString(options.model, "agent model"),
    isolation: options.isolation === "worktree" ? "worktree" : undefined,
    agentType: optionalString(options.agentType, "agent type"),
  };
}

function normalizeWorkflowRef(value: unknown): string | { scriptPath: string } {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as any).scriptPath === "string") {
    return { scriptPath: (value as any).scriptPath };
  }
  throw new TypeError("workflow() expects a workflow name string or { scriptPath }");
}

export function loadSavedWorkflowFromDisk(
  ref: string | { scriptPath: string },
  cwd: string,
): { meta: WorkflowMeta; body: string } {
  let scriptPath: string | undefined;
  if (typeof ref === "object") {
    scriptPath = path.isAbsolute(ref.scriptPath) ? ref.scriptPath : path.join(cwd, ref.scriptPath);
  } else {
    scriptPath = resolveSavedWorkflowPath(ref, cwd);
  }
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    throw new Error(`workflow() could not find a saved workflow for ${JSON.stringify(ref)}`);
  }
  return parseWorkflowScript(fs.readFileSync(scriptPath, "utf8"));
}

function resolveSavedWorkflowPath(name: string, cwd: string): string | undefined {
  const dirs = [
    path.join(cwd, ".pi", "ultracode", "workflows"),
    path.join(os.homedir(), ".pi", "ultracode", "workflows"),
  ];
  const candidates = [`${name}.workflow.js`, `${name}.js`, name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
  }
  return undefined;
}

function buildInstructions(phase: string | undefined, opts: AgentOptions): string | undefined {
  const lines: string[] = [];
  if (phase) lines.push(`Workflow phase: ${phase}`);
  if (opts.isolation === "worktree") {
    lines.push("You are running in an isolated git worktree; edit files freely without coordinating with siblings.");
  }
  return lines.length ? lines.join("\n") : undefined;
}

function defaultLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function createLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneResult<T>(value: T, name: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), or pipeline()?${detail}`,
    );
  }
}
