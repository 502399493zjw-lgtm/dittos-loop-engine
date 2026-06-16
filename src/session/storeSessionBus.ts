import type { SessionBus } from '../loop/sessionBus'
import type { SessionStore } from './types'

/**
 * The real SessionBus, backed by a SessionStore. Implements the existing
 * loop-side SessionBus seam (src/loop/sessionBus.ts): a loop run opens a
 * session under its project and posts its narration in as the agent.
 */
export function storeSessionBus(store: SessionStore): SessionBus {
  return {
    async createSession(projectId, opts) {
      const session = await store.createSession(projectId, opts)
      return { sessionId: session.id }
    },
    async postMessage(sessionId, text) {
      await store.appendMessage(sessionId, { sender_type: 'agent', type: 'text', content: { text } })
    },
  }
}
