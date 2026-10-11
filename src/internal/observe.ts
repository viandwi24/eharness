/**
 * Observability (internal): the one hook `config.observe` that reports phase durations and
 * counters. Zero cost when unset (no clock reads, no allocations); a throwing observer never
 * breaks the runtime.
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#8-observability
 */
import type {
  ObserveCountName,
  ObserveEvent,
  ObserveScope,
  ObserveSpanName,
} from '../agent/types.ts'

/** The agent's observer; `undefined` when `config.observe` is not set. */
export type Observer = (event: ObserveEvent) => void

/** Wrap a user observer so that it can never throw into the runtime. */
export function safeObserver(observe: Observer | undefined): Observer | undefined {
  if (observe === undefined) return undefined
  let reported = false
  return (event) => {
    try {
      observe(event)
    } catch (error) {
      if (reported) return
      reported = true
      try {
        console.error('[eharness] observe handler threw (further failures are silent):', error)
      } catch {}
    }
  }
}

/** Attributes of a span or counter event. */
export type ObserveAttrs = ObserveScope

/** Report a counter event. */
export function observeCount(
  observe: Observer | undefined,
  name: ObserveCountName,
  attrs: ObserveAttrs = {},
): void {
  if (observe === undefined) return
  observe({ type: 'count', name, ...attrs })
}

/** Run `fn` and report its duration as a span (`ok: false` when it throws; the error is rethrown). */
export function observeSpan<T>(
  observe: Observer | undefined,
  name: ObserveSpanName,
  attrs: ObserveAttrs,
  fn: () => Promise<T>,
): Promise<T> {
  if (observe === undefined) return fn()
  const started = performance.now()
  const done = (ok: boolean): void =>
    observe({ type: 'span', name, durationMs: performance.now() - started, ok, ...attrs })
  return fn().then(
    (value) => {
      done(true)
      return value
    },
    (error: unknown) => {
      done(false)
      throw error
    },
  )
}
