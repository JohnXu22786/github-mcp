#!/usr/bin/env node
/**
 * 入口：解析配置 → 装配服务 → 启动 stdio MCP 会话。
 * 可作为独立 MCP server 被任意客户端加载（命令：node src/entry.js）。
 */
import { loadConfig } from './core/config.js'
import { CredentialHub } from './core/auth.js'
import { Gateway } from './core/gateway.js'
import { McpEngine } from './protocol/engine.js'
import { StdioLoop } from './protocol/transport.js'
import { buildRegistry } from './tools/index.js'
import { NAME, VERSION } from './core/version.js'

const HELP = `${NAME} v${VERSION} —— GitHub 开发者工作台（MCP stdio server）

用法：
  node src/entry.js [选项]

选项：
  --config <path>        配置文件（JSON，键见 README）
  --token <value>        访问令牌（覆盖环境变量与配置文件）
  --read-only            只读模式：拦截全部写操作
  --base-url <url>       API 根地址（默认 https://api.github.com）
  --timeout-ms <ms>      单请求超时（1–600000，默认 30000）
  --oauth-client-id <id> GitHub App Client ID（启用设备授权）
  --token-file <path>    OAuth 令牌缓存文件路径
  --debug                输出调试日志（stderr）
  --version              打印版本
  --help                 打印本帮助

环境变量：REPOGATE_TOKEN（兼容 GITHUB_TOKEN / GH_TOKEN）、
REPOGATE_READ_ONLY、REPOGATE_BASE_URL、REPOGATE_TIMEOUT_MS、
REPOGATE_OAUTH_CLIENT_ID、REPOGATE_TOKEN_FILE、REPOGATE_CONFIG、REPOGATE_DEBUG。

协议：stdin/stdout 上的行分隔 JSON-RPC 2.0（MCP）。日志只写 stderr。
`

function main() {
  const argv = process.argv.slice(2)
  let config
  try {
    config = loadConfig(argv)
  } catch (err) {
    process.stderr.write(`[${NAME}] 配置错误：${err.message}\n`)
    process.exit(2)
  }
  if (config.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (config.version) {
    process.stdout.write(`${NAME} ${VERSION}\n`)
    process.exit(0)
  }

  const log = (...parts) => {
    if (config.debug) process.stderr.write(`[${NAME}] ${parts.join(' ')}\n`)
  }

  const auth = new CredentialHub({
    token: config.token,
    oauthClientId: config.oauthClientId,
    tokenFile: config.tokenFile,
    log,
  })
  const gateway = new Gateway({
    baseUrl: config.baseUrl,
    tokenResolver: () => auth.resolveToken(),
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent,
    log,
  })
  const services = { auth, config, gateway, version: { name: NAME, version: VERSION } }
  const registry = buildRegistry(services)
  const engine = new McpEngine({
    registry,
    services,
    serverInfo: { name: NAME, version: VERSION },
    log,
  })

  process.stderr.write(`[${NAME}] v${VERSION} 已启动（只读=${config.readOnly}，令牌=${config.tokenSource}，API=${config.baseUrl}，工具=${registry.list().length} 个）\n`)
  process.on('SIGTERM', () => process.exit(0))
  process.on('SIGINT', () => process.exit(0))
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[${NAME}] 未捕获异常，进程退出：${err?.stack ?? err}\n`)
    process.exit(1)
  })
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[${NAME}] 未处理的 Promise 拒绝：${err?.stack ?? err}\n`)
  })
  // 客户端断开后 stdout 管道消失：安静退出，避免 EPIPE 刷屏
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0)
  })
  process.stderr.on('error', () => { /* 忽略 stderr 管道错误 */ })

  const loop = new StdioLoop({ handle: (msg) => engine.handle(msg), log })
  loop.start()
}

main()
