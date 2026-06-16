import { describe, it, expect } from 'vitest'
import { claudeCliExecutor } from '../src/executor/claudeCli'

function fakeSpawn(stdout: string, code = 0) {
  return () => ({
    stdout: { on: (_e: string, cb: (b: Buffer) => void) => cb(Buffer.from(stdout)) },
    stderr: { on: () => {} },
    on: (e: string, cb: (c: number) => void) => { if (e === 'close') cb(code) },
  }) as never
}

describe('claudeCliExecutor', () => {
  it('parses the final JSON line: result + total_cost_usd', async () => {
    const line = JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.42, is_error: false })
    const ex = claudeCliExecutor({ spawn: fakeSpawn(`noise\n${line}\n`) })
    const r = await ex.run({ agentId: 'claude', prompt: 'hi' })
    expect(r.text).toBe('done'); expect(r.cost).toBe(0.42)
  })
  it('throws on is_error true', async () => {
    const line = JSON.stringify({ type: 'result', result: 'bad', is_error: true })
    const ex = claudeCliExecutor({ spawn: fakeSpawn(line) })
    await expect(ex.run({ agentId: 'claude', prompt: 'x' })).rejects.toThrow()
  })
  it('throws on nonzero exit', async () => {
    const ex = claudeCliExecutor({ spawn: fakeSpawn('', 1) })
    await expect(ex.run({ agentId: 'claude', prompt: 'x' })).rejects.toThrow()
  })
})
