import { describe, it, expect } from 'vitest'
import { mapStreamJsonLine, fakeStreamExecutor } from '../src/chat/streamExecutor'
import type { MappedEvent } from '../src/chat/streamExecutor'

// A representative `claude -p --output-format stream-json --verbose` NDJSON
// stream: init system → assistant (thinking + text + tool_use) → user
// (tool_result) → final result (usage). One line per event, as claude emits.
const fixture: string[] = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [
        { type: 'thinking', thinking: 'let me check the repo' },
        { type: 'text', text: 'Looking now.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt\nb.txt' },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_2', content: [{ type: 'text', text: 'Two files.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Two files.',
    is_error: false,
    total_cost_usd: 0.01,
    usage: { input_tokens: 12, output_tokens: 3 },
  }),
]

function mapAll(lines: string[]): MappedEvent[] {
  const out: MappedEvent[] = []
  for (const line of lines) out.push(...mapStreamJsonLine(line))
  return out
}

describe('mapStreamJsonLine (stream-json → TraceEvent kind/payload)', () => {
  it('maps a representative stream in order with the spec §3 payload shapes', () => {
    const events = mapAll(fixture)
    // Compare the whole mapped array so order + each kind/payload is pinned
    // in one assertion (and dodges noUncheckedIndexedAccess on indexing).
    expect(events).toEqual<MappedEvent[]>([
      { kind: 'thinking', payload: { content: 'let me check the repo' }, severity: 'info' },
      { kind: 'text', payload: { content: 'Looking now.', message_id: 'msg_1' }, severity: 'info' },
      {
        kind: 'tool_use_start',
        payload: { tool_use_id: 'tu_1', tool_name: 'Bash', input: { command: 'ls' } },
        severity: 'info',
      },
      {
        kind: 'tool_use_result',
        payload: { tool_use_id: 'tu_1', output: 'a.txt\nb.txt' },
        severity: 'info',
      },
      { kind: 'text', payload: { content: 'Two files.', message_id: 'msg_2' }, severity: 'info' },
      { kind: 'result', payload: { usage: { input_tokens: 12, output_tokens: 3 } }, severity: 'info' },
    ])
  })

  it('emits an error mapped event when result.is_error is true', () => {
    const errLine = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      result: 'boom',
      is_error: true,
    })
    const events = mapStreamJsonLine(errLine)
    expect(events).toEqual<MappedEvent[]>([
      { kind: 'error', payload: { error: 'boom', code: undefined }, severity: 'error' },
    ])
  })

  it('ignores system/init and blank lines (no mapped events)', () => {
    expect(mapStreamJsonLine('')).toEqual([])
    expect(mapStreamJsonLine('   ')).toEqual([])
    expect(mapStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([])
  })
})

describe('fakeStreamExecutor', () => {
  it('replays scripted events to onEvent then resolves finalText/usage and records calls', async () => {
    const scripted: MappedEvent[] = [
      { kind: 'thinking', payload: { content: 'hmm' }, severity: 'info' },
      { kind: 'text', payload: { content: 'hello', message_id: 'm1' }, severity: 'info' },
      { kind: 'result', payload: { usage: { output_tokens: 2 } }, severity: 'info' },
    ]
    const ex = fakeStreamExecutor({
      events: scripted,
      finalText: 'hello',
      usage: { output_tokens: 2 },
    })
    const seen: MappedEvent[] = []
    const r = await ex.run({ prompt: 'hi', model: 'opus' }, (e) => seen.push(e))
    expect(seen).toEqual(scripted)
    expect(r.finalText).toBe('hello')
    expect(r.usage).toEqual({ output_tokens: 2 })
    expect(r.isError).toBeFalsy()
    expect(ex.calls).toEqual([{ prompt: 'hi', model: 'opus' }])
  })

  it('reports isError + errorText when scripted to error', async () => {
    const ex = fakeStreamExecutor({
      events: [{ kind: 'error', payload: { error: 'nope' }, severity: 'error' }],
      finalText: '',
      isError: true,
      errorText: 'nope',
    })
    const r = await ex.run({ prompt: 'x' }, () => {})
    expect(r.isError).toBe(true)
    expect(r.errorText).toBe('nope')
  })
})
