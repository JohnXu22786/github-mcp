# Changelog

本文件记录 repogate 的功能与修复变更。版本号与 `package.json` / `src/core/version.js` 保持一致。

## [1.0.1] - 2026-08-17

### Fixed

- `auth`：OAuth 设备授权轮询遇到 `slow_down` 时合并写入缓存，
  不再覆盖已就绪的授权令牌（与 `startDeviceFlow` 的合并语义保持一致）。
- `search`：未显式指定 `sort`（或为 `best-match`）时不再下发 `order`，
  避免 GitHub 搜索 API 拒绝该组合参数。
- `search`：不支持排序的端点（代码搜索）不再对外承诺 `order`/`sort` 参数，
  与执行行为保持一致。
- `registry`：可选参数为 `null` 时视为未提供（MCP 客户端常将缺省可选参数
  序列化为 `null`），不再被类型校验误拦截。
- `version`：版本号统一为 `1.0.1`（package.json / version.js / manifest /
  bridge 客户端一致），`User-Agent` 改为引用单一版本来源，避免三处漂移。

### Tests

- 新增 `slow_down` 保留已授权令牌的回归测试。
- 新增搜索工具缺省 `sort` 时剔除 `order` 的断言。
- 新增 CLI 参数缺值、空值与布尔参数冗余取值的边界测试。
- 新增可选参数为 `null` 时校验放行的回归测试。
- 新增搜索工具 schema 与端点能力一致的断言（代码搜索无 `sort`/`order`）。

### Misc

- `.gitignore` 补充 `.env`、`*.log`、`.repogate/`（令牌缓存）等本地文件。
- README 补充 Windows PowerShell 下环境变量写令牌的示例。
- README 测试数量同步为 128。

## [1.0.0] - 2026-08-16

- 初始发布：面向 agent 的 GitHub 工作台 MCP stdio server。
- 仓库 / issue / PR / 代码审查 / 搜索 / 账户 / OAuth 设备授权，共 23 个工具。
- 零运行时依赖；以 dsh bundle（`cordis.patch.yml` + `repogate/bridge`）形式集成。
