import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialHub } from '../src/core/auth.js'
import { RepogateError } from '../src/core/errors.js'
import { makeFakeFetch } from './helpers/fakeFetch.js'

function makeHub(opts = {}, fetchImpl) {
  return new CredentialHub({
    token: opts.token ?? null,
    oauthClientId: opts.oauthClientId ?? null,
    tokenFile: opts.tokenFile ?? null,
    fetchImpl: fetchImpl ?? makeFakeFetch(() => ({ status: 200, body: {} })),
  })
}

test('模式识别：env / oauth / none / file', () => {
  assert.equal(makeHub({ token: 't' }).tokenMode, 'env')
  assert.equal(makeHub({ oauthClientId: 'Iv1.x' }).tokenMode, 'oauth')
  assert.equal(makeHub({}).tokenMode, 'none')
})

test('resolveToken：直接返回配置令牌', () => {
  const hub = makeHub({ token: 'tok' })
  assert.equal(hub.resolveToken(), 'tok')
  assert.equal(hub.hasToken(), true)
})

test('无任何令牌来源：报错并提示配置方式', () => {
  const hub = makeHub({})
  assert.equal(hub.hasToken(), false)
  assert.throws(() => hub.resolveToken(), (err) => {
    assert.ok(err instanceof RepogateError)
    assert.equal(err.code, 'auth')
    assert.match(err.message, /REPOGATE_TOKEN/)
    return true
  })
})

test('仅配置 OAuth：提示先完成设备授权', () => {
  const hub = makeHub({ oauthClientId: 'Iv1.x' })
  assert.throws(() => hub.resolveToken(), (err) => {
    assert.match(err.message, /gh_auth_login/)
    return true
  })
})

test('startDeviceFlow：向 GitHub 提交表单并返回授权信息', async () => {
  let seen
  const hub = makeHub({ oauthClientId: 'Iv1.x' }, makeFakeFetch(async (url, init) => {
    seen = { url, init }
    return {
      status: 200,
      body: {
        device_code: 'dc-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      },
    }
  }))
  const out = await hub.startDeviceFlow('repo')
  assert.equal(out.userCode, 'ABCD-1234')
  assert.equal(out.verificationUri, 'https://github.com/login/device')
  assert.equal(out.interval, 5)
  assert.equal(seen.url, 'https://github.com/login/device/code')
  assert.equal(seen.init.method, 'POST')
  assert.match(seen.init.body, /client_id=Iv1\.x/)
  assert.match(seen.init.body, /scope=repo/)
  assert.ok(seen.init.signal instanceof AbortSignal, 'OAuth 请求应带超时信号')
})

test('startDeviceFlow 未配置 clientId → 配置错误', async () => {
  const hub = makeHub({})
  await assert.rejects(() => hub.startDeviceFlow(), (err) => {
    assert.equal(err.code, 'config')
    assert.match(err.message, /clientId|oauth/i)
    return true
  })
})

const deviceCodeBody = {
  device_code: 'dc-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
}

test('pollDeviceFlow：等待中 / 成功 / 拒绝 / 过期', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    const calls = []
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile }, makeFakeFetch(async () => {
      calls.push(1)
      if (calls.length === 1) return { status: 200, body: deviceCodeBody }
      if (calls.length === 2) return { status: 200, body: { error: 'authorization_pending' } }
      return { status: 200, body: { access_token: 'oauth-tok', scope: 'repo' } }
    }))

    await hub.startDeviceFlow()
    let out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'pending')
    assert.equal(out.retryAfterSeconds, 5)

    out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'granted')
    assert.equal(hub.tokenMode, 'file')
    assert.equal(hub.resolveToken(), 'oauth-tok')
    assert.equal(seenSaved(hub, tokenFile), 'oauth-tok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function seenSaved(hub, tokenFile) {
  return JSON.parse(readFileSync(tokenFile, 'utf8')).token
}

test('pollDeviceFlow：授权被拒绝', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    let n = 0
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile }, makeFakeFetch(async () => {
      n += 1
      return { status: 200, body: n === 1 ? deviceCodeBody : { error: 'access_denied' } }
    }))
    await hub.startDeviceFlow()
    const out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'denied')
    assert.equal(existsSync(tokenFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pollDeviceFlow：无进行中的流程', async () => {
  const hub = makeHub({})
  const out = await hub.pollDeviceFlow()
  assert.equal(out.status, 'no-flow')
})

test('pollDeviceFlow：slow_down 会拉长间隔', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    let n = 0
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile }, makeFakeFetch(async () => {
      n += 1
      return { status: 200, body: n === 1 ? deviceCodeBody : { error: 'slow_down' } }
    }))
    await hub.startDeviceFlow()
    const out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'pending')
    assert.equal(out.retryAfterSeconds, 10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pollDeviceFlow：本地缓存过期（expiresAt 已过）→ expired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile })
    hub.writeCache({ pending: { deviceCode: 'dc', interval: 5, expiresAt: Date.now() - 1000 } })
    const out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'expired')
    assert.equal(existsSync(tokenFile), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pollDeviceFlow：服务端返回 expired_token → expired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    let n = 0
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile }, makeFakeFetch(async () => {
      n += 1
      return { status: 200, body: n === 1 ? deviceCodeBody : { error: 'expired_token' } }
    }))
    await hub.startDeviceFlow()
    const out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pollDeviceFlow：令牌已就绪时重复确认返回 granted/already', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    const hub = makeHub({ tokenFile })
    hub.saveToken({ token: 'cached', scope: 'repo' })
    const out = await hub.pollDeviceFlow()
    assert.equal(out.status, 'granted')
    assert.equal(out.already, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('发起新设备授权不销毁已缓存的旧令牌', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    const hub = makeHub({ oauthClientId: 'Iv1.x', tokenFile }, makeFakeFetch(async () => ({
      status: 200,
      body: deviceCodeBody,
    })))
    hub.saveToken({ token: 'old-tok', scope: 'repo' })
    await hub.startDeviceFlow()
    assert.equal(hub.tokenMode, 'file')
    assert.equal(hub.resolveToken(), 'old-tok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('OAuth 缓存令牌在重启后可复用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    makeHub({ tokenFile }).saveToken({ token: 'cached-tok', scope: 'repo' })
    const restored = makeHub({ tokenFile })
    assert.equal(restored.tokenMode, 'file')
    assert.equal(restored.resolveToken(), 'cached-tok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('discardToken 清除缓存令牌', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-auth-'))
  try {
    const tokenFile = join(dir, 'tok.json')
    const hub = makeHub({ tokenFile })
    hub.saveToken({ token: 't', scope: '' })
    assert.equal(hub.discardToken(), true)
    assert.equal(existsSync(tokenFile), false)
    assert.equal(hub.tokenMode, 'none')
    assert.equal(hub.discardToken(), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认 tokenFile 位于用户目录 .repogate 下', () => {
  const hub = makeHub({ oauthClientId: 'Iv1.x' })
  assert.ok(hub.tokenFile.endsWith(join('.repogate', 'token.json')))
})
