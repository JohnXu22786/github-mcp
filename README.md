[English](README.en.md)

# repogate — GitHub 开发者工作台（agent 工具集）

`repogate` 是一个面向编码 agent 的 GitHub 工作台：它把 GitHub REST API 封装成一组
MCP（Model Context Protocol）工具，让 agent 直接在对话中完成**仓库查询、issue 管理、
PR 创建与合并、代码审查、搜索**等常见操作。

- **零运行时依赖**：只用 Node.js 自带能力（`fetch`、`node:test`），无需安装任何包即可运行；
- **标准 MCP stdio server**：任何支持 MCP 的客户端（dsh、Claude Code、Codex、opencode 等）都能接入；
- **为 dsh 而生**：自带 dsh bundle（`cordis.patch.yml` + 自研桥接插件），`dsh plugin add` 一步接入，
  工具自动出现在模型工具列表里（`mcp__repogate__*`）；
- **双认证通道**：个人访问令牌（PAT）与 OAuth 设备授权流程，附令牌本地缓存；
- **只读模式**：一键拦截全部写操作，适合只做调研的会话；
- **错误可执行**：频率限制、令牌失效、权限不足、参数被拒……每条错误都带中文修复指引；
- **输出为模型瘦身**：列表/搜索返回精简摘要而非完整 JSON，节省上下文 token。

---

## 快速开始

### 方式 A：任意 MCP 客户端直接连接

```bash
# 需要 Node.js ≥ 18.17
REPOGATE_TOKEN=ghp_你的令牌 node src/entry.js
```

以 dsh 官方桥接为例的配置行（也适用于 Claude Code / Codex 的 MCP 配置）：

```yaml
# dsh：插入到 $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-repogate
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: repogate
        transport: stdio
        command: node
        args: ['/绝对路径/src/entry.js']
        env:
          REPOGATE_TOKEN: !!js process.env.REPOGATE_TOKEN ?? ''
```

连接后模型即可看到 `gh_issue_fetch`、`gh_pr_merge` 等 23 个工具
（通用 MCP 客户端看到的是裸名；dsh 场景下带 `mcp__repogate__` 前缀，见下）。

### 方式 B：作为 dsh 插件 bundle 安装（推荐）

本插件已声明为 dsh bundle（`package.json` 的 `dsh.bundle` 字段）。在插件 checkout 目录执行：

```bash
dsh plugin --profile web add .
```

- 首次使用会自动初始化 `web` profile，并把本包加入 `dsh.profile.bundles`；
- 包内 `cordis.patch.yml` 定义的 `repogate/bridge` 插件会在 dsh 进程内直接拉起本 MCP server，
  完成握手后把全部工具注册进 `ctx.tools`，**无需手动改任何配置**；
- 令牌默认从 dsh 进程的环境变量继承（`REPOGATE_TOKEN` 或 `GITHUB_TOKEN`）；
- 卸载：`dsh plugin --profile web remove repogate`。

安装后重启 dsh，在会话中即可直接说：

> “看看 octo/hello 仓库的 open issues，把 #12 关掉，然后在 #12 上评论一句‘已修复，等待验证’”

对应工具调用链：`mcp__repogate__gh_issue_browse` → `mcp__repogate__gh_issue_fetch` →
`mcp__repogate__gh_issue_edit` → `mcp__repogate__gh_issue_respond`。

> 备注：dsh 默认不启用任何 MCP 服务器（每条 server 命令都是在沙箱之外执行的受信代码），
> 本插件的 bundle 行即"启用"动作本身；请只安装可信的插件。

---

## 在 DSH 中安装

```bash
dsh plugin --profile demo add github:JohnXu22786/github-mcp
```

一行命令即可从 GitHub 仓库安装本插件到 dsh 的 `demo` profile，之后的接入、认证与生命周期细节见下节「dsh 接入说明」。

---

## dsh 接入说明（插件化 harness 如何加载它）

dsh 使用 Cordis 插件框架，组合单元是 **bundle**：一个 npm 包 + 一份 patch 层。加载链条如下：

