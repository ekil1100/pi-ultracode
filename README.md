# pi-ultracode

Deterministic multi-agent workflows for [Pi](https://github.com/earendil-works/pi).

**English** · [简体中文](https://github.com/ekil1100/pi-ultracode/blob/main/README.zh-CN.md)

`pi-ultracode` adds opt-in semantic analysis-depth modes to Pi. It can route each task automatically or hold a fixed focused, standard, or deep policy. When delegation adds value, the main agent can run a bounded JavaScript workflow with parallel subagents, isolated worktrees, structured output, durable resume, and live progress.

The project combines the terminal-first agentic experience of [Claude Code](https://github.com/anthropics/claude-code) with the explicit workflow and structural-control ideas found in [Grok Build](https://github.com/xai-org/grok-build), while keeping Pi as the runtime.

## Install

```bash
pi install npm:pi-ultracode
```

Then reload Pi and enable adaptive Ultracode:

```text
/reload
/ultracode
```

You can also start directly in `auto` mode:

```bash
pi --ultracode
```

> `pi-ultracode` registers a tool named `workflow`. If `pi-dynamic-workflows` is installed, remove it first with `pi remove npm:pi-dynamic-workflows`.

**Pi ≥ 0.99.1**

## Core features

- **Adaptive semantic depth** — choose `auto`, `focused`, `standard`, or `deep`; `auto` selects the smallest evidence-sufficient depth while the parent effort remains under user control.
- **Explicit workflows** — compose work with `agent()`, `parallel()`, `pipeline()`, and nested `workflow()` calls.
- **Independent subagents** — each agent gets its own Pi session, context, tools, model selection, and optional role.
- **Parallel worktree isolation** — writing agents can work in temporary git worktrees before their patches are integrated.
- **Structured output** — validate agent results with a bounded JSON Schema subset.
- **Durable resume** — replay completed calls by stable structural identity without rerunning successful work.
- **Live observability** — inspect status, model, thinking level, turns, tool use, token usage, retries, and transcripts in the TUI.
- **Bounded execution** — lifetime agent admission, concurrency limits, strict JSON limits, worker watchdogs, and bounded cleanup.

## Quick start

Enable adaptive Ultracode and describe a task:

```text
/ultracode

Review the current branch in parallel, verify every finding,
fix the justified issues, and run the relevant tests.
```

Pi decides whether a workflow is useful. Small tasks can still use the normal single-agent loop.

Useful commands:

| Command | Action |
| --- | --- |
| `/ultracode` | Enable `auto` from off; disable any active mode |
| `/ultracode auto` | Let the parent choose depth using the task and context |
| `/ultracode focused` | Use fixed depth for bounded work with direct local verification |
| `/ultracode standard` | Use fixed depth for independent dimensions or competing hypotheses, with targeted verification |
| `/ultracode deep` | Use fixed depth for interacting constraints or critical invariants, with independent evidence and counterexample checks |
| `/ultracode off` | Disable it without changing the parent effort |
| `/ultracode status` | Show the configured mode and its applicability / verification requirements |
| `/workflows` or `F6` | Open the workflow browser |
| `/workflows <runId>` | Open a specific run |
| `/workflows abort` | Abort active runs |

Press `Esc` to cancel a running workflow. In Pi's fullscreen TUI, use `Ctrl+PageUp`, `Ctrl+PageDown`, and `Ctrl+End` inside workflow details.

## Analysis depth

Depth defines **what must be investigated and verified**, not model effort or a quota of agents and rounds:

| Depth | Applicable conditions | Required verification |
|---|---|---|
| **Focused** | Bounded work with a known approach and locally verifiable results; e.g. a specified validation rule | Directly check the changed behavior or key claim, usually in the parent loop. No broad investigation or adversarial panel by default; verification is not skipped. |
| **Standard** | Multiple independent dimensions or unresolved hypotheses can materially change the answer; e.g. a fault with several plausible causes | Investigate those dimensions or compare causes, then target disputed or weakly evidenced claims. Known multi-step work alone is not enough to require standard. |
| **Deep** | Tightly interacting hard constraints or critical invariants need independent evidence and counterexamples; e.g. cancellation racing a durable commit | Trace interactions, test boundary/failure cases, and challenge key claims with a distinct test, reproduction, proof, or source. A second agent is neither necessary nor sufficient. |
| **Auto** | Choose the smallest depth sufficient for the current task | Apply the selected depth's evidence requirements; escalate only when material new evidence or unresolved conflicts justify it. |

Risk determines **which claims need verification**. Security, concurrency, data loss, file count, or a request for review alone never mandates `deep`; missing information does not prove hidden complexity. Deep does not automatically mean a workflow, more agents, or repeated rounds. Explicit `focused` / `standard` / `deep` modes remain fixed: if insufficient, report the uncertainty and recommend a deeper mode rather than silently exceeding the boundary.

Research stops when key claims have direct evidence, no material conflict or unresolved high-risk question remains, and another round would repeat known evidence. Wall-clock time, deadlines, and duration limits are never used to choose or stop analysis depth. `maxAgents` and `reserveAgents` remain structural admission limits. Parent effort stays user-owned, and child effort remains a separate per-subtask decision.

### Parent-selected depth in auto

In `auto`, the parent always chooses `focused`, `standard`, or `deep` in its normal turn using the current task, conversation, and repository evidence, following the shared criteria in `src/depth.ts`. It starts at the shallowest sufficient depth and escalates only when evidence warrants it. No router agent or extra classification request is created, even when Jev is available in Pi.

Jev availability affects only the child-effort selector below, including in fixed depth modes. `/ultracode status` and the footer describe the **configured mode**, not a live estimate of the parent's evidence-driven depth.

The `workflow` tool uses Pi’s `model-only` exposure: it is declared to the model when active, but cannot be called through codemode or another tool’s `ctx.executeTool()`. Its annotations explicitly declare that it may modify or overwrite files, access external services, and produce additional effects when repeated. These are permission hints, not a sandbox.

### Child-agent effort

Ultracode never changes the parent session's effort. The parent selection below remains the default and the fallback when Jev fails.

The parent selects the most appropriate supported effort with a model suffix for **each assigned subtask**, with no fixed `medium` or `high` default and no blind preference for the minimum or maximum.

Before each parent run, the extension supplies a local Pi capability snapshot: the current default child model (`ctx.model`) and available registered model overrides, each with its supported effort levels from Pi's capability API. Model switches and registry changes are reflected on the next run. A bare suffix such as `:low` uses the default child model; an explicit model or agent-role model uses its own capabilities. Prefer exact `provider/model` identifiers for overrides. A model supporting only `low/medium/high` offers exactly those three choices—not all seven followed by clamping. Unknown capabilities remain unknown; the parent should omit an automatic suffix rather than guess. No extra model request is needed.

The snapshot describes local registered capabilities, not a live provider probe, and may become stale during a run. Runtime clamping remains a safety net for explicit requests or stale metadata. Standalone SDK use of `createWorkflowTool()` without the extension does not inject this section; the host must supply capability context to enable informed automatic suffix selection. Neither the snapshot nor its absence rewrites explicit user effort choices or no-suffix defaults.

| Suffix | Criteria and exclusions | Example |
|---|---|---|
| `:off` | Fully specified mechanical work; no locating changes, interpreting meaning, or hidden-impact reasoning | Fix a typo at an exact location using a supplied replacement |
| `:minimal` | One clear local judgment; no cross-file tracing or multi-step implementation | Explain a short self-contained expression |
| `:low` | Small implementation or question with a known approach and straightforward checks; not an unknown-root-cause fault | Add a specified validation rule and its test |
| `:medium` | Bounded multi-step work coordinating known constraints; not interacting unresolved hypotheses | Wire a configuration option through loading, usage, and tests |
| `:high` | Test competing hypotheses, trace cross-module effects, or reason about critical correctness constraints; security/architecture keywords alone do not qualify | Diagnose cross-module state desynchronization by comparing plausible causes |
| `:xhigh` | Interacting hard problems requiring comparison of approaches and validation of cross-module invariants; file count or vague complexity claims do not qualify | Investigate an intermittent lifecycle, cache, and cancellation interaction |
| `:max` | Exceptionally difficult synthesis requiring rigorous argument and adversarial validation, or concrete evidence of insufficient lower-effort reasoning; risk keywords alone do not qualify | Prove and repair system-wide concurrency, memory-safety, and low-level invariants |

Implementation, review, input length, file count, risk keywords, and depth mode are not sufficient reasons for high effort. Missing information does not automatically imply `medium/high`; do not invent complexity. For `high/xhigh/max`, briefly identify the concrete reasoning difficulty. The highest supported effort requires neither a failed lower-level attempt nor an available intermediate level. Risk determines what needs verification, not a uniform high effort for every child.

These are task-selection heuristics, not a universal provider capability scale. The workflow UI reports actual effort; an omitted suffix retains normal child user/model configuration unless Jev overrides it. The system prompt, workflow guidelines, and Jev share the criteria in `src/effort-policy.ts`; none changes the parent's effort. A separate skeptic or synthesis agent is not automatic.

#### Optional Jev selection

Jev selection runs automatically when Pi’s native `getAvailableOfType("classifier", "typesafe")` includes `typesafe/jev-latest`. This checks Pi’s credential configuration, not merely catalog presence or remote service health. If Jev is unavailable, no classification request is made and existing parent-selected suffixes and user/model defaults remain unchanged.

- Ready subtasks in one scheduler batch share **one** Pi-native `modelRuntime` / `modelRegistry.classify()` request to `typesafe/jev-latest`, with one `questions` entry per eligible task. Each question maps to that task’s full prompt, **actual child session model**, and supported effort levels. Answers are applied independently; a successful selection changes neither the execution model nor the parent session or global defaults.
- Selection reuses `src/effort-policy.ts` and judges each task separately, not the complexity of the whole workflow. Shared background contains the existing workflow `meta` (including name/description and any supplied goal, acceptance criteria, or dependencies) and `args`. Per-task context includes phase, workflow path, known parallel branch/pipeline item-stage structure, and nested workflow metadata/arguments when applicable. Full task prompts include roles, additional instructions, labels, output requirements, and any upstream results already supplied by the script. Missing goals or dependency edges are not invented; no summarization model call, additional repository read, full script, or complete parent conversation is sent. By default, requests go to `https://api.typesafe.ai` through Pi’s provider configuration. Configure Jev in Pi only if these prompts, metadata, and arguments may be shared with TypeSafe; available credentials automatically enable selection.
- Pi resolves credentials at request time from its runtime credentials, stored credentials, provider configuration, or normal environment sources (including `TYPESAFE_API_KEY`). Ultracode does not read that variable as a switch or pass an explicit `apiKey`, and does not change Pi’s stored credentials. No alternate provider or model is queried.
- Requests have a **10-second timeout and no retries**. An invalid or unsupported answer exposed by Pi retains only that task’s already-resolved parent selection/default. A request-level error retains every task’s own default. **Pi 0.99.1 limitation:** its TypeSafe adapter discards all answers when any wire answer is missing or malformed; those cases necessarily fall back for the whole batch. Valid wire answers with unsupported choices still fall back independently. **Fallback never makes another model request.**
- User cancellation aborts selection and terminates the subtasks, including those queued for execution, rather than executing fallback tasks. Cached resume results, models supporting only one level, and unknown actual models are excluded from classification; an entirely excluded batch makes no request.
- The UI reports actual effort. The selector does not log keys, raw responses, or service error bodies. Jev selection usage is not included in child execution usage.

**Batch boundary:** `parallel()` and `pipeline()` collect calls actually issued while synchronously launching their thunks/items, then seal that batch. No debounce, elapsed-time heuristic, full-script pre-evaluation, or waiting for future tasks is used. Calls after an `await`, nested workflow/panel loads, and later pipeline stages form new batches as they become ready (often a single task); a slow sibling does not block an already-ready later stage. A later explicit fan-out is batched again. This is not one request for an arbitrary lazy JavaScript workflow.

Admission/cache checks still precede live session preparation. Idle child sessions (and isolated worktrees when requested) are prepared before classification so Jev sees actual capabilities; preparation may exceed the execution concurrency count, but remains bounded by lifetime admission. Batch collection/classification never holds an execution semaphore permit. Child execution and result/worktree delivery still obey the configured concurrency (maximum 16), even when a ready batch is larger than that limit.

## Workflow example

The main agent normally writes workflows for you. Reusable workflows can also be saved under `.pi/ultracode/workflows/*.workflow.js` or `~/.pi/ultracode/workflows/*.workflow.js`. Project-scoped workflows are discovered only after Pi marks the project as trusted; user-scoped workflows remain available in untrusted projects.

```js
export const meta = {
  name: "parallel_review",
  description: "Review correctness and tests in parallel",
};

const findings = await parallel([
  () => agent(
    "Review the current branch for correctness and lifecycle bugs.",
    { label: "correctness review" },
  ),
  () => agent(
    "Review the current branch for missing or weak regression tests.",
    { label: "test review" },
  ),
]);

return findings.filter(Boolean);
```

For editor IntelliSense, add:

```js
/// <reference types="pi-ultracode/workflow" />
```

The complete workflow contract is documented in [`types/workflow.d.ts`](types/workflow.d.ts). A larger example is available in [`examples/workflows`](examples/workflows).

## Roles, models, and worktrees

Custom agent roles live in:

```text
.pi/ultracode/agents/*.md
.pi/agents/*.md
~/.pi/ultracode/agents/*.md
~/.pi/agent/agents/*.md
```

A call can select a role, model, thinking level, or worktree isolation:

```js
await agent("Implement and test the fix.", {
  label: "implement fix",
  agentType: "general-purpose",
  model: "anthropic/claude-sonnet-4:high",
  isolation: "worktree",
});
```

Worktree isolation requires a git repository with at least one commit and fails closed if the isolated tree cannot be created. Each call receives a unique detached worktree. Integration preserves the user's index and applies only byte-exact patches that pass cached checks in a private, object-format-matched Git index; raw blobs are then materialized without repository attributes, filters, or EOL conversion. A conflicting patch is saved for manual recovery instead of using a destructive three-way fallback. Successful delivery patches are retained so resume can verify that the shared-tree effect still exists. Isolated trees never link the shared writable `node_modules`; install dependencies there when needed, or run final tests after integration. A clean working tree is recommended for predictable patch integration.

## Guardrails

A workflow defaults to `maxAgents: 128`, supports at most 16 concurrent agent calls, and allows one level of nested workflows. Nested `workflow()` calls accept only trust-aware saved-workflow names, not explicit paths. The lifetime agent limit is preserved across resumes; cached replay does not consume it again.

Workflow agent sessions retain project context and ordinary skills, but do not initialize ambient Pi extensions or expose parent orchestration tools and skills (`workflow`, `subagent`, `subagent_wait`, or `pi-subagents`). Codemode is explicitly enabled for tool scripting, without its model-call API; explicit role tool allowlists still apply. This keeps orchestration at the parent boundary and allows `pi-ultracode` and `pi-subagents` to coexist in the main session.

A parent's guard extensions therefore do not see child tool calls or provider requests. To keep a guard in force, list it in `~/.pi/agent/ultracode.json` (under the active agent directory):

```json
{ "childExtensions": ["/absolute/path/to/guard.ts"] }
```

Every child loads those extensions and nothing else from the ambient set. A child does not start if one fails to load or the setting is not an array of absolute paths. Project-scoped agents and settings follow Pi's project-trust decision. The built-in Explore and Plan roles have a sealed read-only tool list without shell or write tools.

Resume is intentionally immutable: the normalized script, arguments, canonical repository/relative cwd, project-trust context, agent definitions, effective models, and call structure must still match. Worktree delivery writes a durable recovery intent before changing the shared repository; an interrupted or conflicted delivery blocks automatic replay and reports its recovery patch. Changed work starts a new run.

Token and cost data are reported for observability, not enforced as a budget. Worker and VM restrictions are determinism and liveness guards, not a security sandbox and not analysis-depth controls.

## Design inspiration

- **Claude Code** — natural-language, terminal-first agentic coding and focused delegation.
- **Grok Build** — explicit workflows, durable journals, bounded admission, and structural execution controls.
- **Pi** — the model runtime, sessions, tools, extension API, and TUI remain native Pi behavior.

`pi-ultracode` is an independent Pi extension and is not affiliated with Anthropic or xAI.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## License

MIT
