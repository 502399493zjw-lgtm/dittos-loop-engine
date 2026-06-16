import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import type { Message, Session } from '../src/session/types'

function sessionServer(withStore = true) {
  const sessionStore = withStore
    ? jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-sess-')))
    : undefined
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, sessionStore,
  })
  return { srv, sessionStore }
}

describe('server — session endpoints', () => {
  it('POST /sessions creates a Session, GET /sessions lists it (filtered by projectId)', async () => {
    const { srv } = sessionServer()
    const { port } = await srv.listen(0)

    const create = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1', title: 'morning' }),
    })
    expect(create.status).toBe(200)
    const session = (await create.json()) as Session
    expect(session.id).toBeTruthy()
    expect(session.projectId).toBe('proj-1')
    expect(session.title).toBe('morning')

    // a second session under a different project
    await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'proj-2' }),
    })

    const filtered = (await (await fetch(`http://localhost:${port}/sessions?projectId=proj-1`)).json()) as Session[]
    expect(filtered.map((s) => s.id)).toEqual([session.id])

    const all = (await (await fetch(`http://localhost:${port}/sessions`)).json()) as Session[]
    expect(all).toHaveLength(2)

    await srv.close()
  })

  it('POST /sessions/:id/messages appends (sender defaults user), GET returns chronological', async () => {
    const { srv } = sessionServer()
    const { port } = await srv.listen(0)
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'proj-1' }),
    })).json()) as Session

    const m1res = await fetch(`http://localhost:${port}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }),
    })
    expect(m1res.status).toBe(200)
    const m1 = (await m1res.json()) as Message
    expect(m1.sender).toBe('user') // defaulted
    expect(m1.text).toBe('hi')
    expect(m1.sessionId).toBe(session.id)

    await fetch(`http://localhost:${port}/sessions/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sender: 'agent', text: 'hello' }),
    })

    const msgs = (await (await fetch(`http://localhost:${port}/sessions/${session.id}/messages`)).json()) as Message[]
    expect(msgs.map((m) => ({ sender: m.sender, text: m.text }))).toEqual([
      { sender: 'user', text: 'hi' },
      { sender: 'agent', text: 'hello' },
    ])

    await srv.close()
  })

  it('session endpoints 500 when no session store is configured', async () => {
    const { srv } = sessionServer(false)
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p' }),
    })
    expect(res.status).toBe(500)
    await srv.close()
  })
})
