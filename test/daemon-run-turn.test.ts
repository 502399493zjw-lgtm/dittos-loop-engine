import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { runClaudeTurn } from '../src/daemon/main'
import type { TurnEvent } from '../src/daemon/main'

// A fake child_process.spawn that records argv and lets the test drive stdout /
// stderr / close, so runClaudeTurn is exercised WITHOUT a real `claude` spawn.
function fakeSpawn(script: (child: FakeChild) => void) {
  const calls: { bin: string; argv: string[] }[] = []
  const children: FakeChild[] = []
  const spawn = ((bin: string, argv: string[]) => {
    calls.push({ bin, argv })
    const child = new FakeChild()
    children.push(child)
    // Drive the scripted stream on the next tick so listeners are attached.
    queueMicrotask(() => script(child))
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, calls, children }
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written = ''
  stdin = { write: (s: string) => { this.written += s; return true }, end: () => {} }
  feed(line: string) { this.stdout.emit('data', Buffer.from(line)) }
  fail(line: string) { this.stderr.emit('data', Buffer.from(line)) }
  done(code: number) { this.emit('close', code) }
}

// A representative stream-json NDJSON: assistant (text + tool_use) → user
// (tool_result) → assistant (text) → result (success, usage).
const fixture: string[] = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_2', content: [{ type: 'text', text: ' Done.' }] },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Looking. Done.',
    is_error: false,
    usage: { input_tokens: 5, output_tokens: 4 },
  }),
]

describe('runClaudeTurn (fake spawn → daemon turn events)', () => {
  it('emits turn:start once, a trace:batch per mapped event, then turn:end with finalText', async () => {
    const { spawn, calls } = fakeSpawn((child) => {
      // Feed each NDJSON line (newline-terminated, multiple in one chunk too).
      child.feed(fixture.slice(0, 2).join('\n') + '\n')
      child.feed(fixture.slice(2).join('\n') + '\n')
      child.done(0)
    })

    const events: TurnEvent[] = []
    const result = await runClaudeTurn('hi', { spawn, model: 'opus', onEvent: (e) => events.push(e) })

    // claude was spawned with the stream-json + model flags and the prompt fed via stdin.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus'])

    // First event is exactly one turn:start.
    expect(events[0]).toEqual({ type: 'turn:start' })
    expect(events.filter((e) => e.type === 'turn:start')).toHaveLength(1)

    // One trace:batch per mapped event, in order, carrying the mapped kinds.
    const batches = events.filter((e) => e.type === 'trace:batch')
    const kinds = batches.flatMap((b) => (b.type === 'trace:batch' ? b.events.map((m) => m.kind) : []))
    expect(kinds).toEqual(['text', 'tool_use_start', 'tool_use_result', 'text', 'result'])

    // Last event is turn:end completed with assembled finalText + usage.
    const last = events[events.length - 1]!
    expect(last.type).toBe('turn:end')
    if (last.type === 'turn:end') {
      expect(last.status).toBe('completed')
      expect(last.finalText).toBe('Looking. Done.')
      expect(last.usage).toEqual({ input_tokens: 5, output_tokens: 4 })
      expect(last.error).toBeUndefined()
    }

    expect(result.status).toBe('completed')
    expect(result.finalText).toBe('Looking. Done.')
  })

  it('omits --model when no model is given and feeds the prompt on stdin', async () => {
    const { spawn, calls, children } = fakeSpawn((child) => {
      child.feed(JSON.stringify({ type: 'result', is_error: false, usage: {} }) + '\n')
      child.done(0)
    })
    await runClaudeTurn('the prompt', { spawn, onEvent: () => {} })
    expect(calls[0]!.argv).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(children[0]!.written).toBe('the prompt')
  })

  it('emits turn:end failed with an error when claude exits nonzero', async () => {
    const { spawn } = fakeSpawn((child) => {
      child.fail('boom from claude\n')
      child.done(1)
    })
    const events: TurnEvent[] = []
    const result = await runClaudeTurn('x', { spawn, onEvent: (e) => events.push(e) })
    const last = events[events.length - 1]!
    expect(last.type).toBe('turn:end')
    if (last.type === 'turn:end') {
      expect(last.status).toBe('failed')
      expect(last.error).toContain('boom from claude')
    }
    expect(result.status).toBe('failed')
  })

  it('emits turn:end failed when result.is_error is true', async () => {
    const { spawn } = fakeSpawn((child) => {
      child.feed(JSON.stringify({ type: 'result', subtype: 'error', result: 'nope', is_error: true }) + '\n')
      child.done(0)
    })
    const events: TurnEvent[] = []
    await runClaudeTurn('x', { spawn, onEvent: (e) => events.push(e) })
    const last = events[events.length - 1]!
    expect(last.type).toBe('turn:end')
    if (last.type === 'turn:end') {
      expect(last.status).toBe('failed')
      expect(last.error).toContain('nope')
    }
  })
})
