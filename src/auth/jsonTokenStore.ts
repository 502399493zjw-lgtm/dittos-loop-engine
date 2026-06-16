import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TokenStore } from './types'

/**
 * jsonTokenStore — JSON-backed, in-process bearer-token persistence.
 *
 * Mirrors jsonSessionStore: mkdir -p the dir, persist the whole map to
 * tokens.json under it, read-modify-write on issue. Tokens are opaque random
 * (randomUUID) strings; the store keeps token -> userId. issue() may be called
 * many times per user (each login mints a fresh token); resolve() is undefined
 * for unknown tokens.
 */
export function jsonTokenStore(dir: string): TokenStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tokensFile = join(dir, 'tokens.json')

  const readAll = (): Record<string, string> => {
    if (!existsSync(tokensFile)) return {}
    return JSON.parse(readFileSync(tokensFile, 'utf8')) as Record<string, string>
  }
  const writeAll = (map: Record<string, string>) => { writeFileSync(tokensFile, JSON.stringify(map, null, 2) + '\n') }

  return {
    async issue(userId) {
      const token = randomUUID()
      const map = readAll()
      map[token] = userId
      writeAll(map)
      return token
    },
    async resolve(token) {
      return readAll()[token]
    },
  }
}
