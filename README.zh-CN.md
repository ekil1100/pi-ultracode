# pi-ultracode

为 [Pi](https://github.com/earendil-works/pi) 提供确定性的多代理工作流。

[English](README.md) · **简体中文**

`pi-ultracode` 为 Pi 增加可选的语义化分析深度模式。它既可以自动判断任务需要的深度，也可以固定使用 focused、standard 或 deep 策略。当委派确有价值时，主代理可以运行有边界的 JavaScript 工作流，使用并行子代理、隔离 worktree、结构化输出、持久恢复和实时进度。

项目结合了 [Claude Code](https://github.com/anthropics/claude-code) 的终端 Agentic 体验，以及 [Grok Build](https://github.com/xai-org/grok-build) 的显式工作流和结构控制思路，同时继续使用 Pi 作为运行时。

## 安装

```bash
pi install npm:pi-ultracode
```

然后重新加载 Pi，并用主命令开启自适应 Ultracode：

```text
/reload
/ultracode
```

也可以在启动时直接进入 `auto` 模式：

```bash
pi --ultracode
```

> `pi-ultracode` 会注册名为 `workflow` 的工具。如果已安装 `pi-dynamic-workflows`，请先运行 `pi remove npm:pi-dynamic-workflows`。

需要 Pi 0.99.1 或更高版本。模式提示词通过独立分区更新，不再替换整段系统提示词。

## 核心特性

- **自适应语义深度**：可选择 `auto`、`focused`、`standard` 或 `deep`；`auto` 使用证据充分的最小深度，父代理 effort 始终由用户控制。
- **显式工作流**：通过 `agent()`、`parallel()`、`pipeline()` 和嵌套 `workflow()` 组合任务。
- **独立子代理**：每个代理拥有独立的 Pi 会话、上下文、工具、模型选择和可选角色。
- **并行 worktree 隔离**：写入型代理可在临时 git worktree 中工作，再集成补丁。
- **结构化输出**：使用有边界的 JSON Schema 子集校验代理结果。
- **持久恢复**：按照稳定的结构身份复用已完成调用，不重复执行成功任务。
- **实时可观测性**：在 TUI 中查看状态、模型、思考强度、turn、工具、token、重试和 transcript。
- **有界执行**：限制累计代理数、并发、JSON 大小、Worker 运行和取消清理时间。

## 快速开始

用主命令开启自适应 Ultracode，然后描述任务：

```text
/ultracode

Review the current branch in parallel, verify every finding,
fix the justified issues, and run the relevant tests.
```

Pi 会自行判断工作流是否有帮助。小任务仍可继续使用普通的单代理循环。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `/ultracode` | 关闭时开启 `auto`；任一模式已开启时关闭 |
| `/ultracode auto` | 始终由父代理结合任务和上下文选择深度 |
| `/ultracode focused` | 固定处理方法已知、范围明确且能局部直接验证的工作 |
| `/ultracode standard` | 固定调查独立维度或竞争假设，并做针对性验证 |
| `/ultracode deep` | 固定检查相互作用的约束或关键不变量，要求独立证据和反例检验 |
| `/ultracode off` | 关闭且不改变父代理 effort |
| `/ultracode status` | 查看配置模式及其适用条件、验证要求 |
| `/ultracode default on` | 全局默认开启，并立即开启当前会话；已开启时保留当前深度 |
| `/ultracode default off` | 取消默认开启 |
| `/ultracode default` | 查看全局启动默认值 |
| `/workflows` 或 `F6` | 打开工作流浏览器 |
| `/workflows <runId>` | 打开指定运行 |
| `/workflows abort` | 中止活动运行 |

`/ultracode default on` 保存全局启动默认值，并立即将关闭的当前会话切换为 `auto`；当前已开启时保留所选深度。`/ultracode default off` 只取消默认开启，不关闭当前会话；关闭当前会话请用 `/ultracode off`。这些操作均不改变 effort。设置保存在 `~/.pi/agent/ultracode.json`（遵循 `PI_CODING_AGENT_DIR`），跨项目和重启生效；未设置时默认关闭。启动时，只有当前分支没有保存 Ultracode 模式才应用默认值，已有的 `off` 或深度选择在 reload、resume、fork 后继续保留。显式 `pi --ultracode` 仍可启用 `auto`。

按 `Esc` 可取消正在运行的工作流。在 Pi 的 fullscreen TUI 中，请在工作流详情内使用 `Ctrl+PageUp`、`Ctrl+PageDown` 和 `Ctrl+End`。

## 分析深度

深度决定**要调查和验证什么**，不是模型 effort，也不是代理数量或调查轮数配额：

| 深度 | 适用条件 | 验证要求 |
|---|---|---|
| **Focused** | 范围明确、方法已知、结果可局部验证；例如添加指定校验规则 | 直接检查修改行为或关键结论，通常使用父代理循环。默认不做广泛调查或对抗评审，但不能省略验证。 |
| **Standard** | 多个独立维度或未解决的竞争假设会实质影响答案；例如故障存在多个合理根因 | 调查相关维度或比较根因，再针对冲突、证据薄弱的结论验证。仅仅步骤多且方法已知，不足以要求 standard。 |
| **Deep** | 紧密相互作用的硬约束或关键不变量，需要独立证据与反例检验；例如取消与持久提交发生竞争 | 追踪相互影响，检查边界及失败路径，用不同测试、复现、证明或来源挑战关键结论。第二个代理既非必要条件，也不保证证据独立。 |
| **Auto** | 选择足以处理当前任务的最小深度 | 遵守所选深度的证据要求；仅在实质新证据或未解决冲突要求时升级。 |

风险决定**哪些结论需要验证**。安全、并发、数据丢失等关键词、文件数量或“做一次 review”本身不能自动触发 `deep`；信息不足也不证明存在隐藏复杂度。Deep 不自动意味着必须使用工作流、增加代理或反复调查。显式 `focused` / `standard` / `deep` 保持固定：若不足以确认结论，应说明不确定性并建议更深模式，不能悄悄越界。

当关键结论已有直接证据、没有实质冲突或未解决的高风险问题，且下一轮只会重复已知证据时停止。墙钟时间、deadline 和 duration limit 不得用于选择或停止分析深度。`maxAgents` 与 `reserveAgents` 继续作为结构性准入限制。父会话 effort 由用户控制，子代理 effort 仍按具体子任务单独判断。

### Auto 由父代理选择深度

在 `auto` 下，父代理始终在正常轮次中结合当前任务、会话上下文及仓库证据，按 `src/depth.ts` 的共享标准选择 `focused`、`standard` 或 `deep`。从足以完成任务的最浅深度开始，仅在证据要求时升级。即使 Pi 中已有可用的 Jev，也不会创建路由代理或发起额外分类请求。

Jev 的可用性仅影响下述子代理 effort 选择，包括固定深度模式。`/ultracode status` 与页脚描述的是**配置模式**，不是父代理随证据变化的实时深度。

`workflow` 工具采用 Pi 的 `model-only` 暴露方式：激活时向模型声明，但不能通过 codemode 或其他工具的 `ctx.executeTool()` 调用。工具注解明确声明它可能修改或覆盖文件、访问外部服务，且重复调用可能产生额外影响。这些是权限提示，不是沙箱。

### 子代理 effort

Ultracode 不会修改父会话的 effort；以下父代理选择作为默认和 Jev 失败时的回退。父代理按**分配给每个子代理的具体任务**通过模型后缀选择最合适的受支持档位，不固定默认 `medium` 或 `high`，也不盲目追求最低或最高档。

每次父会话运行前，扩展都会提供本地 Pi 能力快照：当前默认子模型（`ctx.model`）和已注册且可用的覆盖模型，以及 Pi 能力 API 返回的各模型支持档位。切换模型或更新注册信息后，下次运行会使用新快照。裸后缀（如 `:low`）使用默认子模型的能力；显式模型或 agent 角色指定的模型使用各自能力，建议用完整 `provider/model` 标识。仅支持 `low/medium/high` 的模型只提供这三个选项，不会先提供七档再依赖 clamp。未知能力明确保留为未知，父代理应省略自动 effort 后缀，而不是猜测。此过程不增加模型请求。

快照来自本地注册信息，不会在线探测提供商，且运行期间可能过时；执行端仍用 clamp 保护显式请求或过时信息。SDK 单独使用 `createWorkflowTool()` 而不加载扩展时，不会注入此区块，宿主需自行提供能力上下文才能让父代理据此自动选择后缀。快照存在与否，都不会改写用户显式选择的 effort 或无后缀默认行为。

| 后缀 | 适用条件与排除条件 | 例子 |
|---|---|---|
| `:off` | 完全指定的机械操作；不涉及寻找修改位置、判断含义或隐藏影响 | 在指定位置按给定内容修正错字 |
| `:minimal` | 单一范围内的一次明确局部判断；不涉及跨文件追踪或多步骤实现 | 解释一个自包含短表达式 |
| `:low` | 目标清楚、方法已知、验证直接的小实现或问题；不包含根因未知的故障 | 给已有函数添加指定校验规则及测试 |
| `:medium` | 协调多个已知约束的有界多步骤实现或调查；不包含相互影响的未解决假设 | 在既有架构中贯通配置加载、使用和测试 |
| `:high` | 检验多个合理假设、追踪跨模块影响，或推理关键正确性约束；不能只凭安全或架构关键词升级 | 比较竞争根因，诊断跨模块状态不同步 |
| `:xhigh` | 多个困难问题相互作用，需要比较方案、验证跨模块不变量；文件多或笼统声称复杂不够 | 排查生命周期、缓存、取消相互影响的偶发故障 |
| `:max` | 极难的综合推理，需要严密论证及反例检验，或已有低档推理不足的具体证据；风险关键词本身不够 | 证明并修复涉及并发、内存安全和底层语义的全系统不变量 |

写代码、审查、文本长度、文件数量、风险关键词及 depth 模式都不能单独决定高档；信息不足不自动意味着 `medium/high`，也不能臆造复杂度。选择 `high/xhigh/max` 时须简述具体推理难点。最高档不要求先经历低档失败，也不要求模型支持中间档。风险决定需要验证什么，不等于所有参与代理都要高 effort。

这些分档是任务选择标准，不是跨提供商统一的能力刻度。Workflow UI 展示实际生效的 effort；未指定后缀且 Jev 未覆盖时，子会话使用正常的用户/模型配置。系统提示词、workflow 指南和 Jev 共用 `src/effort-policy.ts` 的分档标准，均不改变父会话 effort。skeptic 和独立 synthesis agent 都不是默认步骤。

#### 可选 Jev 自动选择

当 Pi 原生 `getAvailableOfType("classifier", "typesafe")` 返回的可用模型中包含 `typesafe/jev-latest` 时，自动进行 Jev 选择。该接口检查 Pi 的凭证配置，不只是模型目录中是否存在，也不保证远端服务正常。Jev 不可用时不发分类请求，完全保留现有父代理后缀及用户/模型默认行为。

- 同一调度批次中的已就绪子任务共用**一次** Pi 原生 `modelRuntime` / `modelRegistry.classify()` 请求，每个符合条件的任务在 `questions` 中有独立问题，映射到其完整提示词、**实际子会话模型**及支持档位。回答独立应用；成功选择只覆盖对应子任务的 effort，不更换执行模型，不修改父会话或全局默认值。
- 选择标准复用 `src/effort-policy.ts`，各任务按自身复杂度判断，不因整个工作流复杂而统一提高档位。共享背景包含现有工作流 `meta`（名称、描述，以及实际提供的总目标、验收或依赖信息）和 `args`；每项任务附带阶段、工作流路径、已知的并行分支/流水线项目与阶段结构，嵌套工作流还包含自身元数据和参数。完整提示词包含角色、额外指令、标签、输出要求及脚本已经传入的上游结果。不编造缺失目标或依赖关系，不额外调用模型总结，不额外读取仓库，不发送完整脚本或父会话历史。请求通过 Pi 的提供商配置发送，默认地址为 `https://api.typesafe.ai`。在 Pi 中配置 Jev 前，请确认这些提示词、元数据和参数可以发送给 TypeSafe；可用凭证会自动启用选择。
- 凭证由 Pi 在请求时解析，可来自运行时凭证、已保存凭证、提供商配置或标准环境变量来源（包括 `TYPESAFE_API_KEY`）。Ultracode 不读取该变量作为开关，也不显式传入 `apiKey`，不修改 Pi 已保存的凭证，不请求其他提供商或模型。
- 请求超时为 **10 秒，不重试**。Pi 暴露的单项答案无效或档位不受支持时，只保留对应任务原来的父代理选择/默认值；请求级错误则各自保留整批任务的原值。**Pi 0.99.1 限制：**TypeSafe 适配器遇到任一缺失或格式损坏的网络答案，会丢弃整批答案，这种情况只能整批回退；格式有效但档位不受支持的答案仍可独立回退。**回退不会额外请求模型重新判断**。
- 用户取消会中止选择并终止子任务，包括等待执行名额的任务，不会执行回退任务。恢复缓存命中、仅支持一个档位或无法确定实际模型的任务均不参与分类；整批都无需分类时不发请求。
- UI 展示实际生效的 effort。选择器不记录密钥、原始响应或服务错误正文；Jev 的选择请求用量不计入子代理执行用量。

**批次边界：**`parallel()` 和 `pipeline()` 收集同步启动各分支/项目时实际发出的任务，然后立即封闭批次。不使用防抖计时、不预执行完整脚本、不等待未来任务。`await` 之后、嵌套工作流/并行面板加载之后，以及流水线后续阶段产生的任务，就绪后进入新批次（常为单任务）；不会为了等待慢分支而阻塞已就绪的后续阶段。后续显式并行启动仍会再次合批。因此，任意惰性 JavaScript 工作流不能保证全程只发一次分类请求。

名额检查和缓存检查仍先于实际会话准备。为取得真实能力，分类前会准备空闲子会话及所需隔离工作树；准备数量可能超过执行并发数，但仍受生命周期任务名额限制。收集批次及分类不占执行信号量，子任务执行、结果发布和工作树交付仍受原并发限制（最多 16），即使整批任务多于并发上限也不会因此死锁。

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

Workflow 子代理会保留项目上下文和普通 skills，但不会初始化环境中的 Pi 扩展，也不会暴露父级编排工具与 skill（`workflow`、`subagent`、`subagent_wait` 或 `pi-subagents`）。子会话显式启用 codemode 来编排工具调用，但不开放其模型调用 API；角色显式指定的工具白名单仍然有效。这样可把编排限制在父会话边界，同时允许 `pi-ultracode` 与 `pi-subagents` 在主会话中共存。项目级代理和设置遵循 Pi 的项目信任结果；内置 Explore 与 Plan 角色使用封闭的只读工具列表，不包含 shell 或写入工具。

Resume 刻意保持不可变：规范化脚本、参数、规范仓库及仓内相对 cwd、项目信任上下文、代理定义、实际模型和调用结构都必须匹配。Worktree 交付会在修改共享仓库前先写入持久恢复意图；中断或冲突的交付会阻止自动回放，并报告恢复补丁。工作内容发生变化时，应启动新的 run。

Token 和成本只用于可观测性，不作为执行预算。Worker 与 VM 限制用于确定性和存活性保护，不是安全沙箱，也不参与分析深度判断。

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
