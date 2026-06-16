import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { daemonHub } from '../src/daemon/daemonHub'
import { daemonExecutor } from '../src/daemon/daemonExecutor'
import type { DaemonToEngineMessage, EngineToDaemonMessage, AgentRunMessage } from '../src/daemon/protocol'
import WebSocket from 'ws'

const TOKEN = 'super-secret-daemon-token'
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

// A server with the daemon link wired (no auth, no chat — just the daemon surface).
function daemonServer() {
  const hub = daemonHub()
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    daemon: { hub, tokenHash: TOKEN_HASH },
  })
  return { srv, hub }
}

// Wait for the WS to open (accepted) or close (rejected). Resolves 'open'|'close'.
function openOrClose(ws: WebSocket): Promise<'open' | 'close'> {
  return new Promise((resolve) => {
    ws.on('open', () => resolve('open'))
    ws.on('close', () => resolve('close'))
    ws.on('error', () => {}) // a rejected handshake can surface as error; close still fires
  })
}

describe('server — daemon WS endpoint', () => {
  it('accepts a daemon connecting with the correct token + registers it into the hub', async () => {
    const { srv, hub } = daemonServer()
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${TOKEN}`)
    const r = await openOrClose(ws)
    expect(r).toBe('open')
    // Give register() a tick to run on the server's connection handler.
    await new Promise((res) => setTimeout(res, 30))
    expect(hub.hasDaemon()).toBe(true)
    ws.close()
    await srv.close()
  })

  it('rejects (closes) a daemon connecting with a wrong token', async () => {
    const { srv, hub } = daemonServer()
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=wrong`)
    const r = await openOrClose(ws)
    expect(r).toBe('close')
    expect(hub.hasDaemon()).toBe(false)
    await srv.close()
  })

  it('rejects (closes) a daemon connecting with no token', async () => {
    const { srv, hub } = daemonServer()
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws`)
    const r = await openOrClose(ws)
    expect(r).toBe('close')
    expect(hub.hasDaemon()).toBe(false)
    await srv.close()
  })

  it('closes the /daemon/ws connection when no daemon surface is configured', async () => {
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined })
    const { port } = await srv.listen(0)
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${TOKEN}`)
    const r = await openOrClose(ws)
    expect(r).toBe('close')
    await srv.close()
  })

  it('end-to-end: daemonExecutor over the hub dispatches to the connected WS daemon and resolves', async () => {
    const { srv, hub } = daemonServer()
    const { port } = await srv.listen(0)

    // Connect a fake daemon that replies to agent:run with start→batch→end.
    const ws = new WebSocket(`ws://localhost:${port}/daemon/ws?token=${TOKEN}`)
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
    await new Promise((res) => setTimeout(res, 30)) // let register() land

    const ex = daemonExecutor(hub)
    const seen: string[] = []
    const r = await ex.run({ prompt: 'ping' }, (e) => {
      const c = (e.payload as { content?: string }).content
      if (typeof c === 'string') seen.push(c)
    })
    expect(seen).toEqual(['pong'])
    expect(r.finalText).toBe('pong')
    expect(r.cost).toBe(0.01)

    ws.close()
    await srv.close()
  })
})
