/**
 * The event feed of the app on `eharness/activity`: the store (SQLite), the SSE/JSON readers the
 * HTTP layer calls through `ActivityFeedPort`, and the appender app code uses for its own events
 * (providers-changed, settings-changed, ...). Session events (turns, pending items, approvals)
 * come from the library's `activity()` plugin into the same store.
 */
import { type ActivityStore, handleActivityStream, readActivityPage } from 'eharness/activity'
import type { ActivityFeedPort, EventAppender } from '../../app/ports.ts'
import type { TeamEvent } from '../../domain/events.ts'

export interface ActivityFeedOptions {
  store: ActivityStore
  /** Identifies this server process (the `boot` event of the stream). */
  bootId: string
  /** Store poll interval of the SSE stream (ms, default 500). */
  pollMs?: number
  warn?: (message: string) => void
}

export function createActivityFeed(options: ActivityFeedOptions): ActivityFeedPort {
  const { store } = options
  return {
    stream: (request) =>
      handleActivityStream(request, {
        store,
        bootId: options.bootId,
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        onError: (error) => options.warn?.(`event stream failed: ${String(error)}`),
      }),
    async page(query) {
      const page = await readActivityPage(store, query)
      return { ...page, events: page.events as TeamEvent[] }
    },
  }
}

/**
 * App events appended without waiting: the store writes before `append` returns control (SQLite),
 * a failure is logged and never breaks the use case that raised the event.
 */
export function createEventAppender(
  store: ActivityStore,
  warn: (message: string) => void = (m) => console.warn(`team: ${m}`),
): EventAppender {
  return {
    append(event) {
      store.append(event).catch((error) => warn(`appending ${event.type} failed: ${String(error)}`))
    },
  }
}
