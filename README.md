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

**Pi ≥ 0.86.0**

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
| `/ultracode auto` | Select adaptive semantic-depth routing |
| `/ultracode focused` | Fix the lightweight, narrowly scoped policy |
| `/ultracode standard` | Fix the balanced policy with conditional verification |
| `/ultracode deep` | Fix the high-assurance policy with deep verification |
| `/ultracode off` | Disable it without changing the parent effort |
| `/ultracode status` | Show the configured semantic-depth mode |
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

### Child-agent effort

Ultracode 不会修改父会话的 effort；以下父代理选择作为默认和 Jev 失败时的回退。

The parent selects the most appropriate supported effort with a model suffix for **each assigned subtask**, with no fixed `medium` or `high` default and no blind preference for the minimum or maximum.

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

这些分档是任务选择标准，不是跨提供商统一的能力刻度。Workflow UI 展示实际生效的 effort；未指定后缀且 Jev 未覆盖时，子会话使用正常的用户/模型配置。系统提示词、workflow 指南和 Jev 共用 `src/effort-policy.ts` 的分档标准，均不改变父会话 effort。skeptic 和独立 synthesis agent 都不是默认步骤。

#### 可选 Jev 自动选择

在启动 Pi 的环境中设置非空白的 `TYPESAFE_API_KEY` 即启用；未设置或仅含空白时，完全保留现有父代理后缀及用户/模型默认行为。

- 每个子任务在子会话创建后、执行前，通过 `@typesafe-ai/sdk` 请求 `jev-1.13.0`，仅从**实际子模型**支持的 effort 中选择；成功后覆盖父代理为该子任务选择的 effort，不更换执行模型，也不修改父会话或全局默认值。
- 选择标准复用 `src/effort-policy.ts`。请求发送至 `https://api.typesafe.ai`，包含该子任务提示词（角色、额外指令、标签及输出要求）、子模型标识和支持档位；不会额外读取仓库或发送完整父会话历史。启用前请确认这些任务内容可以发送给 TypeSafe。
- 请求超时为 **10 秒，不重试**。网络、服务、响应格式错误或返回不受支持的档位时，保留已经解析好的父代理选择/默认 effort；**回退不会额外请求模型重新判断**。
- 用户取消会中止选择并终止子任务，不会执行回退任务。模型仅支持一个档位时无需请求 Jev；无法确定实际模型时保留原行为。
- UI 展示实际生效的 effort。Jev SDK 日志关闭，不记录密钥、原始响应或服务错误正文；Jev 的选择请求用量不计入子代理执行用量。

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
