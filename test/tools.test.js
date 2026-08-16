import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRegistry } from '../src/tools/index.js'
import { CredentialHub } from '../src/core/auth.js'
import { Gateway } from '../src/core/gateway.js'
import { makeFakeFetch } from './helpers/fakeFetch.js'

function makeContext(handler, overrides = {}) {
  const config = {
    baseUrl: 'https://api.example.test',
    readOnly: overrides.readOnly ?? false,
    timeoutMs: 1000,
    userAgent: 'repogate/test',
    oauthClientId: null,
    tokenFile: null,
    tokenSource: overrides.token === undefined ? 'none' : 'env',
    ...(overrides.config ?? {}),
  }
  const fetchImpl = makeFakeFetch(handler)
  const auth = new CredentialHub({
    token: overrides.token === undefined ? 'test-tok' : overrides.token,
    oauthClientId: config.oauthClientId,
    tokenFile: config.tokenFile,
    fetchImpl,
  })
  let token = null
  try {
    token = auth.resolveToken()
  } catch {
    token = null
  }
  const gateway = new Gateway({ ...config, token, fetchImpl })
  const services = { auth, config, gateway, version: { name: 'repogate', version: '1.0.0' } }
  return { registry: buildRegistry(services), services, last: () => requests[requests.length - 1] }
}

let requests = []

function capture(handler) {
  requests = []
  return async (url, init) => {
    requests.push({ url: String(url), init })
    return handler(url, init)
  }
}

const repoBody = {
  id: 1, name: 'hello', full_name: 'octo/hello', private: false,
  description: '示例仓库', html_url: 'https://github.com/octo/hello',
  default_branch: 'main', language: 'JavaScript',
  stargazers_count: 12, forks_count: 3, open_issues_count: 2,
  owner: { login: 'octo' }, created_at: '2020-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const issueBody = {
  id: 101, number: 1, title: '示例问题', state: 'open', body: '正文',
  html_url: 'https://github.com/octo/hello/issues/1',
  user: { login: 'octo' }, labels: [{ name: 'bug' }], assignees: [{ login: 'alice' }],
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  comments: 0, pull_request: undefined,
}

const prBody = {
  id: 7, number: 7, title: 'PR 标题', state: 'open', body: 'PR 正文',
  html_url: 'https://github.com/octo/hello/pull/7',
  user: { login: 'octo' }, draft: false,
  mergeable: true, mergeable_state: 'clean', merged: false, merged_at: null,
  additions: 10, deletions: 2, changed_files: 3, commits: 1, comments: 0, review_comments: 0,
  created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z',
  base: { ref: 'main' }, head: { ref: 'topic' },
}

function ok(body, status = 200) {
  return { status, body }
}

test('gh_repo_fetch：请求与输出摘要', async () => {
  const c = makeContext(capture(() => ok(repoBody)))
  const out = await c.registry.call('gh_repo_fetch', { owner: 'octo', repo: 'hello' }, c.services)
  const req = c.last()
  assert.equal(req.url, 'https://api.example.test/repos/octo/hello')
  assert.equal(out.fullName, 'octo/hello')
  assert.equal(out.htmlUrl, 'https://github.com/octo/hello')
  assert.equal(out.stars, 12)
  assert.equal(out.defaultBranch, 'main')
})

test('gh_repo_fetch：owner/repo 中的特殊字符被转义', async () => {
  const c = makeContext(capture(() => ok(repoBody)))
  await c.registry.call('gh_repo_fetch', { owner: 'we/ird', repo: 'na me' }, c.services)
  assert.equal(c.last().url, 'https://api.example.test/repos/we%2Fird/na%20me')
})

