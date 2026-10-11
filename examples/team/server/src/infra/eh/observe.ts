/**
 * `config.observe` adapter (spec 10 §8): the runtime reports every timed phase of a turn (`span`)
 * and the counters that say something is going wrong (`count`). This adapter keeps it cheap, as
 * the handler runs synchronously inside the runtime: it logs a span only when it is slow or
 * failed, and counts every failure and every counter in memory (`snapshot()` for a metrics
 * endpoint, a test or a shutdown line). Ship the counts to a real metrics backend by replacing
 * the Map; see docs/guides/observability.md for an OpenTelemetry bridge.
 */
import type { ObserveEvent } from 'eharness'

export interface ObserverOptions {
  /** Log sink (default `console.warn`). */
  log?: (message: string) => void
  /** A span at least this long is logged (ms, default 10 000). `model.call` and `tool.execute` use `slowModelMs`. */
  slowMs?: number
  /** Threshold of the long phases (model calls, tool runs; ms, default 60 000). */
  slowModelMs?: number
}

export interface Observer {
  observe: (event: ObserveEvent) => void
  /** Counters since boot: `fail:<span>` for a span that threw, `count:<name>` for counters. */
  snapshot: () => Record<string, number>
}

const LONG_PHASES = new Set(['model.call', 'tool.execute', 'compaction'])

export function createObserver(options: ObserverOptions = {}): Observer {
  const log = options.log ?? ((message: string) => console.warn(message))
  const slowMs = options.slowMs ?? 10_000
  const slowModelMs = options.slowModelMs ?? 60_000
  const counts = new Map<string, number>()
  const bump = (key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    observe: (event) => {
      // one line, no user content: session id and turn id are for correlation, never metric labels
      const where = [event.sessionId, event.tool ?? event.hook ?? event.source ?? event.code]
        .filter((part) => part !== undefined)
        .join(' ')
      if (event.type === 'count') {
        bump(`count:${event.name}`)
        // `warning` counts every occurrence; the warning itself is already printed by `onWarning`
        if (event.name !== 'warning') log(`team: observe ${event.name} ${where}`)
        return
      }
      if (!event.ok) bump(`fail:${event.name}`)
      const limit = LONG_PHASES.has(event.name) ? slowModelMs : slowMs
      if (!event.ok || event.durationMs >= limit) {
        log(
          `team: observe ${event.ok ? 'slow' : 'failed'} ${event.name} ${Math.round(event.durationMs)}ms ${where}`,
        )
      }
    },
    snapshot: () => Object.fromEntries(counts),
  }
}
