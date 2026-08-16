/**
 * 搜索类工具：仓库、issue/PR、代码。
 * 统一使用 GitHub 搜索语法（q 参数），例如：
 *   repo:octo/hello label:bug is:open
 */
import { summarizeIssue, summarizeRepo, summarizeCodeHit, parsePagination } from '../util/format.js'

/**
 * 生成一个搜索工具。sorts 为空数组表示该端点不支持 sort 参数（代码搜索）。
 */
function searchTool({ gateway, name, description, path, summarize, sorts }) {
  const properties = {
    query: {
      type: 'string',
      minLength: 1,
      description: 'GitHub 搜索语法，例如 "repo:octo/hello label:bug is:open"',
    },
    order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向，默认 desc' },
    page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
    perPage: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 30' },
  }
  if (sorts.length > 0) {
    properties.sort = { type: 'string', enum: ['best-match', ...sorts], description: '排序字段；缺省为最相关' }
  }
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required: ['query'] },
    async execute(args) {
      const page = args.page ?? 1
      const perPage = args.perPage ?? 30
      const query = { q: args.query, order: args.order }
      if (args.sort !== undefined && args.sort !== 'best-match') query.sort = args.sort
      const { data, headers } = await gateway.request('GET', path, {
        query: { ...query, page, per_page: perPage },
      })
      const { hasMore } = parsePagination(headers)
      return {
        totalCount: data.total_count ?? null,
        items: (data.items ?? []).map(summarize),
        page,
        perPage,
        hasMore,
      }
    },
  }
}

export function searchTools({ gateway }) {
  return [
    searchTool({
      gateway,
      name: 'gh_search_repos',
      description: '按关键词与筛选条件搜索仓库，返回精简摘要列表。',
      path: '/search/repositories',
      summarize: summarizeRepo,
      sorts: ['stars', 'forks', 'help-wanted-issues', 'updated'],
    }),
    searchTool({
      gateway,
      name: 'gh_search_issues',
      description: '搜索 issue 与 PR（可用 type:pr / type:issue 区分），返回精简摘要列表。',
      path: '/search/issues',
      summarize: summarizeIssue,
      sorts: ['comments', 'reactions', 'reactions-+1', 'created', 'updated'],
    }),
    searchTool({
      gateway,
      name: 'gh_search_code',
      description: '搜索代码（需要令牌；仅返回文件命中，不含文件内容），返回精简摘要列表。',
      path: '/search/code',
      summarize: summarizeCodeHit,
      sorts: [],
    }),
  ]
}
