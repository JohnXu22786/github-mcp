/**
 * 配置分层加载：命令行标志 > 环境变量 > 配置文件 > 默认值。
 * 配置文件为 JSON（路径由 --config 或 REPOGATE_CONFIG 指定）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { RepogateError, ErrorCodes } from './errors.js'
import { VERSION } from './version.js'

const DEFAULT_BASE_URL = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 30000

const VALUE_FLAGS = new Set([
  'config',
  'token',
  'base-url',
  'timeout-ms',
  'oauth-client-id',
  'token-file',
])

const BOOL_FLAGS = new Set(['read-only', 'debug', 'version', 'help'])

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

/**
 * 解析命令行参数，支持 `--flag value` 与 `--flag=value` 两种写法。
 * 返回 flag 名 → 值的映射。
 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (VALUE_FLAGS.has(name)) {
      let value = eq === -1 ? undefined : arg.slice(eq + 1)
      if (value === undefined) {
        i += 1
        value = argv[i]
      }
      if (value === undefined || value === '') {
        throw new RepogateError(`参数 --${name} 缺少取值`, { code: ErrorCodes.CONFIG })
      }
      flags[name] = value
    } else if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) {
        throw new RepogateError(`参数 --${name} 不接受取值`, { code: ErrorCodes.CONFIG })
      }
      flags[name] = true
    } else {
      throw new RepogateError(`不支持的参数：--${name}`, { code: ErrorCodes.CONFIG })
    }
  }
  if (positional.length > 0) {
    throw new RepogateError(`不支持的参数：${positional.join(' ')}`, { code: ErrorCodes.CONFIG })
  }
  return flags
}

function readConfigFile(path) {
  if (!path) return {}
  if (!existsSync(path)) {
    throw new RepogateError(`配置文件不存在：${path}`, { code: ErrorCodes.CONFIG })
  }
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new RepogateError(`无法读取配置文件 ${path}：${err.message}`, { code: ErrorCodes.CONFIG })
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('顶层必须是对象')
    }
    return parsed
  } catch (err) {
    throw new RepogateError(`配置文件 ${path} 不是合法的 JSON 对象：${err.message}`, { code: ErrorCodes.CONFIG })
  }
}

/**
 * 加载并合并配置。argv 不含 node/脚本自身。
 * env 仅用于读取 REPOGATE_* 与兼容的环境变量（便于测试注入）。
 */
export function loadConfig(argv, env) {
  const flags = parseArgs(argv ?? [])
  const envMap = env ?? process.env

  // 帮助/版本优先于配置文件读取：配置损坏时仍能自救
  if (flags.version) return { version: true, help: false }
  if (flags.help) return { help: true, version: false }

  const file = readConfigFile(flags.config ?? envMap.REPOGATE_CONFIG)

  // 用 || 链而非 ?? 链：空字符串视为未设置，继续回退
  const envToken = envMap.REPOGATE_TOKEN || envMap.GITHUB_TOKEN || envMap.GH_TOKEN
  const token = flags.token ?? envToken ?? file.token ?? null

  const baseUrl = String(
    flags['base-url'] ?? envMap.REPOGATE_BASE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL,
  ).replace(/\/+$/, '')

  const rawTimeout = flags['timeout-ms'] ?? envMap.REPOGATE_TIMEOUT_MS ?? file.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = Number(rawTimeout)
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new RepogateError(
      `超时值非法：${rawTimeout}（应为 1–600000 毫秒的整数）`,
      { code: ErrorCodes.CONFIG },
    )
  }

  const readOnly = flags['read-only'] ?? (envMap.REPOGATE_READ_ONLY !== undefined
    ? parseBool(envMap.REPOGATE_READ_ONLY)
    : (file.readOnly ?? false))

  const oauthClientId = flags['oauth-client-id'] ?? envMap.REPOGATE_OAUTH_CLIENT_ID ?? file.oauth?.clientId ?? null
  const tokenFile = flags['token-file'] ?? envMap.REPOGATE_TOKEN_FILE ?? file.oauth?.tokenFile ?? null

  const debug = flags.debug ?? (envMap.REPOGATE_DEBUG !== undefined
    ? parseBool(envMap.REPOGATE_DEBUG)
    : (file.debug ?? false))

  return {
    token,
    baseUrl,
    readOnly: Boolean(readOnly),
    timeoutMs,
    oauthClientId,
    tokenFile,
    debug: Boolean(debug),
    userAgent: `repogate/${VERSION} (mcp; node ${process.version})`,
    tokenSource: flags.token ? 'flag' : (envToken !== undefined ? 'env' : (file.token ? 'file' : 'none')),
    help: false,
    version: false,
  }
}
