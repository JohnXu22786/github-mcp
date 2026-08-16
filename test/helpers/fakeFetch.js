/**
 * 测试辅助：伪造 fetch，用于在单测中拦截 HTTP 请求。
 * handler(url: string, init: RequestInit) -> { status?, headers?, body? }
 */
export function makeFakeFetch(handler) {
  return async (url, init) => {
    const res = await handler(url, init)
    const status = res.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(res.headers ?? {}),
      async json() {
        return typeof res.body === 'string' ? JSON.parse(res.body) : (res.body ?? null)
      },
      async text() {
        return typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null)
      },
    }
  }
}
