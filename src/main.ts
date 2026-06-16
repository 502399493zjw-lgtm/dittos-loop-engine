/**
 * Dev entrypoint + end-to-end smoke. Runs a tiny demo flow and prints the
 * event stream. With RUN_REAL=1 it uses the real `claude -p` executor (costs
 * tokens, uses your logged-in subscription); otherwise the deterministic fake.
 *
 *   npm run dev            # fake executor
 *   RUN_REAL=1 npm run dev # real claude -p
 */
import { runFlow } from './engine/runtime'
import { claudeCliExecutor } from './executor/claudeCli'
import { fakeExecutor } from './executor/fake'
import type { Flow } from './types'

const demo: Flow = async (api) => {
  api.phase('demo')
  api.log('starting demo flow')
  const greeting = await api.agent('用一句话友好地跟用户打个招呼,说明你是 Dittos 的 Loop Flow agent。')
  return greeting
}

const real = process.env.RUN_REAL === '1'
const executor = real
  ? claudeCliExecutor()
  : fakeExecutor({ replies: { 'claude:用一句话友好地跟用户打个招呼,说明你是 Dittos 的 Loop Flow agent。': { text: '你好!我是 Dittos 的 Loop Flow agent。' } } })

const res = await runFlow(demo, {
  runId: 'smoke-1',
  executor,
  defaultAgent: 'claude',
  emit: (e) => console.log(JSON.stringify(e)),
})
console.log('RESULT', JSON.stringify(res))
