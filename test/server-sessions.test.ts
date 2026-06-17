import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { jsonProjectStore } from '../src/project/jsonProjectStore'
import { fakeGithubOAuth } from '../src/auth/github'
import { signState } from '../src/auth/state'
import { jsonUserStore } from '../src/auth/jsonUserStore'
import { jsonTokenStore } from '../src/auth/jsonTokenStore'
import type { Message, Session } from '../src/session/types'
import type { Project } from '../src/project/types'

function sessionServer(withStore = true) {
  const sessionStore = withStore
    ? jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-sess-')))
    : undefined
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, sessionStore,
  })
  return { srv, sessionStore }
}

// A server with auth + session + project stores wired, so userId is resolved
// and the "我的" default-project behaviour can be exercised end to end.
const sessionSecret = 'test-session-secret'
function authedServer() {
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    sessionStore: jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-sess-'))),
    projectStore: jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-'))),
    auth: {
      github: fakeGithubOAuth({ user: { id: 99, login: 'u', name: 'U' } }),
      userStore: jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-user-'))),
      tokenStore: jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-token-'))),
      sessionSecret, appBaseUrl: 'http://localhost:5173',
    },
  })
  return { srv }
}
async function mintToken(port: number): Promise<string> {
  const state = signState(sessionSecret)
  const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
  return new URL(cb.headers.get('location')!).searchParams.get('token')!
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

  it('GET /projects ensures a "我的" home project for an authed user', async () => {
    const { srv } = authedServer()
    const { port } = await srv.listen(0)
    const token = await mintToken(port)
    const projects = (await (await fetch(`http://localhost:${port}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json()) as Project[]
    expect(projects.some((p) => p.name === '我的')).toBe(true)
    await srv.close()
  })

  it('an authed POST /sessions with no projectId defaults into "我的"', async () => {
    const { srv } = authedServer()
    const { port } = await srv.listen(0)
    const token = await mintToken(port)
    const auth = { Authorization: `Bearer ${token}` }

    const home = ((await (await fetch(`http://localhost:${port}/projects`, { headers: auth })).json()) as Project[])
      .find((p) => p.name === '我的')!
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ title: 'x' }),
    })).json()) as Session
    // No projectId supplied → server resolved it to the user's home project.
    expect(session.projectId).toBe(home.id)
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
