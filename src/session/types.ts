/** A chat session — a scoped conversation, optionally under a project. */
export interface Session {
  id: string
  projectId?: string
  title?: string
  /** The user who owns this session; set by the HTTP surface / runner when scoping. Unowned = visible to all (dev). */
  ownerId?: string
  createdAt: number
}

/** A single message in a session, from either the agent or the user. */
export interface Message {
  id: string
  sessionId: string
  sender: 'agent' | 'user'
  text: string
  ts: number
}

/**
 * Standalone session/chat persistence. JSON-backed, in-process. Mirrors the
 * shape of LoopStore: small async surface, an injectable clock for tests.
 */
export interface SessionStore {
  createSession(projectId: string | undefined, opts?: { title?: string; ownerId?: string }): Promise<Session>
  /** Filter by project when given; further narrow to one owner when opts.ownerId is set. */
  listSessions(projectId?: string, opts?: { ownerId?: string }): Promise<Session[]>
  appendMessage(sessionId: string, msg: { sender: 'agent' | 'user'; text: string }): Promise<Message>
  /** Messages for one session, chronological. */
  getMessages(sessionId: string): Promise<Message[]>
}
