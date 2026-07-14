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
| 验证 notable | 3 | I2 屏障说法错、B1 漏 flag、G1 只写不读 |

## ultracode 模式实际做什么

- **thinking**:主 agent 请求 `max`,Pi SDK 按模型 clamp；旧版 Pi 不识别 `max` 时兼容回退到 `xhigh`(`mode.ts` `applyUltracodeThinking`)。
- **workflow 工具**:始终在 active 列表(`extensions/ultracode.ts` `session_start`,即使 ultracode 关也按需可用)。
- **standing prompt block**:开启时每轮注入(`mode.ts` `beforeAgentStart` → `prompts.ts` `ultracodeSystemBlock`),把默认倾向调到"substantive task 默认用 workflow",但明文给跳过条件(对话轮 / 琐碎机械改动)。
- **触发方式 = 按需,不是必定触发**。没有任何 hook 强制调用 workflow;`tool_choice` 无法强制(Pi SDK 不暴露,见 D2)。模型有最终决定权。

## 已修复(`f6e8a42`)

| 项 | 修复内容 | 证据 |
|---|---|---|
| **H1** | worktree 3-way 冲突丢数据。`applyPatch` 快照 pre-apply 字节、失败时 revert(清 UU/AA + 还原内容);`captureWorktreeDiff` 用 `--binary` + 不 trim 的 reader;冲突时先写 rescue patch 再删 worktree,rescue 写失败则保留 worktree;`integrateWorktree` 外层 try/catch 永不抛(任一异常 → `keep=true`)。 | `src/workflow/worktree.ts:126-128,140,185-192`;`src/workflow/runtime.ts:390-394,425,432,441-447,284-286` |
| **C1** | `:level`/空 pattern 静默切模型。bare `:level` 保留默认模型(只覆盖 thinking);空/空白 pattern 被拒(不再静默匹配第一个注册模型);`splitThinkingSuffix` 处理 `sonnet:` 尾冒号。 | `src/workflow/agent-runner.ts:197,206,242-244` |
| **G1** | `scriptHash` 用真实内容哈希(`hashString`,djb2-xor),不再是 `String(script.length)`。 | `src/workflow/tool.ts:118`;`src/workflow/journal.ts:46-50` |
| **A2** | 删除死掉的 `WorkflowToolDeps.notify`;改用 `ctx.ui?.notify`(完成 + 错误/中止两路)。 | `src/workflow/tool.ts:58-72,204-206,241-243` |
| **I2** | 补 guideline:no-schema `agent()` 返回子 agent 最后一段 assistant 文本。 | `src/prompts.ts:71` |
| **commands 类型** | `commands.ts` 的 warn 级 notify 用 `"warning"`(非 `"warn"`,修正类型错误)。 | `src/commands.ts:112` |
| **effort 转发** | 子 agent 继承 ultracode effort。最初在 `f6e8a42` 转发原始 `xhigh`;当前模式转发原始 `max`,runner 再按各子模型的 `thinkingLevelMap` 选择 `max` 或兼容 `xhigh`,由 Pi 最终 clamp。优先级仍为 per-call `model:"X:level"` > agentType `thinking:` > ultracode 默认。 | `src/mode.ts` `getSubagentThinkingLevel`;`src/workflow/agent-runner.ts` `resolveSessionThinkingLevel`;`src/workflow/tool.ts` `getThinkingLevel` |

## 判定不改(设计取舍 / SDK 限制)

| 项 | 实际行为(代码确认) | 不改的理由 |
|---|---|---|
| **F4** | 确定性设计真实且刻意:AST 静态校验禁止 `Date.now()`/`new Date()`；`durationMs` 由 host 在 workflow 返回后盖戳(`runtime.ts:89,105`)。VM 仅是 cooperative guardrail，并非硬隔离边界。`Math` 已换成 `createDeterministicMath` shim——保留 `max/min/floor/PI/E/...`，但直接调用 `Math.random()` 会在运行时抛错；host-realm `.constructor` 仍可能逃逸，已文档化。`Date.now()` 是 epoch ms、**TZ 无关**，所谓“TZ 不确定性”并不存在。 | 确定性是刻意设计。`Math.random` 的 runtime gap 已用 shim 补(cooperative);硬隔离不在范围(文档已说明)。 |
| **D2** | 子 agent **无重试**:`run()` 单次 `createAgentSession→prompt→return`;失败分支 `catch → log → return null`(`runtime.ts:280-282,314-315,341-342`)。全仓 `rg tool_choice|toolChoice` **无匹配**。 | 重试是设计选择(确定性 null-on-failure,可组合);`tool_choice` 是 Pi SDK 限制(`createAgentSession` 选项未暴露),pi-ultracode 无法单方面补。 |
| **J2** | mode 持久化用 `pi.appendEntry`(`mode.ts:165`),append-only;`restore()` 扫所有 entry 取最新匹配(`mode.ts`)。全仓无 trim/compaction 调用(workflow journal 的 `appendFileSync` 同样 append-only,`create()` 只截断同 runId 的陈旧文件)。 | SDK `appendEntry` 只追加、无 trim API;compaction 是 pi 层职责。 |
| **D3** | structured-output 走"公共子集转换 + `Type.Unsafe` 兜底":识别的子集正常转换,未识别的关键字用 `Type.Unsafe` 保留**原始 schema** 给模型(不丢不崩)。 | 刻意保留全 schema 给模型(非"公共子集"),文件头已说明(`json-schema.ts:5-8`)。 |

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
| **F4 Math.random gap** | sandbox 的 `Math` 换成 `createDeterministicMath` shim:保留 `max/min/floor/PI/E/...` 但命名 `Math.random()` 运行时抛错。**cooperative**(Node vm 非隔离边界,host-realm `.constructor` 可逃逸——已文档化)。 | `src/workflow/runtime.ts` `createDeterministicMath` |

