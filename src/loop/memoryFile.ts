import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Memory } from '../types'

/**
 * Append-only file-backed memory for a loop's `memory.md`.
 * `read()` returns the full file text ('' when absent); `append(line)` writes `line + '\n'`.
 * Mirrors P1 `jsonStore`'s existsSync/mkdirSync/readFileSync/appendFileSync pattern.
 */
export function memoryFile(path: string): Memory {
  return {
    read() {
      if (!existsSync(path)) return ''
      return readFileSync(path, 'utf8')
    },
    append(line: string) {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      appendFileSync(path, line + '\n')
    },
  }
}
