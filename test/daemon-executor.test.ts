import { describe, it, expect } from 'vitest'
import { daemonHub } from '../src/daemon/daemonHub'
import { daemonExecutor } from '../src/daemon/daemonExecutor'
import type { DaemonConn } from '../src/daemon/daemonHub'
import type { AgentRunMessage, EngineToDaemonMessage } from '../src/daemon/protocol'
import type { MappedEvent } from '../src/chat/streamExecutor'

// A fake daemon that auto-replies to each agent:run by streaming the scripted
// events then a turn:end — so dispatch() resolves without a real WS.
function autoReplyConn(
  hub: ReturnType<typeof daemonHub>,
  script: { events: MappedEvent[]; finalText: string; usage?: unknown; fail?: boolean },
): { conn: DaemonConn; sent: EngineToDaemonMessage[] } {
  const sent: EngineToDaemonMessage[] = []
  const conn: DaemonConn = {
    send: (msg) => {
      sent.push(msg)
      if (msg.type !== 'agent:run') return
      const run = msg as AgentRunMessage
      // Reply asynchronously, like a real daemon over the wire.
      queueMicrotask(() => {
        hub.handleMessage({ type: 'turn:start', turnId: run.turnId })
        hub.handleMessage({ type: 'trace:batch', turnId: run.turnId, events: script.events })
        hub.handleMessage({
          type: 'turn:end',
          turnId: run.turnId,
          status: script.fail ? 'failed' : 'completed',
          finalText: script.finalText,
          ...(script.usage !== undefined ? { usage: script.usage } : {}),
          ...(script.fail ? { error: script.finalText } : {}),
        })
      })
    },
  }
  return { conn, sent }
}

describe('daemonExecutor', () => {
  it('as StreamExecutor: dispatches + forwards events + resolves finalText/usage', async () => {
    const hub = daemonHub()
    const events: MappedEvent[] = [
      { kind: 'thinking', payload: { content: 'hmm' }, severity: 'info' },
      { kind: 'text', payload: { content: 'hello', message_id: 'm1' }, severity: 'info' },
    ]
    const { conn, sent } = autoReplyConn(hub, { events, finalText: 'hello', usage: { output_tokens: 2 } })
    hub.register(conn)
    const ex = daemonExecutor(hub)

    const seen: MappedEvent[] = []
    const r = await ex.run({ prompt: 'hi', model: 'opus' }, (e) => seen.push(e))
    expect(seen).toEqual(events)
    expect(r.finalText).toBe('hello')
    expect(r.usage).toEqual({ output_tokens: 2 })
    expect(r.isError).toBeFalsy()
    // The agent:run carried prompt + model (turnId is engine-generated).
    const run = sent.find((m) => m.type === 'agent:run') as AgentRunMessage
    expect(run.prompt).toBe('hi')
    expect(run.model).toBe('opus')
    expect(run.turnId).toBeTruthy()
  })

  it('as Executor: same dispatch returns { text, cost }', async () => {
    const hub = daemonHub()
    const { conn } = autoReplyConn(hub, {
      events: [{ kind: 'text', payload: { content: 'done' }, severity: 'info' }],
      finalText: 'done',
      usage: { cost: 0.05 },
    })
    hub.register(conn)
    const ex = daemonExecutor(hub)

    const r = await ex.run({ agentId: 'claude', prompt: 'do it' })
    expect(r.text).toBe('done')
    expect(r.cost).toBe(0.05)
  })

  it('surfaces a failed turn as isError', async () => {
    const hub = daemonHub()
    const { conn } = autoReplyConn(hub, { events: [], finalText: 'boom', fail: true })
    hub.register(conn)
    const ex = daemonExecutor(hub)
    const r = await ex.run({ prompt: 'x' }, () => {})
    expect(r.isError).toBe(true)
    expect(r.errorText).toBe('boom')
  })

  it('rejects with a clear error when no daemon is connected', async () => {
    const hub = daemonHub()
    const ex = daemonExecutor(hub)
    await expect(ex.run({ prompt: 'x' }, () => {})).rejects.toThrow(/no daemon/)
    await expect(ex.run({ agentId: 'claude', prompt: 'x' })).rejects.toThrow(/no daemon/)
  })
})
