import type { LoopSpec } from './types'

/** The default stop/cancel rule applied when a contract omits one. Every loop must
 * be cancellable — a loop with no stop rule can never be told to end, so it's invalid. */
export const DEFAULT_STOP_RULE = 'user cancels'

/**
 * Fill in the mandatory contract defaults so a partial spec becomes a valid {@link LoopSpec}:
 * - `stop`: filled with {@link DEFAULT_STOP_RULE} if missing (a loop must be cancellable).
 * - `mode`: inferred from the trigger — a trigger present → `live`, none → `one-shot`
 *   (an explicit `mode` is respected). A one-shot loop keeps `trigger` undefined.
 *
 * Everything the caller already set is preserved untouched.
 */
export function compileDefaults(partial: Partial<LoopSpec>): LoopSpec {
  const stop = partial.stop && partial.stop.trim() ? partial.stop : DEFAULT_STOP_RULE
  const mode = partial.mode ?? (partial.trigger ? 'live' : 'one-shot')

  const spec: LoopSpec = {
    ...partial,
    // `id`/`flow` are required by LoopSpec; default them so the result typechecks
    // even from a truly empty partial (callers normally supply both).
    id: partial.id ?? '',
    flow: partial.flow ?? '',
    mode,
    stop,
  }

  // A one-shot loop has no trigger by definition.
  if (mode === 'one-shot') {
    delete spec.trigger
  }

  return spec
}

/**
 * Validate a loop contract. Throws if it has no stop/cancel rule — a loop that can
 * never be stopped is not a valid contract.
 */
export function validateContract(spec: LoopSpec): void {
  if (!spec.stop || !spec.stop.trim()) {
    throw new Error('Loop contract is invalid: a stop/cancel rule is mandatory.')
  }
}
