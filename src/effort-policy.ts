import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";

/** Task-based effort criteria shared by both workflow prompt surfaces. */
const EFFORT_CRITERIA: Record<ThinkingLevel, string> = {
  off: "Fully specified mechanical work with no implementation decision or hidden-impact reasoning. Excludes finding where to change something or checking its meaning. Example: fix a typo at an exact location using a supplied replacement.",
  minimal: "One clear local judgment in a single scope with no unresolved dependencies. Excludes cross-file tracing or multi-step implementation. Example: explain a short self-contained expression by checking its direct condition.",
  low: "Small implementation or direct question with a clear goal, known approach, and straightforward checks. Excludes faults with an unknown root cause. Example: add a specified input validation rule and its test to an existing function.",
  medium: "Bounded multi-step implementation or investigation coordinating several known constraints. Excludes interacting unresolved hypotheses requiring deeper investigation. Example: add a configuration option through loading, usage, and tests within an established architecture.",
  high: "Test multiple plausible hypotheses, trace cross-module effects, or reason about critical correctness constraints. Excludes escalation based solely on security or architecture keywords. Example: diagnose state desynchronization across modules by testing competing causes.",
  xhigh: "Interacting hard problems requiring deep reasoning, comparison of approaches, and validation of cross-module invariants. Excludes escalation based only on file count or unsupported claims of complexity. Example: investigate an intermittent bug involving lifecycle, caching, and cancellation interactions.",
  max: "Exceptionally difficult synthesis requiring sustained rigorous argument and adversarial validation, or concrete evidence that lower-effort reasoning is insufficient. Excludes escalation from risk keywords alone; prior lower-level failure is not required. Example: prove and repair system-wide invariants involving concurrency, memory safety, and low-level semantics.",
};

export const WORKFLOW_EFFORT_GUIDELINES: readonly string[] = [
  "Select each workflow agent's effort from its assigned subtask using a per-call model suffix (for example, :low or :medium). Choose the most appropriate supported effort for reliable completion, not blindly the minimum or maximum; there is no fixed medium/high default. Ultracode never changes the parent session's effort; an omitted child suffix uses its normal user/model configuration.",
  "Base effort on known complexity, interacting constraints, verification burden, and missing information. Do not invent hidden complexity; uncertainty alone does not mandate medium or high. Judge the assigned subtask, not the whole project or an earlier difficult task.",
  "Implementation, review, input length, file count, risk keywords, and the configured depth are not sufficient reasons for high/max. Discussing or looking up a risky mechanism differs from changing it. Workflow risk determines verification needs, not a uniform effort for every child. For high, xhigh, or max, briefly name the concrete reasoning difficulty rather than merely calling the task complex.",
  ...THINKING_LEVELS.map((level) => `Effort :${level} — ${EFFORT_CRITERIA[level]}`),
  "These criteria are task-selection heuristics, not a universal provider capability scale. Select from the chosen model's supported efforts when known; the runtime still resolves and clamps the request, and the UI reports actual effort. The highest supported effort requires neither a failed lower-level attempt nor an available intermediate level.",
];
