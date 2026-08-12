# pi-ultracode

为 [Pi](https://github.com/earendil-works/pi) 提供确定性的多代理工作流。

[English](README.md) · **简体中文**

`pi-ultracode` 为 Pi 增加一个可选的高强度执行模式。当任务适合拆分时，主代理可以运行有边界的 JavaScript 工作流，使用并行子代理、隔离 worktree、结构化输出、持久恢复和实时进度。

项目结合了 [Claude Code](https://github.com/anthropics/claude-code) 的终端 Agentic 体验，以及 [Grok Build](https://github.com/xai-org/grok-build) 的显式工作流和结构控制思路，同时继续使用 Pi 作为运行时。

## 安装

```bash
pi install npm:pi-ultracode
```

然后重新加载 Pi，并用主命令切换到 Ultracode：

```text
/reload
/ultracode
```

也可以在启动时直接启用：

```bash
pi --ultracode
```

> `pi-ultracode` 会注册名为 `workflow` 的工具。如果已安装 `pi-dynamic-workflows`，请先运行 `pi remove npm:pi-dynamic-workflows`。

当前版本已在 Pi 0.84 上验证。

## 核心特性

- **可选高强度模式**：请求当前模型支持的最高思考强度，关闭时恢复之前的强度。
- **显式工作流**：通过 `agent()`、`parallel()`、`pipeline()` 和嵌套 `workflow()` 组合任务。
- **独立子代理**：每个代理拥有独立的 Pi 会话、上下文、工具、模型选择和可选角色。
- **并行 worktree 隔离**：写入型代理可在临时 git worktree 中工作，再集成补丁。
- **结构化输出**：使用有边界的 JSON Schema 子集校验代理结果。
- **持久恢复**：按照稳定的结构身份复用已完成调用，不重复执行成功任务。
- **实时可观测性**：在 TUI 中查看状态、模型、思考强度、turn、工具、token、重试和 transcript。
- **有界执行**：限制累计代理数、并发、JSON 大小、Worker 运行和取消清理时间。

## 快速开始

用主命令开启 Ultracode，然后描述一个较复杂的任务：

```text
/ultracode

Review the current branch in parallel, verify every finding,
fix the justified issues, and run the relevant tests.
```

Pi 会自行判断工作流是否有帮助。小任务仍可继续使用普通的单代理循环。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `/ultracode` | 切换 Ultracode 的开启或关闭状态 |
| `/ultracode on` | 显式启用（可选别名） |
| `/ultracode off` | 关闭并恢复之前的思考强度 |
| `/ultracode status` | 查看当前模式和实际思考强度 |
| `/workflows` 或 `F6` | 打开工作流浏览器 |
| `/workflows <runId>` | 打开指定运行 |
| `/workflows abort` | 中止活动运行 |

按 `Esc` 可取消正在运行的工作流。在 Pi 的 fullscreen TUI 中，请在工作流详情内使用 `Ctrl+PageUp`、`Ctrl+PageDown` 和 `Ctrl+End`。

## 工作流示例

通常由主代理自动编写工作流。需要复用时，可以保存到 `.pi/ultracode/workflows/*.workflow.js` 或 `~/.pi/ultracode/workflows/*.workflow.js`。只有 Pi 将项目标记为可信后，才会发现项目级工作流；用户级工作流在未信任项目中仍可使用。

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

如需编辑器类型提示，请添加：

```js
/// <reference types="pi-ultracode/workflow" />
```

完整工作流接口见 [`types/workflow.d.ts`](types/workflow.d.ts)，更多示例见 [`examples/workflows`](examples/workflows)。

## 角色、模型与 worktree

自定义代理角色放在：

```text
.pi/ultracode/agents/*.md
.pi/agents/*.md
~/.pi/ultracode/agents/*.md
~/.pi/agent/agents/*.md
```

每次调用都可以选择角色、模型、思考强度或 worktree 隔离：

```js
await agent("Implement and test the fix.", {
  label: "implement fix",
  agentType: "general-purpose",
  model: "anthropic/claude-sonnet-4:high",
  isolation: "worktree",
});
```

Worktree 隔离只能在至少有一个 commit 的 Git 仓库中使用；隔离树创建失败时会直接失败，不会回退到共享工作目录。每次调用都会获得唯一的 detached worktree。补丁集成不修改用户 index；byte-exact patch 会先在 object format 匹配的私有 Git index 中完成 cached check，再绕开仓库 attributes、filter 与 EOL 转换直接 materialize 原始 blob；冲突补丁会保存供人工恢复，不使用可能破坏 index 的三方合并回退。成功交付的补丁会保留，用于 resume 时校验共享树效果仍然存在。隔离树不会链接共享仓库的可写 `node_modules`；需要时请在隔离树中安装依赖，或在集成后执行最终测试。为保证补丁集成可预测，建议保持工作区干净。

## 执行边界

工作流默认使用 `maxAgents: 128`，最多并发运行 16 个代理，并只允许一层嵌套工作流。嵌套 `workflow()` 只接受经过 trust-aware discovery 的已保存工作流名称，不接受显式路径。累计代理上限会跨 resume 保留，缓存回放不会再次占用额度。

Workflow 子代理会保留项目上下文和普通 skills，但不会初始化环境中的 Pi 扩展，也不会暴露父级编排工具与 skill（`workflow`、`subagent`、`subagent_wait` 或 `pi-subagents`）。这样可把编排限制在父会话边界，同时允许 `pi-ultracode` 与 `pi-subagents` 在主会话中共存。项目级代理和设置遵循 Pi 的项目信任结果；内置 Explore 与 Plan 角色使用封闭的只读工具列表，不包含 shell 或写入工具。

Resume 刻意保持不可变：规范化脚本、参数、规范仓库及仓内相对 cwd、项目信任上下文、代理定义、实际模型和调用结构都必须匹配。Worktree 交付会在修改共享仓库前先写入持久恢复意图；中断或冲突的交付会阻止自动回放，并报告恢复补丁。工作内容发生变化时，应启动新的 run。

Token 和成本只用于可观测性，不作为执行预算。Worker 与 VM 限制用于确定性和存活性保护，不是安全沙箱。

## 设计参考

- **Claude Code**：自然语言驱动、终端优先的 Agentic 编码体验和任务委派。
- **Grok Build**：显式工作流、持久 journal、有界 admission 和结构执行控制。
- **Pi**：模型运行时、会话、工具、扩展 API 和 TUI 都继续使用 Pi 原生能力。

`pi-ultracode` 是独立的 Pi 扩展，与 Anthropic 或 xAI 没有关联。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 许可证

MIT
