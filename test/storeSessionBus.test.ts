import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { storeSessionBus } from '../src/session/storeSessionBus'

const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('storeSessionBus over a real jsonSessionStore', () => {
  it('createSession delegates: lands a session in the store under its project', async () => {
    const store = jsonSessionStore(mkdtempSync(join(tmpdir(), 'ssb-')), { now: clock() })
    const bus = storeSessionBus(store)
    const { sessionId } = await bus.createSession('proj-1', { title: 'morning run' })
    const sessions = await store.listSessions('proj-1')
    expect(sessions.map((s) => s.id)).toEqual([sessionId])
    expect(sessions[0]?.projectId).toBe('proj-1')
    expect(sessions[0]?.title).toBe('morning run')
  })

  it('postMessage appends to the store as sender agent', async () => {
    const store = jsonSessionStore(mkdtempSync(join(tmpdir(), 'ssb-')), { now: clock() })
    const bus = storeSessionBus(store)
    const { sessionId } = await bus.createSession(undefined)
    await bus.postMessage(sessionId, 'narration')
    const msgs = await store.getMessages(sessionId)
    expect(msgs.map((m) => ({ sessionId: m.sessionId, sender: m.sender, text: m.text }))).toEqual([
      { sessionId, sender: 'agent', text: 'narration' },
    ])
  })
})
