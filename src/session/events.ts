/**
 * The long-lived session event channel (`session.events()`), internal.
 *
 * @see docs/specs/04-streaming.md#6-turn-buffer-attach-and-session-events
 */
import type { SessionEvent } from '../agent/session-types.ts'
import type { EventSink } from './runtime.ts'

/** Events queued per reader; a reader that falls further behind is closed (its stream ends). */
const EVENT_QUEUE_LIMIT = 1_000

/** Event hub with any number of readers. */
export interface EventHub extends EventSink {
  /** A new reader stream (each reader receives every event emitted after it was created). */
  stream(): ReadableStream<SessionEvent>
  /** Close every reader (session close). */
  close(): void
}

/** Create an event hub. */
export function createEventHub(): EventHub {
  const controllers = new Set<ReadableStreamDefaultController<SessionEvent>>()
  return {
    emit(event) {
      for (const controller of controllers) {
        try {
          // an abandoned or too slow reader is closed instead of growing without bound
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            controllers.delete(controller)
            controller.close()
            continue
          }
          controller.enqueue(structuredClone(event))
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
