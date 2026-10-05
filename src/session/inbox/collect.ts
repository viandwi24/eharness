/**
 * `collect` inputs (internal): defaults, the debounce rule and the merge into one user message.
 *
 * @see docs/specs/05-session-and-storage.md#12-inbox
 */
import type { CollectOptions } from '../../agent/session-types.ts'
import type { NormalizedInput } from '../input.ts'

/** Default debounce of `collect` inputs. */
export const DEFAULT_COLLECT: Readonly<Required<CollectOptions>> = {
  quietMs: 1_500,
  maxWaitMs: 10_000,
  maxItems: 20,
}

/** Resolve the debounce: later layers win, invalid values fall back to the previous layer. */
export function resolveCollect(
  ...layers: Array<CollectOptions | undefined>
): Required<CollectOptions> {
  const out = { ...DEFAULT_COLLECT }
  for (const layer of layers) {
    if (layer === undefined) continue
    if (typeof layer.quietMs === 'number' && layer.quietMs >= 0) out.quietMs = layer.quietMs
    if (typeof layer.maxWaitMs === 'number' && layer.maxWaitMs >= 0) out.maxWaitMs = layer.maxWaitMs
    if (typeof layer.maxItems === 'number' && layer.maxItems >= 1) {
      out.maxItems = Math.floor(layer.maxItems)
    }
  }
  return out
}

/**
 * Whether a burst of `count` inputs (first at `firstAt`, newest at `lastAt`) is due now, and
 * otherwise when it will be: `quietMs` without a new input, `maxWaitMs` since the first, or
 * `maxItems` inputs.
 */
export function collectDue(
  burst: { firstAt: number; lastAt: number; count: number },
  options: Required<CollectOptions>,
  now: number,
): { due: true } | { due: false; at: number } {
  if (burst.count >= options.maxItems) return { due: true }
  const at = Math.min(burst.lastAt + options.quietMs, burst.firstAt + options.maxWaitMs)
  return at <= now ? { due: true } : { due: false, at }
}

/**
 * Merge collected inputs into one: text parts of each input joined with a blank line, the inputs'
 * texts joined with a blank line in arrival order, then every file part in order. App metadata
 * keys are merged (later inputs win); the client ids go to `metadata.eharness.collected`.
 */
export function mergeInputs(inputs: readonly NormalizedInput[]): NormalizedInput {
  const texts: string[] = []
  const files: NormalizedInput['parts'] = []
  let appMetadata: Record<string, unknown> | undefined
  for (const input of inputs) {
    const own = input.parts.filter((p) => p.type === 'text').map((p) => p.text)
    if (own.length > 0) texts.push(own.join('\n\n'))
    for (const part of input.parts) if (part.type === 'file') files.push(structuredClone(part))
    if (input.appMetadata !== undefined) appMetadata = { ...appMetadata, ...input.appMetadata }
  }
  const parts: NormalizedInput['parts'] = []
  if (texts.length > 0) parts.push({ type: 'text', text: texts.join('\n\n') })
  parts.push(...files)
  return appMetadata === undefined
    ? { parts }
    : { parts, appMetadata: structuredClone(appMetadata) }
}