```
package.json（dsh.bundle.patch → ./cordis.patch.yml）
  └─ cordis.patch.yml 中的一行：name: 'repogate/bridge'
       └─ src/bridge/plugin.js（Cordis 插件，inject: ['tools']）
            ├─ 用 Node 自身 spawn 出 src/entry.js（MCP server 子进程，stdio）
            ├─ 完成 initialize / tools/list 握手
            └─ 每个工具以 mcp__repogate__<工具名> 注册进 ctx.tools
```

- **工具接口**：模型可见的工具名 = `mcp__<serverName>__<原始工具名>`，`serverName` 默认 `repogate`；
- **事件/技能**：本插件不注册事件或技能，只通过 `ctx.tools` 工具接口暴露能力；
- **生命周期**：插件 `apply` 期间完成握手与注册，卸载时自动杀掉子进程并注销全部工具
  （通过 `ctx.effect` 注册清理，热重载/卸载都不会残留）；
- **两种桥接可选**：bundle 内置的自研桥接 `repogate/bridge`（零依赖、开箱即用）与
  dsh 官方 `@deepseek-ai/dsh-mcp-client` 配置行（见 `examples/overlay-for-dsh.yml.example`），
  工具命名与行为一致，任选其一，不要同时启用；
- **环境变量**：dsh 会从 MCP 子进程环境过滤凭据类变量，因此官方桥接行需要把令牌写进
  `env` 配置；自研桥接的子进程继承宿主环境，`REPOGATE_TOKEN` 会自动透传。

### 常见 dsh 问题

| 现象 | 处理 |
| --- | --- |
| 工具没出现在列表 | 检查 `cordis.patch.yml` 行是否生效（`dsh --profile <name> --dump-config` 看层），确认启动日志无报错 |
| 401 令牌无效 | 检查 `env.REPOGATE_TOKEN` 配置；也可在会话中让模型调用 `mcp__repogate__gh_auth_login` 走 OAuth |
| 想要只读 | bridge 行配置 `args: ['--read-only']`，或官方行给 args 追加 `--read-only` |
| pnpm ≥10 拒绝 git 安装的 prepare 脚本 | 本插件是纯 JS、无构建脚本，不涉及；从 checkout 或 tarball 安装即可 |

---

## 工具清单（23 个）

| 领域 | 工具 | 作用 | 写操作 |
| --- | --- | --- | --- |
| 仓库 | `gh_repo_fetch` | 仓库详情：默认分支、星标、语言、可见性 | |
| 仓库 | `gh_repo_browse` | 列出用户/组织/自己的仓库（分页） | |
| issue | `gh_issue_open` | 创建 issue（标题必填，可带标签/负责人） | ✔ |
| issue | `gh_issue_fetch` | 查看 issue 完整信息 | |
| issue | `gh_issue_browse` | 按状态/标签/负责人/创建者筛选（可排除 PR） | |
| issue | `gh_issue_edit` | 改标题/正文/状态/负责人/标签 | ✔ |
| issue | `gh_issue_respond` | 发表评论（PR 对话区通用） | ✔ |
| PR | `gh_pr_open` | 创建拉取请求（head/base/草稿） | ✔ |
| PR | `gh_pr_fetch` | PR 详情：可合并性、变更统计、审查数 | |
| PR | `gh_pr_browse` | 按状态/分支筛选、排序、分页 | |
| PR | `gh_pr_edit` | 改标题/正文/状态/草稿/目标分支 | ✔ |
| PR | `gh_pr_merge` | 合并（方式/提交信息/删除来源分支） | ✔ |
| 审查 | `gh_review_submit` | 提交整体审查：approve / request_changes / comment | ✔ |
| 审查 | `gh_review_comment` | diff 行级评论（含区间评论） | ✔ |
| 审查 | `gh_review_fetch` | 列出全部行级评论 | |
| 审查 | `gh_review_browse` | 列出已提交的整体审查记录 | |
| 搜索 | `gh_search_repos` | 按 GitHub 搜索语法搜仓库 | |
| 搜索 | `gh_search_issues` | 搜 issue/PR（`type:pr` 区分） | |
| 搜索 | `gh_search_code` | 搜代码（需令牌，返回文件命中） | |
| 账户 | `gh_whoami` | 当前身份、令牌来源、只读模式、API 配额 | |
| 认证 | `gh_auth_login` | 发起 OAuth 设备授权（需配置 clientId） | |
| 认证 | `gh_auth_check` | 轮询一次授权结果 | |
| 认证 | `gh_auth_logout` | 清除本地令牌缓存 | |

