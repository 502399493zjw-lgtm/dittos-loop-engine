import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { fakeGithubOAuth } from '../src/auth/github'
import { signState } from '../src/auth/state'
import { jsonUserStore } from '../src/auth/jsonUserStore'
import { jsonTokenStore } from '../src/auth/jsonTokenStore'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import type { User } from '../src/auth/types'

const sessionSecret = 'test-session-secret'
const appBaseUrl = 'http://localhost:5173'

function authServer(over?: { user?: { id: number; login: string; name?: string } }) {
  const github = fakeGithubOAuth({ user: over?.user ?? { id: 42, login: 'octocat', name: 'Octo Cat' } })
  const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-auth-user-')))
  const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-auth-token-')))
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
  })
  return { srv, github, userStore, tokenStore }
}

// Extract a query param (?token / ?auth_error) from a Location header.
const queryOf = (loc: string, key: string) => new URL(loc).searchParams.get(key)

describe('server — auth endpoints', () => {
  it('GET /auth/login 302s to the GitHub authorize URL with a signed state', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/auth/login`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc).toContain('github.com/login/oauth/authorize')
    const state = new URL(loc).searchParams.get('state')!
    expect(state).toContain('.') // a signed state has a nonce.sig shape
    await srv.close()
  })

  it('GET /auth/callback with a valid state mints a token + 302s to appBaseUrl/auth/callback?token=', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const state = signState(sessionSecret)
    const res = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc.startsWith(`${appBaseUrl}/auth/callback?`)).toBe(true)
    expect(queryOf(loc, 'token')).toMatch(/.+/)
    await srv.close()
  })

  it('the minted token resolves on GET /auth/me to the upserted user', async () => {
    const { srv } = authServer({ user: { id: 7, login: 'mona', name: 'Mona' } })
    const { port } = await srv.listen(0)
    const state = signState(sessionSecret)
    const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
    const token = queryOf(cb.headers.get('location')!, 'token')!

    const me = await fetch(`http://localhost:${port}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
    expect(me.status).toBe(200)
    const user = (await me.json()) as User
    expect(user.githubId).toBe(7)
    expect(user.login).toBe('mona')
    expect(user.name).toBe('Mona')
    await srv.close()
  })

  it('GET /auth/me without a token 401s', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/auth/me`)
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('GET /auth/me with an unknown token 401s', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/auth/me`, { headers: { authorization: 'Bearer not-a-real-token' } })
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('GET /auth/callback with a bad state 302s to appBaseUrl/auth/callback?auth_error=bad_state', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/auth/callback?code=x&state=garbage`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc.startsWith(`${appBaseUrl}/auth/callback?`)).toBe(true)
    expect(queryOf(loc, 'auth_error')).toBe('bad_state')
    await srv.close()
  })

  it('CORS allows the Authorization header so a cross-origin SPA can send Bearer', async () => {
    const { srv } = authServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/auth/me`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization')
    await srv.close()
  })

  it('auth routes are absent (404) when cfg.auth is not set', async () => {
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined })
    const { port } = await srv.listen(0)
    const login = await fetch(`http://localhost:${port}/auth/login`, { redirect: 'manual' })
    expect(login.status).toBe(404)
    const me = await fetch(`http://localhost:${port}/auth/me`)
    expect(me.status).toBe(404)
    await srv.close()
  })
})

// A server with auth + the loop/session stores wired, plus a freshly-minted token
// bound to the configured fake user. Used to exercise the auth-gating middleware.
async function gatedServer(over?: { user?: { id: number; login: string; name?: string } }) {
  const github = fakeGithubOAuth({ user: over?.user ?? { id: 42, login: 'octocat', name: 'Octo Cat' } })
  const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-gate-user-')))
  const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-gate-token-')))
  const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-gate-loop-')))
  const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-gate-sess-')))
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    store, sessionStore,
    auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
  })
  const { port } = await srv.listen(0)
  // Mint a token via the real callback flow so it is bound to the upserted user.
  const state = signState(sessionSecret)
  const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
  const token = queryOf(cb.headers.get('location')!, 'token')!
  return { srv, port, token }
}

