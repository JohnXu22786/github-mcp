/**
 * 测试辅助：本地 HTTP 服务，模拟 GitHub REST 接口的最小子集，
 * 用于端到端测试（真实 stdio 子进程 + 真实网络栈）。
 * 路由表：{ 'GET /repos/octo/hello': ({ query, body, headers }) => { status?, headers?, body? } }
 */
import { createServer } from 'node:http'

export function startMockApi(routes) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const key = `${req.method} ${url.pathname}`
    const route = routes[key]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: 'Not Found' }))
      return
    }
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', async () => {
      try {
        const out = await route({
          query: Object.fromEntries(url.searchParams),
          body: raw ? JSON.parse(raw) : null,
          headers: req.headers,
        })
        const status = out.status ?? 200
        res.writeHead(status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
        res.end(JSON.stringify(out.body ?? null))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ message: String(err && err.message ? err.message : err) }))
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

export const sampleRepo = {
  id: 1,
  name: 'hello',
  full_name: 'octo/hello',
  private: false,
  description: '示例仓库',
  html_url: 'https://github.com/octo/hello',
  default_branch: 'main',
  language: 'JavaScript',
  stargazers_count: 12,
  forks_count: 3,
  open_issues_count: 2,
  owner: { login: 'octo' },
}

export const sampleIssue = {
  id: 101,
  number: 1,
  title: '示例问题',
  state: 'open',
  body: '这是正文',
  html_url: 'https://github.com/octo/hello/issues/1',
  user: { login: 'octo' },
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'alice' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  comments: 0,
  pull_request: undefined,
}
