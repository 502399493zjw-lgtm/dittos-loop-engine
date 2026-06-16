import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryFile } from '../src/loop/memoryFile'

describe('memoryFile', () => {
  it('read returns "" when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-mem-'))
    const m = memoryFile(join(dir, 'loop.md'))
    expect(m.read()).toBe('')
  })

  it('append-only: read returns appended lines joined with newlines + trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-mem-'))
    const path = join(dir, 'loop.md')
    const m = memoryFile(path)
    m.append('a')
    m.append('b')
    expect(m.read()).toBe('a\nb\n')
  })

  it('persists across separate memoryFile handles for the same path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-mem-'))
    const path = join(dir, 'loop.md')
    memoryFile(path).append('one')
    const m2 = memoryFile(path)
    m2.append('two')
    expect(m2.read()).toBe('one\ntwo\n')
  })

  it('creates the parent directory if missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-mem-'))
    const path = join(dir, 'nested', 'deep', 'loop.md')
    const m = memoryFile(path)
    m.append('hi')
    expect(m.read()).toBe('hi\n')
  })
})
