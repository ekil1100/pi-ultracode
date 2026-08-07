# pi-ultracode ↔ Claude Code "ultracode" 对齐状态

> **快照起点**:commit `f6e8a42`。本文由 A1–J3 diff 分析的验证会话结论重构,并持续同步当前源码；后续 `max` effort 升级也记录在本文中。
>
> **范围说明**:原始 A1–J3 分析文档(23 项)**未落盘**,故本文不是原文复刻,而是"验证结论 + 当前代码状态"的固化。验证会话的元统计(17/23 完全准确、6 部分准确、pi 侧 0 完全错)来自会话记录,无法从代码反推;下方逐项只覆盖会话中留有记录的 notable 项。

## TL;DR

| 类别 | 数量 | 说明 |
|---|---|---|
| 已修复 | 7 | H1、C1、G1、A2、I2、commands 类型、effort 转发(均在 `f6e8a42`) |
| 判定不改 | 4 | F4、D2、J2、D3(设计取舍或 Pi SDK 限制) |
| 非阻塞 nit | 3 剩余 | tmp 碰撞 + worktree GC 已修(本轮);剩 patchedFiles 过捕获、integrateWorktree 故障安全泄漏、C-quoted 路径 |
| 验证 notable | 3 | I2 屏障说法错、B1 漏 flag、G1 script identity（现已强制校验） |

## ultracode 模式实际做什么

- **thinking**:主 agent 请求 `max`,Pi SDK 按模型 clamp；旧版 Pi 不识别 `max` 时兼容回退到 `xhigh`(`mode.ts` `applyUltracodeThinking`)。
- **workflow 工具**:扩展加载时完成注册，并在 input preflight 与 `before_agent_start` 边界按 ultracode 状态校准 active tools；关闭、暂停或导航到未开启的 session branch 时会请求移除它，同时保留其他 active tools。禁用态即使被其他 active-tool writer 重新暴露，`tool_call` 与实际执行入口也会双重 fail-closed 拒绝执行。当前 workflow 使用 Grok Build 式结构控制：`maxAgents` 默认 128、上限 1024，并跨 immutable resume 累计 live admissions；cache replay 免费；同一进程内每个 session/runsDir 最多 4 个活动顶层 workflow。与 Pi/Grok Build 一致，session 是单进程 owner 模型，不支持多进程并发写同一 session。
- **standing prompt block**:开启时每轮注入(`mode.ts` `beforeAgentStart` → `prompts.ts` `ultracodeSystemBlock`),把默认倾向调到"substantive task 默认用 workflow",但明文给跳过条件(对话轮 / 琐碎机械改动)。
- **触发方式 = 开启后按需,不是必定触发**。ultracode 关闭时模型不可调用未激活的 workflow；开启后没有任何 hook 强制调用它，且 `tool_choice` 无法强制(Pi SDK 不暴露,见 D2)，模型仍有最终决定权。

## 已修复(`f6e8a42`)

| 项 | 修复内容 | 证据 |
|---|---|---|
| **H1** | worktree 3-way 冲突丢数据。`applyPatch` 快照 pre-apply 字节、失败时 revert(清 UU/AA + 还原内容);`captureWorktreeDiff` 用 `--binary` + 不 trim 的 reader;冲突时先写 rescue patch 再删 worktree,rescue 写失败则保留 worktree;`integrateWorktree` 外层 try/catch 永不抛(任一异常 → `keep=true`)。 | `src/workflow/worktree.ts:126-128,140,185-192`;`src/workflow/runtime.ts:390-394,425,432,441-447,284-286` |
| **C1** | `:level`/空 pattern 静默切模型。bare `:level` 保留默认模型(只覆盖 thinking);空/空白 pattern 被拒(不再静默匹配第一个注册模型);`splitThinkingSuffix` 处理 `sonnet:` 尾冒号。 | `src/workflow/agent-runner.ts:197,206,242-244` |
| **G1** | `scriptHash` 使用 SHA-256 真实内容哈希，不再是 `String(script.length)`。 | `src/workflow/tool.ts`;`src/workflow/journal.ts` |
| **A2** | 删除死掉的 `WorkflowToolDeps.notify`;改用 `ctx.ui?.notify`(完成 + 错误/中止两路)。 | `src/workflow/tool.ts:58-72,204-206,241-243` |
| **I2** | 补 guideline:no-schema `agent()` 返回子 agent 最后一段 assistant 文本。 | `src/prompts.ts:71` |
| **commands 类型** | `commands.ts` 的 warn 级 notify 用 `"warning"`(非 `"warn"`,修正类型错误)。 | `src/commands.ts:112` |
| **effort 转发** | 子 agent 继承 ultracode effort。最初在 `f6e8a42` 转发原始 `xhigh`;当前模式转发原始 `max`,runner 再按各子模型的 `thinkingLevelMap` 选择 `max` 或兼容 `xhigh`,由 Pi 最终 clamp。优先级仍为 per-call `model:"X:level"` > agentType `thinking:` > ultracode 默认。 | `src/mode.ts` `getSubagentThinkingLevel`;`src/workflow/agent-runner.ts` `resolveSessionThinkingLevel`;`src/workflow/tool.ts` `getThinkingLevel` |

