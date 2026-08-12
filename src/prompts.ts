/**
 * Prompt text for ultracode mode.
 *
 * These strings reproduce the behavioural contract of Claude Code's "ultracode"
 * effort level: a standing opt-in to deterministic multi-agent workflow
 * orchestration, biased toward the most exhaustive, correct answer.
 */

/** One-line description shown by `/ultracode status` and the footer. */
export const ULTRACODE_TAGLINE = "max thinking + dynamic workflow orchestration";

/**
 * The standing system-prompt block injected on every turn while ultracode is on.
 * Mirrors the "Ultracode" section of the Workflow tool contract.
 */
export function ultracodeSystemBlock(): string {
  return [
    "<ultracode>",
    "Ultracode is ON. This opt-in is standing: author and run a workflow for every substantive task by default.",
    "",
    "The goal is a bounded, exhaustive-enough, correct answer: choose explicit fan-out and round limits before launching work.",
    "For multi-phase work (understand → design → implement → review), prefer one bounded workflow and inspect the result before deciding whether another workflow is justified. Do not run consecutive workflows by default; continue only when new evidence changes the plan.",
    "",
    "Lean toward orchestrating with the workflow tool and adversarially verifying your findings, unless the work is trivial or already verified. Solo (no workflow) only on conversational turns or trivial mechanical edits.",
    "",
    "Quality patterns to compose as the task calls for it:",
    "- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE it; kill the finding if a majority refute. Stops plausible-but-wrong findings from surviving.",
    "- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, performance, does-it-reproduce) instead of N identical refuters.",
    "- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time); each is blind to what the others surface.",
    "- Loop-until-dry: for unknown-size discovery (bugs, edge cases), run at most 2 rounds by default (3 only when the user explicitly asks for comprehensive coverage); stop sooner when no fresh evidence appears.",
    "- Completeness critic: a final agent that asks \"what's missing — a modality not run, a claim unverified, a source unread?\" What it finds becomes the next round of work.",
    "- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), log() what was dropped.",
    "",
    "Scale to the task: \"find any bugs\" → a few finders, single-vote verify; \"thoroughly audit\" / \"be comprehensive\" → a larger but explicit finder pool, 3–5 vote adversarial pass, and a synthesis stage within maxAgents.",
    "</ultracode>",
  ].join("\n");
}

/** Short reminder appended to confirm the mode is active (system-reminder style). */
export const ULTRACODE_ACTIVE_REMINDER =
  "Reminder: ultracode is on — default to authoring and running a workflow for substantive tasks, and adversarially verify your findings.";

