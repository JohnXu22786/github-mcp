/**
 * 仓库类工具：查看仓库详情、按归属列出仓库。
 */
import { repoPath, summarizeRepo, wrapList } from '../util/format.js'
import { RepogateError, ErrorCodes } from '../core/errors.js'

/** 两个端点的 type 取值集合不同（GitHub 官方文档），运行时按 kind 校验 */
const USER_REPO_TYPES = new Set(['all', 'owner', 'public', 'private', 'member'])
const ORG_REPO_TYPES = new Set(['all', 'public', 'private', 'forks', 'sources', 'member'])

export function repoTools({ gateway }) {
  return [
    {
      name: 'gh_repo_fetch',
      description: '获取仓库详情：默认分支、可见性、描述、星标数、主要语言与最近更新时间。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
        },
        required: ['owner', 'repo'],
      },
      async execute(args) {
        const { data } = await gateway.request('GET', repoPath(args.owner, args.repo))
        return {
          name: data.name,
          fullName: data.full_name,
          private: data.private,
          description: data.description,
          htmlUrl: data.html_url,
          defaultBranch: data.default_branch,
          language: data.language,
          stars: data.stargazers_count,
          forks: data.forks_count,
          openIssues: data.open_issues_count,
          owner: data.owner?.login ?? null,
          createdAt: data.created_at,
          updatedAt: data.updated_at,
        }
      },
    },
    {
      name: 'gh_repo_browse',
      description: '按归属列出仓库：某用户、某组织或当前登录者自己的仓库，支持分页。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '用户或组织名；缺省时列出当前登录者的仓库' },
          kind: { type: 'string', enum: ['user', 'org'], description: 'owner 的类型，默认 user' },
          type: {
            type: 'string',
            enum: [...USER_REPO_TYPES, ...ORG_REPO_TYPES],
            description: '筛选仓库类型（取值随 owner 类型不同而受限，非法组合会被拒绝）',
          },
          sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: '排序字段' },
          direction: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
          page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
          perPage: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 30' },
        },
        required: [],
      },
      async execute(args) {
        let path
        // 端点决定可用的 type 集合：无 owner 时无论 kind 如何都走 /user/repos
        const endpointKind = args.owner ? (args.kind ?? 'user') : 'user'
        if (args.owner) {
          path = `/${endpointKind === 'org' ? 'orgs' : 'users'}/${encodeURIComponent(args.owner)}/repos`
        } else {
          path = '/user/repos'
        }
        if (args.type) {
          const allowed = endpointKind === 'org' ? ORG_REPO_TYPES : USER_REPO_TYPES
          if (!allowed.has(args.type)) {
            throw new RepogateError(
              `type=${args.type} 对该端点不可用（可选：${[...allowed].join(' / ')}）`,
              { code: ErrorCodes.VALIDATION },
            )
          }
        }
        const page = args.page ?? 1
        const perPage = args.perPage ?? 30
        const { data, headers } = await gateway.request('GET', path, {
          query: {
            type: args.type,
            sort: args.sort,
            direction: args.direction,
            page,
            per_page: perPage,
          },
        })
        const wrapped = wrapList(data, { page, perPage, headers })
        return { ...wrapped, items: wrapped.items.map(summarizeRepo) }
      },
    },
  ]
}
