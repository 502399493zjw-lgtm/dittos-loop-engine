import { describe, it, expect } from 'vitest'
import { makeIdGen } from '../src/engine/ids'
describe('makeIdGen', () => {
  it('produces stable, prefixed, incrementing ids', () => {
    const id = makeIdGen()
    expect(id('phase')).toBe('phase-1')
    expect(id('agent')).toBe('agent-1')
    expect(id('agent')).toBe('agent-2')
  })
})
