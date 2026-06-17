import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { jsonProjectStore } from '../src/project/jsonProjectStore'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
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

  it('POST /loops/from-session backstops mandatory contract defaults (mode/stop) when the agent omits them', async () => {
    // An executor that returns a MINIMAL contract (no mode, no stop, no body) wrapped
    // in prose — exercises the lenient {…} extraction AND compileDefaults: mode is
    // inferred from the trigger (interval → 'live') and a stop rule is guaranteed.
    const jsonExec = {
      async run() {
        return { text: '好的，这是配置：{"name":"trending 日报","trigger":{"kind":"interval","everyMs":3600000,"description":"每小时"},"goal":"汇总 GitHub trending"} 完成。', cost: 0 }
      },
    }
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-sess-')))
    const loopStore = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-loop-')))
    const srv = createServer({
      executor: jsonExec, defaultAgent: 'claude', flows: {}, storeDir: undefined,
      sessionStore, store: loopStore,
      projectStore: jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-'))),
      auth: {
        github: fakeGithubOAuth({ user: { id: 7, login: 'u', name: 'U' } }),
        userStore: jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-user-'))),
        tokenStore: jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-token-'))),
        sessionSecret, appBaseUrl: 'http://localhost:5173',
      },
    })
    const { port } = await srv.listen(0)
    const token = await mintToken(port)

    // Seed a conversation describing the loop.
    const session = await sessionStore.createSession(undefined, { title: 'draft' })
    await sessionStore.appendMessage(session.id, { sender_type: 'user', type: 'text', content: { text: '帮我每小时汇总一次 GitHub trending' } })

    const res = await fetch(`http://localhost:${port}/loops/from-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(res.status).toBe(200)
    const spec = (await res.json()) as { id: string; flow: string; name: string; mode: string; goal: string; stop: string; trigger: { kind: string; everyMs?: number }; ownerId?: string }
    expect(spec.flow).toBe('contract')
    expect(spec.name).toBe('trending 日报')
    expect(spec.goal).toContain('GitHub trending')
    // compileDefaults backstops: a trigger present → mode 'live'; a stop rule guaranteed.
    expect(spec.mode).toBe('live')
    expect(spec.stop).toBeTruthy()
    expect(spec.trigger.kind).toBe('interval')
    expect(spec.trigger.everyMs).toBe(3600000)
    expect(spec.ownerId).toBeTruthy()

    // It persisted + is owner-scoped on GET /loops.
    const loops = (await (await fetch(`http://localhost:${port}/loops`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{ spec: { id: string } }>
    expect(loops.map((l) => l.spec.id)).toContain(spec.id)

    await srv.close()
  })

  it('POST /loops/from-session distils the chat transcript into a full contract loop (flow=contract)', async () => {
    // An executor that returns a FULL contract as JSON wrapped in prose — exercises
    // the lenient {…} extraction and the contract-shaped build path. The body has
    // two steps so we can assert the structured execution body survives round-trip.
    const contract = {
      name: 'trending 日报',
      mode: 'live',
      goal: '每小时汇总 GitHub trending 并整理成三条发给用户',
      trigger: { kind: 'interval', everyMs: 3600000, description: '每小时' },
      escalation: ['对外发布前先确认'],
      stop: '用户说停止',
      body: {
        steps: [
          { id: 's1', kind: 'agent', label: '抓取', prompt: '抓取今天的 GitHub trending 仓库列表' },
          { id: 's2', kind: 'agent', label: '整理', prompt: '把列表整理成三条要点发给用户' },
        ],
      },
    }
    const jsonExec = {
      async run() {
        return { text: `好的，这是配置：${JSON.stringify(contract)} 完成。`, cost: 0 }
      },
    }
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-sess-')))
    const loopStore = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-loop-')))
    const srv = createServer({
      executor: jsonExec, defaultAgent: 'claude', flows: {}, storeDir: undefined,
      sessionStore, store: loopStore,
      projectStore: jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-'))),
      auth: {
        github: fakeGithubOAuth({ user: { id: 11, login: 'u', name: 'U' } }),
        userStore: jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-user-'))),
        tokenStore: jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-token-'))),
        sessionSecret, appBaseUrl: 'http://localhost:5173',
      },
    })
    const { port } = await srv.listen(0)
    const token = await mintToken(port)

    const session = await sessionStore.createSession(undefined, { title: 'draft' })
    await sessionStore.appendMessage(session.id, { sender_type: 'user', type: 'text', content: { text: '帮我每小时汇总一次 GitHub trending' } })

    const res = await fetch(`http://localhost:${port}/loops/from-session`, {
      method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(res.status).toBe(200)
    const spec = (await res.json()) as {
      id: string; flow: string; name: string; mode: string; goal: string
      stop: string; ownerId?: string
      body: { steps: Array<{ id: string; kind: string; label: string }> }
    }
    expect(spec.flow).toBe('contract')
    expect(spec.name).toBe('trending 日报')
    expect(spec.mode).toBe('live')
    expect(spec.goal).toContain('GitHub trending')
    // The structured execution body survived: two steps.
    expect(spec.body.steps).toHaveLength(2)
    expect(spec.body.steps.map((s) => s.id)).toEqual(['s1', 's2'])
    // A stop rule is guaranteed (the contract supplied one; compileDefaults backstops).
    expect(spec.stop).toBeTruthy()
    expect(spec.ownerId).toBeTruthy()

    // It persisted + is owner-scoped on GET /loops.
    const loops = (await (await fetch(`http://localhost:${port}/loops`, { headers: { Authorization: `Bearer ${token}` } })).json()) as Array<{ spec: { id: string; flow: string; body?: { steps: unknown[] } } }>
    const created = loops.find((l) => l.spec.id === spec.id)
    expect(created).toBeTruthy()
    expect(created!.spec.flow).toBe('contract')
    expect(created!.spec.body!.steps).toHaveLength(2)

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
