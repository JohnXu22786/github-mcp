import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpEngine } from '../src/protocol/engine.js'
import { buildRegistry } from '../src/tools/index.js'
import { makeFakeFetch } from './helpers/fakeFetch.js'
import { CredentialHub } from '../src/core/auth.js'
import { Gateway } from '../src/core/gateway.js'

function makeEngine(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? makeFakeFetch(() => ({
    status: 200,
    body: { number: 1, title: '示例', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
  }))
  const auth = new CredentialHub({ token: 't', fetchImpl })
  const config = {
    baseUrl: 'https://api.github.com',
    readOnly: false,
    timeoutMs: 1000,
    userAgent: 'repogate/test',
    ...(overrides.config ?? {}),
  }
  const gateway = new Gateway({ ...config, token: auth.resolveToken(), fetchImpl })
  const services = { auth, config, gateway, version: { name: 'repogate', version: '1.0.0' } }
  const registry = buildRegistry(services)
  return new McpEngine({ registry, services, serverInfo: { name: 'repogate', version: '1.0.0' } })
}

function request(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
}

/** 构造引擎并完成 initialize 握手（会话状态机要求先握手） */
async function boot(overrides = {}) {
  const engine = makeEngine(overrides)
  await engine.handle(request(1, 'initialize', { protocolVersion: '2025-06-18' }))
  return engine
}

test('未握手就调用其他方法 → Server not initialized (-32002)', async () => {
  const engine = makeEngine()
  const res = await engine.handle(request(1, 'tools/list'))
  assert.equal(res.error.code, -32002)
  const res2 = await engine.handle(request(1, 'ping'))
  assert.equal(res2.error.code, -32002)
})

test('initialize 握手：回显受支持的协议版本', async () => {
  const engine = makeEngine()
  for (const v of ['2025-06-18', '2025-03-26', '2024-11-05']) {
    const res = await engine.handle(request(1, 'initialize', { protocolVersion: v }))
    assert.equal(res.result.protocolVersion, v)
    assert.deepEqual(res.result.capabilities, { tools: {} })
    assert.equal(res.result.serverInfo.name, 'repogate')
  }
})

test('initialize 收到未知协议版本时回退到自身最新版本', async () => {
  const engine = makeEngine()
  const res = await engine.handle(request(1, 'initialize', { protocolVersion: '2099-01-01' }))
  assert.equal(res.result.protocolVersion, '2025-06-18')
})

test('ping 返回空结果', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'ping'))
  assert.deepEqual(res.result, {})
})

test('tools/list 返回全部工具声明', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'tools/list'))
  assert.ok(Array.isArray(res.result.tools))
  assert.ok(res.result.tools.length >= 20)
  for (const tool of res.result.tools) {
    assert.ok(typeof tool.name === 'string' && tool.name.length > 0)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0)
    assert.equal(tool.inputSchema.type, 'object')
    assert.ok(tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object')
  }
})

test('tools/call 成功：返回文本内容与结构化结果', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'tools/call', {
    name: 'gh_issue_fetch',
    arguments: { owner: 'octo', repo: 'hello', number: 1 },
  }))
  assert.equal(res.result.isError, undefined)
  assert.equal(res.result.content[0].type, 'text')
  assert.ok(res.result.structuredContent.number === 1 || res.result.structuredContent === null)
})

test('tools/call 参数校验失败：isError 结果而非协议错误', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'tools/call', {
    name: 'gh_issue_fetch',
    arguments: { owner: 'octo' },
  }))
  assert.equal(res.result.isError, true)
  assert.equal(res.result.structuredContent.error.code, 'validation')
})

test('tools/call 未知工具：JSON-RPC 参数错误', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'tools/call', { name: 'no_such_tool' }))
  assert.equal(res.error.code, -32602)
})

test('未知方法返回 METHOD_NOT_FOUND', async () => {
  const engine = await boot()
  const res = await engine.handle(request(1, 'whatever/method'))
  assert.equal(res.error.code, -32601)
})

test('通知（无 id）不产生响应', async () => {
  const engine = makeEngine()
  const res = await engine.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
  assert.equal(res, null)
})

test('畸形消息返回 INVALID_REQUEST', async () => {
  const engine = makeEngine()
  const res = await engine.handle({ jsonrpc: '2.0', id: 1 })
  assert.equal(res.error.code, -32600)
})

test('只读模式下变更类工具被拦截', async () => {
  const engine = await boot({ config: { readOnly: true } })
  const res = await engine.handle(request(1, 'tools/call', {
    name: 'gh_issue_open',
    arguments: { owner: 'octo', repo: 'hello', title: 'x' },
  }))
  assert.equal(res.result.isError, true)
  assert.equal(res.result.structuredContent.error.code, 'readonly')
})

test('只读模式下查询类工具正常', async () => {
  const engine = await boot({ config: { readOnly: true } })
  const res = await engine.handle(request(1, 'tools/call', {
    name: 'gh_issue_fetch',
    arguments: { owner: 'octo', repo: 'hello', number: 1 },
  }))
  assert.notEqual(res.result.isError, true)
})
