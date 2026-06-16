import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { daemonHub } from '../src/daemon/daemonHub'
import { daemonExecutor } from '../src/daemon/daemonExecutor'
import { inMemoryDaemonTokenStore } from '../src/daemon/daemonTokenStore'
import { fakeGithubOAuth } from '../src/auth/github'
import { signState } from '../src/auth/state'
import { jsonUserStore } from '../src/auth/jsonUserStore'
import { jsonTokenStore } from '../src/auth/jsonTokenStore'
import type { DaemonTokenStore } from '../src/daemon/daemonTokenStore'
import type { DaemonToEngineMessage, EngineToDaemonMessage, AgentRunMessage } from '../src/daemon/protocol'
import WebSocket from 'ws'

const sessionSecret = 'test-session-secret'
const appBaseUrl = 'http://localhost:5173'

// A server with the daemon link wired (no auth, no chat — just the daemon WS
// surface). The token store is pre-seeded with a token for `userId`.
async function daemonServer() {
  const hub = daemonHub()
  const daemonTokenStore = inMemoryDaemonTokenStore()
  const token = await daemonTokenStore.issue('user-1')
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    daemon: { hub, daemonTokenStore },
  })
  return { srv, hub, daemonTokenStore, token }
}

// Wait for the WS to open (accepted) or close (rejected). Resolves 'open'|'close'.
function openOrClose(ws: WebSocket): Promise<'open' | 'close'> {
  return new Promise((resolve) => {
    ws.on('open', () => resolve('open'))
    ws.on('close', () => resolve('close'))
    ws.on('error', () => {}) // a rejected handshake can surface as error; close still fires
  })
}

// Resolve when the WS reaches the CLOSED state. Per-user token resolution is
// async, so an unknown-but-present token first OPENS then is closed right after;
// callers that must see the eventual close wait on this rather than racing open.
function waitClosed(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return }
    ws.on('close', () => resolve())
    ws.on('error', () => {})
  })
}