## 判定不改(设计取舍 / SDK 限制)

| 项 | 实际行为(代码确认) | 不改的理由 |
|---|---|---|
| **F4** | 确定性设计真实且刻意：AST 静态校验禁止 `Date.now()`/`new Date()`；Worker 使用 context-realm bridge、禁用 string/Wasm code generation，不向脚本暴露 host-realm 函数构造器或二进制内存构造器，`Math.random()` 抛错。loop/function checkpoint、10,000 host-call fuel、AST 结构限制（含 promise chain/combinator 与动态 method call 禁令）、128 MiB old-generation heap、同步 stall 与无 RPC idle-progress watchdog共同保证 liveness；取消后的 host drain 最多 25 秒。 | JS 实现追求与 Grok 相同的有界执行目标，不宣称等价于 Rhai 的逐 operation fuel；Node vm 仍不作为安全沙箱。 |
| **D2** | 子 agent **无重试**:`run()` 单次 `createAgentSession→prompt→return`;失败分支 `catch → log → return null`(`runtime.ts:280-282,314-315,341-342`)。全仓 `rg tool_choice|toolChoice` **无匹配**。 | 重试是设计选择(确定性 null-on-failure,可组合);`tool_choice` 是 Pi SDK 限制(`createAgentSession` 选项未暴露),pi-ultracode 无法单方面补。 |
| **J2** | mode 持久化用 `pi.appendEntry`,append-only；`restore()` 扫当前 branch entry 取最新匹配。workflow journal 是 64 MiB 有界 append-only ledger；新 run 用 exclusive create，resume 校验 immutable script/args，只会截断崩溃留下的 EOF torn record，不复用其他陈旧内容。同一进程的 run 排他由 lease 负责。 | SDK `appendEntry` 只追加、无 trim API；mode compaction 是 Pi 层职责。与 Pi/Grok Build 相同，session 使用单进程 owner 模型。 |
| **D3** | structured-output 走显式有界子集转换：schema ≤256 KiB/64 层，每个 agent/workflow output ≤2 MiB；args/schema/output 必须是严格 plain-JSON tree。仅接受已实现的类型、object/array、enum/const、anyOf/allOf、长度/数值约束和注解；未知关键字 fail closed，不再用 `Type.Unsafe` 静默保留。 | JavaScript regex validation 没有 Grok DFA engine 的可靠执行上限，因此 `$ref` 家族、`oneOf`、`format` 和 regex 关键字直接禁用。 |

## 非阻塞 nit(3 剩余;tmp 碰撞 + worktree GC 已在本轮修复)

| 项 | 现状 | 证据 |
|---|---|---|
| **patchedFiles 过捕获** | parser 对 patch **每一行**跑 header 形态的正则,内容行以 `++ b/` 或 `-- a/` 开头会被误当路径。(影响低:仅用于 pre-apply 快照,null 条目 revert 时忽略。) | `src/workflow/worktree.ts:155-176` |
| **integrateWorktree 故障安全泄漏** | 外层 try/catch 任一异常 → `keep=true`,**包括成功路径上 `onLog`/`onUpdate` 抛错**——非数据丢失的异常也会保留 worktree。 | `src/workflow/runtime.ts:389-447`(外层 catch `:439-447`) |
| **C-quoted 路径未处理** | `core.quotepath=false` 只覆盖 unicode(>0x80)引号;含 tab/反斜杠/内嵌双引号的 C-quoted 路径仍被引号包裹,`patchedFiles` 用裸 `(.+)` 捕获、不解引号 → 快照/还原命错文件名。 | `src/workflow/worktree.ts:92-97,155-176` |
| **保留 worktree 无 GC** | ~~已修:见下“本轮新修”~~ | — |
| **tmp 文件名碰撞** | ~~已修:见下“本轮新修”~~ | — |

## 本轮新修(nit 收尾,对抗性 review 后)

