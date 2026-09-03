/** Prompt text for Ultracode's adaptive analysis-depth modes. */

import type { ActiveUltracodeMode } from "./depth.ts";

/** One-line description shown by `/ultracode status` and the footer. */
export const ULTRACODE_TAGLINE = "semantic-depth workflow orchestration";

/**
 * The standing system-prompt block injected on every turn while Ultracode is
 * active. The parent model performs the semantic routing itself; starting a
 * separate agent merely to classify depth would defeat the focused path.
 */
export function ultracodeSystemBlock(mode: ActiveUltracodeMode = "deep"): string {
  return [
    "<ultracode>",
    `Configured mode: ${mode}.`,
    "Analysis depth is a semantic quality decision, never a wall-clock decision. Do not use elapsed time, deadlines, or duration limits to choose, lower, or stop analysis depth.",
    "Use the smallest depth that can establish a correct answer. Depth is controlled by research rounds, independent perspectives, verification strength, evidence requirements, skeptic count, and per-agent reasoning effort.",
    "Existing maxAgents/reserveAgents limits are structural admission bounds, not evidence that every available slot should be used.",
    "",
    ...modeInstructions(mode),
    "",
    "Evidence-driven escalation and stopping:",
    "- Escalate only for material correctness risk, missing direct evidence, conflicting findings, or an unresolved question that can change the answer.",
    "- Treat security, GC, ABI, deoptimization, concurrency, data-loss, irreversible operations, and critical architecture semantics as high-risk unless bounded evidence proves otherwise.",
    "- Stop when key claims have direct evidence, no material conflict or unresolved high-risk question remains, and another round would only repeat known evidence.",
    "- Model-reported confidence alone is not sufficient. Prefer concrete citations, reproduction, tests, and independent agreement.",
    "- If fixed focused/standard is insufficient, report the remaining uncertainty and recommend a deeper mode; in deep, report any irreducible uncertainty. Never silently exceed a fixed mode.",
    "",
    "Workflow policy:",
    "- Use a workflow only when independent decomposition, verification, isolation, or context scale provides real value. Otherwise solve directly in the parent session.",
    "- Make skeptics conditional: verify high-risk, conflicting, weakly evidenced, or low-confidence claims instead of automatically verifying every branch.",
    "- Avoid a separate synthesis agent when deterministic merging or parent synthesis is enough. Use an adjudicator only when a material conflict remains.",
    "- Match effort to the stage with per-call model suffixes when useful: focused discovery/synthesis may use :medium, standard analysis :high, and :max is reserved for deep or decisive high-risk verification.",
    "- When a workflow runs, log `analysis-depth: <level> — <reason>` before launching agents, `analysis-escalation: ...` for each semantic escalation, and `analysis-stop: ...` for the final evidence-based stop reason. Never use time as an escalation or stop reason.",
    "</ultracode>",
  ].join("\n");
}

function modeInstructions(mode: ActiveUltracodeMode): string[] {
  switch (mode) {
    case "auto":
      return [
        "Before acting, silently route this task to focused, standard, or deep. Do not spawn a router agent.",
        "Choose from user intent, consequence risk, scope, ambiguity, available evidence, cross-module or cross-repository breadth, and whether independent verification is necessary.",
        "Begin at the shallowest sufficient depth and escalate only when evidence triggers an escalation condition below.",
      ];
    case "focused":
      return [
        "Focused is a fixed lightweight depth: prefer one bounded line of inquiry and the normal parent-agent loop.",
        "Do not run adversarial verification by default. Use at most a small, narrowly scoped delegation only when it clearly reduces duplicated exploration.",
      ];
    case "standard":
      return [
        "Standard is a fixed balanced depth: cover the few independent dimensions that can materially change the answer.",
        "Prefer one discovery round and conditional verification of only disputed, high-risk, or weakly evidenced claims.",
      ];
    case "deep":
      return [
        "Deep is a fixed high-assurance depth: default to a bounded workflow for substantive tasks unless the work is conversational, trivial, or already verified.",
        "Use multi-perspective investigation and adversarial verification where the task supports it. Choose fan-out and round limits before launch.",
        "Use at most two discovery rounds by default; add a third only when the user explicitly requests exhaustive coverage and fresh evidence is still appearing.",
      ];
  }
}

/** Short reminder appended after the standing block. */
export const ULTRACODE_ACTIVE_REMINDER =
  "Reminder: Ultracode is active — obey its configured semantic depth, escalate only from evidence, and never use elapsed time as an analysis budget.";

/** Tool description for the `workflow` tool. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "Execute a deterministic JavaScript workflow that orchestrates a proportionate set of subagents for independent coverage, targeted verification, or work that exceeds one context.",
  "Choose the smallest workflow justified by the configured Ultracode depth and current evidence; workflow use and adversarial checks are not automatic.",
  "Each invocation must provide workflow source via `script`, `scriptPath`, or `name`. Inline `script` must be raw JavaScript (no Markdown fences) beginning with `export const meta = { name, description }` (a pure literal) and should call agent() at least once for useful orchestration.",
  "Available globals: agent(prompt, opts), parallel(thunks, options?), pipeline(items, ...stages), phase(title), log(message), workflow(name, args), args, cwd. The tool accepts maxAgents (default 128, max 1024) as a lifetime live-agent admission cap across resumes, not a token or depth budget; cache replay is free.",
].join(" ");

/** One-line snippet for the Available tools section. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Run a deterministic JS workflow with proportionate subagent fan-out. Header: export const meta = { name: 'snake_case', description: '...' }. Globals: agent/parallel/pipeline/phase/log/workflow/args/cwd.";

/** Guideline bullets appended to the Guidelines section when the tool is active. */
export const WORKFLOW_GUIDELINES: string[] = [
  "Use the workflow tool only when independent decomposition, targeted verification, isolation, or context scale adds value; use the parent agent directly for a bounded task.",
  "For an auto-depth workflow, log `analysis-depth: <level> — <reason>` before launching agents, `analysis-escalation: ...` when evidence requires more depth, and `analysis-stop: ...` when evidence is sufficient. Elapsed time must never determine depth.",
  "For workflow verification, run skeptics only for high-risk, conflicting, low-confidence, or weakly evidenced claims. Do not automatically attach a skeptic to every branch.",
  "For workflow synthesis, prefer structured results plus deterministic or parent-session merging. Start a synthesis/adjudication agent only for a material unresolved conflict, and normally give pure synthesis lower effort and no broad source-search mandate.",
  "For workflow agent effort, use a model suffix such as `:medium`, `:high`, or `:max` when the stage should differ from the mode default; reserve max for deep investigation or decisive high-risk verification.",
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
  "For the workflow tool, failed agent()/parallel()/pipeline() branches return null and log the failure (unless the whole run is aborted or a policy limit is hit). Check for nulls before synthesizing conclusions, and prefer a final compact JSON-serializable result.",
  "For the workflow tool, directly await or return every orchestration promise (agent/parallel/pipeline/workflow). Native .then/.catch/.finally chains and Promise.all/allSettled/race/any are rejected; use parallel() or pipeline() so call identity stays deterministic. Unobserved, pending, or native same-scope concurrent orchestration is fatal.",
  "Workflow helpers that call orchestration must be directly declared functions/function variables or static methods on a declared object/stored class instance. Do not alias them, assign them later, forward through this.otherMethod(), or call them from temporary/awaited factory receivers; rewrite those forms as a direct declared helper so resume identity remains stable.",
  "For the workflow tool, do not assume subagents share the parent's repository context; include enough task context and relevant file paths in each agent prompt.",
];
