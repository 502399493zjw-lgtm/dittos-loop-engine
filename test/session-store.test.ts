import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonSessionStore } from '../src/session/jsonSessionStore'

// A deterministic clock so createdAt/ts are predictable across assertions.
const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('jsonSessionStore', () => {
  it('createSession returns a Session with id + createdAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const sess = await s.createSession('proj-1', { title: 'morning' })
    expect(sess.id).toBeTruthy()
    expect(sess.projectId).toBe('proj-1')
    expect(sess.title).toBe('morning')
    expect(sess.createdAt).toBe(1000)
  })

  it('listSessions filters by projectId and returns all when omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = jsonSessionStore(dir, { now: clock() })
    await s.createSession('proj-1')
    await s.createSession('proj-2')
    await s.createSession(undefined)
    expect((await s.listSessions('proj-1')).map((x) => x.projectId)).toEqual(['proj-1'])
    expect((await s.listSessions()).length).toBe(3)
  })

  it('appendMessage returns a Message and getMessages returns them chronologically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const sess = await s.createSession('proj-1') // ts 1000
    const m1 = await s.appendMessage(sess.id, { sender: 'user', text: 'hi' }) // ts 2000
    const m2 = await s.appendMessage(sess.id, { sender: 'agent', text: 'hello' }) // ts 3000
    expect(m1.id).toBeTruthy()
    expect(m1.sessionId).toBe(sess.id)
    expect(m1.sender).toBe('user')
    expect(m1.text).toBe('hi')
    expect(m1.ts).toBe(2000)
    const msgs = await s.getMessages(sess.id)
    expect(msgs.map((m) => m.text)).toEqual(['hi', 'hello'])
    expect(msgs.map((m) => m.ts)).toEqual([2000, 3000])
    expect(msgs).toEqual([m1, m2])
  })

  it('getMessages scopes to one session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const a = await s.createSession('proj-1')
    const b = await s.createSession('proj-1')
    await s.appendMessage(a.id, { sender: 'user', text: 'for a' })
    await s.appendMessage(b.id, { sender: 'user', text: 'for b' })
    expect((await s.getMessages(a.id)).map((m) => m.text)).toEqual(['for a'])
    expect((await s.getMessages(b.id)).map((m) => m.text)).toEqual(['for b'])
  })

  it('persistence survives a fresh jsonSessionStore on the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ss-'))
    const s1 = jsonSessionStore(dir, { now: clock() })
    const sess = await s1.createSession('proj-1', { title: 'kept' })
    await s1.appendMessage(sess.id, { sender: 'agent', text: 'persisted' })

    const s2 = jsonSessionStore(dir, { now: clock() })
    const sessions = await s2.listSessions('proj-1')
    expect(sessions.map((x) => x.title)).toEqual(['kept'])
    expect(sessions[0]?.id).toBe(sess.id)
    expect((await s2.getMessages(sess.id)).map((m) => m.text)).toEqual(['persisted'])
  })
})
