/** A chat session — a scoped conversation, optionally under a project. */
export interface Session {
  id: string
  projectId?: string
  title?: string
  /** The user who owns this session; set by the HTTP surface / runner when scoping. Unowned = visible to all (dev). */
  ownerId?: string
  createdAt: number
}

/** Who a message is from. The frontend chat contract uses sender_type. */
export type SenderType = 'user' | 'agent' | 'system'

/** Message content body. Text is the only kind in v1. */
export interface MessageContent {
  text: string
}

/**
 * A single message in a session/channel. Aligned to the standalone-chat wire
 * contract (§1): sender_type / type / content / seq / turn_id / reply_to /
 * created_at. The legacy `sender` / `text` / `ts` / `sessionId` fields are kept
 * as a back-compat mirror so existing session+loop callers stay green; a
 * channel === a session, so channel_id === sessionId.
 */
export interface Message {
  id: string
  /** Contract field; equals sessionId. */
  channel_id: string
  sender_id: string
  sender_type: SenderType
  /** Message kind; defaults to 'text'. */
  type: string
  content: MessageContent
  /** Dense, per-channel sequence number, starting at 0. */
  seq: number
  turn_id?: string
  reply_to?: string
  created_at: number
  streaming?: boolean

  // --- legacy back-compat mirror (existing session/loop callers) ---
  sessionId: string
  sender: 'agent' | 'user'
  text: string
  ts: number
}

/**
 * Input to appendMessage. Either the legacy shape ({ sender, text }) or the
 * richer contract shape ({ sender_type, type?, content, turn_id?, reply_to? }).
 * The store fills the rest (id, seq, channel_id, created_at) and mirrors the two
 * shapes onto each other.
 */
export type AppendMessageInput =
  | { sender: 'agent' | 'user'; text: string; turn_id?: string; reply_to?: string; type?: string; streaming?: boolean; sender_id?: string; id?: string }
  | { sender_type: SenderType; content: MessageContent; type?: string; turn_id?: string; reply_to?: string; streaming?: boolean; sender_id?: string; id?: string }

/**
 * Standalone session/chat persistence. JSON-backed, in-process. Mirrors the
 * shape of LoopStore: small async surface, an injectable clock for tests.
 */
export interface SessionStore {
  createSession(projectId: string | undefined, opts?: { title?: string; ownerId?: string }): Promise<Session>
  /** Filter by project when given; further narrow to one owner when opts.ownerId is set. */
  listSessions(projectId?: string, opts?: { ownerId?: string }): Promise<Session[]>
  /** Appends a message, assigning a dense per-channel seq. Accepts the legacy or contract shape. */
  appendMessage(sessionId: string, msg: AppendMessageInput): Promise<Message>
  /** Messages for one session, chronological (ascending seq). */
  getMessages(sessionId: string): Promise<Message[]>
  /** Set a session's display title (e.g. derived from its first user message). */
  setTitle(sessionId: string, title: string): Promise<void>
}
