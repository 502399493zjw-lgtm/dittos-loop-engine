import { describe, it, expect } from 'vitest'
import { fakeSessionBus } from '../src/loop/sessionBus'

describe('fakeSessionBus', () => {
  it('createSession returns a stable id and records the call', async () => {
    const bus = fakeSessionBus()
    const a = await bus.createSession('proj-1', { title: 'morning run' })
    expect(a.sessionId).toMatch(/^sess-/)
    expect(bus.calls).toEqual([{ kind: 'create', projectId: 'proj-1', title: 'morning run' }])
  })

  it('postMessage records the target session + text', async () => {
    const bus = fakeSessionBus()
    const { sessionId } = await bus.createSession('proj-1')
    await bus.postMessage(sessionId, 'hello')
    expect(bus.calls).toContainEqual({ kind: 'post', sessionId, text: 'hello' })
  })
})
