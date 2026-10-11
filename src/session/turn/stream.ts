import { createUIMessageStream, type UIMessage } from 'ai'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { describeError } from '../../stream/describe-error.ts'
import type { TurnCtx } from './ctx.ts'
import { onEnd, onStepEnd } from './end.ts'
import { checkBarrier } from './output.ts'

// ─── the stream ───────────────────────────────────────────────────────────────────────────
/**
 * Create the AI SDK stream (at `start`, so a continuation can pass `originalMessages: [A']`).
 * `execute` only hands out the writer; the turn runs in `body()` and resolves it at the end.
 */
export function openStream(t: TurnCtx): void {
  const stream = createUIMessageStream<UIMessage>({
    generateId: () => t.rt.agent.generateId(),
    ...(t.original === undefined ? {} : { originalMessages: t.original }),
    // also receives AI SDK echoes of error chunks already written (and described) by the core
    onError: (error) => describeError(error),
    onStepEnd: ({ responseMessage }) => onStepEnd(t, responseMessage as HarnessUIMessage),
    onEnd: ({ responseMessage }) => onEnd(t, responseMessage as HarnessUIMessage),
    execute: ({ writer: w }) => {
      t.writer = w
      return new Promise<void>((resolve) => {
        t.finishExecute = resolve
      })
    },
  })

  // the core drains the stream itself, so the turn never stalls and is always persisted even
  // if the caller never reads run.stream (which replays the turn buffer, spec 04 §5)
  void (async () => {
    const reader = stream.getReader()
    try {
      while (!(await reader.read()).done) {
        // drain
      }
    } catch (error) {
      t.rt.log.error('eharness: turn stream failed', { error })
    } finally {
      t.drained = true
      checkBarrier(t)
      // AI SDK skips onEnd when its pipeline fails; the end sequence must still run
      if (!t.ended) await onEnd(t, undefined)
    }
  })()
}
