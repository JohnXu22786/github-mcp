/**
 * 代码审查类工具：提交 review、行级评论、查看已有评论与 review 记录。
 * 术语：review = 一次整体审查（approve / request changes / comment）；
 *       review comment = 挂在 diff 某一行上的评论。
 */
import { repoPath, summarizeComment, summarizeReview, wrapList } from '../util/format.js'
import { RepogateError, ErrorCodes } from '../core/errors.js'

const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT']

export function reviewTools({ gateway }) {
  const pullsPath = (owner, repo) => `${repoPath(owner, repo)}/pulls`

  return [
    {
      name: 'gh_review_submit',
      description: '提交一次整体审查：通过（approve）、请求修改（request_changes）或仅评论（comment），可附综述。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
          event: { type: 'string', enum: ['approve', 'request_changes', 'comment'], description: '审查结论' },
          body: { type: 'string', description: '综述评论（支持 Markdown）' },
          commitId: { type: 'string', description: '针对的提交 SHA（缺省为最新提交）' },
        },
        required: ['owner', 'repo', 'number', 'event'],
      },
      async execute(args) {
        const body = { event: args.event.toUpperCase() }
        if (args.body !== undefined) body.body = args.body
        if (args.commitId !== undefined) body.commit_id = args.commitId
        const { data } = await gateway.request(
          'POST',
          `${pullsPath(args.owner, args.repo)}/${args.number}/reviews`,
          { body },
        )
        return summarizeReview(data)
      },
    },
    {
      name: 'gh_review_comment',
      description: '在 PR diff 的指定行上评论：给出文件路径与行号；startLine 提供时表示区间评论（要求 side 为 RIGHT）。',
      mutating: true,
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
          body: { type: 'string', description: '评论内容' },
          path: { type: 'string', description: '文件路径（相对仓库根）' },
          line: { type: 'integer', minimum: 1, description: '行号（必填；区间评论时为结束行）' },
          side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: '评论所在侧，默认 RIGHT' },
          startLine: { type: 'integer', minimum: 1, description: '区间评论的起始行（仅 side=RIGHT 时有效，须小于 line）' },
          commitId: { type: 'string', description: '针对的提交 SHA（缺省为最新提交）' },
        },
        required: ['owner', 'repo', 'number', 'body', 'path', 'line'],
      },
      async execute(args) {
        if (args.startLine !== undefined && args.side === 'LEFT') {
          throw new RepogateError(
            'startLine 区间评论要求 side 为 RIGHT（GitHub 只支持新文件侧的区间评论）。',
            { code: ErrorCodes.VALIDATION },
          )
        }
        if (args.startLine !== undefined && args.startLine >= args.line) {
          throw new RepogateError(
            'startLine（区间起始行）必须小于 line（区间结束行）。',
            { code: ErrorCodes.VALIDATION },
          )
        }
        const body = { body: args.body, path: args.path }
        // side 缺省即 RIGHT，区间评论时显式写出
        if (args.side !== undefined) body.side = args.side
        if (args.startLine !== undefined) {
          body.side = 'RIGHT'
          body.start_line = args.startLine
          body.start_side = 'RIGHT'
        }
        if (args.line !== undefined) body.line = args.line
        if (args.commitId !== undefined) body.commit_id = args.commitId
        const { data } = await gateway.request(
          'POST',
          `${pullsPath(args.owner, args.repo)}/${args.number}/comments`,
          { body },
        )
        return {
          id: data.id,
          htmlUrl: data.html_url,
          user: data.user?.login ?? null,
          path: data.path,
          line: data.line,
          side: data.side,
          body: data.body,
          createdAt: data.created_at,
        }
      },
    },
    {
      name: 'gh_review_fetch',
      description: '列出 PR 上的全部行级评论（含已解决的），支持分页。',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: '仓库所属用户或组织名' },
          repo: { type: 'string', description: '仓库名' },
          number: { type: 'integer', minimum: 1, description: 'PR 编号' },
          page: { type: 'integer', minimum: 1, description: '页码，默认 1' },
          perPage: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 30' },
        },
        required: ['owner', 'repo', 'number'],
      },
      async execute(args) {
        const page = args.page ?? 1
        const perPage = args.perPage ?? 30
        const { data, headers } = await gateway.request('GET', `${pullsPath(args.owner, args.repo)}/${args.number}/comments`, {
          query: { page, per_page: perPage },
        })
        const wrapped = wrapList(data, { page, perPage, headers })
        return { ...wrapped, items: wrapped.items.map(summarizeComment) }
      },
    },
    {
      name: 'gh_review_browse',
      description: '列出 PR 上已提交的整体审查记录（每次 approve / request changes 等）。',
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
        const { data } = await gateway.request('GET', `${pullsPath(args.owner, args.repo)}/${args.number}/reviews`)
        return { items: data.map(summarizeReview) }
      },
    },
  ]
}

export { REVIEW_EVENTS }