| 项 | 修复 | 证据 |
|---|---|---|
| **tmp 文件名碰撞** | `patchTmpPath()` 用 `crypto.randomBytes(8)`(realm 无关),跨调用/毫秒/进程/worker thread 都不撞;JSDoc 不再过度声称 worker 安全。 | `src/workflow/worktree.ts` `patchTmpPath` |
| **保留 worktree 无 GC** | `reapStaleWorktrees`:扫 tmpdir,`ultracode-wt-*` 目录 + `ultracode-patch-*` 文件超 24h 才清;tracked 用 `git worktree remove`+branch -D,untracked 用 rmSync;`git worktree list` 失败时 bail-safe;同 24h 阈值保证 cross-repo in-flight/kept worktree 与同仓一样存活。 | `src/workflow/worktree.ts` `reapStaleWorktrees` |
| **F4 Math.random gap + liveness** | sandbox 的 `Math` 换成 deterministic shim:保留常用成员但命名 `Math.random()` 运行时抛错。Worker 使用 AST/checkpoint/host-call/idle/stall 多层限制，父线程可 terminate，并对取消 drain 设置 deadline。**cooperative/liveness only**，不声称安全沙箱或 Rhai operation-level 等价。 | `src/workflow/parser.ts`;`src/workflow/script-executor.ts`;`src/workflow/script-worker.mjs`;`src/workflow/runtime.ts` |

## effort-level 对齐（当前）

- **主 agent**:请求 `setThinkingLevel("max")`;Pi 按主模型 clamp。若旧版 Pi 将未知 `max` 降错,再请求 `xhigh` 保留旧行为。
- **模型 / effort / session 生命周期**:Ultracode 开启期间切换模型会重新请求 `max`;手动降低 effort 也会立即重新请求 `max`，每轮 provider 调用前还有最终屏障。模式自身产生的事件与过期事件会被忽略,避免递归。由于 Pi 的 setter 同时写全局默认值，扩展会尽力保存并回写语义等价的全局 preference（原本缺省时会显式写为 `medium`）；旧版 active entry 若只有 `previousThinking` 且全局仍是旧实现写入的 `xhigh`，会用该快照迁移回原 baseline。`session_shutdown` 先进入 quiescing 再恢复开启前的有效 effort，但不改持久化 mode 状态，因此 reload/resume/fork replacement 与 `/tree` 导航都会按当前 branch 的 session 记录重新恢复。若中间模型只能表示 `xhigh`，原始待恢复的 `max` 不会被过早消费。Pi 尚无 session-only setter，hard kill、自定义 SDK agentDir 或另一份 live settings cache 仍属于上游 API 限制。
- **workflow 子 agent**:模式转发**原始 `"max"`**;runner 根据各子模型是否公开非空 `thinkingLevelMap.max` 选择 `max` 或 `xhigh`,再交给 `createAgentSession` clamp。模型未知时先传 `max`，当前 Pi 的正常模型 clamp 不重建；pre-max Pi 或已宣告支持 `max` 却未接受的 runtime 才会销毁尚未运行的内存 session 并以 `xhigh` 重建,避免修改用户全局默认 effort。初始化、异步 preflight 与流式执行都响应取消；运行器等待 `abort()` 后再释放会话，且 cleanup 错误不覆盖原始失败。
- **状态**:显示真实 clamp 后的 level（`off|minimal|low|medium|high|xhigh|max`），格式为 `ultracode: on · <level>`（不额外写 `thinking`）。
- **ultracode 关时**:`workflow` 不在 active tools；`getSubagentThinkingLevel()` = `undefined`，主 agent 恢复开启前的 effort。
- **显式配置**:`model:"X:max"` 与 agent frontmatter `thinking: max` 均受支持。优先级仍为 per-call `model:"X:level"` > agentType `thinking:` > ultracode 默认。

## 验证 notable(解释为何 6 项"部分准确")

| 项 | 验证结论 | 证据 |
|---|---|---|
| **I2 屏障说法错** | 原分析对 pipeline/parallel 的"屏障"说法与事实相反。实际:`pipeline` = **无**屏障(item 各自跑 stage,A 可在 stage 3 而 B 在 stage 1);`parallel` = 屏障(等所有 thunk)且现在整批预留 agent slots。guideline 描述准确。 | `src/workflow/script-worker.mjs`(pipeline/parallel);`src/prompts.ts` |
| **B1 漏 flag** | 原分析漏了 `--ultracode` CLI flag。`extensions/ultracode.ts` 注册了布尔 flag,`session_start` 在 flag 为 true 时启用 mode。 | `extensions/ultracode.ts:28-31,40-41` |
| **G1 script identity** | `scriptHash` 现使用 SHA-256 写入唯一 run header，并在每次 resume 强制读回校验；args 与每个 nested workflow callPath 的 source hash 同样 immutable。 | `src/workflow/journal.ts` `RunJournal.resume`/`recordNestedSource`;`src/workflow/runtime.ts` `loadWorkflow` |

---

**C1/D2/D3 行为比原分析描述的更差**:验证会话判定这三项实际 pi 侧行为比 A1–J3 写的差距更大(C1 静默切模型更严重、D2 既无重试又无 tool_choice、D3 兜底细节不同),故归为"部分准确"。

*本文为活文档,随修复推进更新；历史验证条目仍以 `f6e8a42` 为基线，标注“当前”的章节以现行源码为准。*
