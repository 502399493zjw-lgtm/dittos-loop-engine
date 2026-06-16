/** The ONE global query template every loop shares. The only dynamic part is the
 *  trigger reason (from describeTrigger). The per-loop "what to do" lives in the
 *  workflow (flow script), never here. */
export function kickoffMessage(reason: string): string {
  return `开始执行你的 loop flow。本次触发原因:${reason}。`
}
