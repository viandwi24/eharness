/**
 * Cross-instance invalidation, ONE mechanism for providers and connectors: a change appends an
 * event (`providers-changed`, `connectors-changed`, payload `{ instance }`), every instance
 * polls the shared event feed once and calls the handler registered for each type that another
 * instance appended. Handlers are awaited one batch at a time; a failing handler is logged.
 */

export interface ChangeFeedSource {
  lastSeq(): Promise<number>
  read(query: {
    after: number
    limit: number
    types?: readonly string[]
  }): Promise<Array<{ seq: number; type: string; payload: Record<string, unknown> }>>
}

export interface ChangeFeed {
  /** Run `handler` once per poll in which another instance appended an event of `type`. */
  on(type: string, handler: () => void | Promise<void>): void
  close(): void
}

export interface ChangeFeedOptions {
  feed: ChangeFeedSource | undefined
  /** Id of this instance: its own events are ignored. */
  instance: string
  /** Poll interval (ms, default 1000; 0 = off). */
  pollMs?: number
  warn?: (message: string) => void
}

export function createChangeFeed(options: ChangeFeedOptions): ChangeFeed {
  const handlers = new Map<string, Array<() => void | Promise<void>>>()
  const warn = options.warn ?? ((m) => console.warn(`team: ${m}`))
  const pollMs = options.pollMs ?? 1000
  let timer: ReturnType<typeof setInterval> | undefined
  const { feed } = options
  if (feed !== undefined && pollMs > 0) {
    // the head now: only changes after this instance started count
    const head = feed.lastSeq()
    head.catch(() => undefined)
    let after: number | undefined
    let busy = false
    timer = setInterval(() => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          after ??= await head
          const changed = new Set<string>()
          for (;;) {
            const batch = await feed.read({ after, limit: 100, types: [...handlers.keys()] })
            if (batch.length === 0) break
            for (const e of batch) {
              after = e.seq
              if (handlers.has(e.type) && e.payload.instance !== options.instance) {
                changed.add(e.type)
              }
            }
          }
          for (const type of changed) {
            for (const handler of handlers.get(type) ?? []) {
              try {
                await handler()
              } catch (error) {
                warn(`reacting to ${type} failed: ${String(error)}`)
              }
            }
          }
        } catch (error) {
          warn(`reading the change feed failed: ${String(error)}`)
        } finally {
          busy = false
        }
      })()
    }, pollMs)
    timer.unref()
  }
  return {
    on(type, handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