test('gh_repo_browse：用户 / 组织 / 自身三种端点', async () => {
  const c = makeContext(capture(() => ok({ items: [], total_count: 0 })))
  await c.registry.call('gh_repo_browse', { owner: 'octo' }, c.services)
  assert.equal(new URL(c.last().url).pathname, '/users/octo/repos')
  await c.registry.call('gh_repo_browse', { owner: 'acme', kind: 'org' }, c.services)
  assert.equal(new URL(c.last().url).pathname, '/orgs/acme/repos')
  await c.registry.call('gh_repo_browse', {}, c.services)
  assert.equal(new URL(c.last().url).pathname, '/user/repos')
})

test('gh_repo_browse：org 端点拒绝 user 专属 type 值', async () => {
  const c = makeContext(capture(() => ok({ items: [] })))
  await assert.rejects(() => c.registry.call('gh_repo_browse', { owner: 'acme', kind: 'org', type: 'owner' }, c.services), (err) => {
    assert.equal(err.code, 'validation')
    assert.match(err.message, /type=owner/)
    return true
  })
  // user 端点放行 owner；org 端点放行 forks
  await c.registry.call('gh_repo_browse', { owner: 'octo', type: 'owner' }, c.services)
  await c.registry.call('gh_repo_browse', { owner: 'acme', kind: 'org', type: 'forks' }, c.services)
  // 无 owner 时走 /user/repos，org 专属 type 应被拒
  await assert.rejects(() => c.registry.call('gh_repo_browse', { kind: 'org', type: 'forks' }, c.services), (err) => {
    assert.equal(err.code, 'validation')
    return true
  })
})

test('gh_issue_open：POST 请求体与返回', async () => {
  const created = { ...issueBody, number: 2, title: '新问题', html_url: 'https://github.com/octo/hello/issues/2' }
  const c = makeContext(capture(() => ok(created, 201)))
  const out = await c.registry.call('gh_issue_open', {
    owner: 'octo', repo: 'hello', title: '新问题',
    body: '描述', labels: ['bug', 'p1'], assignees: ['alice'],
  }, c.services)
  const req = c.last()
  assert.equal(req.url, 'https://api.example.test/repos/octo/hello/issues')
  assert.equal(JSON.parse(req.init.body).title, '新问题')
  assert.deepEqual(JSON.parse(req.init.body).labels, ['bug', 'p1'])
  assert.deepEqual(JSON.parse(req.init.body).assignees, ['alice'])
  assert.equal(out.number, 2)
  assert.equal(out.htmlUrl, 'https://github.com/octo/hello/issues/2')
})

test('gh_issue_open：缺少 title → validation 错误', async () => {
  const c = makeContext(capture(() => ok(issueBody, 201)))
  await assert.rejects(() => c.registry.call('gh_issue_open', { owner: 'o', repo: 'r' }, c.services), /title/)
})

test('gh_issue_fetch：GET 详情', async () => {
  const c = makeContext(capture(() => ok(issueBody)))
  const out = await c.registry.call('gh_issue_fetch', { owner: 'octo', repo: 'hello', number: 1 }, c.services)
  assert.equal(c.last().url, 'https://api.example.test/repos/octo/hello/issues/1')
  assert.equal(out.title, '示例问题')
  assert.equal(out.labels.join(','), 'bug')
  assert.deepEqual(out.assignees, ['alice'])
  assert.equal(out.pullRequest, false)
})

test('gh_issue_browse：筛选参数映射', async () => {
  const c = makeContext(capture(() => ok({ items: [issueBody] })))
  const out = await c.registry.call('gh_issue_browse', {
    owner: 'octo', repo: 'hello', state: 'open', label: 'bug',
    assignee: 'alice', creator: 'octo', page: 2, perPage: 5,
  }, c.services)
  const u = new URL(c.last().url)
  assert.equal(u.pathname, '/repos/octo/hello/issues')
  assert.equal(u.searchParams.get('state'), 'open')
  assert.equal(u.searchParams.get('label'), 'bug')
  assert.equal(u.searchParams.get('assignee'), 'alice')
  assert.equal(u.searchParams.get('creator'), 'octo')
  assert.equal(u.searchParams.get('page'), '2')
  assert.equal(u.searchParams.get('per_page'), '5')
  assert.equal(out.items.length, 1)
  assert.equal(out.hasMore, false)
})

