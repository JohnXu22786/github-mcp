/**
 * issue 类工具：创建、查看、浏览、编辑与评论。
 * 说明：GitHub 的 issue 评论端点同时适用于 PR 的对话区评论。
 */
import { repoPath, summarizeIssue, wrapList } from '../util/format.js'
import { RepogateError, ErrorCodes } from '../core/errors.js'

export function issueTools({ gateway }) {
  const issuesPath = (owner, repo) => `${repoPath(owner, repo)}/issues`

  return [
    {
      name: 'gh_issue_open',
      description: '创建新 issue：标题必填，可附正文、标签与负责人。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          title: { type: 'string', description: 'issue 标题' },
          body: { type: 'string', description: '正文（支持 Markdown）' },
          labels: { type: 'array', items: { type: 'string' }, description: '标签名列表' },
          assignees: { type: 'array', items: { type: 'string' }, description: '负责人的 GitHub 用户名列表' },
        },
        required: ['owner', 'repo', 'title'],
      },
      async execute(args) {
        const body = {}
        for (const key of ['title', 'body', 'labels', 'assignees']) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        const { data } = await gateway.request('POST', issuesPath(args.owner, args.repo), { body })
        return summarizeIssue(data)
      },
    },
    {
      name: 'gh_issue_fetch',
      description: '查看单个 issue 的完整信息：状态、正文、标签、负责人、评论数等。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'issue 编号' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const { data } = await gateway.request('GET', `${issuesPath(args.owner, args.repo)}/${args.number}`)
        return {
          number: data.number,
          title: data.title,
          state: data.state,
          body: data.body,
          htmlUrl: data.html_url,
          user: data.user?.login ?? null,
          labels: (data.labels ?? []).map((l) => l.name ?? l),
          assignees: (data.assignees ?? []).map((a) => a.login),
          createdAt: data.created_at,
          updatedAt: data.updated_at,
          closedAt: data.closed_at,
          comments: data.comments,
          pullRequest: Boolean(data.pull_request),
        }
      },
    },
    {
      name: 'gh_issue_browse',
      description: '浏览/筛选仓库中的 issue：按状态、标签、负责人、创建者筛选，支持分页；默认同时包含 PR，可用 includePulls 排除。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态筛选，默认 open' },
          label: { type: 'string', description: '按标签筛选' },
          assignee: { type: 'string', description: '按负责人筛选（anyone 表示任何人）' },
          creator: { type: 'string', description: '按创建者筛选' },
          since: { type: 'string', description: '仅返回该 ISO 时间之后的条目' },
          includePulls: { type: 'boolean', description: '是否包含 PR 条目，默认 true' },
          page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
          perPage: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 30' },
        },
        required: ['owner', 'repo'],
      },
      async execute(args) {
        const page = args.page ?? 1
        const perPage = args.perPage ?? 30
        const { data, headers } = await gateway.request('GET', issuesPath(args.owner, args.repo), {
          query: {
            state: args.state ?? 'open',
            label: args.label,
            assignee: args.assignee,
            creator: args.creator,
            since: args.since,
            page,
            per_page: perPage,
          },
        })
        const wrapped = wrapList(data, { page, perPage, headers })
        const items = args.includePulls === false
          ? wrapped.items.filter((i) => !i.pull_request)
          : wrapped.items
        return { ...wrapped, items: items.map(summarizeIssue) }
      },
    },
    {
      name: 'gh_issue_edit',
      description: '更新 issue：标题、正文、状态（开/关）、负责人与标签；只提交提供的字段。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'issue 编号' },
          title: { type: 'string', description: '新标题' },
          body: { type: 'string', description: '新正文' },
          state: { type: 'string', enum: ['open', 'closed'], description: '新状态' },
          assignees: { type: 'array', items: { type: 'string' }, description: '新的负责人列表' },
          labels: { type: 'array', items: { type: 'string' }, description: '新的标签列表' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const patch = {}
        for (const key of ['title', 'body', 'state', 'assignees', 'labels']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        const { data } = await gateway.request('PATCH', `${issuesPath(args.owner, args.repo)}/${args.number}`, { body: patch })
        return summarizeIssue(data)
      },
    },
    {
      name: 'gh_issue_respond',
      description: '在 issue（或 PR 对话区）发表评论。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'issue 编号（PR 对话区同样适用）' },
          body: { type: 'string', description: '评论正文（支持 Markdown）' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
      async execute(args) {
        const { data } = await gateway.request(
          'POST',
          `${issuesPath(args.owner, args.repo)}/${args.number}/comments`,
          { body: { body: args.body } },
        )
        return {
          id: data.id,
          htmlUrl: data.html_url,
          user: data.user?.login ?? null,
          body: data.body,
          createdAt: data.created_at,
        }
      },
    },
  ]
}