所有工具的输入均为 JSON Schema（`name`/`description`/`inputSchema`），模型可自行发现；
变更类工具在只读模式下会被拦截并返回明确提示。

---

## 配置

优先级：**命令行 > 环境变量 > 配置文件 > 默认值**。配置文件为 JSON，路径由 `--config`
或 `REPOGATE_CONFIG` 指定，示例见 `examples/repogate.config.json.example`。

| 配置项 | 环境变量 | 默认值 |
| --- | --- | --- |
| 访问令牌 | `REPOGATE_TOKEN`（兼容 `GITHUB_TOKEN` / `GH_TOKEN`） | 无 |
| API 根地址（支持企业实例） | `REPOGATE_BASE_URL` | `https://api.github.com` |
| 只读模式 | `REPOGATE_READ_ONLY`（`1/true/yes/on`） | `false` |
| 单请求超时（毫秒） | `REPOGATE_TIMEOUT_MS` | `30000` |
| OAuth Client ID | `REPOGATE_OAUTH_CLIENT_ID` | 无 |
| OAuth 令牌缓存文件 | `REPOGATE_TOKEN_FILE` | 配置了 `oauth.clientId` 时默认 `~/.repogate/token.json` |
| 配置文件路径 | `REPOGATE_CONFIG` | 无 |
| 调试日志（stderr） | `REPOGATE_DEBUG` | `false` |

命令行标志：`--config` `--token` `--read-only` `--base-url` `--timeout-ms`
`--oauth-client-id` `--token-file` `--debug` `--version` `--help`。

---

## 认证

### 个人访问令牌（PAT）

在 GitHub 的 Developer settings 生成（fine-grained token 勾选所需仓库权限），然后任选其一：

```bash
REPOGATE_TOKEN=ghp_xxx node src/entry.js          # 环境变量
node src/entry.js --token ghp_xxx                 # 命令行
node src/entry.js --config repogate.config.json   # 配置文件（token 字段）
```

令牌读取顺序：`--token` > `REPOGATE_TOKEN` > `GITHUB_TOKEN` > `GH_TOKEN` > 配置文件 > 缓存文件。

### OAuth 设备授权（免令牌交互登录）

适合不想手搓令牌的场景。需要先有一个 GitHub App 的 Client ID（设备授权流程只需公开的 client_id）：

1. 配置 `oauth.clientId`（配置文件或 `REPOGATE_OAUTH_CLIENT_ID`）；
2. 让模型调用 `gh_auth_login` → 返回授权地址与一次性代码；
3. 用户浏览器打开地址、输入代码并确认；
4. 模型调用 `gh_auth_check`（可多次，每次只查一次）→ 得到 `granted` 后令牌写入缓存文件，
   之后所有工具自动可用；重启进程后缓存令牌依然生效；
5. `gh_auth_logout` 清除缓存。

> 注意：设备授权端点固定使用 github.com；企业实例（自定义 `baseUrl`）请使用 PAT。
> 令牌缓存文件写入时带 0600 权限位；请勿把缓存文件提交进版本库。

---

## 只读模式

```bash
node src/entry.js --read-only          # 或 REPOGATE_READ_ONLY=1
```

开启后，8 个写工具（`gh_issue_open` / `gh_issue_edit` / `gh_issue_respond` /
`gh_pr_open` / `gh_pr_edit` / `gh_pr_merge` / `gh_review_submit` / `gh_review_comment`）
在参数校验之后被拦截，返回 `[readonly]` 错误并说明关闭方式；查询、搜索、认证类工具不受影响。

