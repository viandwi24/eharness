/**
 * The long-lived session event channel (`session.events()`), internal.
 *
 * @see docs/specs/04-streaming.md#6-turn-buffer-attach-and-session-events
 */
import type { SessionEvent } from '../agent/session-types.ts'
import { HarnessError } from '../errors.ts'
import type { EventSink } from './runtime.ts'

/**
 * Events queued per reader; a reader that falls further behind is errored with
 * `EH_EVENTS_OVERFLOW` (never closed as a normal end: it would look like "no more events").
 */
const EVENT_QUEUE_LIMIT = 1_000

/** Event hub with any number of readers. */
export interface EventHub extends EventSink {
  /** A new reader stream (each reader receives every event emitted after it was created). */
  stream(): ReadableStream<SessionEvent>
  /** Close every reader (session close). */
  close(): void
}

/** Options of {@link createEventHub}. */
export interface EventHubOptions {
  /** Called once for every reader that was dropped because it fell too far behind. */
  onOverflow?(info: { limit: number; readers: number }): void
}

/** Create an event hub. */
export function createEventHub(options: EventHubOptions = {}): EventHub {
  const controllers = new Set<ReadableStreamDefaultController<SessionEvent>>()
  return {
    emit(event) {
      if (controllers.size === 0) return
      // one copy per emit: decoupled from the runtime's own object; readers share it read-only
      const copy = structuredClone(event)
      for (const controller of controllers) {
        try {
          // an abandoned or too slow reader is errored instead of growing without bound; the
          // error tells it events were lost (spec 04 §6.3)
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            controllers.delete(controller)
            controller.error(
              new HarnessError(
                'EH_EVENTS_OVERFLOW',
                `A session events reader fell more than ${EVENT_QUEUE_LIMIT} events behind and was dropped; subscribe again and reload the state.`,
                { details: { limit: EVENT_QUEUE_LIMIT } },
              ),
            )
            try {
              options.onOverflow?.({ limit: EVENT_QUEUE_LIMIT, readers: controllers.size })
            } catch {}
            continue
          }
          controller.enqueue(copy)
        } catch {
          controllers.delete(controller)
        }
      }
    },
    get readers() {
      return controllers.size
    },
    stream() {
      let own: ReadableStreamDefaultController<SessionEvent> | undefined
      return new ReadableStream<SessionEvent>(
        {
          start(controller) {
            own = controller
            controllers.add(controller)
          },
          cancel() {
            if (own !== undefined) controllers.delete(own)
          },
        },
        new CountQueuingStrategy({ highWaterMark: EVENT_QUEUE_LIMIT }),
      )
    },
    close() {
      for (const controller of controllers) {
        try {
          controller.close()
        } catch {}
      }
      controllers.clear()
    },
  }
}
