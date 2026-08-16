/**
 * 输出整形：把 GitHub API 的完整响应裁剪为对模型友好、省 token 的摘要。
 * 单条实体（fetch 类工具）返回较全字段，列表/搜索返回精简摘要。
 */

export function jsonText(value) {
  const text = JSON.stringify(value, null, 2)
  // JSON.stringify(undefined) 返回 undefined，避免产出畸形的 content 块
  return text === undefined ? 'null' : text
}

export function summarizeRepo(r) {
  return {
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    htmlUrl: r.html_url,
    stars: r.stargazers_count,
    forks: r.forks_count,
    language: r.language,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }
}

export function summarizeIssue(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    htmlUrl: i.html_url,
    user: i.user?.login ?? null,
    labels: (i.labels ?? []).map((l) => l.name ?? l),
    assignees: (i.assignees ?? []).map((a) => a.login),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    comments: i.comments,
    pullRequest: Boolean(i.pull_request),
  }
}

export function summarizePr(p) {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    htmlUrl: p.html_url,
    user: p.user?.login ?? null,
    draft: p.draft ?? false,
    mergeable: p.mergeable,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
  }
}

export function summarizeComment(c) {
  return {
    id: c.id,
    htmlUrl: c.html_url,
    user: c.user?.login ?? null,
    body: c.body,
    createdAt: c.created_at,
  }
}

export function summarizeReview(r) {
  return {
    id: r.id,
    state: r.state,
    user: r.user?.login ?? null,
    body: r.body,
    submittedAt: r.submitted_at,
    htmlUrl: r.html_url,
  }
}

export function summarizeCodeHit(h) {
  return {
    name: h.name,
    path: h.path,
    repository: h.repository?.full_name ?? null,
    htmlUrl: h.html_url,
  }
}

/** 从 Link 头推断是否还有下一页 */
export function parsePagination(headers) {
  const link = headers?.get?.('link') ?? headers?.link ?? ''
  return { hasMore: /rel="?next"?/i.test(link) }
}

/** 列表类响应的统一包装（GitHub 部分端点直接返回数组，部分返回 { items }） */
export function wrapList(data, { page = 1, perPage = 30, headers = null } = {}) {
  const items = Array.isArray(data) ? data : (data?.items ?? [])
  const { hasMore } = parsePagination(headers)
  return { items, page, perPage, hasMore }
}

/** 仓库路径：/repos/{owner}/{repo}，逐段转义 */
export function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}
