import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppendMessageInput, Message, SenderType, Session, SessionStore } from './types'

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
        ...(opts?.ownerId !== undefined ? { ownerId: opts.ownerId } : {}),
        createdAt: now(),
      }
      const sessions = readAll<Session>(sessionsFile)
      sessions.push(session)
      writeAll(sessionsFile, sessions)
      return session
    },
    async listSessions(projectId, opts) {
      const sessions = readAll<Session>(sessionsFile)
      return sessions.filter((s) =>
        (projectId === undefined || s.projectId === projectId) &&
        (opts?.ownerId === undefined || s.ownerId === opts.ownerId),
      )
    },
    async appendMessage(sessionId, msg: AppendMessageInput) {
      // Normalise the legacy ({ sender, text }) and contract ({ sender_type, content })
      // shapes into one, then mirror both onto the stored Message.
      const senderType: SenderType = 'sender_type' in msg ? msg.sender_type : msg.sender
      const text = 'content' in msg ? msg.content.text : msg.text
      // The legacy `sender` field only models agent|user; map system→agent for it.
      const legacySender: 'agent' | 'user' = senderType === 'user' ? 'user' : 'agent'

      const messages = readAll<Message>(messagesFile)
      // Dense per-channel seq: continue from the persisted max for this channel.
      const channelSeqs = messages.filter((m) => m.channel_id === sessionId).map((m) => m.seq)
      const seq = channelSeqs.length === 0 ? 0 : Math.max(...channelSeqs) + 1
      const ts = now()

      const message: Message = {
        // Caller may supply the id (e.g. a streaming bubble id) so chunks and
        // the persisted message share one message_id; otherwise mint one.
        id: msg.id ?? randomUUID(),
        channel_id: sessionId,
        sender_id: msg.sender_id ?? senderType,
        sender_type: senderType,
        type: msg.type ?? 'text',
        content: { text },
        seq,
        ...(msg.turn_id !== undefined ? { turn_id: msg.turn_id } : {}),
        ...(msg.reply_to !== undefined ? { reply_to: msg.reply_to } : {}),
        created_at: ts,
        ...(msg.streaming !== undefined ? { streaming: msg.streaming } : {}),
        // legacy mirror
        sessionId,
        sender: legacySender,
        text,
        ts,
      }
      messages.push(message)
      writeAll(messagesFile, messages)
      return message
    },
    async getMessages(sessionId) {
      // Persisted in append order, which is chronological.
      return readAll<Message>(messagesFile).filter((m) => m.sessionId === sessionId)
    },
    async setTitle(sessionId, title) {
      const sessions = readAll<Session>(sessionsFile)
      const s = sessions.find((x) => x.id === sessionId)
      if (s) { s.title = title; writeAll(sessionsFile, sessions) }
    },
  }
}
