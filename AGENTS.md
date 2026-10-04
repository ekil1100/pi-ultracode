# AGENTS.md

## 代码规范

- 使用函数式范式。
- 不使用 try-catch。
- 使用 Effect TS 统一管理异步流程、类型化错误、依赖注入和资源生命周期。
- 使用 Effect 的链式组合：独立任务用 Effect.all，依赖步骤用 pipe 和组合函数，纯计算用普通函数；禁止使用 yield，复杂流程按职责拆分，避免深层嵌套。

## 发布

发布 npm 包使用 GitHub Actions。执行发布前读取 `.github/workflows/publish-npm.yml`，按其中的触发方式、版本校验和输入参数发起发布；本地无需 npm 登录或验证码。以 Action 成功且 npm 可查询到目标版本为完成条件。
