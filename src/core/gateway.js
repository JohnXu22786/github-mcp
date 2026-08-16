/**
 * 网关：GitHub REST API 的薄封装。
 * 负责 URL/查询串/请求头组装、超时信号、5xx 与网络错误的一次重试，
 * 以及把 HTTP 状态码翻译成带可执行提示的中文错误。
 */
import { RepogateError, ErrorCodes } from './errors.js'

const API_VERSION = '2022-11-28'
const RETRYABLE_STATUS = new Set([502, 503, 504])
/** 只有幂等方法值得自动重试；POST 等写请求重试可能造成副作用重复 */
const RETRYABLE_METHODS = new Set(['GET', 'HEAD'])

export class Gateway {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl API 根地址（如 https://api.github.com）
   * @param {string|null} opts.token 静态令牌；与 opts.tokenResolver 二选一
   * @param {Function|null} opts.tokenResolver 每次请求时取令牌（支持 OAuth 落地后生效）
   * @param {number} opts.timeoutMs 单请求超时
   * @param {string} opts.userAgent GitHub 强制要求 UA
   * @param {Function} opts.fetchImpl 可注入的 fetch
   * @param {number} opts.maxRetries 5xx/网络错误的重试次数
   */
  constructor({ baseUrl, token = null, tokenResolver = null, timeoutMs = 30000, userAgent, fetchImpl = fetch, maxRetries = 1, log = () => {} }) {
    this.baseUrl = String(baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    this.token = token
    this.tokenResolver = tokenResolver
    this.timeoutMs = timeoutMs
    this.userAgent = userAgent
    this.fetchImpl = fetchImpl
    this.maxRetries = maxRetries
    this.log = log
  }

  /**
   * 发起一次请求。
   * @param {string} method GET/POST/PATCH/PUT/DELETE
   * @param {string} path 以 / 开头的 API 路径
   * @param {object} opts
   * @param {object} opts.query 查询参数（undefined/null/'' 自动剔除）
   * @param {object} opts.body 请求体（JSON 序列化）
   * @returns {Promise<{status:number, data:any, headers:Headers, rateLimit:object|null}>}
   */
  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': this.userAgent,
    }
    const token = this.tokenResolver ? this.tokenResolver() : this.token
    if (token) headers.Authorization = `Bearer ${token}`
    let payload
    if (body !== undefined) {
      payload = JSON.stringify(body)
      headers['Content-Type'] = 'application/json'
    }

    const retryable = RETRYABLE_METHODS.has(method)
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
        if (res.status >= 200 && res.status < 300) {
          const data = res.status === 204 ? null : await res.json().catch(() => null)
          return {
            status: res.status,
            data,
            headers: res.headers,
            rateLimit: readRateLimit(res.headers),
          }
        }
        if (retryable && RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
          this.log(`HTTP ${res.status}，第 ${attempt + 1} 次重试…`)
          await sleep(250 * (attempt + 1))
          continue
        }
        throw await makeHttpError(res)
      } catch (err) {
        if (err instanceof RepogateError) throw err
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
          throw new RepogateError(`请求超时（${this.timeoutMs}ms），可调大 timeoutMs 后重试。`, { code: ErrorCodes.TIMEOUT })
        }
        // 网络层错误（DNS/连接被重置等）只对幂等方法重试
        if (retryable && attempt < this.maxRetries) {
          this.log(`网络错误，第 ${attempt + 1} 次重试：${err?.message}`)
          await sleep(250 * (attempt + 1))
          continue
        }
        throw new RepogateError(
          `网络请求失败：${err?.cause?.message ?? err?.message ?? String(err)}。请检查网络连接与 baseUrl 配置。`,
          { code: ErrorCodes.NETWORK },
        )
      }
    }
    // 循环内所有路径均已 return 或 throw，此行为兜底保险
    throw new RepogateError('请求失败', { code: ErrorCodes.NETWORK })
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readRateLimit(headers) {
  const get = (name) => {
    const v = headers?.get?.(name)
    if (v === null || v === undefined || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const remaining = get('x-ratelimit-remaining')
  if (remaining === null) return null
  return {
    limit: get('x-ratelimit-limit'),
    remaining,
    reset: get('x-ratelimit-reset'),
  }
}

async function makeHttpError(res) {
  const data = await res.json().catch(() => null)
  const message = data?.message ?? ''
  switch (res.status) {
    case 401:
      return new RepogateError(
        '令牌无效或已过期。请检查令牌配置（REPOGATE_TOKEN / 配置文件 token 字段），或重新调用 gh_auth_login 完成 OAuth 授权。',
        { code: ErrorCodes.AUTH },
      )
    case 403: {
      if (res.headers.get('x-ratelimit-remaining') === '0') {
        const resetMs = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000
        const when = resetMs > 0 ? new Date(resetMs).toISOString() : '未知时间'
        return new RepogateError(
          `已触发 GitHub 频率限制，本小时配额已用尽，约于 ${when} 重置。请稍后再试，或降低调用频率。`,
          { code: ErrorCodes.RATELIMIT },
        )
      }
      return new RepogateError(
        '当前令牌无权执行该操作（403 Forbidden）。请检查令牌的权限范围（scope）与仓库访问级别。',
        { code: ErrorCodes.HTTP },
      )
    }
    case 404:
      return new RepogateError(
        '未找到该资源：可能不存在、已删除，或当前令牌无权访问（私有仓库需要相应授权）。',
        { code: ErrorCodes.HTTP },
      )
    case 422: {
      const detail = (data?.errors ?? [])
        .map((e) => e?.message || e?.field)
        .filter(Boolean)
        .join('；')
      return new RepogateError(
        `GitHub 拒绝了请求参数（422 Validation Failed）${detail ? `：${detail}` : ''}`,
        { code: ErrorCodes.HTTP },
      )
    }
    case 409:
      return new RepogateError(
        `操作冲突（409 Conflict）：${message || '目标状态已变化，请刷新后重试'}`,
        { code: ErrorCodes.HTTP },
      )
    case 429: {
      const wait = res.headers.get('retry-after')
      return new RepogateError(
        `请求过于频繁（429 Rate Limit）${wait ? `，请在 ${wait} 秒后重试` : '，请稍后再试'}`,
        { code: ErrorCodes.RATELIMIT },
      )
    }
    default:
      if (res.status >= 500) {
        return new RepogateError(
          `上游服务暂时不可用（HTTP ${res.status}）：${message || '请稍后重试'}`,
          { code: ErrorCodes.HTTP },
        )
      }
      return new RepogateError(
        `GitHub API 返回异常状态码 ${res.status}：${message || '无详情'}`,
        { code: ErrorCodes.HTTP },
      )
  }
}
