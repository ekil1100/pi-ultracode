# pi-auto effort 机制参考

## 结论

**能借鉴分档标准，不能照搬父会话路由。** 最有价值的区别是：medium 已包含常规多步骤实现；high 不是“做实事”，而是需要验证竞争假设、追踪跨模块影响或推理关键正确性约束。max 不是“高风险”的同义词。

证据范围：pi-auto `7e7d584b1937fa60cfa815db23859392979bc789`；本地 pi-ai 依赖版本 `0.84.4`。下文 `A/` = `/Users/like/workspace/pi-auto/`，`U/` = `/Users/like/workspace/pi-ultracode/`。均为当前文件行号。

指令检查：已检查 `/`、`/Users`、`/Users/like`、`/Users/like/workspace`、两仓库根目录的 `AGENTS.md`，以及 pi-auto 内部、报告目标目录的同名文件，未发现额外指令；遵循会话提供的 `/Users/like/.pi/agent/AGENTS.md`。只读研究，不 pull、不修改源码；唯一主动写入文件为本报告。

## 1. 七档定义：适用条件 + 排除条件 + 例子

直接来源：`A/src/effort-policy.ts:12-23`；逐档文字断言：`A/tests/effort-policy.test.ts:7-82`。

| 档位 | 适用条件 | 不应归入此档的情况 | 源码例子 |
|---|---|---|---|
| off | 完全指定的机械操作，无实现决策或隐含影响推理 | 还需找修改位置、判断含义 | 在精确位置按给定替换修正文档错字 |
| minimal | 单一范围内的一次明确局部判断，无未解决依赖 | 跨文件追踪、多步骤实现 | 解释自包含短表达式的直接条件 |
| low | 小实现或直接问题，目标清楚、方法已知、验证直接 | 根因未知的故障 | 给已有函数加指定校验规则及测试 |
| medium | 有界多步骤实现或调查，协调多个已知约束 | 多个相互影响、尚未解决的假设 | 在既有架构中贯通配置加载、使用及测试 |
| high | 验证多个合理假设、追踪跨模块影响，或推理关键正确性约束 | 仅因出现安全、架构关键词而升级 | 检验竞争原因，诊断跨模块状态不同步 |
| xhigh | 多个困难问题相互作用，需深入推理、比较方案及验证跨模块不变量 | 仅凭文件多或无证据的复杂性声明 | 生命周期、缓存、取消相互作用的偶发故障 |
| max | 极难的综合问题，需持续严密论证及主动反例检验；或有具体证据表明较低 effort 不够 | 仅凭风险关键词升级 | 证明并修复并发、内存安全、底层语义共同涉及的全系统不变量 |

注意：high 中三个条件是“或”，不是必须同时满足；max **不要求先失败，也不要求模型支持 xhigh**（`A/src/effort-policy.ts:8,17-19`；`A/tests/effort-policy.test.ts:76-81`）。

## 2. 默认值、升级与降级：不是阶梯状态机

- **没有默认执行档 medium/high。** 默认开启自动选档；使用当前会话 effort，缺失才以 off 表示。测试里的 medium 是 fixture，不是产品默认值（`A/src/index.ts:22-23,80-87`；`A/tests/router.test.ts:25-32`）。
- **选档器自身优先用 low**；模型不支持 low 时取最低可用非 off 档。这不是任务执行档，不应移植成“所有子代理默认 low”（`A/src/router.ts:91-98`；`A/tests/router.test.ts:143-160`）。
- 默认让当前模型判断；非空 `TYPESAFE_API_KEY` 改用 Jev，执行模型仍不变（`A/src/index.ts:101-130`；`A/src/jev.ts:10,40-47`）。
- 每次重新从全部支持档位选择，可直接升、降或保持。代码没有逐档重试、失败计数、升降分数、冷却期或 high 保底；`currentEffort` 只是输入数据，选定值直接应用（`A/src/router.ts:149-172`；`A/src/index.ts:140-148`）。
- **升级依据是任务证据**：已知复杂度、相互作用的约束、验证负担、缺失信息。长度、文件数、代码存在、安全/并发关键词不能单独决定档位；“讨论危险机制”不同于“修改机制”；不确定也不自动意味着 medium/high（`A/src/effort-policy.ts:5-10`）。
- **降级不是硬规则**：当前任务变得局部、方法明确、验证直接时应重新匹配低档；旧困难任务不应抬高新任务。这里是提示词语义，不是代码检测“根因已查明后自动降一级”（同上 `:6-9`）。
- Jev 的 confidence 只作元数据，0 也不会导致 high 降级；概率校验要求合法分布且所选项为最高概率项，不是“置信度低于阈值降档”（`A/src/jev.ts:158-183`；`A/tests/jev.test.ts:116-120`）。
- 分类与选档共用 **10 秒**，失败/超时保留当前档，不降档、不跨后端回退；Jev 不自动重试（`A/src/index.ts:17,80-84,135-152`；`A/src/jev.ts:93-98`；`A/tests/index.test.ts:262-274,968-1002`）。这是路由请求期限，不是任务深度预算。

## 3. 提示词、实际代码与测试是否一致

### 主运行路径一致，但语义不由代码强制

当前模型和 Jev 共用同一份 `EFFORT_INSTRUCTIONS` 与 `getEffortCriteria`，且只提供模型支持的选项；没有两套分档文案（`A/src/router.ts:164-172`；`A/src/jev.ts:40-47`）。测试断言分档互异、支持子集、max 无须先失败、无任意 confidence 阈值（`A/tests/effort-policy.test.ts:51-108`）；Jev 请求测试检查实际发送的 criteria（`A/tests/jev.test.ts:38-55`）。

