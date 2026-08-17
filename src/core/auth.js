/**
 * 凭据中枢：统一管理三类令牌来源 ——
 *  1. 环境变量/配置文件/命令行（最高优先）；
 *  2. 本地缓存的 OAuth 令牌文件（设备授权成功后写入，可跨进程复用）；
 *  3. OAuth 设备授权流程（面向交互式登录，需要 oauth.clientId）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RepogateError, ErrorCodes } from './errors.js'

const OAUTH_CODE_URL = 'https://github.com/login/device/code'
const OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'repo'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const OAUTH_REQUEST_TIMEOUT_MS = 15000

/** 防御服务端返回的非法数字字段 */
function toPositiveNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export class CredentialHub {
  /**
   * @param {object} opts
   * @param {string|null} opts.token 直接配置的令牌（env/config/flag 已合并）
   * @param {string|null} opts.oauthClientId GitHub App 的 Client ID
   * @param {string|null} opts.tokenFile 缓存文件路径（缺省且配置了 clientId 时用 ~/.repogate/token.json）
   * @param {Function} opts.fetchImpl 可注入的 fetch（测试用）
   */
  constructor({ token = null, oauthClientId = null, tokenFile = null, fetchImpl = fetch, log = () => {} }) {
    this.token = token
    this.oauthClientId = oauthClientId
    this.tokenFile = tokenFile ?? (oauthClientId ? join(homedir(), '.repogate', 'token.json') : null)
    this.fetchImpl = fetchImpl
    this.log = log
  }

  /** 当前令牌来源模式：env / file / oauth / none */
  get tokenMode() {
    if (this.hasToken()) return 'env'
    if (this.readCache()?.token) return 'file'
    if (this.oauthClientId) return 'oauth'
    return 'none'
  }

  hasToken() {
    return typeof this.token === 'string' && this.token.length > 0
  }

  /** 取出可用的访问令牌；没有任何来源时抛出带指引的错误 */
  resolveToken() {
    if (this.hasToken()) return this.token
    const cached = this.readCache()?.token
    if (typeof cached === 'string' && cached.length > 0) return cached
    if (this.oauthClientId) {
      throw new RepogateError(
        '尚未取得访问令牌。请先调用 gh_auth_login 发起 OAuth 设备授权，用户完成授权后再调用 gh_auth_check 确认令牌落地。',
        { code: ErrorCodes.AUTH },
      )
    }
    throw new RepogateError(
      '未配置访问令牌。请设置环境变量 REPOGATE_TOKEN（兼容 GITHUB_TOKEN / GH_TOKEN），或在配置文件中提供 token 字段；也可以配置 oauth.clientId 后使用 gh_auth_login 完成 OAuth 授权。',
      { code: ErrorCodes.AUTH },
    )
  }

  // ---- 本地缓存 ----

  readCache() {
    if (!this.tokenFile || !existsSync(this.tokenFile)) return null
    try {
      return JSON.parse(readFileSync(this.tokenFile, 'utf8'))
    } catch {
      return null
    }
  }

  writeCache(data) {
    if (!this.tokenFile) return
    try {
      mkdirSync(dirname(this.tokenFile), { recursive: true })
      writeFileSync(this.tokenFile, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (err) {
      // 缓存写入失败不应中断主流程，记一条日志继续
      this.log(`令牌缓存写入失败：${err.message}`)
    }
  }

  clearCache() {
    if (!this.tokenFile) return
    try {
      rmSync(this.tokenFile, { force: true })
    } catch { /* 忽略清除失败 */ }
  }

  /** 显式保存 OAuth 令牌（供测试与未来扩展使用） */
  saveToken({ token, scope = '' }) {
    this.writeCache({ token, scope, createdAt: new Date().toISOString() })
  }

  /** 清除本地缓存令牌；返回是否原本存在 */
  discardToken() {
    const existed = this.tokenFile && existsSync(this.tokenFile)
    this.clearCache()
    return Boolean(existed)
  }

  // ---- OAuth 设备授权 ----

  /**
   * 发起设备授权：返回用户需要访问的地址与一次性代码。
   * 流程状态写入缓存文件，进程重启后仍可继续轮询。
   */
  async startDeviceFlow(scope = DEFAULT_SCOPE) {
    if (!this.oauthClientId) {
      throw new RepogateError(
        'OAuth 设备授权需要 GitHub App 的 Client ID。请在配置文件的 oauth.clientId 字段中提供，或改用环境变量令牌。',
        { code: ErrorCodes.CONFIG },
      )
    }
    const body = new URLSearchParams({ client_id: this.oauthClientId, scope }).toString()
    const res = await this.fetchImpl(OAUTH_CODE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.device_code) {
      throw new RepogateError(
        `设备授权启动失败（HTTP ${res.status}）：${data.error_description ?? data.message ?? '未知原因'}`,
        { code: ErrorCodes.AUTH },
      )
    }
    const interval = toPositiveNumber(data.interval, 5)
    const expiresIn = toPositiveNumber(data.expires_in, 900)
    // 合并写入而非整体覆盖：已缓存的授权令牌不能因发起新流程而被销毁
    this.writeCache({
      ...this.readCache(),
      pending: {
        deviceCode: data.device_code,
        interval,
        expiresAt: Date.now() + expiresIn * 1000,
      },
    })
    return {
      verificationUri: data.verification_uri,
      userCode: data.user_code,
      deviceCode: data.device_code,
      expiresIn,
      interval,
    }
  }

  /**
   * 轮询一次授权结果（每次调用只发一个请求，供 agent 反复调用）。
   * 返回 { status }，status ∈ granted | pending | expired | denied | no-flow | error。
   */
  async pollDeviceFlow() {
    const cache = this.readCache()
    // 令牌已就绪（授权成功后的重复确认，或重启后的残留缓存）
    if (!cache?.pending && cache?.token) {
      return { status: 'granted', already: true }
    }
    const pending = cache?.pending
    if (!pending) return { status: 'no-flow' }
    if (!this.oauthClientId) {
      this.clearCache()
      return { status: 'error', message: 'oauth.clientId 配置缺失，无法继续轮询' }
    }
    if (Date.now() > pending.expiresAt) {
      this.clearCache()
      return { status: 'expired' }
    }
    const body = new URLSearchParams({
      client_id: this.oauthClientId,
      device_code: pending.deviceCode,
      grant_type: GRANT_TYPE,
    }).toString()
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    })
    const data = await res.json().catch(() => ({}))
    if (data.access_token) {
      this.saveToken({ token: data.access_token, scope: data.scope ?? '' })
      return { status: 'granted' }
    }
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending', retryAfterSeconds: pending.interval }
      case 'slow_down': {
        pending.interval += 5
        // 保留已有缓存（例如已就绪的授权令牌），只更新 pending 字段
        this.writeCache({ ...this.readCache(), pending })
        return { status: 'pending', retryAfterSeconds: pending.interval }
      }
      case 'expired_token':
        this.clearCache()
        return { status: 'expired' }
      case 'access_denied':
        this.clearCache()
        return { status: 'denied' }
      default:
        return { status: 'error', message: data.error_description ?? data.error ?? '未知错误' }
    }
  }
}
