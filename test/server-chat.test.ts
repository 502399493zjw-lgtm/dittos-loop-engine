import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { jsonTurnStore } from '../src/chat/turnStore'
import { jsonTraceStore } from '../src/chat/traceStore'
import { fakeStreamExecutor } from '../src/chat/streamExecutor'
import type { MappedEvent } from '../src/chat/streamExecutor'
import type { Message } from '../src/session/types'
import type { Turn, TraceEvent } from '../src/chat/types'
import WebSocket from 'ws'

// A server with the chat slice wired: session + turn + trace stores + a scripted
// stream executor. No auth → routes are public (dev path).
function chatServer(ex?: ReturnType<typeof fakeStreamExecutor>) {
  const base = mkdtempSync(join(tmpdir(), 'srv-chat-'))
  const sessionStore = jsonSessionStore(join(base, 'sess'))
  const turnStore = jsonTurnStore(join(base, 'turns'))
  const traceStore = jsonTraceStore(join(base, 'trace'))
  const streamExecutor = ex ?? fakeStreamExecutor({
    events: [
      { kind: 'thinking', payload: { content: 'hmm' }, severity: 'info' },
      { kind: 'text', payload: { content: 'Hi there', message_id: 'm1' }, severity: 'info' },
      { kind: 'result', payload: { usage: { output_tokens: 3 } }, severity: 'info' },
    ] as MappedEvent[],
    finalText: 'Hi there',
    usage: { output_tokens: 3 },
  })
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
    sessionStore, turnStore, traceStore, streamExecutor,
  })
  return { srv, sessionStore, turnStore, traceStore, streamExecutor }
}

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

