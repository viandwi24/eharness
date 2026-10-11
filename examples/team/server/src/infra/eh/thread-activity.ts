/**
 * Keeps the thread rows current (P40 phase M): a `message-added` event of a chat session moves its
 * thread's last activity and preview, and names an unnamed thread after its first user message.
 * Wrapping the app's event appender keeps this out of every place that appends such an event
 * (the `taskIndex` hooks, the seeding of a thread).
 */
import type { EventAppender, ThreadStore } from '../../app/ports.ts'
import { parseChatSession, titleFromMessage } from '../../domain/threads.ts'

export function withThreadActivity(inner: EventAppender, threads: ThreadStore): EventAppender {
  return {
    append(event) {
      inner.append(event)
      if (event.type !== 'message-added' || event.sessionId == null) return
      const chat = parseChatSession(event.sessionId)
      if (chat === undefined || chat.child) return
      try {
        const preview = typeof event.payload.preview === 'string' ? event.payload.preview : null
        threads.touch(event.sessionId, {
          at: event.at ?? Date.now(),
          preview,
          title:
            event.payload.role === 'user' && preview !== null ? titleFromMessage(preview) : null,
        })
      } catch (error) {
        console.warn(`team: updating the thread of ${event.sessionId} failed: ${String(error)}`)
      }
    },
  }
}
