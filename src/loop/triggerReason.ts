import type { LoopSpec } from './types'

export type TriggerCause = { kind: 'schedule' } | { kind: 'manual' }

/** A short human reason for *why this firing happened*, spliced into the kickoff
 *  query. Manual always wins; otherwise describe the schedule. */
export function describeTrigger(trigger: LoopSpec['trigger'], cause: TriggerCause): string {
  if (cause.kind === 'manual') return '你手动触发'
  if (trigger.kind === 'cron') return `定时:cron ${trigger.expr} 到点`
  return `定时:间隔 ${Math.round(trigger.everyMs / 1000)}s 到点`
}
