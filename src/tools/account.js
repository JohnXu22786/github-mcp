/**
 * 账户与认证类工具：身份与配额查询、OAuth 设备授权全流程。
 * 这些工具只读写本地配置，不修改 GitHub 上的数据，因此只读模式下仍可用。
 */

const LOGIN_HINT = '开始授权：调用 gh_auth_login 获取授权地址与代码，用户完成授权后调用 gh_auth_check 确认令牌生效。'

export function accountTools({ auth, config, gateway }) {
  return [
    {
      name: 'gh_whoami',
      description: '查询当前身份：登录用户、令牌来源、只读模式与剩余 API 配额；未配置令牌时返回配置指引。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() {
        if (!auth.hasToken() && auth.tokenMode === 'none') {
          return {
            login: null,
            tokenMode: 'none',
            tokenSource: config.tokenSource ?? null,
            readOnly: config.readOnly,
            hint: '未配置访问令牌：可设置环境变量 REPOGATE_TOKEN（兼容 GITHUB_TOKEN / GH_TOKEN）、在配置文件中提供 token 字段，或配置 oauth.clientId 后调用 gh_auth_login 完成授权。',
          }
        }
        if (!auth.hasToken() && auth.tokenMode === 'oauth') {
          return {
            login: null,
            tokenMode: 'oauth',
            tokenSource: config.tokenSource ?? null,
            readOnly: config.readOnly,
            hint: LOGIN_HINT,
          }
        }
        const { data, rateLimit } = await gateway.request('GET', '/user')
        return {
          login: data.login,
          name: data.name ?? null,
          id: data.id,
          htmlUrl: data.html_url,
          tokenMode: auth.tokenMode,
          tokenSource: config.tokenSource ?? null,
          readOnly: config.readOnly,
          rateLimit,
        }
      },
    },
    {
      name: 'gh_auth_login',
      description: '发起 OAuth 设备授权：返回用户需要访问的地址与一次性代码。需要配置文件中的 oauth.clientId。',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: '请求的权限范围（空格分隔），默认 repo' },
        },
        required: [],
      },
      async execute(args) {
        const flow = await auth.startDeviceFlow(args.scope ?? 'repo')
        return {
          verificationUri: flow.verificationUri,
          userCode: flow.userCode,
          expiresIn: flow.expiresIn,
          interval: flow.interval,
          hint: `请让用户打开 ${flow.verificationUri} 并输入一次性代码 ${flow.userCode}（在 ${flow.expiresIn} 秒内有效）。完成后调用 gh_auth_check 确认令牌落地。`,
        }
      },
    },
    {
      name: 'gh_auth_check',
      description: '轮询一次 OAuth 设备授权结果：已授权（granted）/ 等待中（pending）/ 拒绝（denied）/ 过期（expired）。每次调用只查一次。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() {
        const out = await auth.pollDeviceFlow()
        switch (out.status) {
          case 'no-flow':
            return { status: 'no-flow', hint: '当前没有进行中的设备授权。如需开始授权，请调用 gh_auth_login。' }
          case 'pending':
            return { status: 'pending', hint: `用户尚未完成授权，请 ${out.retryAfterSeconds} 秒后再次调用 gh_auth_check。` }
          case 'granted':
            return {
              status: 'granted',
              tokenMode: auth.tokenMode,
              hint: out.already
                ? '令牌已就绪，无需重复确认。'
                : '授权成功，令牌已缓存，现在可以正常调用其他工具。',
            }
          case 'expired':
            return { status: 'expired', hint: '授权码已过期，请重新调用 gh_auth_login。' }
          case 'denied':
            return { status: 'denied', hint: '用户拒绝了授权。如需重试，请重新调用 gh_auth_login。' }
          default:
            return { status: 'error', message: out.message, hint: '请重新调用 gh_auth_login 重试。' }
        }
      },
    },
    {
      name: 'gh_auth_logout',
      description: '清除本地缓存的 OAuth 令牌文件；不影响环境变量/配置文件中的令牌。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() {
        const cleared = auth.discardToken()
        return {
          cleared,
          hint: cleared
            ? '已清除本地缓存的令牌。'
            : '没有缓存的令牌可清除（当前没有使用 OAuth 令牌文件，或令牌来自环境变量/配置文件）。',
        }
      },
    },
  ]
}
