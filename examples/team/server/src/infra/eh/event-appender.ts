/**
 * The app's own events on the shared feed (`eharness/activity`): providers-changed,
 * settings-changed, ... Session events (turns, pending items, approvals) come from the library's
 * `activity()` plugin into the same store; reading the feed (JSON and SSE) is the library's
 * `activity` option of `eharness/http` (`infra/eh/harness-http.ts`).
 */
import type { ActivityStore } from 'eharness/activity'
import type { EventAppender } from '../../app/ports.ts'

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
