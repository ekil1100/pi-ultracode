# pi-ultracode

> Claude-Code-style **ultracode** for [Pi](https://github.com/earendil-works/pi).

`ultracode` is an effort mode that turns Pi into a relentless, multi-agent
orchestrator. While it's on, Pi raises its thinking to **xhigh** and treats
"author and run a workflow" as the **default** for every substantive task —
decomposing work, fanning it out across isolated subagents, and adversarially
verifying findings before committing to an answer. Token cost is not the
constraint; correctness and coverage are.

This single extension implements the full ultracode surface:

| Pillar | What you get |
| --- | --- |
| **Ultracode mode** | `/ultracode on` raises thinking to xhigh, keeps the `workflow` tool active, and injects a standing "orchestrate + verify by default" system block on every turn. Survives reload / resume / fork via session entries. Optional token budget. |
| **The `workflow` tool** | A deterministic JavaScript orchestrator: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `workflow()` (nesting), `args`, `budget`. Plus per-agent **model overrides**, **custom agent types**, **git-worktree isolation**, a real **token budget**, **resumable runs**, and **script persistence**. |
| **`/workflows` manager** | List recent and in-flight runs with live progress; inspect or abort runs. |

Inspired by Anthropic's [dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code),
and a superset of the `pi-dynamic-workflows` prototype.

## Install

```bash
pi install npm:pi-ultracode      # or: pi install /path/to/pi-ultracode
```

> **Conflict note:** pi-ultracode registers a tool named `workflow`, the same name
> used by `pi-dynamic-workflows`. pi-ultracode is a strict superset, so remove the
> prototype first: `pi remove npm:pi-dynamic-workflows`.

Then in Pi: `/reload`.

## Usage

### Turn ultracode on

```text
/ultracode               # TOGGLE on/off
/ultracode on            # xhigh thinking + default workflow orchestration
/ultracode on 500k       # also cap the per-session output-token budget at ~500k
/ultracode budget 1m     # change the budget later
/ultracode status        # show current mode
/ultracode off           # restore the previous thinking level
```

> **Models without `xhigh`:** pi clamps the requested level down to the model's
> maximum (e.g. glm-5.2 tops out at `high`; non-reasoning models fall to `off`) —
> it never errors. `/ultracode status` shows the level that actually applied
> (e.g. `ultracode: on · thinking high`). The **workflow orchestration** half of
> ultracode doesn't depend on the thinking level at all, so it's unaffected by
> the model you run.

You can also start a session in ultracode mode with the CLI flag:

```bash
pi --ultracode
```

While on, just describe the task. Pi will write a workflow script and call the
`workflow` tool, with live progress shown inline:

```text
◆ ▶ audit_repo (4/7 done, 2 running) · 3 cached · 41.2k/500k tok
  ✓ Survey 1/1
    #1 ✓ repo inventory
  ▶ Review 3/4 · 1 running
    #2 ✓ auth module
    #3 ✓ db layer
    #4 ● payments module
  ▶ Verify 0/2 · 2 running
```

Press `Esc` to cancel; running subagents are aborted and surfaced as skipped.

### Manage runs

```text
/workflows               # toggle the run panel above the editor (run again to hide)
/workflows wf_ab12-3     # show one run's detail
/workflows clear         # hide the panel
/workflows abort         # abort all active runs (and hide the panel)
```

The panel is a static snapshot taken when you run the command, so re-run
`/workflows` to refresh it, or `/workflows clear` to dismiss it. Live progress
while a workflow runs is shown inline in the tool result, not in this panel.

## Workflow script shape

A workflow is plain JavaScript whose first statement is a **pure literal**
`export const meta`:

```js
export const meta = {
  name: 'review_changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Find correctness bugs in the diff.' },
  { key: 'perf', prompt: 'Find performance regressions in the diff.' },
]

// pipeline: each dimension verifies as soon as its review completes (no barrier).
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS }),
  (review) => parallel((review.findings ?? []).map((f) => () =>
    agent('Adversarially verify, default to refuted: ' + f.title,
      { label: 'verify:' + f.file, phase: 'Verify', agentType: 'code-reviewer', schema: VERDICT })
      .then((v) => ({ ...f, verdict: v }))
  )),
)

const confirmed = results.flat().filter(Boolean).filter((f) => f.verdict?.isReal)
return { confirmed }

const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object' } } } }
const VERDICT = { type: 'object', properties: { isReal: { type: 'boolean' }, why: { type: 'string' } }, required: ['isReal'] }
```

### Globals

| Global | Description |
| --- | --- |
| `agent(prompt, opts)` | Spawn an isolated subagent. Returns its final text, or a validated object when `opts.schema` is set. |
| `parallel(thunks)` | Run `() => agent(...)` thunks concurrently. **A barrier.** Failures become `null`. |
| `pipeline(items, ...stages)` | Run each item through stages independently (no barrier). Stages get `(prev, original, index)`. **The default** for multi-stage work. |
| `workflow(nameOrRef, args)` | Run a saved workflow (by name) or `{ scriptPath }` inline, sharing the run's concurrency cap, agent counter, and budget. One level of nesting. |
| `phase(title)` | Mark the current progress group. |
| `log(message)` | Append a workflow-level log line. |
| `args`, `cwd` | The tool's `args` value; the working directory. |
| `budget` | `{ total, spent(), remaining() }` — real output-token budget. |

### `agent()` options

| Option | Effect |
| --- | --- |
| `label` | Short (2-5 word) name shown in live progress. |
| `phase` | Assign this agent to a progress group explicitly (use inside `parallel`/`pipeline`). |
| `schema` | Plain JSON Schema; the subagent returns a validated object via a terminating `structured_output` tool. |
| `model` | Override the subagent model by pattern, e.g. `'sonnet'` or `'provider/id:high'`. |
| `agentType` | Use a custom role: built-ins `claude`, `general-purpose`, `Explore`, `Plan`, `code-reviewer`, or your own (below). |
| `isolation: 'worktree'` | Run the agent in a throwaway git worktree (for parallel file mutation). Changes are applied back to the working tree under a lock; an unchanged worktree is auto-removed. |

### Determinism

Scripts run in a `vm` sandbox. `Date.now()`, `new Date()`, `Math.random()`,
`require`/`import`, `fs`, and network APIs are unavailable — this keeps `meta`
parseable and runs **reproducible and resumable**. Pass timestamps via `args`;
vary randomness by agent index.

## Custom agent types

Drop a Markdown file with frontmatter under
`.pi/ultracode/agents/<name>.md` (project) or `~/.pi/ultracode/agents/<name>.md`
(user):

```markdown
---
name: security
description: Security-focused reviewer
tools: read, grep, find, bash
model: sonnet
thinking: high
---
You are a security reviewer. Hunt for injection, authz gaps, and unsafe deserialization.
Cite exact file:line evidence and prefer false negatives over invented findings.
```

Then `agent('Audit auth.ts', { agentType: 'security' })`.

## Saved & resumable runs

Every run persists its script and a JSONL journal under
`<sessionDir>/ultracode-runs/<runId>.{workflow.js,jsonl}`. To resume after a
pause, kill, or script edit, call the tool again with `resumeFromRunId`: the
longest unchanged prefix of `agent()` calls returns cached results instantly;
the first changed/new call and everything after it run live.

Save reusable workflows under `.pi/ultracode/workflows/<name>.workflow.js` and
run them with the tool's `name` parameter or `workflow('<name>')`.

## Library modules

| File | Purpose |
| --- | --- |
| `src/prompts.ts` | Ultracode system block + workflow tool guidelines. |
| `src/mode.ts` | The ultracode mode controller (toggle, thinking, persistence, injection). |
| `src/commands.ts` | `/ultracode` and `/workflows` commands. |
| `src/workflow/parser.ts` | AST-validated, deterministic script parser. |
| `src/workflow/runtime.ts` | The sandboxed runtime (agent/parallel/pipeline/phase/log/workflow/budget). |
| `src/workflow/agent-runner.ts` | In-memory subagent runner (model, agent type, worktree, usage). |
| `src/workflow/worktree.ts` | Git worktree isolation. |
| `src/workflow/agent-types.ts` | Custom agent-type discovery. |
| `src/workflow/journal.ts` | Run journal + resume. |
| `src/workflow/registry.ts` | In-process run registry for `/workflows`. |
| `src/workflow/display.ts` | Live progress snapshots and renderers. |
| `src/workflow/structured-output.ts` / `json-schema.ts` | Terminating structured output + JSON-Schema → TypeBox. |
| `src/workflow/tool.ts` | The Pi `workflow` tool. |
| `extensions/ultracode.ts` | Extension entrypoint. |

## Development

```bash
npm test          # node --test over the parser, runtime, journal, agent types, mode, and extension
npm run typecheck # tsc --noEmit (requires a local TypeScript)
```

The test suite injects a mock subagent runner, so it runs without a model. A
faithful end-to-end check (real subagents) just calls `runWorkflow` with the
default runner.

**Dependencies.** The only hard runtime dependency is `acorn`; Pi provides
`typebox` and `@earendil-works/*` to extensions at load time. When running the
node test runner directly (which has no Pi loader), link those peers into
`node_modules/` — e.g. symlink them from your Pi install — alongside the
real `acorn` that `pi install` / `npm install` provides.

## License

MIT
