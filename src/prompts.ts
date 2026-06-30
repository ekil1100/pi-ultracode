/**
 * Prompt text for ultracode mode.
 *
 * These strings reproduce the behavioural contract of Claude Code's "ultracode"
 * effort level: a standing opt-in to deterministic multi-agent workflow
 * orchestration, biased toward the most exhaustive, correct answer.
 */

/** One-line description shown by `/ultracode status` and the footer. */
export const ULTRACODE_TAGLINE = "xhigh thinking + dynamic workflow orchestration";

/**
 * The standing system-prompt block injected on every turn while ultracode is on.
 * Mirrors the "Ultracode" section of the Workflow tool contract.
 */
export function ultracodeSystemBlock(opts: { budgetTotal: number | null }): string {
  const budgetLine =
    opts.budgetTotal != null
      ? `\n- Token budget for this session: ~${formatTokens(opts.budgetTotal)} output tokens. Treat it as a hard ceiling — scale workflow depth (fleet size, verification rounds) to fit it, and stop spawning agents as it runs out.`
      : "";

  return [
    "<ultracode>",
    "Ultracode is ON. This opt-in is standing: author and run a workflow for every substantive task by default.",
    "",
    "The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint.",
    "For multi-phase work (understand → design → implement → review), run several workflows in sequence — one per phase — so you stay in the loop between them, reading each result before deciding the next phase.",
    "",
    "Lean toward orchestrating with the workflow tool and adversarially verifying your findings, unless the work is trivial or already verified. Solo (no workflow) only on conversational turns or trivial mechanical edits.",
    "",
    "Quality patterns to compose as the task calls for it:",
    "- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE it; kill the finding if a majority refute. Stops plausible-but-wrong findings from surviving.",
    "- Perspective-diverse verify: when a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, performance, does-it-reproduce) instead of N identical refuters.",
    "- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time); each is blind to what the others surface.",
    "- Loop-until-dry: for unknown-size discovery (bugs, edge cases), keep spawning finders until K consecutive rounds return nothing new.",
    "- Completeness critic: a final agent that asks \"what's missing — a modality not run, a claim unverified, a source unread?\" What it finds becomes the next round of work.",
    "- No silent caps: if a workflow bounds coverage (top-N, no-retry, sampling), log() what was dropped.",
    "",
    "Scale to the task: \"find any bugs\" → a few finders, single-vote verify; \"thoroughly audit\" / \"be comprehensive\" → larger finder pool, 3–5 vote adversarial pass, a synthesis stage." +
      budgetLine,
    "</ultracode>",
  ].join("\n");
}

/** Short reminder appended to confirm the mode is active (system-reminder style). */
export const ULTRACODE_ACTIVE_REMINDER =
  "Reminder: ultracode is on — default to authoring and running a workflow for substantive tasks, and adversarially verify your findings.";

/** Tool description for the `workflow` tool. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Execute a deterministic JavaScript workflow that orchestrates multiple subagents to be comprehensive (decompose and cover in parallel), confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps).",
  "`script` is required raw JavaScript. It must begin with `export const meta = { name, description }` (a pure literal) and must call agent() at least once.",
  "Available globals: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(message), workflow(nameOrRef, args), args, cwd, budget.",
].join(" ");

/** One-line snippet for the Available tools section. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Run a deterministic JS workflow that fans out subagents. Header: export const meta = { name: 'snake_case', description: '...' }. Globals: agent/parallel/pipeline/phase/log/workflow/args/budget.";

/** Guideline bullets appended to the Guidelines section when the tool is active. */
export const WORKFLOW_GUIDELINES: string[] = [
  "Use the workflow tool to decompose-and-cover in parallel, to gather independent perspectives that adversarially verify each other, or to take on scale a single context can't hold. Outside ultracode mode, reserve it for explicit fan-out / multi-agent requests.",
  "For the workflow tool, pass one raw JavaScript string in the required `script` parameter; no Markdown fences, no prose around the script.",
  "For the workflow tool, the script's first statement must be `export const meta = { name: 'short_snake_case', description: 'non-empty human description' }`. meta must be a pure literal: no variables, function calls, spreads, or template interpolation. meta.phases is optional and should mirror your phase() titles.",
  "For the workflow tool, write plain JavaScript after the meta export. No TypeScript syntax, imports, require(), fs, network, Date.now(), Math.random(), or new Date() (they break determinism and resume). Stamp timestamps after the workflow returns; vary randomness by agent index.",
  "For the workflow tool, every workflow must call agent() at least once. Each agent() call should pass a short unique label (2-5 words) so live status and error reporting stay readable.",
  "For the workflow tool, DEFAULT TO pipeline(items, ...stages): items flow through stages independently with no barrier, so item A can be in stage 3 while item B is still in stage 1. Only use parallel() (a barrier that awaits all thunks) when a later stage genuinely needs ALL prior results together (dedup/merge across the full set, early-exit on zero, cross-item comparison).",
  "For the workflow tool, parallel() takes functions, not promises: `await parallel(items.map(item => () => agent('...', { label: '...' })))`, never `await parallel(items.map(item => agent(...)))`. Results are returned in input order; a thunk that throws resolves to null, so .filter(Boolean) before using results.",
  "For the workflow tool, pipeline(items, ...stages) passes each stage (previousValue, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.",
  "For the workflow tool, if agent() needs machine-readable output pass a plain JSON Schema via opts.schema; agent() then returns the validated object. Use JSON Schema, not TypeScript or TypeBox constructors.",
  "For the workflow tool, when agent() is called WITHOUT a schema, its return value is the subagent's final assistant text (the last text the subagent produced). With a schema it returns the validated structured_output object. Prefer a schema for machine-readable results; use the text form only for prose summaries.",
  "For the workflow tool, agent opts also accept: model (override the subagent model by pattern), agentType (use a custom subagent role/system-prompt), isolation:'worktree' (run the agent in an isolated git worktree — use ONLY when agents mutate files in parallel and would conflict), and phase (assign the agent to a progress group explicitly inside parallel()/pipeline()).",
  "For the workflow tool, use budget for dynamic depth: `while (budget.total && budget.remaining() > 50000) { ... }`. Guard the loop on budget.total — with no budget set, remaining() is Infinity and the loop runs to the agent cap.",
  "For the workflow tool, workflow(nameOrRef, args) runs a saved workflow (by name) or a scriptPath inline as a sub-step, sharing this run's concurrency cap, agent counter, and token budget. Nesting is one level only.",
  "For the workflow tool, failed agent()/parallel()/pipeline() branches return null and log the failure (unless the whole run is aborted). Check for nulls before synthesizing conclusions, and prefer a final synthesis/assertion agent that returns a compact JSON-serializable verdict.",
  "For the workflow tool, do not assume subagents share the parent's repository context; include enough task context and relevant file paths in each agent prompt.",
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