describe('server — daemon WS endpoint (per-user tokens)', () => {
  it('binds the conn to the userId the token resolves to', async () => {
    const { srv, hub, token } = await daemonServer()
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${token}`)
    const r = await openOrClose(ws)
    expect(r).toBe('open')
    // Give the async resolve + register a tick to run.
    await new Promise((res) => setTimeout(res, 40))
    expect(hub.hasDaemon('user-1')).toBe(true)
    // A different user has no daemon.
    expect(hub.hasDaemon('someone-else')).toBe(false)
    ws.close()
    await srv.close()
  })

  it('closes the conn (and registers nothing) for an unknown token', async () => {
    const { srv, hub } = await daemonServer()
    const { port } = await srv.listen(0)
    // A present-but-unknown token passes the cheap handshake check, then the async
    // resolve returns undefined → the server closes it without registering.
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=not-a-real-token`)
    await waitClosed(ws)
    expect(ws.readyState).toBe(WebSocket.CLOSED)
    expect(hub.hasDaemon('user-1')).toBe(false)
    await srv.close()
  })

  it('rejects (closes) a daemon connecting with no token', async () => {
    const { srv, hub } = await daemonServer()
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws`)
    const r = await openOrClose(ws)
    expect(r).toBe('close')
    expect(hub.hasDaemon('user-1')).toBe(false)
    await srv.close()
  })

  it('closes the /daemon/ws connection when no daemon surface is configured', async () => {
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined })
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=whatever`)
    const r = await openOrClose(ws)
    expect(r).toBe('close')
    await srv.close()
  })

  it('end-to-end: daemonExecutor routes a turn to the connected WS daemon by ownerId', async () => {
    const { srv, hub, token } = await daemonServer()
    const { port } = await srv.listen(0)

    // Connect a fake daemon (for user-1) that replies to agent:run with start→batch→end.
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${token}`)
    await openOrClose(ws)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as EngineToDaemonMessage
      if (msg.type !== 'agent:run') return
      const run = msg as AgentRunMessage
      const reply = (m: DaemonToEngineMessage) => ws.send(JSON.stringify(m))
      reply({ type: 'turn:start', turnId: run.turnId })
      reply({ type: 'trace:batch', turnId: run.turnId, events: [{ kind: 'text', payload: { content: 'pong' }, severity: 'info' }] })
      reply({ type: 'turn:end', turnId: run.turnId, status: 'completed', finalText: 'pong', usage: { cost: 0.01 } })
    })
    await new Promise((res) => setTimeout(res, 40)) // let resolve + register land

    const ex = daemonExecutor(hub)
    const seen: string[] = []
    const r = await ex.run({ prompt: 'ping', ownerId: 'user-1' }, (e) => {
      const c = (e.payload as { content?: string }).content
      if (typeof c === 'string') seen.push(c)
    })
    expect(seen).toEqual(['pong'])
    expect(r.finalText).toBe('pong')
    expect(r.cost).toBe(0.01)

    // A turn for a user with no daemon fails clearly.
    await expect(ex.run({ prompt: 'x', ownerId: 'nobody' }, () => {})).rejects.toThrow(/no daemon/)

    ws.close()
    await srv.close()
  })
})

// ----- auth-gated /daemon/tokens + /daemon/status -----

// A server with auth + the daemon surface wired, plus a freshly-minted bearer
// token bound to the configured fake user. Mirrors gatedServer in server-auth.
async function gatedDaemonServer(over?: {
  user?: { id: number; login: string; name?: string }
  daemonTokenStore?: DaemonTokenStore
}) {
  const github = fakeGithubOAuth({ user: over?.user ?? { id: 42, login: 'octocat', name: 'Octo Cat' } })
  const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-dtok-user-')))
  const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-dtok-token-')))
  const hub = daemonHub()
  const daemonTokenStore = over?.daemonTokenStore ?? inMemoryDaemonTokenStore()
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    daemon: { hub, daemonTokenStore },
    auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
  })
  const { port } = await srv.listen(0)
  // Mint a bearer token via the real callback flow so it is bound to the upserted user.
  const state = signState(sessionSecret)
  const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
  const bearer = new URL(cb.headers.get('location')!).searchParams.get('token')!
  // The userId the bearer resolves to (so the test can register a daemon under it).
  const userId = (await tokenStore.resolve(bearer))!
  return { srv, port, bearer, userId, hub, daemonTokenStore }
}

describe('server — POST /daemon/tokens + GET /daemon/status (auth-gated)', () => {
  it('POST /daemon/tokens without a bearer 401s', async () => {
    const { srv, port } = await gatedDaemonServer()
    const res = await fetch(`http://localhost:${port}/daemon/tokens`, { method: 'POST' })
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('GET /daemon/status without a bearer 401s', async () => {
    const { srv, port } = await gatedDaemonServer()
    const res = await fetch(`http://localhost:${port}/daemon/status`)
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('POST /daemon/tokens (authed) returns a token that resolves to that user', async () => {
    const { srv, port, bearer, userId, daemonTokenStore } = await gatedDaemonServer()
    const res = await fetch(`http://localhost:${port}/daemon/tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(200)
    const { token } = (await res.json()) as { token: string }
    expect(token).toMatch(/.+/)
    expect(await daemonTokenStore.resolve(token)).toBe(userId)
    await srv.close()
  })

  it('GET /daemon/status reflects a registered conn for the authed user', async () => {
    const { srv, port, bearer, userId, hub } = await gatedDaemonServer()
    // Offline before any daemon connects.
    const before = await (await fetch(`http://localhost:${port}/daemon/status`, {
      headers: { authorization: `Bearer ${bearer}` },
    })).json() as { online: boolean }
    expect(before.online).toBe(false)

    // Register a conn for the authed user directly in the hub.
    hub.register(userId, { send: () => {} })
    const after = await (await fetch(`http://localhost:${port}/daemon/status`, {
      headers: { authorization: `Bearer ${bearer}` },
    })).json() as { online: boolean }
    expect(after.online).toBe(true)

    // A different user's daemon does not flip this user's status.
    hub.unregister(userId)
    hub.register('other-user', { send: () => {} })
    const other = await (await fetch(`http://localhost:${port}/daemon/status`, {
      headers: { authorization: `Bearer ${bearer}` },
    })).json() as { online: boolean }
    expect(other.online).toBe(false)
    await srv.close()
  })

  it('a token minted via POST /daemon/tokens authenticates the /daemon/ws handshake', async () => {
    const { srv, port, bearer, userId, hub } = await gatedDaemonServer()
    const { token } = (await (await fetch(`http://localhost:${port}/daemon/tokens`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}` },
    })).json()) as { token: string }

    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${token}`)
    const r = await openOrClose(ws)
    expect(r).toBe('open')
    await new Promise((res) => setTimeout(res, 40))
    expect(hub.hasDaemon(userId)).toBe(true)
    ws.close()
    await srv.close()
  })
})
