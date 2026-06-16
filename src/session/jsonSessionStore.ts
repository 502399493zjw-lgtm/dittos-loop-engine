import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message, Session, SessionStore } from './types'

/**
 * jsonSessionStore — JSON-backed, in-process session/chat persistence.
 *
 * Mirrors jsonLoopStore: mkdir -p the dir, persist whole collections to JSON
 * files under it (sessions.json + messages.json), read-modify-write on each
 * mutation. ids via randomUUID; timestamps via the injectable clock so tests
 * stay deterministic (like scheduler's `now`).
 */
export function jsonSessionStore(dir: string, opts?: { now?: () => number }): SessionStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const now = opts?.now ?? Date.now
  const sessionsFile = join(dir, 'sessions.json')
  const messagesFile = join(dir, 'messages.json')

  const readAll = <T>(file: string): T[] => {
    if (!existsSync(file)) return []
    return JSON.parse(readFileSync(file, 'utf8')) as T[]
  }
  const writeAll = <T>(file: string, rows: T[]) => { writeFileSync(file, JSON.stringify(rows, null, 2) + '\n') }

  return {
    async createSession(projectId, opts) {
      const session: Session = {
        id: randomUUID(),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(opts?.title !== undefined ? { title: opts.title } : {}),
        createdAt: now(),
      }
      const sessions = readAll<Session>(sessionsFile)
      sessions.push(session)
      writeAll(sessionsFile, sessions)
      return session
    },
    async listSessions(projectId) {
      const sessions = readAll<Session>(sessionsFile)
      return projectId === undefined ? sessions : sessions.filter((s) => s.projectId === projectId)
    },
    async appendMessage(sessionId, msg) {
      const message: Message = { id: randomUUID(), sessionId, sender: msg.sender, text: msg.text, ts: now() }
      const messages = readAll<Message>(messagesFile)
      messages.push(message)
      writeAll(messagesFile, messages)
      return message
    },
    async getMessages(sessionId) {
      // Persisted in append order, which is chronological.
      return readAll<Message>(messagesFile).filter((m) => m.sessionId === sessionId)
    },
  }
}
