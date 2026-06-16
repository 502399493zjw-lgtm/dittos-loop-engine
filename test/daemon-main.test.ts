import { describe, it, expect } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'node:net'
import { startDaemon } from '../src/daemon/main'
import { parseDaemonMessage } from '../src/daemon/protocol'
import type { DaemonToEngineMessage, AgentRunMessage } from '../src/daemon/protocol'
import type { TurnEvent } from '../src/daemon/main'

// A fake engine WS that records inbound daemon→engine messages and lets the
// test script an agent:run dispatch. Mirrors the real server's /daemon/ws.
function fakeEngine() {
  const wss = new WebSocketServer({ port: 0 })
  return new Promise<{ url: string; received: DaemonToEngineMessage[]; sendRun: (m: AgentRunMessage) => void; nextConn: () => Promise<void>; close: () => Promise<void> }>((resolve) => {
    const received: DaemonToEngineMessage[] = []
    let socket: import('ws').WebSocket | undefined
    let onConn: (() => void) | undefined
    wss.on('connection', (ws) => {
      socket = ws
      ws.on('message', (data) => {
        const msg = parseDaemonMessage(data as Buffer)
        if (msg) received.push(msg)
      })
      onConn?.()
    })
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port
      resolve({
        url: `ws://localhost:${port}/daemon/ws?token=t`,
        received,
        sendRun: (m) => socket?.send(JSON.stringify(m)),
        nextConn: () => new Promise<void>((res) => { onConn = res }),
        close: () => new Promise<void>((res) => wss.close(() => res())),
      })
    })
  })
}

// Fake runTurn injected into the daemon: scripts a fixed turn:start / batch / end.
const fakeRunTurn = async (prompt: string, opts: { onEvent: (e: TurnEvent) => void }) => {
  opts.onEvent({ type: 'turn:start' })
  opts.onEvent({ type: 'trace:batch', events: [{ kind: 'text', payload: { content: prompt + '!' }, severity: 'info' }] })
  const end: TurnEvent = { type: 'turn:end', status: 'completed', finalText: prompt + '!', usage: { cost: 0.02 } }
  opts.onEvent(end)
  return { status: 'completed' as const, finalText: prompt + '!', usage: { cost: 0.02 } }
}

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (pred()) return resolve()
      if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe('startDaemon (fake engine WS)', () => {
  it('sends daemon:hello on connect, then on agent:run replies with turn:start/trace:batch/turn:end stamped with the turnId', async () => {
    const engine = await fakeEngine()
    const daemon = startDaemon({ url: engine.url, runTurn: fakeRunTurn })

    // hello arrives after the socket opens.
    await waitFor(() => engine.received.some((m) => m.type === 'daemon:hello'))
    const hello = engine.received.find((m) => m.type === 'daemon:hello')!
    expect(hello).toEqual({ type: 'daemon:hello', protocol: 1 })

    // Dispatch a turn.
    engine.sendRun({ type: 'agent:run', turnId: 'T1', prompt: 'ping' })

    await waitFor(() => engine.received.some((m) => m.type === 'turn:end'))
    const start = engine.received.find((m) => m.type === 'turn:start')!
    const batch = engine.received.find((m) => m.type === 'trace:batch')!
    const end = engine.received.find((m) => m.type === 'turn:end')!
    expect(start).toEqual({ type: 'turn:start', turnId: 'T1' })
    expect(batch).toEqual({ type: 'trace:batch', turnId: 'T1', events: [{ kind: 'text', payload: { content: 'ping!' }, severity: 'info' }] })
    expect(end).toEqual({ type: 'turn:end', turnId: 'T1', status: 'completed', finalText: 'ping!', usage: { cost: 0.02 } })

    daemon.stop()
    await engine.close()
  })

  it('reconnects with backoff after the socket drops and sends hello again', async () => {
    const engine = await fakeEngine()
    const daemon = startDaemon({ url: engine.url, runTurn: fakeRunTurn, backoffMs: 20 })

    await waitFor(() => engine.received.length >= 1)
    expect(engine.received.filter((m) => m.type === 'daemon:hello')).toHaveLength(1)

    // Drop the daemon's socket from the engine side; daemon should reconnect.
    const nextConn = engine.nextConn()
    daemon.dropForTest()
    await nextConn

    await waitFor(() => engine.received.filter((m) => m.type === 'daemon:hello').length >= 2)
    expect(engine.received.filter((m) => m.type === 'daemon:hello').length).toBeGreaterThanOrEqual(2)

    daemon.stop()
    await engine.close()
  })
})
