[简体中文](README.zh.md)

# repogate — GitHub Developer Workbench (agent tool set)

`repogate` is a GitHub workbench for coding agents: it wraps the GitHub REST API into a set of MCP (Model Context Protocol) tools, letting agents perform **repo queries, issue management, PR creation and merging, code review, search**, and other common operations directly in a conversation.

- **Zero runtime dependencies**: uses only built-in Node.js capabilities (`fetch`, `node:test`); no packages need to be installed to run;
- **Standard MCP stdio server**: works with any MCP-capable client (dsh, Claude Code, Codex, opencode, etc.);
- **Built for dsh**: ships a dsh bundle (`cordis.patch.yml` + a self-developed bridge plugin), connected with `dsh plugin add` in one step — tools appear automatically in the model's tool list (`mcp__repogate__*`);
- **Dual auth channels**: personal access token (PAT) and OAuth device authorization flow, with local token caching;
- **Read-only mode**: blocks all write operations with one switch, ideal for research-only sessions;
- **Actionable errors**: rate limits, invalid tokens, insufficient permissions, rejected parameters — every error includes a Chinese fix guide;
- **Slim output for models**: lists/search return concise summaries instead of full JSON, saving context tokens.

---

## Quick Start

### Option A: connect directly from any MCP client

```bash
# requires Node.js ≥ 18.17
REPOGATE_TOKEN=ghp_yourtoken node src/entry.js
```

Example config line using the official dsh bridge (also works in Claude Code / Codex MCP configs):

```yaml
# dsh: insert into $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-repogate
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: repogate
        transport: stdio
        command: node
        args: ['/absolute/path/to/src/entry.js']
        env:
          REPOGATE_TOKEN: !!js process.env.REPOGATE_TOKEN ?? ''
```

After connecting, the model sees 23 tools such as `gh_issue_fetch` and `gh_pr_merge`
(generic MCP clients see bare names; under dsh they carry the `mcp__repogate__` prefix, see below).

### Option B: install as a dsh plugin bundle (recommended)

This plugin is declared as a dsh bundle (the `dsh.bundle` field in `package.json`). In the plugin checkout directory run:

```bash
dsh plugin --profile web add .
```

- On first use it initializes the `web` profile automatically and adds this package to `dsh.profile.bundles`;
- The `repogate/bridge` plugin defined in the package's `cordis.patch.yml` launches this MCP server directly inside the dsh process, and after the handshake registers all tools into `ctx.tools` — **no manual config changes needed**;
- The token is inherited from the dsh process environment by default (`REPOGATE_TOKEN` or `GITHUB_TOKEN`);
- Uninstall: `dsh plugin --profile web remove repogate`.

After installing, restart dsh and simply say in a session:

> "Look at the open issues of the octo/hello repo, close #12, then comment 'fixed, waiting for verification' on #12."

The corresponding tool call chain: `mcp__repogate__gh_issue_browse` → `mcp__repogate__gh_issue_fetch` →
`mcp__repogate__gh_issue_edit` → `mcp__repogate__gh_issue_respond`.

> Note: dsh does not enable any MCP server by default (each server command is trusted code executed outside the sandbox);
> this plugin's bundle line is the "enable" action itself; only install trusted plugins.

---

## Installing in DSH

```bash
dsh plugin --profile demo add github:JohnXu22786/github-mcp
```

A single command installs this plugin into the dsh `demo` profile from the GitHub repository. Integration, auth, and lifecycle details follow in the "dsh integration" section below.

---

## dsh Integration (how a plugin-style harness loads it)

dsh uses the Cordis plugin framework; the unit of composition is a **bundle**: an npm package + a patch layer. The loading chain is as follows:

```
package.json (dsh.bundle.patch → ./cordis.patch.yml)
  └─ a line in cordis.patch.yml: name: 'repogate/bridge'
       └─ src/bridge/plugin.js (Cordis plugin, inject: ['tools'])
            ├─ spawns src/entry.js (the MCP server child process, stdio) using Node itself
            ├─ completes the initialize / tools/list handshake
            └─ registers each tool as mcp__repogate__<tool name> into ctx.tools
```

- **Tool interface**: the tool name visible to the model = `mcp__<serverName>__<original tool name>`, `serverName` defaults to `repogate`;
- **Events/skills**: this plugin registers no events or skills; it only exposes capabilities through the `ctx.tools` tool interface;
- **Lifecycle**: handshake and registration happen during the plugin's `apply`; on unload it kills the child process and unregisters all tools automatically
  (cleanup registered via `ctx.effect`, so hot reloads/unloads leave no residue);
- **Two bridges to choose from**: the bundle's built-in bridge `repogate/bridge` (zero dependencies, works out of the box) and
  the official dsh `@deepseek-ai/dsh-mcp-client` config line (see `examples/overlay-for-dsh.yml.example`);
  the tools are named and behave identically — pick either one, do not enable both;
