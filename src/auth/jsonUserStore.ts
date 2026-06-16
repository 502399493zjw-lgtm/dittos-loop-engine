import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { User, UserStore } from './types'

/**
 * jsonUserStore — JSON-backed, in-process user persistence.
 *
 * Mirrors jsonSessionStore: mkdir -p the dir, persist the whole collection to
 * users.json under it, read-modify-write on each mutation. ids via randomUUID;
 * createdAt via the injectable clock so tests stay deterministic.
 *
 * upsertByGithub dedups by githubId: the same GitHub account always maps to the
 * same local User (id + createdAt preserved); login/name are refreshed each login.
 */
export function jsonUserStore(dir: string, opts?: { now?: () => number }): UserStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const now = opts?.now ?? Date.now
  const usersFile = join(dir, 'users.json')

  const readAll = (): User[] => {
    if (!existsSync(usersFile)) return []
    return JSON.parse(readFileSync(usersFile, 'utf8')) as User[]
  }
  const writeAll = (rows: User[]) => { writeFileSync(usersFile, JSON.stringify(rows, null, 2) + '\n') }

  return {
    async upsertByGithub(gh) {
      const users = readAll()
      const existing = users.find((u) => u.githubId === gh.id)
      if (existing) {
        existing.login = gh.login
        if (gh.name !== undefined) existing.name = gh.name
        writeAll(users)
        return existing
      }
      const user: User = {
        id: randomUUID(),
        githubId: gh.id,
        login: gh.login,
        ...(gh.name !== undefined ? { name: gh.name } : {}),
        createdAt: now(),
      }
      users.push(user)
      writeAll(users)
      return user
    },
    async getById(id) {
      return readAll().find((u) => u.id === id)
    },
  }
}