describe('server — auth middleware gates /loops + /sessions', () => {
  it('GET /loops without a token 401s when auth is configured', async () => {
    const { srv, port } = await gatedServer()
    const res = await fetch(`http://localhost:${port}/loops`)
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('POST /loops without a token 401s when auth is configured', async () => {
    const { srv, port } = await gatedServer()
    const res = await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'l1', flow: 'noop', trigger: { kind: 'interval', everyMs: 1000 } }),
    })
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('GET /loops with an invalid token 401s', async () => {
    const { srv, port } = await gatedServer()
    const res = await fetch(`http://localhost:${port}/loops`, { headers: { authorization: 'Bearer nope' } })
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('POST then GET /loops with a valid token behaves normally', async () => {
    const { srv, port, token } = await gatedServer()
    const post = await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: 'l1', flow: 'noop', trigger: { kind: 'interval', everyMs: 1000 } }),
    })
    expect(post.status).toBe(200)
    const get = await fetch(`http://localhost:${port}/loops`, { headers: { authorization: `Bearer ${token}` } })
    expect(get.status).toBe(200)
    const loops = (await get.json()) as Array<{ spec: { id: string } }>
    expect(loops.map((l) => l.spec.id)).toContain('l1')
    await srv.close()
  })

  it('GET /sessions without a token 401s when auth is configured', async () => {
    const { srv, port } = await gatedServer()
    const res = await fetch(`http://localhost:${port}/sessions`)
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('POST /sessions without a token 401s when auth is configured', async () => {
    const { srv, port } = await gatedServer()
    const res = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p' }),
    })
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('POST then GET /sessions with a valid token behaves normally', async () => {
    const { srv, port, token } = await gatedServer()
    const post = await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId: 'p', title: 't' }),
    })
    expect(post.status).toBe(200)
    const get = await fetch(`http://localhost:${port}/sessions`, { headers: { authorization: `Bearer ${token}` } })
    expect(get.status).toBe(200)
    const sessions = (await get.json()) as Array<{ id: string }>
    expect(sessions).toHaveLength(1)
    await srv.close()
  })

  it('loops are scoped per user: B does not see A\'s loop, A does', async () => {
    // Two users share one engine (one auth/store config), each with their own token.
    const github = fakeGithubOAuth({ user: { id: 1, login: 'alice' } })
    const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-scope-user-')))
    const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-scope-token-')))
    const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-scope-loop-')))
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-scope-sess-')))
    const srv = createServer({
      executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
      store, sessionStore,
      auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
    })
    const { port } = await srv.listen(0)

    // Mint two tokens for two distinct GitHub users via the real callback flow.
    const mint = async (gh: { id: number; login: string }) => {
      // Re-point the fake to this user before the callback, then mint.
      ;(github as { setUser?: (u: { id: number; login: string }) => void }).setUser?.(gh)
      const state = signState(sessionSecret)
      const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
      return queryOf(cb.headers.get('location')!, 'token')!
    }
    const tokenA = await mint({ id: 1, login: 'alice' })
    const tokenB = await mint({ id: 2, login: 'bob' })
    expect(tokenA).not.toBe(tokenB)

    // A creates a loop.
    const post = await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ id: 'a-loop', flow: 'noop', trigger: { kind: 'interval', everyMs: 1000 } }),
    })
    expect(post.status).toBe(200)

    // B lists /loops: must NOT see A's loop.
    const bList = (await (await fetch(`http://localhost:${port}/loops`, { headers: { authorization: `Bearer ${tokenB}` } })).json()) as Array<{ spec: { id: string; ownerId?: string } }>
    expect(bList.map((l) => l.spec.id)).not.toContain('a-loop')

    // A lists /loops: sees its own loop, stamped with A's ownerId.
    const aList = (await (await fetch(`http://localhost:${port}/loops`, { headers: { authorization: `Bearer ${tokenA}` } })).json()) as Array<{ spec: { id: string; ownerId?: string } }>
    expect(aList.map((l) => l.spec.id)).toContain('a-loop')
    expect(aList.find((l) => l.spec.id === 'a-loop')?.spec.ownerId).toBeTruthy()

    await srv.close()
  })

  it('sessions are scoped per user: B does not see A\'s session', async () => {
    const github = fakeGithubOAuth({ user: { id: 1, login: 'alice' } })
    const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-scope2-user-')))
    const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-scope2-token-')))
    const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-scope2-loop-')))
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-scope2-sess-')))
    const srv = createServer({
      executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
      store, sessionStore,
      auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
    })
    const { port } = await srv.listen(0)
    const mint = async (gh: { id: number; login: string }) => {
      ;(github as { setUser?: (u: { id: number; login: string }) => void }).setUser?.(gh)
      const state = signState(sessionSecret)
      const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
      return queryOf(cb.headers.get('location')!, 'token')!
    }
    const tokenA = await mint({ id: 1, login: 'alice' })
    const tokenB = await mint({ id: 2, login: 'bob' })

    await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ projectId: 'p', title: 'a-session' }),
    })

    const bSessions = (await (await fetch(`http://localhost:${port}/sessions`, { headers: { authorization: `Bearer ${tokenB}` } })).json()) as Array<{ title?: string }>
    expect(bSessions).toHaveLength(0)
    const aSessions = (await (await fetch(`http://localhost:${port}/sessions`, { headers: { authorization: `Bearer ${tokenA}` } })).json()) as Array<{ title?: string }>
    expect(aSessions.map((s) => s.title)).toContain('a-session')

    await srv.close()
  })

  it('/auth/* stays public even though /loops + /sessions are gated', async () => {
    const { srv, port } = await gatedServer()
    const login = await fetch(`http://localhost:${port}/auth/login`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    await srv.close()
  })

  it('/loops works without a token when auth is NOT configured (backward compat)', async () => {
    const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'srv-noauth-loop-')))
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, store })
    const { port } = await srv.listen(0)
    const get = await fetch(`http://localhost:${port}/loops`)
    expect(get.status).toBe(200)
    const post = await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'l1', flow: 'noop', trigger: { kind: 'interval', everyMs: 1000 } }),
    })
    expect(post.status).toBe(200)
    await srv.close()
  })

  it('/sessions works without a token when auth is NOT configured (backward compat)', async () => {
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-noauth-sess-')))
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, sessionStore })
    const { port } = await srv.listen(0)
    const get = await fetch(`http://localhost:${port}/sessions`)
    expect(get.status).toBe(200)
    await srv.close()
  })
})
