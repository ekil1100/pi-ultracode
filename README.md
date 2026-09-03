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

Current releases are tested with Pi 0.84.

## Core features

- **Adaptive semantic depth** — choose `auto`, `focused`, `standard`, or `deep`; `auto` selects the smallest evidence-sufficient depth and `off` restores the previous thinking level.
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
| `/ultracode auto` | Select adaptive semantic-depth routing |
| `/ultracode focused` | Fix the lightweight, narrowly scoped policy |
| `/ultracode standard` | Fix the balanced policy with conditional verification |
| `/ultracode deep` | Fix the high-assurance policy with deep verification and max effort |
| `/ultracode off` | Disable it and restore the previous thinking level |
| `/ultracode status` | Show the configured mode and effective thinking level |
| `/workflows` or `F6` | Open the workflow browser |
| `/workflows <runId>` | Open a specific run |
| `/workflows abort` | Abort active runs |

Press `Esc` to cancel a running workflow. In Pi's fullscreen TUI, use `Ctrl+PageUp`, `Ctrl+PageDown`, and `Ctrl+End` inside workflow details.

## Analysis depth

Depth is semantic, not time-based:

- **Focused** prefers the parent agent and one bounded line of inquiry. It does not run adversarial verification by default.
- **Standard** covers the few independent dimensions that can change the answer and verifies only high-risk, conflicting, or weakly evidenced claims.
- **Deep** uses bounded multi-perspective investigation and adversarial verification for high-risk or explicitly comprehensive work.
- **Auto** routes to the smallest sufficient level from user intent, consequence risk, scope, ambiguity, available evidence, and conflicts. It escalates only when evidence requires it.

Research stops when key claims have direct evidence, no material conflict or unresolved high-risk question remains, and another round would repeat known evidence. Wall-clock time, deadlines, and duration limits are never used to choose or stop analysis depth. `maxAgents` and `reserveAgents` remain structural admission limits.

Focused defaults to medium effort, auto and standard to high, and deep to max; individual workflow agents can still override effort with a model suffix. A separate skeptic or synthesis agent is not automatic.

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

Workflow agent sessions retain project context and ordinary skills, but do not initialize ambient Pi extensions or expose parent orchestration tools and skills (`workflow`, `subagent`, `subagent_wait`, or `pi-subagents`). This keeps orchestration at the parent boundary and allows `pi-ultracode` and `pi-subagents` to coexist in the main session. Project-scoped agents and settings follow Pi's project-trust decision. The built-in Explore and Plan roles have a sealed read-only tool list without shell or write tools.

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
