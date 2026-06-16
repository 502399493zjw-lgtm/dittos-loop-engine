import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { respondToMessage } from '../src/chat/respond'
import { jsonTurnStore } from '../src/chat/turnStore'
import { jsonTraceStore } from '../src/chat/traceStore'
import { jsonSessionStore } from '../src/session/jsonSessionStore'
import { fakeStreamExecutor } from '../src/chat/streamExecutor'
import type { MappedEvent } from '../src/chat/streamExecutor'

const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

// Recording emit sink: captures (type, payload) pairs in order.
const recorder = () => {
  const events: { type: string; payload: any }[] = []
  const emit = (type: string, payload: unknown) => { events.push({ type, payload: payload as any }) }
  const typesOf = () => events.map((e) => e.type)
  const first = (type: string) => events.find((e) => e.type === type)
  const all = (type: string) => events.filter((e) => e.type === type)
  return { events, emit, typesOf, first, all }
}

async function makeDeps(dir: string, ex: ReturnType<typeof fakeStreamExecutor>) {
  const now = clock()
  return {
    sessionStore: jsonSessionStore(join(dir, 'sess'), { now }),
    turnStore: jsonTurnStore(join(dir, 'turns'), { now }),
    traceStore: jsonTraceStore(join(dir, 'trace'), { now }),
    streamExecutor: ex,
    now,
  }
}

