# pi-ultracode

Deterministic multi-agent workflows for [Pi](https://github.com/earendil-works/pi).

**English** · [简体中文](https://github.com/ekil1100/pi-ultracode/blob/main/README.zh-CN.md)

`pi-ultracode` adds an opt-in high-effort mode to Pi. When a task benefits from delegation, the main agent can run a bounded JavaScript workflow with parallel subagents, isolated worktrees, structured output, durable resume, and live progress.

The project combines the terminal-first agentic experience of [Claude Code](https://github.com/anthropics/claude-code) with the explicit workflow and structural-control ideas found in [Grok Build](https://github.com/xai-org/grok-build), while keeping Pi as the runtime.

## Install

```bash
pi install npm:pi-ultracode
```

Then reload Pi and toggle Ultracode on:

```text
/reload
/ultracode
```

You can also enable it at startup:

```bash
pi --ultracode
```

> `pi-ultracode` registers a tool named `workflow`. If `pi-dynamic-workflows` is installed, remove it first with `pi remove npm:pi-dynamic-workflows`.

Current releases are tested with Pi 0.84.

## Core features

- **Opt-in high-effort mode** — requests the highest thinking level supported by the current model and restores the previous level when disabled.
- **Explicit workflows** — compose work with `agent()`, `parallel()`, `pipeline()`, and nested `workflow()` calls.
- **Independent subagents** — each agent gets its own Pi session, context, tools, model selection, and optional role.
- **Parallel worktree isolation** — writing agents can work in temporary git worktrees before their patches are integrated.
- **Structured output** — validate agent results with a bounded JSON Schema subset.
- **Durable resume** — replay completed calls by stable structural identity without rerunning successful work.
- **Live observability** — inspect status, model, thinking level, turns, tool use, token usage, retries, and transcripts in the TUI.
- **Bounded execution** — lifetime agent admission, concurrency limits, strict JSON limits, worker watchdogs, and bounded cleanup.

## Quick start

Toggle Ultracode on and describe a substantial task:

```text
/ultracode

Review the current branch in parallel, verify every finding,
fix the justified issues, and run the relevant tests.
```

Pi decides whether a workflow is useful. Small tasks can still use the normal single-agent loop.

Useful commands:

| Command | Action |
| --- | --- |
| `/ultracode` | Toggle Ultracode on or off |
| `/ultracode on` | Explicitly enable it (optional alias) |
| `/ultracode off` | Disable it and restore the previous thinking level |
| `/ultracode status` | Show the current mode and effective thinking level |
| `/workflows` or `F6` | Open the workflow browser |
| `/workflows <runId>` | Open a specific run |
| `/workflows abort` | Abort active runs |

Press `Esc` to cancel a running workflow. In Pi's fullscreen TUI, use `Ctrl+PageUp`, `Ctrl+PageDown`, and `Ctrl+End` inside workflow details.

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

Token and cost data are reported for observability, not enforced as a budget. Worker and VM restrictions are determinism and liveness guards, not a security sandbox.

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
