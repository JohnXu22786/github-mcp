import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.js'
import { RepogateError } from '../src/core/errors.js'

test('默认配置：无 token、公开 API、非只读', () => {
  const c = loadConfig([], {})
  assert.equal(c.token, null)
  assert.equal(c.baseUrl, 'https://api.github.com')
  assert.equal(c.readOnly, false)
  assert.equal(c.timeoutMs, 30000)
  assert.equal(c.oauthClientId, null)
  assert.equal(c.tokenSource, 'none')
  assert.equal(c.debug, false)
})

test('环境变量：REPOGATE_TOKEN 优先，其次 GITHUB_TOKEN、GH_TOKEN', () => {
  assert.equal(loadConfig([], { REPOGATE_TOKEN: 'a' }).token, 'a')
  assert.equal(loadConfig([], { GITHUB_TOKEN: 'b' }).token, 'b')
  assert.equal(loadConfig([], { GH_TOKEN: 'c' }).token, 'c')
  assert.equal(loadConfig([], { REPOGATE_TOKEN: 'a', GITHUB_TOKEN: 'b' }).token, 'a')
  assert.equal(loadConfig([], { REPOGATE_TOKEN: 'a', GITHUB_TOKEN: 'b' }).tokenSource, 'env')
})

test('环境变量：只读开关的多种真值', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes']) {
    assert.equal(loadConfig([], { REPOGATE_READ_ONLY: v }).readOnly, true)
  }
  for (const v of ['0', 'false', 'no', '']) {
    assert.equal(loadConfig([], { REPOGATE_READ_ONLY: v }).readOnly, false)
  }
})

test('环境变量：baseUrl 去尾部斜杠、超时解析', () => {
  assert.equal(loadConfig([], { REPOGATE_BASE_URL: 'https://ghe.example.com/api/v3/' }).baseUrl, 'https://ghe.example.com/api/v3')
  assert.equal(loadConfig([], { REPOGATE_TIMEOUT_MS: '5000' }).timeoutMs, 5000)
})

test('环境变量：非法超时值报配置错误', () => {
  assert.throws(() => loadConfig([], { REPOGATE_TIMEOUT_MS: 'abc' }), RepogateError)
  assert.throws(() => loadConfig([], { REPOGATE_TIMEOUT_MS: '0' }), RepogateError)
  assert.throws(() => loadConfig([], { REPOGATE_TIMEOUT_MS: '999999999' }), RepogateError)
})

test('配置文件：读取 JSON 字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-cfg-'))
  try {
    const file = join(dir, 'cfg.json')
    writeFileSync(file, JSON.stringify({
      token: 'file-tok',
      baseUrl: 'https://file.example.com',
      readOnly: true,
      timeoutMs: 9000,
      oauth: { clientId: 'Iv1.abc', tokenFile: join(dir, 'tok.json') },
    }))
    const c = loadConfig(['--config', file], {})
    assert.equal(c.token, 'file-tok')
    assert.equal(c.baseUrl, 'https://file.example.com')
    assert.equal(c.readOnly, true)
    assert.equal(c.timeoutMs, 9000)
    assert.equal(c.oauthClientId, 'Iv1.abc')
    assert.equal(c.tokenFile, join(dir, 'tok.json'))
    assert.equal(c.tokenSource, 'file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('优先级：命令行 > 环境变量 > 配置文件 > 默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-cfg-'))
  try {
    const file = join(dir, 'cfg.json')
    writeFileSync(file, JSON.stringify({ token: 'file-tok', readOnly: false }))
    const fromFile = loadConfig(['--config', file], {})
    assert.equal(fromFile.token, 'file-tok')
    const fromEnv = loadConfig(['--config', file], { REPOGATE_TOKEN: 'env-tok' })
    assert.equal(fromEnv.token, 'env-tok')
    const fromFlag = loadConfig(['--config', file, '--token', 'flag-tok'], { REPOGATE_TOKEN: 'env-tok' })
    assert.equal(fromFlag.token, 'flag-tok')
    assert.equal(fromFlag.tokenSource, 'flag')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件缺失或非法 → 配置错误', () => {
  assert.throws(() => loadConfig(['--config', 'Z:/definitely/missing.json'], {}), RepogateError)
  const dir = mkdtempSync(join(tmpdir(), 'repogate-cfg-'))
  try {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{ not json')
    assert.throws(() => loadConfig(['--config', file], {}), RepogateError)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('命令行标志：--read-only / --base-url / --timeout-ms / --debug / --oauth-client-id', () => {
  const c = loadConfig([
    '--read-only',
    '--base-url', 'http://localhost:8080/api/',
    '--timeout-ms', '1500',
    '--debug',
    '--oauth-client-id', 'Iv1.xyz',
  ], {})
  assert.equal(c.readOnly, true)
  assert.equal(c.baseUrl, 'http://localhost:8080/api')
  assert.equal(c.timeoutMs, 1500)
  assert.equal(c.debug, true)
  assert.equal(c.oauthClientId, 'Iv1.xyz')
})

test('REPOGATE_CONFIG 环境变量指定配置文件路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-cfg-'))
  try {
    const file = join(dir, 'cfg.json')
    writeFileSync(file, JSON.stringify({ token: 'via-env-path' }))
    const c = loadConfig([], { REPOGATE_CONFIG: file })
    assert.equal(c.token, 'via-env-path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--version 与 --help 返回标记', () => {
  assert.equal(loadConfig(['--version'], {}).version, true)
  assert.equal(loadConfig(['--help'], {}).help, true)
})

test('--version 不被损坏的配置文件屏蔽', () => {
  const out = loadConfig(['--version'], { REPOGATE_CONFIG: 'Z:/definitely/missing.json' })
  assert.equal(out.version, true)
})

test('空字符串环境令牌视为未设置，继续回退', () => {
  assert.equal(loadConfig([], { REPOGATE_TOKEN: '', GITHUB_TOKEN: 'real' }).token, 'real')
  assert.equal(loadConfig([], { REPOGATE_TOKEN: '', GITHUB_TOKEN: '', GH_TOKEN: 'gh' }).token, 'gh')
  assert.equal(loadConfig([], { REPOGATE_TOKEN: '' }).token, null)
})

test('未知参数报配置错误', () => {
  assert.throws(() => loadConfig(['--nope'], {}), RepogateError)
})

test('取值参数缺值/空值 → 配置错误', () => {
  assert.throws(() => loadConfig(['--timeout-ms'], {}), RepogateError)
  assert.throws(() => loadConfig(['--token', ''], {}), RepogateError)
  assert.throws(() => loadConfig(['--config='], {}), RepogateError)
  assert.throws(() => loadConfig(['--timeout-ms=abc'], {}), RepogateError)
})

test('布尔参数不接受取值 → 配置错误', () => {
  assert.throws(() => loadConfig(['--read-only=true'], {}), RepogateError)
  assert.throws(() => loadConfig(['--debug=x'], {}), RepogateError)
})
