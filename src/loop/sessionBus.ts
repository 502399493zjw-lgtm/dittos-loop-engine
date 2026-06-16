/** The seam between the engine and a chat backend. A loop run uses it to open a
 *  session under its project and post messages into it (as the agent). The real
 *  impl wraps agent-im (later); tests use fakeSessionBus. */
export interface SessionBus {
  createSession(projectId: string | undefined, opts?: { title?: string }): Promise<{ sessionId: string }>
  postMessage(sessionId: string, text: string): Promise<void>
}

export type FakeSessionCall =
  | { kind: 'create'; projectId: string | undefined; title?: string }
  | { kind: 'post'; sessionId: string; text: string }

export interface FakeSessionBus extends SessionBus {
  calls: FakeSessionCall[]
}

export function fakeSessionBus(): FakeSessionBus {
  const calls: FakeSessionCall[] = []
  let n = 0
  return {
    calls,
    async createSession(projectId, opts) {
      const sessionId = `sess-${++n}`
      calls.push({ kind: 'create', projectId, ...(opts?.title ? { title: opts.title } : {}) })
      return { sessionId }
    },
    async postMessage(sessionId, text) {
      calls.push({ kind: 'post', sessionId, text })
    },
  }
}