但代码只校验输出格式和档位合法性，**不验证 high/max 的任务理由是否充分**。当前模型路径甚至接受缺失 reason、围栏 JSON，并补默认理由（`A/src/router.ts:191-207`；`A/tests/router.test.ts:204-208`）。因此“同源提示词”不等于“模型一定选对”。测试中的返回档位多为模拟结果，例如 max 应用测试直接返回 max；不能用它证明真实模型会减少 high 使用（`A/tests/index.test.ts:1089-1107`）。

### 一处明确的不一致：benchmark 仍依赖旧提示词前缀

现提示词以 `Choose the most appropriate supported effort` 开头（`A/src/effort-policy.ts:5`），benchmark 网关却用旧前缀 `Choose the most appropriate effort in supportedEfforts` 识别 selector（`A/benchmarks/gateway.py:163-166`）。按该分支，当前无工具选档请求会被记为 auxiliary，而非 selector。测试仍构造旧前缀，并在 CLI 测试期望 selector（`A/benchmarks/tests/test_gateway.py:180-186,226-233`）。这是外围测量识别不一致，不是主路由另有分档策略；不能无条件引用该 benchmark 为当前策略背书。

## 4. 模型限制

- 支持档位来自 Pi 的 `getSupportedThinkingLevels`，不是 pi-auto 自写模型名单（`A/src/router.ts:79-98`）。本地依赖实现：`A/node_modules/@earendil-works/pi-ai/dist/models.js:547-558`。
- `reasoning=false` 仅 off；支持 reasoning 时，off 至 high 默认可用，映射为 null 则禁用；xhigh/max 必须显式映射才可用。可存在 high → max 的空档，也可禁用 off。**七档不是各提供商统一的能力或 token 标尺**（同上；`A/src/effort-policy.ts:9`）。
- 无当前模型/无支持档：跳过；仅一个档：直接采用、不调用选档器；模型返回不支持档则拒绝，不自行替换（`A/src/router.ts:80-98,158-171,191-200`；`A/tests/router.test.ts:59-105,162-176`）。
- Pi 通用 clamp 与 pi-auto 的“拒绝非法结果”不是一回事：本地依赖 clamp 对不支持档位先向上找可用档，再向下找（`A/node_modules/@earendil-works/pi-ai/dist/models.js:560-577`）。子代理应区分请求档与最终实际档，不能把 clamp 当成任务难度升级。
- 选择器只收到文字状态和图片存在标志，不分析图片本体；历史只收用户/助手文字和压缩摘要，排除工具结果、thinking 与工具调用。当前任务上限 12,000 字符，历史预算 6,000 字符、候选池 24,000 字符/32 块，故并非掌握完整执行证据（`A/src/session-context.ts:17-44`；`A/src/router.ts:9,149-154`；`A/src/context-compaction.ts:3-5`；`A/src/index.ts:223-228`）。

## 5. 哪些适用于 Ultracode 子代理

### 可以借鉴：分配前，按这个子任务而不是整个项目判断

建议将现有“三档角色标签”改成“适用条件、排除条件、例子”；这是迁移建议，不是 pi-auto 已有的子代理实现。

1. **low**：已知方法的小实现、精确查找或直接验证；不要把所有实质工作挤进 high。
2. **medium**：边界清楚的多步骤研究/实现，包括跨文件贯通已知配置链路；不再仅指“查找汇总”。
3. **high**：明确指出需要检验哪些竞争假设、追踪什么跨模块影响、证明哪个关键约束；“写代码/分析/审查”本身不够。
4. **xhigh/max**：保留独立描述，只在模型支持时提供。复杂耦合问题可用 xhigh；max 需要极难综合论证/反例检验，或较低 effort 不足的具体证据，但不强制先试低档。
5. 缺少信息时说明缺口，不凭想象升级；风险用于决定验证重点，不能直接等价为每个参与代理都用 high/max。

尤其需要同时检查两处重复文案：`U/src/prompts.ts:34,88`。当前 `:25` 的风险词规则属于工作流深度/验证策略，应与子代理 effort 解耦，否则仍可能把“高风险领域里的局部查找”推到高档。pi-auto 与 Ultracode 的总体目标也不完全相同：前者选“最合适”而非盲目最小/最大，后者要求能建立正确答案的最小深度（`A/src/effort-policy.ts:5`；`U/src/prompts.ts:16-17`）。

### 不宜照搬：父会话生命周期和自动改档

pi-auto 挂在 `before_agent_start`：用户新请求启动 agent loop 前选一次，**不是每次模型响应/工具循环的 turn_start 都选**。所以“逐轮路由”应理解为逐次任务启动（`A/src/index.ts:80-87,181-202`；`A/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:538-548,578-582`）。它还负责历史分类、识别“继续”、更新父会话 effort、手动切档/切模型时废弃在途结果，这些不是子代理分档定义（`A/src/context-policy.ts:3-11`；`A/src/index.ts:69-72,140-147`）。

Ultracode 应保留自己的边界：父 effort 由用户掌控；子代理按调用的 model 后缀选档，未指定时进入角色/默认配置链，不是固定 medium。实际解析和会话传入见 `U/src/workflow/agent-runner.ts:734-756,356-377`，实际生效档记录于 `:427-434`。子代理禁用环境扩展（同文件 `:78`），不要为了复用文案把 pi-auto 自动路由装进子代理。

## 验证及未解决问题

完成源码、类型定义和相关测试断言的静态交叉核对；未运行测试、真实模型请求或 benchmark，以避免测试缓存、临时会话等额外写入。没有修改任何仓库代码。

**无法判断新文案能将 high 占比降低多少或提高多少成功率**：缺少真实子任务样本、预期分档标注、实际档位分布与结果质量对照。现有模拟测试只能证明提示词及执行契约，不能证明语义分类效果。benchmark 前缀不一致也尚未修复。