---

## 错误处理

所有失败都以结构化错误返回（MCP `isError: true` + `structuredContent.error`），格式为
`[错误码] 原因`，常见错误码与典型场景：

| 错误码 | 场景 | 指引 |
| --- | --- | --- |
| `auth` | 令牌缺失/失效（401） | 配置令牌或走 OAuth 设备授权 |
| `ratelimit` | 配额用尽（403/429） | 提示重置时间或 Retry-After 秒数 |
| `http` | 404/403/422/409 等 | 说明具体原因（不存在/无权限/参数被拒/冲突） |
| `validation` | 参数校验失败 | 指明哪个参数不合法 |
| `readonly` | 只读模式拦截写操作 | 说明如何关闭 |
| `timeout` | 请求超时 | 建议调大 `timeoutMs` |
| `network` | 网络层失败 | 检查网络与 `baseUrl` |

网关层对 502/503/504 与网络抖动自动重试一次（仅幂等读请求，写请求不重试以避免副作用重复）；
5xx 重试仍失败会返回 `http` 错误而不是静默失败。

---

## 架构与目录

```
src/
├── entry.js              入口：配置解析 → 装配 → 启动 stdio 会话
├── protocol/             协议层（MCP over stdio，行分隔 JSON-RPC 2.0）
│   ├── jsonrpc.js        消息编解码与分类
│   ├── transport.js      stdin/stdout 读写循环（日志只走 stderr）
│   └── engine.js         会话引擎：initialize / ping / tools/list / tools/call
├── core/                 核心层
│   ├── config.js         配置分层合并（flag > env > 配置文件 > 默认）
│   ├── auth.js           凭据中枢：令牌解析 + OAuth 设备授权状态机 + 缓存
│   ├── gateway.js        REST 网关：请求组装/重试/超时/状态码翻译
│   └── errors.js         统一错误模型与可执行提示
├── tools/                工具层
│   ├── registry.js       注册表：参数校验（JSON Schema 子集）+ 只读门禁 + 分派
│   ├── repo.js / issue.js / pull.js / review.js / search.js / account.js
│   └── index.js          装配 23 个工具
├── bridge/               dsh 接入
│   ├── client.js         MCP stdio 客户端（initialize/list/call，取消与超时）
│   └── plugin.js         Cordis 插件：spawn server 并把工具注册进 ctx.tools
└── util/format.js        输出整形：实体摘要、分页判断、URL 构建

test/                     测试（node:test，零依赖）
├── helpers/              伪造 fetch 与本地 mock API 服务
└── *.test.js             协议/网关/配置/认证/注册表/工具/端到端（121 项测试用例）
```

设计要点：

- **分层单向依赖**：协议层 → 核心层 → 工具层，工具不感知协议细节，协议不感知 API 细节；
- **令牌按需解析**：OAuth 授权落地后无需重启即可生效（网关持有 tokenResolver 而非静态令牌）；
- **同一份代码两头用**：`bridge/client.js` 与 server 共享同一套 JSON-RPC 词表，握手与调用逻辑一致。

---

## 开发与测试

```bash
node --test          # 运行全部 121 项测试（含真实子进程端到端）
node src/entry.js --help
```

测试覆盖：协议握手与错误路径（含未初始化会话拦截）、网关重试（仅幂等方法）与状态码翻译、
OAuth 状态机全路径（含过期）、配置优先级、参数校验、只读门禁、全部 23 个工具的请求构造
与输出整形、以及“真实子进程 + 本地 mock API”的端到端链路。

## 安全提示

- 令牌等同账号权限，请勿写入日志、提交版本库或泄露给不可信对话；
- dsh 场景下，MCP server 命令属于沙箱之外的受信代码，请从可信来源安装本插件；
- 只读模式可显著降低误操作风险，仅供调研的会话建议开启。

---

## 许可

[MIT](LICENSE)