describe('server — chat endpoints', () => {
  it('POST /channels/:id/messages persists + returns the user message, GET lists it', async () => {
    const { srv } = chatServer()
    const { port } = await srv.listen(0)
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json()) as { id: string }

    const res = await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'hello agent' } }),
    })
    expect(res.status).toBe(200)
    const msg = (await res.json()) as Message
    expect(msg.sender_type).toBe('user')
    expect(msg.content.text).toBe('hello agent')
    expect(msg.channel_id).toBe(session.id)
    expect(msg.seq).toBe(0)

    const list = (await (await fetch(`http://localhost:${port}/channels/${session.id}/messages`)).json()) as Message[]
    // includes the user message + (eventually) the agent reply; the user one is present immediately
    expect(list.some((m) => m.content.text === 'hello agent' && m.sender_type === 'user')).toBe(true)

    await srv.close()
  })

  it('the first user message names the session (first ~20 chars, … when longer)', async () => {
    const { srv, sessionStore } = chatServer()
    const { port } = await srv.listen(0)
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json()) as { id: string }

    const long = 'Summarize the latest GitHub trending repos for me please'
    await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: long } }),
    })
    const titled = (await sessionStore.listSessions()).find((s) => s.id === session.id)
    expect(titled?.title).toBe(long.slice(0, 20) + '…')

    // A second message does NOT rename the conversation.
    await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'and the second one' } }),
    })
    const after = (await sessionStore.listSessions()).find((s) => s.id === session.id)
    expect(after?.title).toBe(long.slice(0, 20) + '…')

    await srv.close()
  })

  it('a WS subscriber sees turn:created → ... → new_message(agent) → turn:update(completed) after POST', async () => {
    const { srv } = chatServer()
    const { port } = await srv.listen(0)
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json()) as { id: string }

    // Subscribe with trace before posting so we catch the whole turn lifecycle.
    const collected = collectWs(
      `ws://localhost:${port}/channels/${session.id}/events?trace=1`,
      (types) => types.some((t, i) => t === 'turn:update' && i >= 0) && types.includes('new_message')
        && types.filter((t) => t === 'turn:update').length >= 2,
    )
    // Give the WS a tick to attach before firing.
    await new Promise((r) => setTimeout(r, 50))

    const res = await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'hello agent' } }),
    })
    expect(res.status).toBe(200)

    const msgs = await collected
    const types = msgs.map((m) => m.type)
    // ordering: turn:created precedes the AGENT new_message precedes the completed
    // turn:update. (The user's own message is echoed too, before turn:created.)
    // Wire shape: the trace v2 family (turn:* / trace:* / msg:chunk) is NESTED
    // under `payload`; new_message is FLAT (channel_id + message at top level).
    const createdIdx = types.indexOf('turn:created')
    const agentMsgIdx = msgs.findIndex((m) => m.type === 'new_message' && m.message.sender_type === 'agent')
    const completedIdx = msgs.findIndex((m) => m.type === 'turn:update' && m.payload.status === 'completed')
    expect(createdIdx).toBeGreaterThanOrEqual(0)
    expect(agentMsgIdx).toBeGreaterThan(createdIdx)
    expect(completedIdx).toBeGreaterThan(agentMsgIdx)
    // turn:created/turn:update carry their fields under `payload` (frontend reads data.payload)
    expect(msgs[createdIdx]!.payload.turn_id).toBeTruthy()
    expect(msgs[createdIdx]!.payload.status).toBe('queued')
    // trace flowed too (subscribe_trace) — also nested under `payload`
    const traceEnv = msgs.find((m) => m.type === 'trace:batch' || m.type === 'trace:event')!
    expect(traceEnv.payload.turn_id).toBeTruthy()
    // the agent reply was the streamed text (new_message is flat)
    const nm = msgs[agentMsgIdx]!
    expect(nm.message.content.text).toBe('Hi there')

    await srv.close()
  })

  it('GET /turns/:id + /turns/:id/events return the persisted turn + trace events', async () => {
    const { srv } = chatServer()
    const { port } = await srv.listen(0)
    const session = (await (await fetch(`http://localhost:${port}/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    })).json()) as { id: string }

    // Capture the turn_id off the WS, and wait for completion so the turn is persisted.
    const collected = collectWs(
      `ws://localhost:${port}/channels/${session.id}/events?trace=1`,
      (types) => types.filter((t) => t === 'turn:update').length >= 2,
    )
    await new Promise((r) => setTimeout(r, 50))
    await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'hi' } }),
    })
    const msgs = await collected
    // turn:created is nested: { type, payload: { turn_id, ... } }
    const turnId = msgs.find((m) => m.type === 'turn:created')!.payload.turn_id as string

    const turn = (await (await fetch(`http://localhost:${port}/turns/${turnId}`)).json()) as Turn
    expect(turn.turn_id).toBe(turnId)
    expect(turn.channel_id).toBe(session.id)
    expect(turn.status).toBe('completed')

    const ev = (await (await fetch(`http://localhost:${port}/turns/${turnId}/events`)).json()) as { turn_id: string; events: TraceEvent[] }
    expect(ev.turn_id).toBe(turnId)
    expect(ev.events.map((e) => e.kind)).toEqual(['thinking', 'text', 'result'])
    // after_seq filters
    const after = (await (await fetch(`http://localhost:${port}/turns/${turnId}/events?after_seq=0`)).json()) as { events: TraceEvent[] }
    expect(after.events.every((e) => e.seq > 0)).toBe(true)

    // GET /channels/:id/turns lists the turn
    const turns = (await (await fetch(`http://localhost:${port}/channels/${session.id}/turns`)).json()) as Turn[]
    expect(turns.map((t) => t.turn_id)).toContain(turnId)

    await srv.close()
  })

  it('GET /channels/:id/messages paginates by seq (before_seq + limit)', async () => {
    const { srv, sessionStore } = chatServer()
    const { port } = await srv.listen(0)
    const session = await sessionStore.createSession(undefined)
    // seed five user messages directly (deterministic seqs 0..4)
    for (let i = 0; i < 5; i++) {
      await sessionStore.appendMessage(session.id, { sender_type: 'user', type: 'text', content: { text: `m${i}` } })
    }

    const limited = (await (await fetch(`http://localhost:${port}/channels/${session.id}/messages?limit=2`)).json()) as Message[]
    expect(limited).toHaveLength(2)
    // the most recent page (highest seqs), chronological
    expect(limited.map((m) => m.seq)).toEqual([3, 4])

    const older = (await (await fetch(`http://localhost:${port}/channels/${session.id}/messages?before_seq=3&limit=2`)).json()) as Message[]
    expect(older.map((m) => m.seq)).toEqual([1, 2])

    await srv.close()
  })

  it('chat routes 500 when the chat stores are not configured', async () => {
    const sessionStore = jsonSessionStore(mkdtempSync(join(tmpdir(), 'srv-nochat-')))
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, sessionStore })
    const { port } = await srv.listen(0)
    const session = await sessionStore.createSession(undefined)
    const res = await fetch(`http://localhost:${port}/channels/${session.id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'text', content: { text: 'x' } }),
    })
    expect(res.status).toBe(500)
    const turn = await fetch(`http://localhost:${port}/turns/whatever`)
    expect(turn.status).toBe(500)
    await srv.close()
  })
})
