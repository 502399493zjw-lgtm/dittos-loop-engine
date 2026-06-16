import type { Executor, ExecutorRequest, ExecutorResult } from '../types'
interface Scripted { text?: string; error?: string; cost?: number }
export interface FakeExecutor extends Executor { calls: ExecutorRequest[] }
export function fakeExecutor(opts: { replies?: Record<string, Scripted> } = {}): FakeExecutor {
  const replies = opts.replies ?? {}
  const calls: ExecutorRequest[] = []
  return {
    calls,
    async run(req: ExecutorRequest): Promise<ExecutorResult> {
      calls.push(req)
      const hit = replies[`${req.agentId}:${req.prompt}`]
      if (hit?.error) throw new Error(hit.error)
      return { text: hit?.text ?? `echo:${req.prompt}`, cost: hit?.cost ?? 0 }
    },
  }
}
