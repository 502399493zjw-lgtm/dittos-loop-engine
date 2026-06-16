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

describe('daemonHub — keyed by userId', () => {
  it('hasDaemon flips on register and back off on unregister, per user', () => {
    const hub = daemonHub()
    const conn = fakeConn([])
    expect(hub.hasDaemon('u1')).toBe(false)
    hub.register('u1', conn)
    expect(hub.hasDaemon('u1')).toBe(true)
    // Another user is unaffected.
    expect(hub.hasDaemon('u2')).toBe(false)
    hub.unregister('u1')
    expect(hub.hasDaemon('u1')).toBe(false)
  })

  it('dispatch sends agent:run, forwards trace:batch events, resolves on turn:end', async () => {
    const hub = daemonHub()
    const sent: EngineToDaemonMessage[] = []
    hub.register('u1', fakeConn(sent))

    const seen: MappedEvent[] = []
    const events: MappedEvent[] = [
      { kind: 'thinking', payload: { content: 'hmm' }, severity: 'info' },
      { kind: 'text', payload: { content: 'hi', message_id: 'm1' }, severity: 'info' },
    ]
    const p = hub.dispatch('u1', 't1', { prompt: 'say hi', model: 'opus' }, (e) => seen.push(e))

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
    hub.register('u1', fakeConn([]))
    const seenA: MappedEvent[] = []
    const seenB: MappedEvent[] = []
    const pa = hub.dispatch('u1', 'a', { prompt: 'A' }, (e) => seenA.push(e))
    const pb = hub.dispatch('u1', 'b', { prompt: 'B' }, (e) => seenB.push(e))

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
    hub.register('u1', fakeConn([]))
    const p = hub.dispatch('u1', 't1', { prompt: 'x' }, () => {})
    hub.handleMessage({ type: 'turn:end', turnId: 't1', status: 'failed', finalText: '', error: 'boom' })
    const r = await p
    expect(r.isError).toBe(true)
    expect(r.errorText).toBe('boom')
  })

  it('dispatch rejects when that user has no daemon connected', async () => {
    const hub = daemonHub()
    await expect(hub.dispatch('u1', 't1', { prompt: 'x' }, () => {})).rejects.toThrow(/no daemon/)
  })

  it('routes a turn to the right user and never to another user', async () => {
    const hub = daemonHub()
    const sentA: EngineToDaemonMessage[] = []
    const sentB: EngineToDaemonMessage[] = []
    hub.register('alice', fakeConn(sentA))
    hub.register('bob', fakeConn(sentB))

    const p = hub.dispatch('alice', 't1', { prompt: 'for alice' }, () => {})
    // Only alice's conn received the agent:run.
    expect(sentA).toEqual<EngineToDaemonMessage[]>([{ type: 'agent:run', turnId: 't1', prompt: 'for alice' }])
    expect(sentB).toEqual([])

    hub.handleMessage({ type: 'turn:end', turnId: 't1', status: 'completed', finalText: 'done' })
    expect((await p).finalText).toBe('done')

    // bob has no daemon for HIS dispatch even though alice does.
    hub.unregister('bob')
    await expect(hub.dispatch('bob', 't2', { prompt: 'x' }, () => {})).rejects.toThrow(/no daemon/)
  })

  it('unregister fails any in-flight dispatch for that user', async () => {
    const hub = daemonHub()
    hub.register('u1', fakeConn([]))
    const p = hub.dispatch('u1', 't1', { prompt: 'x' }, () => {})
    hub.unregister('u1')
    await expect(p).rejects.toThrow(/disconnected/)
  })

  it('a stale conn unregister does not drop a reconnected daemon for the same user', () => {
    const hub = daemonHub()
    const first = fakeConn([])
    const second = fakeConn([])
    hub.register('u1', first)
    // User reconnects with a new conn (replaces the first).
    hub.register('u1', second)
    expect(hub.hasDaemon('u1')).toBe(true)
    // The OLD socket closes and unregisters with its own (stale) conn — must be a no-op.
    hub.unregister('u1', first)
    expect(hub.hasDaemon('u1')).toBe(true)
    // The current conn unregistering does drop it.
    hub.unregister('u1', second)
    expect(hub.hasDaemon('u1')).toBe(false)
  })

  it('ignores trace:batch / turn:end for an unknown turnId (no throw)', () => {
    const hub = daemonHub()
    hub.register('u1', fakeConn([]))
    expect(() => hub.handleMessage({ type: 'trace:batch', turnId: 'ghost', events: [] })).not.toThrow()
    expect(() => hub.handleMessage({ type: 'turn:end', turnId: 'ghost', status: 'completed', finalText: '' })).not.toThrow()
  })
})