- **Environment variables**: dsh filters credential-type variables from the MCP child process environment, so the official bridge line needs the token written into the
  `env` config; the built-in bridge's child process inherits the host environment, so `REPOGATE_TOKEN` is passed through automatically.

### Common dsh issues

| Symptom | Treatment |
| --- | --- |
| Tools don't appear in the list | Check whether the `cordis.patch.yml` line took effect (`dsh --profile <name> --dump-config` to inspect layers), confirm no errors in the startup log |
| 401 invalid token | Check the `env.REPOGATE_TOKEN` config; or ask the model to call `mcp__repogate__gh_auth_login` in the session to use OAuth |
| Want read-only | Configure `args: ['--read-only']` on the bridge line, or append `--read-only` to the official line's args |
| pnpm ≥10 rejects prepare scripts on git installs | This plugin is pure JS with no build script, so it's not affected; install from checkout or tarball |

---

## Tool List (23 tools)

| Domain | Tool | Purpose | Write op |
| --- | --- | --- | --- |
| Repo | `gh_repo_fetch` | Repo details: default branch, stars, language, visibility | |
| Repo | `gh_repo_browse` | List user/org/own repos (paginated) | |
| Issue | `gh_issue_open` | Create an issue (title required, optional labels/assignee) | ✔ |
| Issue | `gh_issue_fetch` | View full issue info | |
| Issue | `gh_issue_browse` | Filter by state/labels/assignee/author (pages may exclude PRs) | |
| Issue | `gh_issue_edit` | Edit title/body/state/assignee/labels | ✔ |
| Issue | `gh_issue_respond` | Post a comment (works in PR threads too) | ✔ |
| PR | `gh_pr_open` | Create a pull request (head/base/draft) | ✔ |
| PR | `gh_pr_fetch` | PR details: mergeability, changed stats, review count | |
| PR | `gh_pr_browse` | Filter by state/branch, sort, paginate | |
| PR | `gh_pr_edit` | Edit title/body/state/draft/base branch | ✔ |
| PR | `gh_pr_merge` | Merge (method/commit message/delete source branch) | ✔ |
| Review | `gh_review_submit` | Submit a full review: approve / request_changes / comment | ✔ |
| Review | `gh_review_comment` | Line-level diff comments (including range comments) | ✔ |
| Review | `gh_review_fetch` | List all line-level comments | |
| Review | `gh_review_browse` | List submitted full reviews | |
| Search | `gh_search_repos` | Search repos with GitHub search syntax | |
| Search | `gh_search_issues` | Search issues/PRs (`type:pr` distinguishes) | |
| Search | `gh_search_code` | Search code (requires token, returns file hits) | |
| Account | `gh_whoami` | Current identity, token source, read-only mode, API quota | |
| Auth | `gh_auth_login` | Start OAuth device authorization (requires configured clientId) | |
| Auth | `gh_auth_check` | Poll authorization result once | |
| Auth | `gh_auth_logout` | Clear the local token cache | |

All tools take JSON Schema inputs (`name`/`description`/`inputSchema`) that models can discover on their own;
write tools are intercepted with a clear message in read-only mode.

---

## Configuration

Priority: **CLI flags > environment variables > config file > defaults**. The config file is JSON, its path given by `--config`
or `REPOGATE_CONFIG`; see `examples/repogate.config.json.example`.

| Config item | Environment variable | Default |
| --- | --- | --- |
| Access token | `REPOGATE_TOKEN` (also accepts `GITHUB_TOKEN` / `GH_TOKEN`) | none |
| API base URL (enterprise instances) | `REPOGATE_BASE_URL` | `https://api.github.com` |
| Read-only mode | `REPOGATE_READ_ONLY` (`1/true/yes/on`) | `false` |
| Per-request timeout (ms) | `REPOGATE_TIMEOUT_MS` | `30000` |
| OAuth Client ID | `REPOGATE_OAUTH_CLIENT_ID` | none |
| OAuth token cache file | `REPOGATE_TOKEN_FILE` | `~/.repogate/token.json` when `oauth.clientId` is configured |
| Config file path | `REPOGATE_CONFIG` | none |
| Debug logging (stderr) | `REPOGATE_DEBUG` | `false` |

CLI flags: `--config` `--token` `--read-only` `--base-url` `--timeout-ms`
`--oauth-client-id` `--token-file` `--debug` `--version` `--help`.

---

## Authentication

### Personal access token (PAT)

Generate one in GitHub's Developer settings (check the repo permissions needed on a fine-grained token), then choose any of:

```bash
REPOGATE_TOKEN=ghp_xxx node src/entry.js          # environment variable
node src/entry.js --token ghp_xxx                 # CLI flag
node src/entry.js --config repogate.config.json   # config file (token field)
```

Windows PowerShell 下环境变量写法：

```powershell
$env:REPOGATE_TOKEN = 'ghp_xxx'
node src/entry.js
```

Token resolution order: `--token` > `REPOGATE_TOKEN` > `GITHUB_TOKEN` > `GH_TOKEN` > config file > cache file.

### OAuth device authorization (token-free interactive login)