test('gh_issue_browse：Link 头推断 hasMore', async () => {
  const c = makeContext(capture(() => ({
    status: 200,
    headers: { link: '<https://api.example.test/issues?page=3>; rel="next"' },
    body: { items: [issueBody] },
  })))
  const out = await c.registry.call('gh_issue_browse', { owner: 'o', repo: 'r' }, c.services)
  assert.equal(out.hasMore, true)
})

test('gh_issue_browse：includePulls=false 过滤 PR 条目', async () => {
  const prLike = { ...issueBody, number: 3, pull_request: { url: 'x' } }
  const c = makeContext(capture(() => ok({ items: [issueBody, prLike] })))
  const out = await c.registry.call('gh_issue_browse', { owner: 'o', repo: 'r', includePulls: false }, c.services)
  assert.equal(out.items.length, 1)
  assert.equal(out.items[0].number, 1)
})

test('gh_issue_edit：仅提交提供的字段', async () => {
  const c = makeContext(capture(() => ok({ ...issueBody, state: 'closed' })))
  const out = await c.registry.call('gh_issue_edit', { owner: 'o', repo: 'r', number: 1, state: 'closed' }, c.services)
  const body = JSON.parse(c.last().init.body)
  assert.deepEqual(Object.keys(body), ['state'])
  assert.equal(body.state, 'closed')
  assert.equal(out.number, 1)
})

test('gh_issue_respond：POST 评论', async () => {
  const comment = { id: 9, html_url: 'https://github.com/o/r/issues/1#issuecomment-9', body: '回复', user: { login: 'octo' }, created_at: '2026-01-04T00:00:00Z' }
  const c = makeContext(capture(() => ok(comment, 201)))
  const out = await c.registry.call('gh_issue_respond', { owner: 'o', repo: 'r', number: 1, body: '回复' }, c.services)
  assert.equal(c.last().url, 'https://api.example.test/repos/o/r/issues/1/comments')
  assert.equal(JSON.parse(c.last().init.body).body, '回复')
  assert.equal(out.id, 9)
})

test('gh_pr_open：head/base 映射到 pull 端点', async () => {
  const c = makeContext(capture(() => ok(prBody, 201)))
  const out = await c.registry.call('gh_pr_open', {
    owner: 'octo', repo: 'hello', title: 'PR 标题', head: 'topic', base: 'main', body: 'PR 正文', draft: true,
  }, c.services)
  const req = c.last()
  assert.equal(req.url, 'https://api.example.test/repos/octo/hello/pulls')
  const body = JSON.parse(req.init.body)
  assert.deepEqual(body, { title: 'PR 标题', head: 'topic', base: 'main', body: 'PR 正文', draft: true })
  assert.equal(out.number, 7)
})

test('gh_pr_fetch：详情字段齐全', async () => {
  const c = makeContext(capture(() => ok(prBody)))
  const out = await c.registry.call('gh_pr_fetch', { owner: 'o', repo: 'r', number: 7 }, c.services)
  assert.equal(out.mergeable, true)
  assert.equal(out.mergeableState, 'clean')
  assert.equal(out.additions, 10)
  assert.equal(out.changedFiles, 3)
  assert.equal(out.base, 'main')
  assert.equal(out.head, 'topic')
})

test('gh_pr_browse：筛选参数', async () => {
  const c = makeContext(capture(() => ok({ items: [prBody] })))
  await c.registry.call('gh_pr_browse', {
    owner: 'o', repo: 'r', state: 'open', head: 'topic', base: 'main',
    sort: 'updated', direction: 'desc', perPage: 10,
  }, c.services)
  const u = new URL(c.last().url)
  assert.equal(u.searchParams.get('head'), 'topic')
  assert.equal(u.searchParams.get('base'), 'main')
  assert.equal(u.searchParams.get('sort'), 'updated')
  assert.equal(u.searchParams.get('direction'), 'desc')
  assert.equal(u.searchParams.get('per_page'), '10')
})

