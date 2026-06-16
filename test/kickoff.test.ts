import { describe, it, expect } from 'vitest'
import { kickoffMessage } from '../src/loop/kickoff'

describe('kickoffMessage', () => {
  it('is the global template with the reason spliced in', () => {
    const m = kickoffMessage('你手动触发')
    expect(m).toContain('你手动触发')
    expect(m).toContain('loop flow')
  })
})
