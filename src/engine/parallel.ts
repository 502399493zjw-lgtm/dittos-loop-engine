import type { FlowApi } from '../types'
export function bindParallel(api: FlowApi): void {
  api.parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
}
