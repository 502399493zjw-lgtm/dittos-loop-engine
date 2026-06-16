/**
 * GitHub OAuth client.
 *
 * An injectable interface so the server/tests swap in a fake (no network).
 * The real impl reads `{ clientId, clientSecret, callbackUrl }` from config and
 * talks to github.com / api.github.com via stdlib `fetch`. scope=read:user.
 */

export interface GithubUser {
  id: number
  login: string
  name?: string
}

export interface GithubOAuth {
  authorizeUrl(state: string): string
  exchangeCode(code: string): Promise<string>
  fetchUser(accessToken: string): Promise<GithubUser>
}

export interface GithubOAuthConfig {
  clientId: string
  clientSecret: string
  callbackUrl: string
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'

export function githubOAuth(cfg: GithubOAuthConfig): GithubOAuth {
  return {
    authorizeUrl(state) {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('client_id', cfg.clientId)
      url.searchParams.set('redirect_uri', cfg.callbackUrl)
      url.searchParams.set('scope', 'read:user')
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchangeCode(code) {
      const res = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: cfg.callbackUrl,
        }),
      })
      if (!res.ok) throw new Error(`github token exchange failed: ${res.status}`)
      const json = (await res.json()) as { access_token?: string; error?: string }
      if (!json.access_token) throw new Error(`github token exchange error: ${json.error ?? 'no access_token'}`)
      return json.access_token
    },
    async fetchUser(accessToken) {
      const res = await fetch(USER_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error(`github user fetch failed: ${res.status}`)
      const json = (await res.json()) as { id: number; login: string; name?: string | null }
      return {
        id: json.id,
        login: json.login,
        ...(json.name ? { name: json.name } : {}),
      }
    },
  }
}

export interface FakeGithubOAuth extends GithubOAuth {
  calls: {
    authorizeUrl: string[]
    exchangeCode: string[]
    fetchUser: string[]
  }
  /** Re-point which user the next fetchUser returns (lets one fake mint several users). */
  setUser(user: GithubUser): void
}

/**
 * Test double — no network, records calls, returns scripted values.
 */
export function fakeGithubOAuth(opts: { user: GithubUser; accessToken?: string }): FakeGithubOAuth {
  const accessToken = opts.accessToken ?? 'fake-access-token'
  let user = opts.user
  const calls = { authorizeUrl: [] as string[], exchangeCode: [] as string[], fetchUser: [] as string[] }
  return {
    calls,
    setUser(next) { user = next },
    authorizeUrl(state) {
      calls.authorizeUrl.push(state)
      const url = new URL('https://github.com/login/oauth/authorize')
      url.searchParams.set('client_id', 'fake-client-id')
      url.searchParams.set('scope', 'read:user')
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchangeCode(code) {
      calls.exchangeCode.push(code)
      return accessToken
    },
    async fetchUser(token) {
      calls.fetchUser.push(token)
      return user
    },
  }
}
