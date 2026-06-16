import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

/**
 * daemonTokenStore — per-user daemon link tokens (spec §1). A user issues a
 * token from their logged-in account, then runs their local daemon with it in
 * `ENGINE_WS_URL`; `/daemon/ws` resolves the token back to the userId and
 * registers the conn under that user. Distinct from the bearer TokenStore
 * (auth/types): these tokens authenticate a DAEMON, not an API caller, and are
 * stored HASHED (sha256(token) -> userId) so the raw token never lands on disk.
 */
export interface DaemonTokenStore {
  /** Mint a fresh random token bound to `userId`; store sha256(token) -> userId. */
  issue(userId: string): Promise<string>
  /** Resolve a raw token to its userId by hashing + lookup, or undefined if unknown. */
  resolve(token: string): Promise<string | undefined>
}

/** Hex sha256 of a token — the key we persist (never the raw token). */
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A fresh random, URL-safe daemon token. */
const mintToken = (): string => randomBytes(32).toString('hex')

/**
 * jsonDaemonTokenStore — JSON-backed, in-process. Mirrors jsonTokenStore: mkdir
 * -p the dir, persist the whole map to daemon-tokens.json under it, read-modify-
 * write on issue. The map is sha256(token) -> userId.
 */
export function jsonDaemonTokenStore(dir: string): DaemonTokenStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tokensFile = join(dir, 'daemon-tokens.json')

  const readAll = (): Record<string, string> => {
    if (!existsSync(tokensFile)) return {}
    return JSON.parse(readFileSync(tokensFile, 'utf8')) as Record<string, string>
  }
  const writeAll = (map: Record<string, string>) => { writeFileSync(tokensFile, JSON.stringify(map, null, 2) + '\n') }

  return {
    async issue(userId) {
      const token = mintToken()
      const map = readAll()
      map[hashToken(token)] = userId
      writeAll(map)
      return token
    },
    async resolve(token) {
      if (!token) return undefined
      return readAll()[hashToken(token)]
    },
  }
}

/** In-memory variant for tests: same contract, no filesystem. */
export function inMemoryDaemonTokenStore(): DaemonTokenStore {
  const map = new Map<string, string>()
  return {
    async issue(userId) {
      const token = mintToken()
      map.set(hashToken(token), userId)
      return token
    },
    async resolve(token) {
      if (!token) return undefined
      return map.get(hashToken(token))
    },
  }
}
