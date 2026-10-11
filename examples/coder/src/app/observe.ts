/**
 * `config.observe` adapter (docs/guides/observability.md): the library reports every timed phase of
 * a turn (`span`) and the counters that mean something is wrong (`count`). The handler runs
 * synchronously inside the runtime, so it only counts and queues a line; the file write is async
 * and best-effort. Slow or failed spans and every counter go to `<userDir>/observe.log` (never to
 * the terminal: Ink owns it). `/doctor`-style tooling can read {@link Observer.counters}.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ObserveEvent } from 'eharness'

/** Spans slower than this are logged (a whole `model.call` is routinely seconds; tools can be minutes). */
export const SLOW_SPAN_MS = 10_000

/** The handler passed as `observe`, plus the running counters. */
export interface Observer {
  observe: (event: ObserveEvent) => void
  /** Counter name → occurrences since the process started (`hook.failed`, `warning`, …). */
  counters: () => Record<string, number>
}

/**
 * Logs spans over `slowMs` (and every failed span) plus every counter event to `file`.
 * `sessionId` stays in the log line (a trace field), never in the counter key.
 */
export function createObserver(options: { file: string; slowMs?: number }): Observer {
  const slowMs = options.slowMs ?? SLOW_SPAN_MS
  const counts = new Map<string, number>()
  const write = (line: string): void => {
    void mkdir(dirname(options.file), { recursive: true })
      .then(() => appendFile(options.file, `${new Date().toISOString()} ${line}\n`))
      .catch(() => {})
  }
  const scope = (e: ObserveEvent): string =>
    [e.tool, e.hook, e.source, e.code, e.owner].filter((v) => v !== undefined).join(' ')
  return {
    observe(event) {
      if (event.type === 'count') {
        counts.set(event.name, (counts.get(event.name) ?? 0) + 1)
        write(`count ${event.name} ${scope(event)} session=${event.sessionId ?? '-'}`)
      } else if (!event.ok || event.durationMs >= slowMs) {
        if (!event.ok)
          counts.set(`${event.name}.failed`, (counts.get(`${event.name}.failed`) ?? 0) + 1)
        write(
          `span ${event.name} ${Math.round(event.durationMs)}ms ${event.ok ? 'ok' : 'FAILED'} ${scope(event)} session=${event.sessionId ?? '-'}`,
        )
      }
    },
    counters: () => Object.fromEntries(counts),
  }
}
