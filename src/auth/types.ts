/** A local user, one per GitHub account. Loops + sessions are scoped by `id`. */
export interface User {
  id: string
  githubId: number
  login: string
  name?: string
  createdAt: number
}

/**
 * User persistence. JSON-backed, in-process. Mirrors the shape of the other
 * stores: small async surface, an injectable clock for tests.
 */
export interface UserStore {
  /** Find-or-create by GitHub id; on re-login refreshes login/name, keeps id + createdAt. */
  upsertByGithub(gh: { id: number; login: string; name?: string }): Promise<User>
  getById(id: string): Promise<User | undefined>
}

/** Opaque bearer-token persistence: token -> userId. */
export interface TokenStore {
  /** Mint a fresh opaque token bound to `userId`. */
  issue(userId: string): Promise<string>
  /** Resolve a token to its userId, or undefined if unknown. */
  resolve(token: string): Promise<string | undefined>
}
