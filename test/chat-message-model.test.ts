import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { storeSessionBus } from '../src/session/storeSessionBus'

const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('Message model — contract fields', () => {
  it('appendMessage assigns a dense per-channel seq and fills the contract fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const sess = await s.createSession('proj-1') // ts 1000
    const m1 = await s.appendMessage(sess.id, { sender: 'user', text: 'hi' }) // ts 2000, seq 0
    const m2 = await s.appendMessage(sess.id, { sender: 'agent', text: 'yo' }) // ts 3000, seq 1

    // seq is dense per channel, starting at 0
    expect(m1.seq).toBe(0)
    expect(m2.seq).toBe(1)

    // contract fields round-trip
    expect(m1.channel_id).toBe(sess.id)
    expect(m1.sender_type).toBe('user')
    expect(m1.type).toBe('text')
    expect(m1.content).toEqual({ text: 'hi' })
    expect(m1.created_at).toBe(2000)
    expect(m1.sender_id).toBeTruthy()

    // legacy fields stay intact (back-compat)
    expect(m1.sessionId).toBe(sess.id)
    expect(m1.sender).toBe('user')
    expect(m1.text).toBe('hi')
    expect(m1.ts).toBe(2000)
  })

  it('seq is independent per channel', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const a = await s.createSession('proj-1')
    const b = await s.createSession('proj-1')
    const a0 = await s.appendMessage(a.id, { sender: 'user', text: 'a0' })
    const b0 = await s.appendMessage(b.id, { sender: 'user', text: 'b0' })
    const a1 = await s.appendMessage(a.id, { sender: 'user', text: 'a1' })
    expect(a0.seq).toBe(0)
    expect(b0.seq).toBe(0)
    expect(a1.seq).toBe(1)
  })

  it('seq survives a fresh store on the same dir (continues from persisted max)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-'))
    const s1 = jsonSessionStore(dir, { now: clock() })
    const sess = await s1.createSession('proj-1')
    await s1.appendMessage(sess.id, { sender: 'user', text: 'first' }) // seq 0
    const s2 = jsonSessionStore(dir, { now: clock() })
    const m = await s2.appendMessage(sess.id, { sender: 'agent', text: 'second' })
    expect(m.seq).toBe(1)
  })

  it('appendMessage accepts the richer contract shape (sender_type, type, content, turn_id, reply_to)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const sess = await s.createSession('proj-1')
    const m = await s.appendMessage(sess.id, {
      sender_type: 'agent',
      type: 'text',
      content: { text: 'rich' },
      turn_id: 'turn-1',
      reply_to: 'msg-0',
    })
    expect(m.sender_type).toBe('agent')
    expect(m.type).toBe('text')
    expect(m.content).toEqual({ text: 'rich' })
    expect(m.turn_id).toBe('turn-1')
    expect(m.reply_to).toBe('msg-0')
    // legacy mirror still derived
    expect(m.sender).toBe('agent')
    expect(m.text).toBe('rich')
  })

  it('getMessages returns chronological with ascending seq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-'))
    const s = jsonSessionStore(dir, { now: clock() })
    const sess = await s.createSession('proj-1')
    await s.appendMessage(sess.id, { sender: 'user', text: 'one' })
    await s.appendMessage(sess.id, { sender: 'agent', text: 'two' })
    const msgs = await s.getMessages(sess.id)
    expect(msgs.map((m) => m.content.text)).toEqual(['one', 'two'])
    expect(msgs.map((m) => m.seq)).toEqual([0, 1])
  })
})

describe('storeSessionBus — agent-shaped narration (loop back-compat)', () => {
  it('postMessage produces an agent-shaped message and keeps legacy fields', async () => {
    const store = jsonSessionStore(mkdtempSync(join(tmpdir(), 'cmb-')), { now: clock() })
    const bus = storeSessionBus(store)
    const { sessionId } = await bus.createSession(undefined)
    await bus.postMessage(sessionId, 'narration')
    const [m] = await store.getMessages(sessionId)
    // contract shape
    expect(m?.sender_type).toBe('agent')
    expect(m?.type).toBe('text')
    expect(m?.content).toEqual({ text: 'narration' })
    expect(m?.channel_id).toBe(sessionId)
    expect(m?.seq).toBe(0)
    // legacy mirror
    expect(m?.sender).toBe('agent')
    expect(m?.text).toBe('narration')
  })
})
