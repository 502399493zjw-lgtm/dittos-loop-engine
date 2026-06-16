/** A chat session — a scoped conversation, optionally under a project. */
export interface Session {
  id: string
  projectId?: string
  title?: string
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
  createSession(projectId: string | undefined, opts?: { title?: string }): Promise<Session>
  /** Filter by project when given, else return all sessions. */
  listSessions(projectId?: string): Promise<Session[]>
  appendMessage(sessionId: string, msg: { sender: 'agent' | 'user'; text: string }): Promise<Message>
  /** Messages for one session, chronological. */
  getMessages(sessionId: string): Promise<Message[]>
}
