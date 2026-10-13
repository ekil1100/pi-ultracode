import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { ACTIVE_ULTRACODE_MODES } from "../src/depth.ts";
import { WORKFLOW_EFFORT_GUIDELINES } from "../src/effort-policy.ts";
import { ultracodeSystemBlock, WORKFLOW_GUIDELINES } from "../src/prompts.ts";
import { THINKING_LEVELS } from "../src/thinking.ts";

const policy = WORKFLOW_EFFORT_GUIDELINES.join("\n");

function criterion(level: string): string {
  const lines = WORKFLOW_EFFORT_GUIDELINES.filter((line) => line.startsWith(`Effort :${level} — `));
  assert.equal(lines.length, 1, `one criterion for ${level}`);
  return lines[0];
}

test("effort policy covers all seven levels with exclusions and concrete examples", () => {
  const criteria = WORKFLOW_EFFORT_GUIDELINES.filter((line) => line.startsWith("Effort :"));
  assert.equal(criteria.length, THINKING_LEVELS.length);
  assert.equal(new Set(criteria).size, THINKING_LEVELS.length);
  for (const level of THINKING_LEVELS) {
    assert.match(criterion(level), /Excludes /);
    assert.match(criterion(level), /Example: /);
  }
});

test("effort criteria separate routine implementation from unresolved reasoning difficulty", () => {
  assert.match(criterion("off"), /no implementation decision or hidden-impact reasoning/);
  assert.match(criterion("minimal"), /One clear local judgment/);
  assert.match(criterion("low"), /known approach, and straightforward checks/);
  assert.match(criterion("low"), /Excludes faults with an unknown root cause/);
  assert.match(criterion("medium"), /multi-step implementation.*known constraints/);
  assert.match(criterion("medium"), /configuration option through loading, usage, and tests/);
  assert.match(
    criterion("high"),
    /multiple plausible hypotheses.*cross-module effects.*critical correctness/,
  );
  assert.match(
    criterion("xhigh"),
    /Interacting hard problems.*comparison of approaches.*cross-module invariants/,
  );
  assert.match(criterion("max"), /rigorous argument and adversarial validation/);
  assert.match(criterion("max"), /concrete evidence that lower-effort reasoning is insufficient/);
});

test("effort selection avoids fixed defaults, keyword escalation, and mandatory lower-level trials", () => {
  assert.match(policy, /assigned subtask/);
  assert.match(policy, /no fixed medium\/high default/);
  assert.match(policy, /uncertainty alone does not mandate medium or high/);
  assert.match(
    policy,
    /file count, risk keywords, and the configured depth are not sufficient reasons/,
  );
  assert.match(policy, /not a uniform effort for every child/);
  assert.match(policy, /briefly name the concrete reasoning difficulty/);
  assert.match(
    policy,
    /highest supported effort requires neither a failed lower-level attempt nor an available intermediate level/,
  );
  assert.match(policy, /never changes the parent session's effort/);
  assert.match(policy, /omitted child suffix uses its normal user\/model configuration/);
  assert.match(policy, /chosen model's supported efforts/);
  assert.match(policy, /UI reports actual effort/);
  assert.doesNotMatch(policy, /high for substantive analysis or implementation/);
});

test("model inheritance is separate from effort selection and requires user authorization for overrides", () => {
  assert.match(policy, /Inherit the current session's model for workflow children by default/);
  assert.match(policy, /bare suffix such as model: ':high'/);
  assert.match(
    policy,
    /only when the user explicitly requests it or explicitly authorizes model routing/,
  );
  assert.match(policy, /authorization requirement also applies to agentType model overrides/);
  assert.match(
    policy,
    /capabilities describe supported effort levels, not permission to switch models/,
  );
  const guidelines = WORKFLOW_GUIDELINES.join("\n");
  assert.match(guidelines, /For user-authorized model overrides, use exact provider\/model IDs/);
  assert.match(guidelines, /model \(use a bare :level to set effort on the inherited model/);
  assert.match(guidelines, /agentType .*check its model against the model-inheritance policy/);
});

test("all depth modes and workflow guidelines inject the same effort policy", () => {
  for (const line of WORKFLOW_EFFORT_GUIDELINES) {
    assert.equal(WORKFLOW_GUIDELINES.filter((entry) => entry === line).length, 1);
    for (const mode of ACTIVE_ULTRACODE_MODES) {
      const lines = ultracodeSystemBlock(mode).split("\n");
      assert.equal(lines.filter((entry) => entry === `- ${line}`).length, 1, mode);
    }
  }
  for (const prompt of [
    WORKFLOW_GUIDELINES.join("\n"),
    ...ACTIVE_ULTRACODE_MODES.map((mode) => ultracodeSystemBlock(mode)),
  ]) {
    assert.doesNotMatch(prompt, /high for substantive analysis or implementation/);
    assert.doesNotMatch(prompt, /max only for deep or decisive high-risk verification/);
  }
});

test("selector policy describes configurable judge and unavailable fallback", () => {
  assert.match(policy, /configured by \/ultracode model/);
  assert.match(policy, /default: typesafe\/jev-latest classifier/);
  assert.match(policy, /retained if the selector is unavailable or fails/);
  assert.doesNotMatch(policy, /TYPESAFE_API_KEY/);
});
