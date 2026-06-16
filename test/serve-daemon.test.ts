import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { jsonTurnStore } from '../src/chat/turnStore'
import { jsonTraceStore } from '../src/chat/traceStore'
import { buildDaemonWiring } from '../src/serve'
import type { DaemonConn } from '../src/daemon/daemonHub'
import type { AgentRunMessage } from '../src/daemon/protocol'
import type { Message } from '../src/session/types'
import WebSocket from 'ws'

// Save/restore env so tests don't leak DAEMON_MODE/DAEMON_TOKEN into each other.
const ENV_KEYS = ['DAEMON_MODE', 'DAEMON_TOKEN'] as const
const saved: Record<string, string | undefined> = {}
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('serve — DAEMON_MODE wiring', () => {
  it('non-DAEMON_MODE: returns undefined (local in-process executors are kept)', () => {
    setEnv({ DAEMON_MODE: undefined, DAEMON_TOKEN: undefined })
    expect(buildDaemonWiring()).toBeUndefined()
  })

  it('DAEMON_MODE=1: wires daemonExecutor as BOTH executor + streamExecutor and a daemon config', () => {
    setEnv({ DAEMON_MODE: '1', DAEMON_TOKEN: 'tok' })
    const wiring = buildDaemonWiring()
    expect(wiring).toBeDefined()
    // The SAME daemon executor object serves both seams (chat stream + loop executor).
    expect(wiring!.executor).toBe(wiring!.streamExecutor)
    // The daemon config carries sha256(DAEMON_TOKEN) so /daemon/ws can auth.
    expect(wiring!.daemon.tokenHash).toBe(createHash('sha256').update('tok').digest('hex'))
    // The hub the executor dispatches over is the same hub mounted on the WS endpoint.
    expect(wiring!.daemon.hub).toBe(wiring!.hub)
  })

  it('DAEMON_MODE chat POST drives respond through the daemon → turn/trace/new_message envelopes', async () => {
    setEnv({ DAEMON_MODE: '1', DAEMON_TOKEN: 'tok' })
    const wiring = buildDaemonWiring()!

    const base = mkdtempSync(join(tmpdir(), 'serve-daemon-'))
    const sessionStore = jsonSessionStore(join(base, 'sess'))
    const turnStore = jsonTurnStore(join(base, 'turns'))
    const traceStore = jsonTraceStore(join(base, 'trace'))
    const srv = createServer({
      executor: wiring.executor, defaultAgent: 'claude', flows: {}, storeDir: undefined,
      sessionStore, turnStore, traceStore, streamExecutor: wiring.streamExecutor,
      daemon: wiring.daemon,
    })
    const { port } = await srv.listen(0)

    // Register a fake daemon conn directly into the hub (no real WS needed): it
    // scripts turn:start → trace:batch → turn:end for each agent:run.
    let conn: DaemonConn
    conn = {
      send: (msg) => {
        if (msg.type !== 'agent:run') return
        const run = msg as AgentRunMessage
        queueMicrotask(() => {
          wiring.hub.handleMessage({ type: 'turn:start', turnId: run.turnId })
          wiring.hub.handleMessage({
            type: 'trace:batch', turnId: run.turnId,
            events: [{ kind: 'text', payload: { content: 'pong' }, severity: 'info' }],
          })
          wiring.hub.handleMessage({
            type: 'turn:end', turnId: run.turnId, status: 'completed', finalText: 'pong',
            usage: { output_tokens: 1 },
          })
        })
      },
    }
    wiring.hub.register(conn)

    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json()) as { id: string }

    const collected = collectWs(
      `ws://localhost:${port}/channels/${session.id}/events?trace=1`,
      (types) => types.includes('new_message') && types.filter((t) => t === 'turn:update').length >= 2,
    )
    await new Promise((r) => setTimeout(r, 50))

    const res = await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'ping' } }),
    })
    expect(res.status).toBe(200)

    const msgs = await collected
    const types = msgs.map((m) => m.type)
    // The respond flow drove the full lifecycle THROUGH the daemon executor.
    expect(types).toContain('turn:created')
    const traceEnv = msgs.find((m) => m.type === 'trace:batch' || m.type === 'trace:event')!
    expect(traceEnv.payload.turn_id).toBeTruthy()
    const agentMsg = msgs.find((m) => m.type === 'new_message' && m.message.sender_type === 'agent') as
      { message: Message } | undefined
    expect(agentMsg?.message.content.text).toBe('pong')
    expect(msgs.some((m) => m.type === 'turn:update' && m.payload.status === 'completed')).toBe(true)

    wiring.hub.unregister(conn)
    await srv.close()
  })
})

// Collect WS messages until `done(types)` is satisfied, then resolve the buffer.
function collectWs(url: string, done: (types: string[]) => boolean): Promise<any[]> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const msgs: any[] = []
    ws.on('message', (d) => {
      const e = JSON.parse(d.toString())
      msgs.push(e)
      if (done(msgs.map((m) => m.type))) { ws.close(); resolve(msgs) }
    })
  })
}