describe('respondToMessage', () => {
  it('emits envelopes in spec order for a successful run and persists the agent message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resp-'))
    const scripted: MappedEvent[] = [
      { kind: 'thinking', payload: { content: 'let me think' }, severity: 'info' },
      { kind: 'tool_use_start', payload: { tool_use_id: 'tu_1', tool_name: 'Read', input: { p: 'x' } }, severity: 'info' },
      { kind: 'tool_use_result', payload: { tool_use_id: 'tu_1', output: 'ok' }, severity: 'info' },
      { kind: 'text', payload: { content: 'Hello world', message_id: 'msg_a' }, severity: 'info' },
      { kind: 'result', payload: { usage: { output_tokens: 5 } }, severity: 'info' },
    ]
    const ex = fakeStreamExecutor({ events: scripted, finalText: 'Hello world', usage: { output_tokens: 5 } })
    const deps = await makeDeps(dir, ex)
    const rec = recorder()

    const session = await deps.sessionStore.createSession(undefined, { ownerId: 'A' })
    const userMsg = await deps.sessionStore.appendMessage(session.id, {
      sender_type: 'user', type: 'text', content: { text: 'hi agent' },
    })

    const result = await respondToMessage(
      { ...deps, emit: rec.emit },
      { channelId: session.id, ownerId: 'A', userMessage: userMsg },
    )

    // Ordering: turn:created → turn:update(in_progress) → trace... → msg:chunk(s)
    // → new_message(agent) → turn:update(completed). Pin the first/last decisively.
    const types = rec.typesOf()
    const createdIdx = types.indexOf('turn:created')
    const inProgIdx = types.findIndex((t, i) => t === 'turn:update' && (rec.events[i]!.payload.status === 'in_progress'))
    const firstTrace = types.indexOf('trace:batch') === -1 ? types.indexOf('trace:event') : types.indexOf('trace:batch')
    const firstChunk = types.indexOf('msg:chunk')
    const newMsgIdx = types.indexOf('new_message')
    const completedIdx = types.findIndex((t, i) => t === 'turn:update' && (rec.events[i]!.payload.status === 'completed'))

    expect(createdIdx).toBeGreaterThanOrEqual(0)
    expect(inProgIdx).toBeGreaterThan(createdIdx)
    expect(firstTrace).toBeGreaterThan(inProgIdx)
    expect(firstChunk).toBeGreaterThan(inProgIdx)
    expect(newMsgIdx).toBeGreaterThan(firstChunk)
    expect(completedIdx).toBeGreaterThan(newMsgIdx)

    // turn:created envelope shape (spec §1)
    const created = rec.first('turn:created')!.payload
    expect(created.status).toBe('queued')
    expect(created.channel_id).toBe(session.id)
    expect(created.trigger_msg_id).toBe(userMsg.id)
    expect(created.turn_id).toBeTruthy()
    expect(created.agent_id).toBeTruthy()
    expect(typeof created.created_at).toBe('number')

    // turn:update(in_progress) carries started_at
    const inProg = rec.events.find((e) => e.type === 'turn:update' && e.payload.status === 'in_progress')!.payload
    expect(inProg.turn_id).toBe(created.turn_id)
    expect(typeof inProg.started_at).toBe('number')

    // trace events persisted + broadcast (one per mapped event)
    const traceEvents = await deps.traceStore.list(created.turn_id)
    expect(traceEvents.map((e) => e.kind)).toEqual(['thinking', 'tool_use_start', 'tool_use_result', 'text', 'result'])

    // msg:chunk envelope shape (spec §1) — chunk text + agent message id, finalised
    const chunks = rec.all('msg:chunk').map((e) => e.payload)
    expect(chunks.length).toBeGreaterThan(0)
    const firstC = chunks[0]!
    expect(firstC.channel_id).toBe(session.id)
    expect(firstC.message_id).toBeTruthy()
    expect(firstC.agent_id).toBeTruthy()
    expect(firstC.streaming).toBe(true)
    // all chunks share one message_id
    expect(new Set(chunks.map((c) => c.message_id)).size).toBe(1)
    const finalChunk = chunks[chunks.length - 1]!
    expect(finalChunk.is_final).toBe(true)

    // new_message: the agent's final message, linked to the turn
    const nm = rec.first('new_message')!.payload
    expect(nm.channel_id).toBe(session.id)
    expect(nm.message.sender_type).toBe('agent')
    expect(nm.message.turn_id).toBe(created.turn_id)
    expect(nm.message.content.text).toBe('Hello world')

    // completed turn:update carries usage
    const completed = rec.events.find((e) => e.type === 'turn:update' && e.payload.status === 'completed')!.payload
    expect(completed.turn_id).toBe(created.turn_id)
    expect(completed.usage).toEqual({ output_tokens: 5 })
    expect(typeof completed.completed_at).toBe('number')

    // persisted: turn completed; agent message stored with turn_id
    const turn = await deps.turnStore.get(created.turn_id)
    expect(turn!.status).toBe('completed')
    const msgs = await deps.sessionStore.getMessages(session.id)
    const agentMsg = msgs.find((m) => m.sender_type === 'agent')!
    expect(agentMsg.turn_id).toBe(created.turn_id)
    expect(agentMsg.content.text).toBe('Hello world')
    expect(agentMsg.id).toBe(finalChunk.message_id)

    // return value links turn + message
    expect(result.turn.turn_id).toBe(created.turn_id)
    expect(result.message!.id).toBe(agentMsg.id)

    // the prompt assembled from history was fed to the executor
    expect(ex.calls.length).toBe(1)
    expect(ex.calls[0]!.prompt).toContain('hi agent')
  })

  it('marks the turn failed and emits turn:update(failed) with error on an isError run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resp-'))
    const ex = fakeStreamExecutor({
      events: [{ kind: 'error', payload: { error: 'spawn boom', code: 1 }, severity: 'error' }],
      finalText: '',
      isError: true,
      errorText: 'spawn boom',
    })
    const deps = await makeDeps(dir, ex)
    const rec = recorder()

    const session = await deps.sessionStore.createSession(undefined, { ownerId: 'A' })
    const userMsg = await deps.sessionStore.appendMessage(session.id, {
      sender_type: 'user', type: 'text', content: { text: 'do it' },
    })

    const result = await respondToMessage(
      { ...deps, emit: rec.emit },
      { channelId: session.id, ownerId: 'A', userMessage: userMsg },
    )

    const created = rec.first('turn:created')!.payload
    const failed = rec.events.find((e) => e.type === 'turn:update' && e.payload.status === 'failed')
    expect(failed).toBeTruthy()
    expect(failed!.payload.turn_id).toBe(created.turn_id)
    expect(failed!.payload.error_message).toBe('spawn boom')

    // no agent message persisted on failure
    const msgs = await deps.sessionStore.getMessages(session.id)
    expect(msgs.find((m) => m.sender_type === 'agent')).toBeUndefined()
    // no new_message broadcast on failure
    expect(rec.first('new_message')).toBeUndefined()

    const turn = await deps.turnStore.get(created.turn_id)
    expect(turn!.status).toBe('failed')
    expect(turn!.error_message).toBe('spawn boom')
    expect(result.turn.status).toBe('failed')
    expect(result.message).toBeUndefined()
  })

  it('emits msg:chunk per text_delta and accumulates into the final agent message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resp-'))
    const ex = fakeStreamExecutor({
      events: [
        { kind: 'text_delta', payload: { chunk: 'Hel', message_id: 'm1' }, severity: 'info' },
        { kind: 'text_delta', payload: { chunk: 'lo', message_id: 'm1' }, severity: 'info' },
        { kind: 'result', payload: { usage: {} }, severity: 'info' },
      ],
      finalText: 'Hello',
    })
    const deps = await makeDeps(dir, ex)
    const rec = recorder()
    const session = await deps.sessionStore.createSession(undefined, { ownerId: 'A' })
    const userMsg = await deps.sessionStore.appendMessage(session.id, {
      sender_type: 'user', type: 'text', content: { text: 'hi' },
    })
    await respondToMessage({ ...deps, emit: rec.emit }, { channelId: session.id, ownerId: 'A', userMessage: userMsg })

    const streamingChunks = rec.all('msg:chunk').filter((e) => !e.payload.is_final).map((e) => e.payload.chunk)
    expect(streamingChunks).toEqual(['Hel', 'lo'])
    const nm = rec.first('new_message')!.payload
    expect(nm.message.content.text).toBe('Hello')
  })
})
