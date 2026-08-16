/**
 * 拉取请求（PR）类工具：创建、查看、浏览、编辑与合并。
 */
import { repoPath, summarizePr, wrapList } from '../util/format.js'

export function pullTools({ gateway }) {
  const pullsPath = (owner, repo) => `${repoPath(owner, repo)}/pulls`

  return [
    {
      name: 'gh_pr_open',
      description: '创建拉取请求：需要目标分支（base）与来源分支（head），可标记草稿。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          title: { type: 'string', description: 'PR 标题' },
          head: { type: 'string', description: '来源分支名（本仓库分支或 owner:branch 跨仓库）' },
          base: { type: 'string', description: '目标分支名' },
          body: { type: 'string', description: '正文（支持 Markdown）' },
          draft: { type: 'boolean', description: '是否以草稿状态创建，默认 false' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
      async execute(args) {
        const body = {}
        for (const key of ['title', 'head', 'base', 'body', 'draft']) {
          if (args[key] !== undefined) body[key] = args[key]
        }
        const { data } = await gateway.request('POST', pullsPath(args.owner, args.repo), { body })
        return summarizePr(data)
      },
    },
    {
      name: 'gh_pr_fetch',
      description: '查看单个 PR 的完整状态：是否可合并、合并状态、变更统计、审查评论数等。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const { data } = await gateway.request('GET', `${pullsPath(args.owner, args.repo)}/${args.number}`)
        return {
          number: data.number,
          title: data.title,
          state: data.state,
          body: data.body,
          htmlUrl: data.html_url,
          user: data.user?.login ?? null,
          draft: data.draft ?? false,
          base: data.base?.ref ?? null,
          head: data.head?.ref ?? null,
          mergeable: data.mergeable,
          mergeableState: data.mergeable_state,
          merged: data.merged,
          mergedAt: data.merged_at,
          additions: data.additions,
          deletions: data.deletions,
          changedFiles: data.changed_files,
          commits: data.commits,
          comments: data.comments,
          reviewComments: data.review_comments,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        }
      },
    },
    {
      name: 'gh_pr_browse',
      description: '浏览/筛选仓库中的 PR：按状态、来源分支、目标分支筛选，可排序，支持分页。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态筛选，默认 open' },
          head: { type: 'string', description: '按来源分支筛选' },
          base: { type: 'string', description: '按目标分支筛选' },
          sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: '排序字段' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
          page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
          perPage: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 30' },
        },
        required: ['owner', 'repo'],
      },
      async execute(args) {
        const page = args.page ?? 1
        const perPage = args.perPage ?? 30
        const { data, headers } = await gateway.request('GET', pullsPath(args.owner, args.repo), {
          query: {
            state: args.state ?? 'open',
            head: args.head,
            base: args.base,
            sort: args.sort,
            direction: args.direction,
            page,
            per_page: perPage,
          },
        })
        const wrapped = wrapList(data, { page, perPage, headers })
        return { ...wrapped, items: wrapped.items.map(summarizePr) }
      },
    },
    {
      name: 'gh_pr_edit',
      description: '更新 PR 基本信息：标题、正文、状态、草稿标记、目标分支；只提交提供的字段。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
          title: { type: 'string', description: '新标题' },
          body: { type: 'string', description: '新正文' },
          state: { type: 'string', enum: ['open', 'closed'], description: '新状态' },
          draft: { type: 'boolean', description: '是否转草稿' },
          base: { type: 'string', description: '新的目标分支' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const patch = {}
        for (const key of ['title', 'body', 'state', 'draft', 'base']) {
          if (args[key] !== undefined) patch[key] = args[key]
        }
        const { data } = await gateway.request('PATCH', `${pullsPath(args.owner, args.repo)}/${args.number}`, { body: patch })
        return summarizePr(data)
      },
    },
    {
      name: 'gh_pr_merge',
      description: '合并 PR：可指定合并方式（merge/squash/rebase）与提交信息，可顺带删除来源分支。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
          commitTitle: { type: 'string', description: '合并提交标题' },
          commitMessage: { type: 'string', description: '合并提交正文' },
          method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: '合并方式，默认 merge' },
          deleteBranch: { type: 'boolean', description: '合并后删除来源分支，默认 false' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const body = {}
        if (args.commitTitle !== undefined) body.commit_title = args.commitTitle
        if (args.commitMessage !== undefined) body.commit_message = args.commitMessage
        if (args.method !== undefined) body.merge_method = args.method
        if (args.deleteBranch !== undefined) body.delete_branch = args.deleteBranch
        const { data } = await gateway.request(
          'PUT',
          `${pullsPath(args.owner, args.repo)}/${args.number}/merge`,
          { body },
        )
        return { merged: data.merged, message: data.message, sha: data.sha }
      },
    },
  ]
}