For those who'd rather not assemble a token by hand. You first need a GitHub App's Client ID (the device flow only requires a public client_id):

1. Configure `oauth.clientId` (config file or `REPOGATE_OAUTH_CLIENT_ID`);
2. Ask the model to call `gh_auth_login` → returns an authorization URL and a one-time code;
3. The user opens the URL in a browser, enters the code, and confirms;
4. The model calls `gh_auth_check` (may be called multiple times; each call checks once) → once `granted`, the token is written to the cache file,
   and all tools become available; the cached token survives process restarts;
5. `gh_auth_logout` clears the cache.

> Note: the device authorization endpoint always uses github.com; for enterprise instances (custom `baseUrl`) use a PAT.
> The token cache file is written with 0600 permissions; do not commit the cache file to version control.

---

## Read-only Mode

```bash
node src/entry.js --read-only          # or REPOGATE_READ_ONLY=1
```

When enabled, the 8 write tools (`gh_issue_open` / `gh_issue_edit` / `gh_issue_respond` /
`gh_pr_open` / `gh_pr_edit` / `gh_pr_merge` / `gh_review_submit` / `gh_review_comment`)
are intercepted after argument validation and return a `[readonly]` error explaining how to turn it off; query, search, and auth tools are unaffected.

---

## Error Handling

All failures are returned as structured errors (MCP `isError: true` + `structuredContent.error`) in the form
`[error code] reason`. Common error codes and typical scenarios:

| Error code | Scenario | Guide |
| --- | --- | --- |
| `auth` | Token missing/invalid (401) | Configure a token or use OAuth device authorization |
| `ratelimit` | Quota exhausted (403/429) | Report reset time or Retry-After seconds |
| `http` | 404/403/422/409 etc. | Explain the specific cause (not found/no permission/params rejected/conflict) |
| `validation` | Argument validation failed | Point out which argument is invalid |
| `readonly` | Read-only mode blocks a write | Explain how to disable |
| `timeout` | Request timeout | Suggest increasing `timeoutMs` |
| `network` | Network-layer failure | Check the network and `baseUrl` |

The gateway automatically retries once on 502/503/504 and network jitter (idempotent read requests only; writes are not retried to avoid duplicate side effects);
if a 5xx still fails after retry, it returns an `http` error instead of failing silently.

---

## Architecture and Layout

```
src/
├── entry.js              entry: config parsing → assembly → start the stdio session
├── protocol/             protocol layer (MCP over stdio, line-delimited JSON-RPC 2.0)
│   ├── jsonrpc.js        message encoding/decoding and classification
│   ├── transport.js      stdin/stdout read/write loop (logs go to stderr only)
│   └── engine.js         session engine: initialize / ping / tools/list / tools/call
├── core/                 core layer
│   ├── config.js         layered config merge (flag > env > config file > defaults)
│   ├── auth.js           credential hub: token resolution + OAuth device auth state machine + cache
│   ├── gateway.js        REST gateway: request assembly/retry/timeout/status-code mapping
│   └── errors.js         unified error model with actionable hints
├── tools/                tool layer
│   ├── registry.js       registry: argument validation (JSON Schema subset) + read-only gate + dispatch
│   ├── repo.js / issue.js / pull.js / review.js / search.js / account.js
│   └── index.js          assembles the 23 tools
├── bridge/               dsh integration
│   ├── client.js         MCP stdio client (initialize/list/call, cancellation and timeout)
│   └── plugin.js         Cordis plugin: spawns the server and registers tools into ctx.tools
└── util/format.js        output shaping: entity summaries, pagination detection, URL building

test/                     tests (node:test, zero dependencies)
├── helpers/              fake fetch and a local mock API service
└── *.test.js             protocol/gateway/config/auth/registry/tool/end-to-end (128 test cases)
```

Design highlights:

- **Layered one-way dependencies**: protocol layer → core layer → tool layer; tools don't know protocol details, and the protocol doesn't know API details;
- **On-demand token resolution**: OAuth authorization takes effect after completion without restart (the gateway holds a tokenResolver rather than a static token);
- **One codebase, both ends**: `bridge/client.js` and the server share the same JSON-RPC vocabulary, so handshake and call logic are consistent.

---

## Development and Testing

```bash
node --test          # run all 128 tests (including real child-process end-to-end)
node src/entry.js --help
```

Test coverage: protocol handshake and error paths (including interception of uninitialized sessions), gateway retry (idempotent methods only) and status-code mapping,
the full OAuth state machine (including expiry), config priority, argument validation, the read-only gate, request construction and output shaping for all 23 tools,
and an end-to-end chain of "real child process + local mock API".

## Security Notes

- A token has the same power as the account; do not write it into logs, commit it to version control, or leak it to untrusted conversations;
- Under dsh, MCP server commands are trusted code outside the sandbox; install this plugin only from trusted sources;
- Read-only mode significantly reduces the risk of misuse; research-only sessions are recommended to enable it.

---

## License

[MIT](LICENSE)