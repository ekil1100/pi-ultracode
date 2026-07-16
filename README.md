# Ultracode

**Ultracode** 是 [Pi](https://github.com/badlogic/pi-mono) 的“全力执行”模式。它把 Pi 的 Agentic Loop 从单线程编码助手升级为能够运行子代理团队的编排器。

启用 Ultracode 后，主代理会获得一条 `workflow` 工具，以及一段要求它主动使用该工具处理复杂任务的系统提示词。扩展加载时会先注册该工具，并在模型请求前的 input 与 `before_agent_start` 边界按模式校准 active tools；未启用或已暂停时，残留调用会被拒绝。每个子代理都运行在独立的内存 Pi 会话中，拥有标准编码工具、独立上下文，并可选择结构化输出、模型覆盖、Agent Type 和隔离的 git worktree。

Ultracode 保留 Pi 自身的核心循环、内存模型、工具系统、扩展 API 与会话格式。它是在 Pi 之上增加编排能力，而不是替换 Pi。

## 功能

| 能力 | 说明 |
| --- | --- |
| `workflow` 工具 | 模型请求前按 Ultracode 状态校准；运行确定性的 JavaScript 编排脚本，并调用 `agent()`、`parallel()`、`pipeline()` 和 `workflow()`。 |
| 独立子代理 | 每次 `agent()` 调用都会创建一条带标准编码工具的新 Pi 会话。 |
| 并行执行 | `parallel()` 并发运行任务，且保留输入顺序。 |
| 流水线 | `pipeline()` 让任务独立流经多个阶段，无需全局屏障。 |
| 结构化输出 | 传入 JSON Schema，即可通过终止型 `structured_output` 工具获得经校验的对象。 |
| Agent Type | 通过 `.pi/ultracode/agents/*.md` 定义角色提示词、工具白名单、模型和思考强度。 |
| 模型覆盖 | 每次 `agent()` 调用都可指定模型模式，例如 `anthropic/claude-sonnet-4`。 |
| Worktree 隔离 | 让写入型并行代理在临时 git worktree 中运行，并把改动安全合并回共享工作树。 |
| 进度与详情 | 实时状态、实际模型/effort、turn/工具/token 统计，以及可流式展开的 TUI 任务详情浮层。 |
| Ultracode 模式 | `/ultracode on` 启用主动编排提示词，并请求当前模型支持的最高思考强度。 |
| 配额执行 | 可选 token 预算、代理数量限制、并发限制、脚本超时与嵌套深度限制。 |

## 为什么使用工作流

普通的多代理提示通常依赖模型临场决定如何分解与组合任务。Ultracode 采用另一种方式：**模型编写确定性的编排脚本，运行时执行该脚本**。

这样可以清晰表达：

- 哪些任务可以并行；
- 哪些阶段依赖前一阶段的结果；
- 哪些代理应返回结构化数据；
- 何时需要共享上下文，何时需要隔离；
- 预算如何限制额外探索；
- 失败分支应如何降级。

## 安装

```bash
pi install npm:pi-ultracode      # or: pi install /path/to/pi-ultracode
```

> **工具冲突：** pi-ultracode 注册名为 `workflow` 的工具，与 `pi-dynamic-workflows` 相同。pi-ultracode 是后者的严格超集，请先执行 `pi remove npm:pi-dynamic-workflows` 移除原型扩展。

安装后在 Pi 中运行 `/reload`。

开发仓库也可直接加载：

```bash
pi -e ./extensions/ultracode.ts
```

仓库中提供两个兼容入口：

- `extensions/ultracode.ts`：推荐的 Pi 扩展入口；
- `src/index.ts`：兼容入口，重新导出同一个扩展。

## 快速开始

在 Pi 中启用模式：

```text
/ultracode on
```

随后给出复杂任务，例如：

```text
Review the current branch, identify correctness and compatibility risks,
fix the justified issues, and verify the result.
```

启用后，主代理会被要求在并行检视、迁移、审计或大范围修改明显有益时编写并运行工作流，而不是把所有工作塞进一个上下文。

也可以在启动时启用：

```bash
pi --ultracode
```

工作流运行时会内联显示实时进度，例如：

```text
◆ ▶ audit_repo (4/7 done, 2 running) · 3 cached · 203k token (141k new, 62k replayed) · 41.2k/500k out
  ✓ Survey 1/1
    #1 ✓ repo inventory
       gpt-5.6-sol • max · 15 turns · 42 tool uses · 141k token
  ▶ Review 3/4 · 1 running
    #2 ✓ auth module
    #3 ✓ db layer
    #4 ● payments module
       claude-sonnet-4 • high · 6 turns · 18 tool uses · 52.3k+ token · partial
  ▶ Verify 0/2 · 2 running
```

紧凑 token 数始终是 input + output；cache read/write 与成本只出现在任务详情中。主对话会折叠较早任务并明确显示省略数量，按 `Ctrl+O` 可展开全部，或用 `F6` 打开详情。按 `Esc` 可取消；运行中的子代理会被终止并显示为 cancelled，同时保留已有输出和部分用量。

## 命令

```text
/ultracode             # toggle on/off
/ultracode on          # enable orchestration mode
/ultracode on 500k     # enable it with an output-token budget
/ultracode off         # disable the tool and restore the previous thinking level
/ultracode status      # show status and the configured budget
/ultracode budget 500k # set a token budget
/ultracode budget off  # remove the budget
/workflows             # open the interactive workflow detail overlay
/workflows <runId>     # open one run directly (prefix accepted)
/workflows abort       # abort active runs
F6                     # open the workflow detail overlay
```

`/workflows` 与 `F6` 打开实时浮层。只有一个活动运行时会直接进入；多个活动运行会先显示选择器；没有活动运行时会打开最近完成的运行。宽终端使用任务/详情双栏，窄终端在列表与详情间切换。键盘操作：

- `↑` / `↓` 选择运行或任务；`Enter` 打开；`Tab` 切换双栏焦点；`Esc` 返回或关闭；
- `PageUp` / `PageDown` 滚动；`End` 恢复尾随；
- `/` 搜索任务，`r` 只看运行中的任务，`a` 恢复全部，`p` 展开或收起任务 prompt。

每次 `agent()` 调用都是一个可独立展开的任务。详情按时间交错显示 turn、assistant 正文、工具调用、重试、上下文压缩、错误与 thinking 持续时间；thinking 正文不会被捕获。正文 delta 只保存在有界内存中并以不超过每 100ms 一次的频率刷新，消息完成后改用 Markdown 渲染。

所有可视化和落盘内容都会移除终端控制序列并脱敏凭据。内存上限为每任务 1MiB / 5000 行、每工作流 32MiB；最终 transcript 上限为每任务 10MB（约 1MB 头部 + 9MB 尾部）、每工作流 128MB。最终清理后的 timeline 与 manifest 保存在 session 的 `ultracode-runs/` 目录，因而 `/reload` 后仍可浏览；不会复制系统 prompt、注入 skill、AGENTS 内容或父会话上下文。

状态行会显示实际生效的思考强度，例如：

```text
ultracode: on · max
ultracode: on · xhigh
ultracode: on · high
ultracode: on · off
```

Ultracode 请求的是**当前模型支持的最高强度**，不是固定标签。对支持 `max` 的模型（包括 GPT-5.6 Sol）使用 `max`；能力较低的模型由 Pi 正常钳制。对不认识 `max` 的旧版 Pi，Ultracode 会自动回退到 `xhigh`。

显式覆盖始终优先：

- 每次调用的模型后缀，例如 `model: "openai/gpt-5.6-sol:high"`；
- Agent Type frontmatter 中的 `thinking:`；
- 显式 `:off`、`:high`、`:xhigh` 或 `:max`。

模型切换或手动降低强度时，只要 Ultracode 仍启用，它就会重新请求该模型的最高可用强度。关闭或退出时，会恢复启用前的会话强度与原始默认偏好。若当前模型暂时无法表示原始强度，恢复意图会保留到后续兼容模型；中间模型的钳制结果不会覆盖原始意图。

## 工作原理

扩展注册单个 `workflow` 工具，并在 input preflight 与 `before_agent_start` 边界按 Ultracode 状态校准 active tools，同时保留其他 active tools。关闭或暂停时，`tool_call` 与实际执行入口会双重 fail-closed 拒绝残留调用。工具输入是 JavaScript 源码，其中必须包含纯字面量 `meta` 导出：

```js
export const meta = {
  name: "review_and_fix",
  description: "Review independent areas, then verify the combined result",
};
```

脚本可使用下列全局变量：

- `agent(prompt, options)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `phase(title)`
- `log(message)`
- `workflow(nameOrRef, args)`
- `args`
- `cwd`
- `budget`

`agent()` 的主要选项：

| 选项 | 作用 |
| --- | --- |
| `label` | 进度中显示的 2–5 个词短名称。 |
| `phase` | 显式指定进度阶段。 |
| `schema` | 普通 JSON Schema；成功时返回经 `structured_output` 校验的对象。 |
| `model` | 按模式覆盖模型，也可带 `:off`、`:high`、`:xhigh` 或 `:max`。 |
| `agentType` | 使用内置或自定义角色。 |
| `isolation: "worktree"` | 在临时 git worktree 中运行写入型代理。 |

为保证可恢复和确定性，脚本不提供 Node.js 模块加载能力，也不允许直接使用 `fs`、网络、`Date.now()`、`new Date()` 或 `Math.random()`。

### 取消与清理

按 `Esc` 取消工作流时，取消信号会覆盖子代理初始化、异步 preflight 和流式执行窗口。运行器会等待进行中的 `abort()` 完成后再释放会话；清理失败不会覆盖原始 prompt 或取消错误。兼容旧版 Pi 时创建的临时 fallback 会话也遵循同一清理规则。

### 直接调用

```js
export const meta = {
  name: "single_review",
  description: "Run one focused reviewer",
};

const result = await agent(
  "Inspect src/mode.ts for lifecycle bugs. Return concise findings.",
  { label: "mode review" },
);

export default result;
```

### 并行检视

`parallel()` 接收 thunk，而不是已经启动的 Promise：

```js
export const meta = {
  name: "parallel_review",
  description: "Review independent concerns concurrently",
};

const tasks = [
  ["correctness", "Review correctness and lifecycle behavior."],
  ["tests", "Review test coverage and missing regressions."],
  ["docs", "Review README and parity documentation."],
];

const results = await parallel(
  tasks.map(([label, prompt]) => () => agent(prompt, { label })),
);

export default results.filter(Boolean);
```

### 流水线

除非后续阶段确实需要所有前置结果，否则优先使用 `pipeline()`。不同条目可独立推进：

```js
export const meta = {
  name: "review_pipeline",
  description: "Inspect and verify several modules independently",
};

const files = ["src/mode.ts", "src/workflow/agent-runner.ts"];

const results = await pipeline(
  files,
  async (file) => agent(
    `Inspect ${file} and report concrete risks.`,
    { label: `inspect ${file}` },
  ),
  async (finding, file) => agent(
    `Verify this finding against ${file}:\n\n${finding}`,
    { label: `verify ${file}` },
  ),
);

export default results.filter(Boolean);
```

### 结构化输出

不传 `schema` 时，`agent()` 返回子代理最后一段非空 assistant 文本；传入普通 JSON Schema 时，则返回经校验的对象：

```js
export const meta = {
  name: "structured_audit",
  description: "Collect machine-readable findings",
};

const finding = await agent(
  "Audit the mode lifecycle and return one finding.",
  {
    label: "lifecycle audit",
    schema: {
      type: "object",
      properties: {
        severity: { enum: ["low", "medium", "high"] },
        summary: { type: "string" },
      },
      required: ["severity", "summary"],
      additionalProperties: false,
    },
  },
);

export default finding;
```

使用 schema 的代理必须调用 `structured_output`。否则该 `agent()` 分支会失败并返回 `null`；工作流本身仍可继续，因此脚本应过滤或显式处理失败分支，而不会把自由文本伪装成结构化结果。

## Agent Type

项目级角色定义放在：

```text
.pi/ultracode/agents/*.md
```

用户级角色定义放在：

```text
~/.pi/ultracode/agents/*.md
```

同时兼容旧的用户级目录 `~/.pi/agent/agents/*.md`。

示例：

```md
---
name: reviewer
description: Read-only reviewer focused on correctness and regressions
tools: read, bash
model: anthropic/claude-sonnet-4
thinking: high
---

Inspect the requested area. Do not modify files. Report only evidence-backed findings.
```

工作流中的用法：

```js
await agent("Review the current diff.", {
  label: "diff review",
  agentType: "reviewer",
});
```

内置类型包括 `claude`、`general-purpose`、`Explore`、`Plan` 和 `code-reviewer`。

Agent Type 可控制：

- 角色提示词；
- 工具白名单；
- 默认模型；
- 默认思考强度。

每次调用的选项优先于 Agent Type 默认值。

## 模型选择

`model` 接受 provider/model 模式，并可带思考强度后缀：

```js
await agent("Analyze this failure.", {
  label: "failure analysis",
  model: "openai/gpt-5.6-sol:max",
});
```

若未指定 model，则子代理继承工作流工具创建时的 Pi 当前模型。Ultracode 启用时，默认子代理强度同样请求 `max`，并按每个代理实际选择的模型独立钳制。Ultracode 不会自动启用 GPT-5.6 的 `pro` 模式，也不会隐式设置 token 预算。

## Worktree 隔离

并行写入同一工作树容易产生竞态。对会修改文件的代理使用：

```js
await agent("Implement the requested change and run focused tests.", {
  label: "implementation",
  isolation: "worktree",
});
```

运行器会：

1. 创建临时 git worktree；
2. 在隔离目录运行代理；
3. 捕获 worktree diff；
4. 检查共享工作树是否漂移；
5. 通过 `git apply --3way` 应用补丁；
6. 在失败时保存 rescue patch；
7. 成功且安全时清理临时 worktree。

如果 diff 捕获、rescue 保存或补丁集成异常，运行器会故障安全地保留 worktree，并在日志中给出路径，避免丢失代理改动。确认内容后可手动恢复或删除；超过保留阈值的 Ultracode worktree 会由后续运行回收。

使用隔离前，共享仓库必须处于干净状态。

## 已保存的工作流与可恢复运行

可复用工作流可放在：

```text
.pi/ultracode/workflows/<name>.workflow.js
~/.pi/ultracode/workflows/<name>.workflow.js
```

可通过工具的 `name`、`scriptPath`，或脚本内调用来运行：

```js
await workflow("saved_workflow_name", { target: "src" });
```

嵌套限制为一层，且共享父运行的并发上限、代理计数与 token 预算。

每次运行都会把脚本和 JSONL journal 保存到：

```text
<sessionDir>/ultracode-runs/<runId>.workflow.js
<sessionDir>/ultracode-runs/<runId>.jsonl
```

暂停、终止或修改脚本后，可再次调用 `workflow` 工具并传入 `resumeFromRunId`。最长的未变 `agent()` 调用前缀会立即返回缓存结果；第一个变化或新增的调用及其后续调用会实时执行。

## 预算与限制

默认 token 预算为无限。只有显式配置后，`budget.total` 才是有限值。

动态探索必须同时检查预算是否存在：

```js
while (budget.total && budget.remaining() > 50_000) {
  // additional bounded exploration
  break;
}
```

若不检查 `budget.total`，无限预算下的 `remaining()` 是 `Infinity`，循环可能一直运行到代理数量上限。

其他限制：

- 最大代理数；
- 最大并发数；
- 工作流脚本超时；
- 嵌套深度；
- 结构化输出校验；
- 静态禁止不确定性与危险全局变量。

## 会话与兼容性

Ultracode 模式状态通过自定义 session entry 持久化。恢复、reload、fork 和 `/tree` 导航都会按当前 branch 重新读取状态；被丢弃分支中的 entry 不会错误启用模式。旧版 Pi 或旧模型会把 `max` 兼容回退为 `xhigh`，而不会把未知值静默变成 `off`。

扩展清理只管理自己的详情浮层、status 与运行状态，不会调用 Pi 的全局 `ui.clear()`，因此不会清除其他扩展的 UI。

## 开发

```bash
npm run typecheck
npm test
npm pack --dry-run
```

项目源码位于：

- `extensions/ultracode.ts`：扩展入口和 Pi 生命周期接线；
- `src/mode.ts`：Ultracode 模式状态、恢复与强度管理；
- `src/thinking.ts`：共享思考强度词汇与兼容性检测；
- `src/workflow/`：脚本验证、运行时、子代理执行、worktree 和进度显示；
- `test/`：单元、扩展和回归测试；
- `docs/parity.md`：与原生 Pi 能力边界的说明。

直接运行 Node 测试时没有 Pi 的模块加载器，需要把真实的 `acorn` 与 Pi 提供的 peer 包链接到 `node_modules/`；`npm run typecheck` 还要求本地可用的 TypeScript。通过 `pi install` 加载扩展时，Pi 会提供这些 peer 依赖。

## 设计原则

Ultracode 的目标不是“尽可能多地启动代理”，而是：

> 在任务确实适合拆分、并行、独立验证或跨上下文扩展时，使用确定性编排获得更高置信度；否则继续使用 Pi 简洁直接的单代理循环。

## 许可证

MIT
