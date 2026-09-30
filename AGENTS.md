# 仓库约定

## 发布

发布 npm 包使用 GitHub Actions。执行发布前读取 `.github/workflows/publish-npm.yml`，按其中的触发方式、版本校验和输入参数发起发布；本地无需 npm 登录或验证码。以 Action 成功且 npm 可查询到目标版本为完成条件。