test('gh_pr_edit：更新标题与状态', async () => {
  const c = makeContext(capture(() => ok(prBody)))
  await c.registry.call('gh_pr_edit', { owner: 'o', repo: 'r', number: 7, title: '新标题', state: 'closed' }, c.services)
  const body = JSON.parse(c.last().init.body)
  assert.deepEqual(body, { title: '新标题', state: 'closed' })
})

test('gh_pr_merge：合并参数与成功返回', async () => {
  const c = makeContext(capture(() => ok({ merged: true, message: 'Pull Request successfully merged', sha: 'abc123' })))
  const out = await c.registry.call('gh_pr_merge', {
    owner: 'o', repo: 'r', number: 7, method: 'squash', deleteBranch: true, commitMessage: '合并！',
  }, c.services)
  assert.equal(c.last().url, 'https://api.example.test/repos/o/r/pulls/7/merge')
  const body = JSON.parse(c.last().init.body)
  assert.deepEqual(body, { merge_method: 'squash', delete_branch: true, commit_message: '合并！' })
  assert.equal(out.merged, true)
})

test('gh_review_submit：事件名归一化大写', async () => {
  const c = makeContext(capture(() => ok({ id: 3, state: 'APPROVED', submitted_at: '2026-01-05T00:00:00Z', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-3' })))
  const out = await c.registry.call('gh_review_submit', { owner: 'o', repo: 'r', number: 7, event: 'approve', body: 'LGTM' }, c.services)
  const body = JSON.parse(c.last().init.body)
  assert.deepEqual(body, { event: 'APPROVE', body: 'LGTM' })
  assert.equal(out.state, 'APPROVED')
})

test('gh_review_submit：非法事件 → validation', async () => {
  const c = makeContext(capture(() => ok({})))
  await assert.rejects(() => c.registry.call('gh_review_submit', { owner: 'o', repo: 'r', number: 7, event: 'maybe' }, c.services), /event/)
})

test('gh_review_comment：行级评论参数', async () => {
  const c = makeContext(capture(() => ok({ id: 5, html_url: 'https://github.com/o/r/pull/7#discussion_r5', path: 'src/a.js', line: 12, side: 'RIGHT', body: '这里有问题', created_at: '2026-01-05T00:00:00Z' })))
  const out = await c.registry.call('gh_review_comment', {
    owner: 'o', repo: 'r', number: 7, body: '这里有问题', path: 'src/a.js', line: 12, side: 'RIGHT',
  }, c.services)
  const body = JSON.parse(c.last().init.body)
  assert.deepEqual(body, { body: '这里有问题', path: 'src/a.js', line: 12, side: 'RIGHT' })
  assert.equal(out.line, 12)
})

test('gh_review_comment：startLine 要求 side=RIGHT', async () => {
  const c = makeContext(capture(() => ok({ id: 5 })))
  await assert.rejects(() => c.registry.call('gh_review_comment', {
    owner: 'o', repo: 'r', number: 7, body: 'x', path: 'a.js', line: 5, startLine: 2, side: 'LEFT',
  }, c.services), /RIGHT/)
  await assert.rejects(() => c.registry.call('gh_review_comment', {
    owner: 'o', repo: 'r', number: 7, body: 'x', path: 'a.js',
  }, c.services), /line/)
  await assert.rejects(() => c.registry.call('gh_review_comment', {
    owner: 'o', repo: 'r', number: 7, body: 'x', path: 'a.js', line: 5, startLine: 9,
  }, c.services), /startLine/)
})

test('gh_review_comment：startLine 未传 side 时按 RIGHT 处理', async () => {
  const c = makeContext(capture(() => ok({ id: 5 })))
  await c.registry.call('gh_review_comment', {
    owner: 'o', repo: 'r', number: 7, body: 'x', path: 'a.js', line: 12, startLine: 2,
  }, c.services)
  const body = JSON.parse(c.last().init.body)
  assert.equal(body.side, 'RIGHT')
  assert.equal(body.start_line, 2)
  assert.equal(body.start_side, 'RIGHT')
})

test('gh_review_fetch：评论列表', async () => {
  const c = makeContext(capture(() => ok({ items: [{ id: 5, html_url: 'u', body: 'b', path: 'a.js', line: 1, created_at: 't' }] })))
  const out = await c.registry.call('gh_review_fetch', { owner: 'o', repo: 'r', number: 7 }, c.services)
  assert.equal(new URL(c.last().url).pathname, '/repos/o/r/pulls/7/comments')
  assert.equal(out.items[0].id, 5)
})

test('gh_review_browse：已提交的 review 列表', async () => {
  const c = makeContext(capture(() => ok([{ id: 3, state: 'APPROVED', submitted_at: 't', user: { login: 'octo' } }])))
  const out = await c.registry.call('gh_review_browse', { owner: 'o', repo: 'r', number: 7 }, c.services)
  assert.equal(new URL(c.last().url).pathname, '/repos/o/r/pulls/7/reviews')
  assert.equal(out.items[0].state, 'APPROVED')
})

test('gh_search_repos：搜索参数', async () => {
  const c = makeContext(capture(() => ok({ total_count: 1, items: [repoBody] })))
  const out = await c.registry.call('gh_search_repos', { query: 'language:typescript stars:>100', sort: 'stars', order: 'desc', perPage: 20 }, c.services)
  const u = new URL(c.last().url)
  assert.equal(u.pathname, '/search/repositories')
  assert.equal(u.searchParams.get('q'), 'language:typescript stars:>100')
  assert.equal(u.searchParams.get('sort'), 'stars')
  assert.equal(u.searchParams.get('order'), 'desc')
  assert.equal(u.searchParams.get('per_page'), '20')
  assert.equal(out.totalCount, 1)
})

test('gh_search_issues：issue/PR 搜索', async () => {
  const c = makeContext(capture(() => ok({ total_count: 1, items: [issueBody] })))
  const out = await c.registry.call('gh_search_issues', { query: 'repo:octo/hello bug', sort: 'created', order: 'asc' }, c.services)
  const u = new URL(c.last().url)
  assert.equal(u.pathname, '/search/issues')
  assert.equal(u.searchParams.get('q'), 'repo:octo/hello bug')
  assert.equal(out.items[0].number, 1)
})

test('gh_search_code：代码搜索', async () => {
  const c = makeContext(capture(() => ok({
    total_count: 1,
    items: [{ name: 'a.js', path: 'src/a.js', html_url: 'https://github.com/o/r/blob/main/src/a.js', repository: { full_name: 'o/r' } }],
  })))
  const out = await c.registry.call('gh_search_code', { query: 'repo:o/r language:js fetch' }, c.services)
  assert.equal(new URL(c.last().url).pathname, '/search/code')
  assert.equal(out.items[0].repository, 'o/r')
})

test('gh_whoami：身份与配额', async () => {
  const c = makeContext(capture(() => ok({
    login: 'octo', name: 'Octo Cat', id: 1, html_url: 'https://github.com/octo',
  })), { token: 'tok' })
  const out = await c.registry.call('gh_whoami', {}, c.services)
  assert.equal(out.login, 'octo')
  assert.equal(out.tokenMode, 'env')
  assert.equal(out.tokenSource, 'env')
  assert.equal(out.readOnly, false)
})

test('gh_whoami：无 token 时不发请求，给出指引', async () => {
  const handler = capture(() => { throw new Error('不应发起请求') })
  const fetchImpl = makeFakeFetch(handler)
  const auth = new CredentialHub({ token: null, fetchImpl })
  const config = { baseUrl: 'https://api.example.test', readOnly: false, timeoutMs: 1000, userAgent: 'u', oauthClientId: null, tokenFile: null }
  const gateway = new Gateway({ ...config, token: null, fetchImpl })
  const services = { auth, config, gateway, version: { name: 'repogate', version: '1.0.0' } }
  const registry = buildRegistry(services)
  const out = await registry.call('gh_whoami', {}, services)
  assert.equal(out.tokenMode, 'none')
  assert.match(out.hint, /REPOGATE_TOKEN|gh_auth_login/)
  assert.equal(requests.length, 0)
})

test('gh_auth_login：发起设备授权并给出指引', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-tools-'))
  try {
    const c = makeContext(capture(() => ({
      status: 200,
      body: { device_code: 'dc', user_code: 'CODE-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 },
    })), { token: null, config: { oauthClientId: 'Iv1.x', tokenFile: join(dir, 'tok.json') } })
    const out = await c.registry.call('gh_auth_login', { scope: 'repo' }, c.services)
    assert.equal(out.userCode, 'CODE-1234')
    assert.match(out.hint, /CODE-1234/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gh_auth_check：pending 状态透传', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repogate-tools-'))
  try {
    let n = 0
    const c = makeContext(capture(() => {
      n += 1
      return n === 1
        ? { status: 200, body: { device_code: 'dc', user_code: 'C-1', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 } }
        : { status: 200, body: { error: 'authorization_pending' } }
    }), {
      token: null,
      config: { oauthClientId: 'Iv1.x', tokenFile: join(dir, 'tok.json') },
    })
    await c.registry.call('gh_auth_login', {}, c.services)
    const out = await c.registry.call('gh_auth_check', {}, c.services)
    assert.equal(out.status, 'pending')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gh_auth_logout：清除缓存', async () => {
  const c = makeContext(capture(() => ({ status: 200, body: {} })), { token: null, config: { tokenFile: null } })
  const out = await c.registry.call('gh_auth_logout', {}, c.services)
  assert.equal(out.cleared, false)
  assert.match(out.hint, /没有缓存|直接/)
})

test('分页参数边界：perPage 上限 100', async () => {
  const c = makeContext(capture(() => ok({ items: [] })))
  await assert.rejects(() => c.registry.call('gh_issue_browse', { owner: 'o', repo: 'r', perPage: 101 }, c.services), /perPage/)
})

test('只读模式：全部变更工具被拦截，查询工具放行', async () => {
  const c = makeContext(capture(() => ok(issueBody)), { readOnly: true })
  for (const [name, args] of [
    ['gh_issue_open', { owner: 'o', repo: 'r', title: 'x' }],
    ['gh_issue_edit', { owner: 'o', repo: 'r', number: 1, state: 'closed' }],
    ['gh_issue_respond', { owner: 'o', repo: 'r', number: 1, body: 'x' }],
    ['gh_pr_open', { owner: 'o', repo: 'r', title: 'x', head: 'h', base: 'b' }],
    ['gh_pr_edit', { owner: 'o', repo: 'r', number: 1, title: 'x' }],
    ['gh_pr_merge', { owner: 'o', repo: 'r', number: 1 }],
    ['gh_review_submit', { owner: 'o', repo: 'r', number: 1, event: 'approve' }],
    ['gh_review_comment', { owner: 'o', repo: 'r', number: 1, body: 'x', path: 'a', line: 1 }],
  ]) {
    await assert.rejects(() => c.registry.call(name, args, c.services), (err) => err.code === 'readonly', `${name} 应被只读拦截`)
  }
  const fetched = await c.registry.call('gh_issue_fetch', { owner: 'o', repo: 'r', number: 1 }, c.services)
  assert.equal(fetched.number, 1)
})
