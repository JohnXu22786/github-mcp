import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { StdioClient, publicToolName } from '../src/bridge/client.js'
import { startMockApi, sampleRepo, sampleIssue } from './helpers/mockApi.js'

const here = dirname(fileURLToPath(import.meta.url))
const entryPath = join(here, '..', 'src', 'entry.js')

/** 等待子进程退出；若已退出则立即返回 */
function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', resolve))
}

test('publicToolName：serverName 命名空间拼接', () => {
  assert.equal(publicToolName('repogate', 'gh_issue_open'), 'mcp__repogate__gh_issue_open')
})

test('端到端：真实子进程走完整 MCP 握手与工具调用', async () => {
  const api = await startMockApi({
    'GET /repos/octo/hello': () => ({ body: sampleRepo }),
    'GET /repos/octo/hello/issues/1': () => ({ body: sampleIssue }),
    'GET /user': () => ({ body: { login: 'octo', id: 1, html_url: 'https://github.com/octo' } }),
  })
  const child = spawn(process.execPath, [
    entryPath,
    '--base-url', api.baseUrl,
    '--token', 'e2e-tok',
    '--timeout-ms', '5000',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })

  try {
    const client = new StdioClient({ child })
    const tools = await client.connect()
    assert.ok(tools.length >= 20, `工具数量应 ≥20，实际 ${tools.length}`)
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('gh_issue_fetch'))
    assert.ok(names.includes('gh_pr_merge'))
    assert.ok(names.includes('gh_whoami'))
    for (const t of tools) {
      assert.equal(t.inputSchema.type, 'object')
    }

    const result = await client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.number, 1)
    assert.equal(result.structuredContent.title, '示例问题')

    const bad = await client.call('gh_issue_fetch', { owner: 'octo' })
    assert.equal(bad.isError, true)
    assert.equal(bad.structuredContent.error.code, 'validation')

    await assert.rejects(() => client.call('ghost_tool', {}), (err) => {
      assert.equal(err.code, 'jsonrpc')
      return true
    })
  } finally {
    child.kill()
    await waitExit(child)
    await api.close()
  }
  assert.ok(!stderr.includes('Error:'), `子进程不应向 stderr 输出未处理异常：${stderr.slice(0, 500)}`)
})

test('端到端：只读模式启动标志生效', async () => {
  const api = await startMockApi({
    'GET /repos/octo/hello/issues/1': () => ({ body: sampleIssue }),
    'POST /repos/octo/hello/issues': () => ({ status: 201, body: sampleIssue }),
  })
  const child = spawn(process.execPath, [
    entryPath,
    '--base-url', api.baseUrl,
    '--token', 'e2e-tok',
    '--read-only',
    '--timeout-ms', '5000',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  try {
    const client = new StdioClient({ child })
    await client.connect()
    const read = await client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 })
    assert.notEqual(read.isError, true)
    const write = await client.call('gh_issue_open', { owner: 'octo', repo: 'hello', title: 'x' })
    assert.equal(write.isError, true)
    assert.equal(write.structuredContent.error.code, 'readonly')
  } finally {
    child.kill()
    await waitExit(child)
    await api.close()
  }
})

test('子进程死亡后：在途调用与后续调用都快速失败，不挂起', async () => {
  const api = await startMockApi({
    'GET /repos/octo/hello/issues/1': () => ({ body: sampleIssue }),
  })
  const child = spawn(process.execPath, [
    entryPath,
    '--base-url', api.baseUrl,
    '--token', 'e2e-tok',
    '--timeout-ms', '5000',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  try {
    const client = new StdioClient({ child })
    await client.connect()
    child.kill()
    await waitExit(child)
    await assert.rejects(() => client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 }), (err) => {
      assert.equal(err.code, 'network')
      assert.match(err.message, /退出|断开|关闭/)
      return true
    })
  } finally {
    child.kill()
    await waitExit(child)
    await api.close()
  }
})

test('客户端断开 stdin 后：在途请求先排空、响应仍送达', async () => {
  const api = await startMockApi({
    'GET /repos/octo/hello/issues/1': async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      return { body: sampleIssue }
    },
  })
  const child = spawn(process.execPath, [
    entryPath,
    '--base-url', api.baseUrl,
    '--token', 'e2e-tok',
    '--timeout-ms', '5000',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  try {
    const client = new StdioClient({ child })
    await client.connect()
    const pending = client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 })
    // 立即关闭 stdin，模拟客户端在响应返回前断开
    child.stdin.end()
    const result = await Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('在途请求被丢弃，响应未送达')), 3000)),
    ])
    assert.equal(result.structuredContent.number, 1)
  } finally {
    child.kill()
    await waitExit(child)
    await api.close()
  }
})

test('握手超时：活而不响应的子进程不挂死启动', async () => {
  // 一个永远不读 stdin 的假 server
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const client = new StdioClient({ child: fake, handshakeTimeoutMs: 400 })
    await assert.rejects(() => client.connect(), (err) => {
      assert.equal(err.code, 'timeout')
      assert.match(err.message, /握手超时/)
      return true
    })
  } finally {
    fake.kill()
    await waitExit(fake)
  }
})

test('工具调用支持信号取消，且取消不影响后续调用', async () => {
  const api = await startMockApi({
    'GET /repos/octo/hello/issues/1': () => ({ body: sampleIssue }),
  })
  const child = spawn(process.execPath, [
    entryPath,
    '--base-url', api.baseUrl,
    '--token', 'e2e-tok',
    '--timeout-ms', '5000',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })

  try {
    const client = new StdioClient({ child })
    await client.connect()
    const ctrl = new AbortController()
    const pending = client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 }, ctrl.signal)
    ctrl.abort()
    await assert.rejects(() => pending, (err) => err?.name === 'AbortError')
    // 取消只影响被取消的那一次
    const again = await client.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 })
    assert.equal(again.structuredContent.number, 1)
  } finally {
    child.kill()
    await waitExit(child)
    await api.close()
  }
})
