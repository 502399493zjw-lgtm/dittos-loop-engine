import { spawn as nodeSpawn } from 'node:child_process'
import type { Executor, ExecutorRequest, ExecutorResult } from '../types'

export function claudeCliExecutor(opts: { spawn?: typeof nodeSpawn; bin?: string } = {}): Executor {
  const spawn = opts.spawn ?? nodeSpawn
  const bin = opts.bin ?? 'claude'
  return {
    run(req: ExecutorRequest): Promise<ExecutorResult> {
      return new Promise((resolve, reject) => {
        const argv = ['-p', '--output-format', 'json']
        if (req.model) argv.push('--model', req.model)
        argv.push(req.prompt)
        const child = spawn(bin, argv)
        let out = ''
        child.stdout.on('data', (b: Buffer) => { out += b.toString() })
        child.stderr.on('data', () => {})
        child.on('close', (code: number) => {
          if (code !== 0) return reject(new Error(`claude exited ${code}`))
          const last = out.trim().split('\n').filter(Boolean).pop() ?? ''
          let json: { result?: string; total_cost_usd?: number; is_error?: boolean }
          try { json = JSON.parse(last) } catch { return reject(new Error(`unparseable claude output: ${last.slice(0, 200)}`)) }
          if (json.is_error) return reject(new Error(`claude run errored: ${json.result ?? ''}`))
          resolve({ text: json.result ?? '', raw: json, cost: json.total_cost_usd })
        })
      })
    },
  }
}