/** Tool description for the `workflow` tool. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Execute a deterministic JavaScript workflow that orchestrates multiple subagents to be comprehensive (decompose and cover in parallel), confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps).",
  "Each invocation must provide workflow source via `script`, `scriptPath`, or `name`. Inline `script` must be raw JavaScript (no Markdown fences) beginning with `export const meta = { name, description }` (a pure literal) and should call agent() at least once for useful orchestration.",
  "Available globals: agent(prompt, opts), parallel(thunks, options?), pipeline(items, ...stages), phase(title), log(message), workflow(name, args), args, cwd. The tool accepts maxAgents (default 128, max 1024) as a lifetime live-agent admission cap across resumes, not a token budget; cache replay is free.",
].join(" ");

/** One-line snippet for the Available tools section. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Run a deterministic JS workflow that fans out subagents. Header: export const meta = { name: 'snake_case', description: '...' }. Globals: agent/parallel/pipeline/phase/log/workflow/args/cwd.";

/** Guideline bullets appended to the Guidelines section when the tool is active. */
export const WORKFLOW_GUIDELINES: string[] = [
  "While Ultracode is enabled, use the workflow tool to decompose-and-cover in parallel, gather independent perspectives that adversarially verify each other, or take on scale one context can't hold.",
  "For the workflow tool, provide workflow source with `script`, `scriptPath`, or `name`. Inline `script` must be one raw JavaScript string: no Markdown fences, no prose around the script.",
  "For the workflow tool, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`. meta must be a pure literal: no variables, function calls, spreads, or template interpolation. meta.phases is optional and should mirror your phase() titles.",
  "For the workflow tool, write plain JavaScript after the meta export. No TypeScript syntax, imports, require(), fs, network, Date/Intl/Temporal, Math.random(), binary memory constructors, WebAssembly, or dynamic method calls such as value[key](...) (they bypass deterministic checks or resource bounds). Stamp timestamps after the workflow returns; vary randomness by agent index.",
  "For the workflow tool, a useful workflow should call agent() at least once. Each agent() call should pass a short unique label (2-5 words) so live status and error reporting stay readable.",
  "For the workflow tool, DEFAULT TO pipeline(items, ...stages): items flow through stages independently with no barrier, so item A can be in stage 3 while item B is still in stage 1. Only use parallel() (a barrier that awaits all thunks) when a later stage genuinely needs ALL prior results together (dedup/merge across the full set, early-exit on zero, cross-item comparison).",
  "For the workflow tool, parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. It reserves `options.reserveAgents ?? thunks.length` agent slots before any thunk starts; reserveAgents must cover every agent call in the panel because calls beyond it are fatal. Results are returned in input order; a normal thunk throw resolves to null, while policy/cancellation failures are fatal.",
  "For the workflow tool, pipeline(items, ...stages) passes each stage (previousValue, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.",
  "For the workflow tool, if agent() needs machine-readable output pass an inline JSON Schema via opts.schema; agent() then returns the validated object. Use only the bounded subset: types, object/array structure, enum/const, anyOf/allOf, length/numeric constraints, and annotations. Unknown keywords, $ref variants, oneOf, format, pattern, and patternProperties are rejected. Keep schemas under 256 KiB / 64 levels and every agent/workflow output under 2 MiB. Use JSON Schema, not TypeScript or TypeBox constructors.",
  "For the workflow tool, when agent() is called WITHOUT a schema, its return value is the subagent's final assistant text (the last text the subagent produced). With a schema it returns the validated structured_output object. Prefer a schema for machine-readable results; use the text form only for prose summaries.",
  "For the workflow tool, agent opts also accept: model (override the subagent model by pattern), agentType (use a custom subagent role/system-prompt), isolation:'worktree' (run the agent in an isolated git worktree — use ONLY when agents mutate files in parallel and would conflict), and phase (assign the agent to a progress group explicitly inside parallel()/pipeline()).",
  "For the workflow tool, workflow(name, args) runs a trust-aware saved workflow by name as a sub-step, sharing this run's concurrency, maxAgents, active reservations, and agent counter. Explicit nested script paths are not supported. Nesting is one level only. Child subagent sessions do not load ambient extensions or expose workflow/subagent orchestration tools, so they cannot start an independent recursive workflow chain.",
  "For workflow resumeFromRunId, reuse the exact same script and args. Resume is immutable, successful calls replay by stable structural call path, and maxAgents may only stay the same or increase; changed work must start a new run.",
  "For the workflow tool, failed agent()/parallel()/pipeline() branches return null and log the failure (unless the whole run is aborted or a policy limit is hit). Check for nulls before synthesizing conclusions, and prefer a final synthesis/assertion agent that returns a compact JSON-serializable verdict.",
  "For the workflow tool, directly await or return every orchestration promise (agent/parallel/pipeline/workflow). Native .then/.catch/.finally chains and Promise.all/allSettled/race/any are rejected; use parallel() or pipeline() so call identity stays deterministic. Unobserved, pending, or native same-scope concurrent orchestration is fatal.",
  "Workflow helpers that call orchestration must be directly declared functions/function variables or static methods on a declared object/stored class instance. Do not alias them, assign them later, forward through this.otherMethod(), or call them from temporary/awaited factory receivers; rewrite those forms as a direct declared helper so resume identity remains stable.",
  "For the workflow tool, do not assume subagents share the parent's repository context; include enough task context and relevant file paths in each agent prompt.",
];
