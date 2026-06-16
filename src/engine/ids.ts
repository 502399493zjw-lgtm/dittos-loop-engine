export function makeIdGen(seedLabel = 'n'): (prefix: string) => string {
  const counters = new Map<string, number>()
  return (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)
    return `${prefix}-${n}`
  }
}
export const wallClock = (): number => Date.now()