## effort-level 对齐（当前）

- **主 agent**:请求 `setThinkingLevel("max")`;Pi 按主模型 clamp。若旧版 Pi 将未知 `max` 降错,再请求 `xhigh` 保留旧行为。
- **模型 / effort / session 生命周期**:Ultracode 开启期间切换模型会重新请求 `max`;手动降低 effort 也会立即重新请求 `max`，每轮 provider 调用前还有最终屏障。模式自身产生的事件与过期事件会被忽略,避免递归。由于 Pi 的 setter 同时写全局默认值，扩展会尽力保存并回写语义等价的全局 preference（原本缺省时会显式写为 `medium`）；旧版 active entry 若只有 `previousThinking` 且全局仍是旧实现写入的 `xhigh`，会用该快照迁移回原 baseline。`session_shutdown` 先进入 quiescing 再恢复开启前的有效 effort，但不改持久化 mode 状态，因此 reload/resume/fork replacement 与 `/tree` 导航都会按当前 branch 的 session 记录重新恢复。若中间模型只能表示 `xhigh`，原始待恢复的 `max` 不会被过早消费。Pi 尚无 session-only setter，hard kill、自定义 SDK agentDir 或另一份 live settings cache 仍属于上游 API 限制。
- **workflow 子 agent**:模式转发**原始 `"max"`**;runner 根据各子模型是否公开非空 `thinkingLevelMap.max` 选择 `max` 或 `xhigh`,再交给 `createAgentSession` clamp。模型未知时先传 `max`，当前 Pi 的正常模型 clamp 不重建；pre-max Pi 或已宣告支持 `max` 却未接受的 runtime 才会销毁尚未运行的内存 session 并以 `xhigh` 重建,避免修改用户全局默认 effort。初始化、异步 preflight 与流式执行都响应取消；运行器等待 `abort()` 后再释放会话，且 cleanup 错误不覆盖原始失败。
- **状态**:显示真实 clamp 后的 level（`off|minimal|low|medium|high|xhigh|max`），格式为 `ultracode: on · <level>`，可再追加 budget（不额外写 `thinking`）。
- **ultracode 关时**:`getSubagentThinkingLevel()` = `undefined` → 子 agent 回落 session 默认;主 agent 恢复开启前的 effort。
- **显式配置**:`model:"X:max"` 与 agent frontmatter `thinking: max` 均受支持。优先级仍为 per-call `model:"X:level"` > agentType `thinking:` > ultracode 默认。

## 验证 notable(解释为何 6 项"部分准确")

| 项 | 验证结论 | 证据 |
|---|---|---|
| **I2 屏障说法错** | 原分析对 pipeline/parallel 的"屏障"说法与事实相反。实际:`pipeline` = **无**屏障(item 各自跑 stage,A 可在 stage 3 而 B 在 stage 1);`parallel` = 屏障(等所有 thunk)。guideline 描述准确。 | `src/workflow/runtime.ts:321-338`(pipeline 无屏障)、`:297-313`(parallel 屏障);`src/prompts.ts:67` |
| **B1 漏 flag** | 原分析漏了 `--ultracode` CLI flag。`extensions/ultracode.ts` 注册了布尔 flag,`session_start` 在 flag 为 true 时启用 mode。 | `extensions/ultracode.ts:28-31,40-41` |
| **G1 只写不读** | `scriptHash` 写进 run record 但**从不读回**——`loadPrior()` 只索引 `agent` 记录,run-meta(含 scriptHash)解析后丢弃。故 length-vs-hash 的 bug **零功能影响**。 | 写:`src/workflow/tool.ts:118`;读路径:`src/workflow/journal.ts:119-130`(只索引 agent 记录) |

---

**C1/D2/D3 行为比原分析描述的更差**:验证会话判定这三项实际 pi 侧行为比 A1–J3 写的差距更大(C1 静默切模型更严重、D2 既无重试又无 tool_choice、D3 兜底细节不同),故归为"部分准确"。

*本文为活文档,随修复推进更新；历史验证条目仍以 `f6e8a42` 为基线，标注“当前”的章节以现行源码为准。*
