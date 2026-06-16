import { describe, it, expect } from 'vitest'
import { daemonHub } from '../src/daemon/daemonHub'
import type { DaemonConn } from '../src/daemon/daemonHub'
import type { EngineToDaemonMessage } from '../src/daemon/protocol'
import type { MappedEvent } from '../src/chat/streamExecutor'

// A fake daemon conn that records what the engine sent and lets the test script
// the daemon's replies (turn:start → trace:batch → turn:end) into the hub.
function fakeConn(sent: EngineToDaemonMessage[]): DaemonConn {
  return { send: (msg) => sent.push(msg) }
}

describe('daemonHub', () => {
  it('hasDaemon flips on register and back off on unregister', () => {
    const hub = daemonHub()
    const conn = fakeConn([])
    expect(hub.hasDaemon()).toBe(false)
    hub.register(conn)
    expect(hub.hasDaemon()).toBe(true)
    hub.unregister(conn)
    expect(hub.hasDaemon()).toBe(false)
  })

  it('dispatch sends agent:run, forwards trace:batch events, resolves on turn:end', async () => {
    const hub = daemonHub()
    const sent: EngineToDaemonMessage[] = []
    hub.register(fakeConn(sent))

    const seen: MappedEvent[] = []
    const events: MappedEvent[] = [
      { kind: 'thinking', payload: { content: 'hmm' }, severity: 'info' },
      { kind: 'text', payload: { content: 'hi', message_id: 'm1' }, severity: 'info' },
    ]
    const p = hub.dispatch('t1', { prompt: 'say hi', model: 'opus' }, (e) => seen.push(e))

    // The agent:run was sent with the turnId + prompt + model.
    expect(sent).toEqual<EngineToDaemonMessage[]>([
      { type: 'agent:run', turnId: 't1', prompt: 'say hi', model: 'opus' },
    ])

    // Script the daemon's reply: start → batch → end.
    hub.handleMessage({ type: 'turn:start', turnId: 't1' })
    hub.handleMessage({ type: 'trace:batch', turnId: 't1', events })
    hub.handleMessage({ type: 'turn:end', turnId: 't1', status: 'completed', finalText: 'hi', usage: { output_tokens: 2 } })

    const r = await p
    expect(seen).toEqual(events)
    expect(r.finalText).toBe('hi')
    expect(r.usage).toEqual({ output_tokens: 2 })
    expect(r.isError).toBeFalsy()
  })

  it('correlates by turnId across two concurrent dispatches', async () => {
    const hub = daemonHub()
    hub.register(fakeConn([]))
    const seenA: MappedEvent[] = []
    const seenB: MappedEvent[] = []
    const pa = hub.dispatch('a', { prompt: 'A' }, (e) => seenA.push(e))
    const pb = hub.dispatch('b', { prompt: 'B' }, (e) => seenB.push(e))

    hub.handleMessage({ type: 'trace:batch', turnId: 'b', events: [{ kind: 'text', payload: { content: 'B-evt' }, severity: 'info' }] })
    hub.handleMessage({ type: 'trace:batch', turnId: 'a', events: [{ kind: 'text', payload: { content: 'A-evt' }, severity: 'info' }] })
    hub.handleMessage({ type: 'turn:end', turnId: 'a', status: 'completed', finalText: 'A-final' })
    hub.handleMessage({ type: 'turn:end', turnId: 'b', status: 'completed', finalText: 'B-final' })

    expect((await pa).finalText).toBe('A-final')
    expect((await pb).finalText).toBe('B-final')
    expect(seenA.map((e) => (e.payload as { content: string }).content)).toEqual(['A-evt'])
    expect(seenB.map((e) => (e.payload as { content: string }).content)).toEqual(['B-evt'])
  })

  it('turn:end status=failed resolves with isError + errorText', async () => {
    const hub = daemonHub()
    hub.register(fakeConn([]))
    const p = hub.dispatch('t1', { prompt: 'x' }, () => {})
    hub.handleMessage({ type: 'turn:end', turnId: 't1', status: 'failed', finalText: '', error: 'boom' })
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.errorText).toBe('boom')
  })

  it('dispatch rejects when no daemon is connected', async () => {
    const hub = daemonHub()
    await expect(hub.dispatch('t1', { prompt: 'x' }, () => {})).rejects.toThrow(/no daemon/)
  })

  it('unregister fails any in-flight dispatch', async () => {
    const hub = daemonHub()
    const conn = fakeConn([])
    hub.register(conn)
    const p = hub.dispatch('t1', { prompt: 'x' }, () => {})
    hub.unregister(conn)
    await expect(p).rejects.toThrow(/disconnected/)
  })

  it('ignores trace:batch / turn:end for an unknown turnId (no throw)', () => {
    const hub = daemonHub()
    hub.register(fakeConn([]))
    expect(() => hub.handleMessage({ type: 'trace:batch', turnId: 'ghost', events: [] })).not.toThrow()
    expect(() => hub.handleMessage({ type: 'turn:end', turnId: 'ghost', status: 'completed', finalText: '' })).not.toThrow()
  })
})
