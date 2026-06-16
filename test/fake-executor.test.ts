import { describe, it, expect } from 'vitest'
import { fakeExecutor } from '../src/executor/fake'
describe('fakeExecutor', () => {
  it('returns a scripted reply per agentId+prompt and records calls', async () => {
    const ex = fakeExecutor({ replies: { 'claude:hi': { text: 'hello' } } })
    const r = await ex.run({ agentId: 'claude', prompt: 'hi' })
    expect(r.text).toBe('hello')
    expect(ex.calls).toEqual([{ agentId: 'claude', prompt: 'hi', model: undefined, schema: undefined }])
  })
  it('falls back to an echo reply when unscripted', async () => {
    const ex = fakeExecutor()
    expect((await ex.run({ agentId: 'a', prompt: 'x' })).text).toContain('x')
  })
  it('throws when a reply is configured to error', async () => {
    const ex = fakeExecutor({ replies: { 'a:boom': { error: 'nope' } } })
    await expect(ex.run({ agentId: 'a', prompt: 'boom' })).rejects.toThrow('nope')
  })
})
