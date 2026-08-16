import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from '../src/core/gateway.js'
import { RepogateError } from '../src/core/errors.js'
import { makeFakeFetch } from './helpers/fakeFetch.js'

function makeGateway(handler, opts = {}) {
  return new Gateway({
    baseUrl: 'https://api.example.test',
    token: opts.token === undefined ? 'tok123' : opts.token,
    timeoutMs: 1000,
    userAgent: 'repogate/test',
    fetchImpl: makeFakeFetch(handler),
  })
}

test('GET 请求：URL 拼接、查询串与请求头', async () => {
  let seen
  const gw = makeGateway(async (url, init) => {
    seen = { url, init }
    return { status: 200, headers: { 'x-ratelimit-remaining': '99' }, body: { ok: 1 } }
  })
  const out = await gw.request('GET', '/repos/a/b/issues', { query: { state: 'open', page: 2 } })
  assert.equal(out.data.ok, 1)
  const u = new URL(seen.url)
  assert.equal(u.origin, 'https://api.example.test')
  assert.equal(u.pathname, '/repos/a/b/issues')
  assert.equal(u.searchParams.get('state'), 'open')
  assert.equal(u.searchParams.get('page'), '2')
  assert.equal(seen.init.method, 'GET')
  assert.equal(seen.init.headers.Authorization, 'Bearer tok123')
  assert.equal(seen.init.headers.Accept, 'application/vnd.github+json')
  assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28')
  assert.equal(seen.init.headers['User-Agent'], 'repogate/test')
  assert.equal(out.rateLimit.remaining, 99)
})

test('POST 请求：JSON 序列化与 Content-Type', async () => {
  let seen
  const gw = makeGateway(async (url, init) => {
    seen = { url, init }
    return { status: 201, body: { id: 9 } }
  })
  const out = await gw.request('POST', '/repos/a/b/issues', { body: { title: '你好', labels: ['x'] } })
  assert.equal(out.status, 201)
  assert.equal(seen.init.method, 'POST')
  assert.equal(JSON.parse(seen.init.body).title, '你好')
  assert.equal(seen.init.headers['Content-Type'], 'application/json')
})

test('无 token 时不发送 Authorization 头', async () => {
  let seen
  const gw = makeGateway(async (url, init) => {
    seen = init
    return { status: 200, body: {} }
  }, { token: null })
  await gw.request('GET', '/user')
  assert.equal(seen.headers.Authorization, undefined)
})

test('401 → AuthError，附授权提示', async () => {
  const gw = makeGateway(() => ({ status: 401, body: { message: 'Bad credentials' } }))
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.ok(err instanceof RepogateError)
    assert.equal(err.code, 'auth')
    assert.match(err.message, /令牌/)
    return true
  })
})

test('403 且配额耗尽 → RateLimitError，含重置时间', async () => {
  const gw = makeGateway(() => ({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' },
    body: { message: 'API rate limit exceeded' },
  }))
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'ratelimit')
    assert.match(err.message, /频率限制/)
    return true
  })
})

test('403 其他情况 → 权限错误', async () => {
  const gw = makeGateway(() => ({ status: 403, body: { message: 'Forbidden' } }))
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'http')
    assert.match(err.message, /权限/)
    return true
  })
})

test('404 → 不存在或不可见提示', async () => {
  const gw = makeGateway(() => ({ status: 404, body: { message: 'Not Found' } }))
  await assert.rejects(() => gw.request('GET', '/repos/x/y'), (err) => {
    assert.equal(err.code, 'http')
    assert.match(err.message, /未找到/)
    return true
  })
})

test('422 → 带 GitHub 校验细节', async () => {
  const gw = makeGateway(() => ({
    status: 422,
    body: { message: 'Validation Failed', errors: [{ field: 'title', message: 'is too long' }] },
  }))
  await assert.rejects(() => gw.request('POST', '/repos/a/b/issues'), (err) => {
    assert.equal(err.code, 'http')
    assert.match(err.message, /422/)
    assert.match(err.message, /is too long/)
    return true
  })
})

test('429 → 附 Retry-After 提示', async () => {
  const gw = makeGateway(() => ({ status: 429, headers: { 'retry-after': '7' }, body: { message: 'nope' } }))
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'ratelimit')
    assert.match(err.message, /7 秒/)
    return true
  })
})

test('503 自动重试一次后成功', async () => {
  let calls = 0
  const gw = makeGateway(async () => {
    calls += 1
    if (calls === 1) return { status: 503, body: { message: 'Service Unavailable' } }
    return { status: 200, body: { ok: true } }
  })
  const out = await gw.request('GET', '/user')
  assert.equal(calls, 2)
  assert.equal(out.data.ok, true)
})

test('写请求（POST）遇 503 不自动重试，避免副作用重复', async () => {
  let calls = 0
  const gw = makeGateway(async () => {
    calls += 1
    return { status: 503, body: { message: 'Service Unavailable' } }
  })
  await assert.rejects(() => gw.request('POST', '/repos/a/b/issues', { body: { title: 'x' } }), (err) => {
    assert.equal(err.code, 'http')
    return true
  })
  assert.equal(calls, 1)
})

test('504 重试仍失败 → 服务不可用错误', async () => {
  const gw = makeGateway(() => ({ status: 504, body: { message: 'Gateway Timeout' } }))
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'http')
    assert.match(err.message, /504/)
    return true
  })
})

test('网络层错误 → 重试后 NetworkError', async () => {
  let calls = 0
  const gw = makeGateway(async () => {
    calls += 1
    throw new TypeError('fetch failed')
  })
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'network')
    assert.ok(calls === 2)
    return true
  })
})

test('超时（AbortError）不重试，映射为 timeout', async () => {
  let calls = 0
  const gw = makeGateway(async () => {
    calls += 1
    throw new DOMException('The operation was aborted', 'AbortError')
  })
  await assert.rejects(() => gw.request('GET', '/user'), (err) => {
    assert.equal(err.code, 'timeout')
    assert.ok(calls === 1)
    return true
  })
})

test('4xx 客户端错误不重试', async () => {
  let calls = 0
  const gw = makeGateway(async () => {
    calls += 1
    return { status: 422, body: { message: 'bad' } }
  })
  await assert.rejects(() => gw.request('GET', '/user'))
  assert.equal(calls, 1)
})

test('请求超时信号被附加到 fetch 调用', async () => {
  let signalSeen
  const gw = makeGateway(async (url, init) => {
    signalSeen = init.signal
    return { status: 200, body: {} }
  })
  await gw.request('GET', '/user')
  assert.ok(signalSeen instanceof AbortSignal)
})

test('网关删除末尾斜杠的 baseUrl', async () => {
  const gw = new Gateway({
    baseUrl: 'https://api.example.test/',
    token: 't',
    timeoutMs: 1000,
    userAgent: 'u',
    fetchImpl: makeFakeFetch(async (url) => ({ status: 200, body: { host: new URL(url).origin } })),
  })
  const out = await gw.request('GET', '/x')
  assert.equal(out.data.host, 'https://api.example.test')
})
