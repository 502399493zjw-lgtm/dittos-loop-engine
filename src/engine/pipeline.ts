import type { FlowApi } from '../types'
export function bindPipeline(api: FlowApi): void {
  api.pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let prev: unknown = undefined
      try {
        for (const stage of stages) prev = await stage(prev, item, i)
        return prev
      } catch { return null }
    }))
}
