/**
 * Drives one user prompt through the controller and feeds the view reducer: consumes every run's
 * UI message stream with `readUIMessageStream` and picks the transient `data-bashOutput` chunks
 * out of the same raw chunk stream (transient parts never appear in messages).
 */
import { readUIMessageStream } from 'ai'
import type { HarnessRun } from 'eharness'
import type { BashOutputData, CoderController, CoderMessage } from './../contracts.ts'
import type { ViewAction } from './state.ts'

const THROTTLE_MS = 50

/** A tiny batcher: latest message snapshot and bash chunks are flushed at most every 50 ms. */
function createBatcher(dispatch: (a: ViewAction) => void): {
  live(message: CoderMessage): void
  bash(chunk: BashOutputData): void
  flush(): void
} {
  let message: CoderMessage | null = null
  let chunks: BashOutputData[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (chunks.length > 0) {
      dispatch({ type: 'bash-output', chunks })
      chunks = []
    }
    if (message) {
      dispatch({ type: 'live', message, now: Date.now() })
      message = null
    }
  }
  const schedule = (): void => {
    timer ??= setTimeout(flush, THROTTLE_MS)
  }
  return {
    live(next) {
      message = next
      schedule()
    },
    bash(chunk) {
      chunks.push(chunk)
      schedule()
    },
    flush,
  }
}

function isBashChunk(chunk: unknown): chunk is { type: 'data-bashOutput'; data: BashOutputData } {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    (chunk as { type?: string }).type === 'data-bashOutput'
  )
}

/**
 * Run one prompt to the end. Dispatches `turn-started`, then live snapshots, then `turn-finished`.
 * Never rejects.
 */
export async function runTurn(
  controller: CoderController,
  text: string,
  dispatch: (action: ViewAction) => void,
): Promise<void> {
  dispatch({ type: 'turn-started' })
  const batcher = createBatcher(dispatch)
  const consumers: Promise<void>[] = []
  let last: CoderMessage | null = null

  const consume = async (run: HarnessRun<CoderMessage>): Promise<void> => {
    const reader = run.stream.getReader()
    try {
      const first = await reader.read()
      if (first.done) return
      // A `respond()` continuation streams into the same message: seed the reader with it.
      const startId = first.value.type === 'start' ? first.value.messageId : undefined
      const base = last && startId && last.id === startId ? structuredClone(last) : undefined
      const observe = (chunk: unknown): void => {
        if (isBashChunk(chunk)) batcher.bash(structuredClone(chunk.data))
      }
      observe(first.value)
      let pending: typeof first.value | undefined = first.value
      const tapped = new ReadableStream<typeof first.value>({
        async pull(controllerStream) {
          if (pending) {
            controllerStream.enqueue(pending)
            pending = undefined
            return
          }
          const next = await reader.read()
          if (next.done) {
            controllerStream.close()
            return
          }
          observe(next.value)
          controllerStream.enqueue(next.value)
        },
        cancel: (reason) => reader.cancel(reason),
      })
      for await (const message of readUIMessageStream<CoderMessage>({
        message: base,
        stream: tapped,
        onError: () => {},
      })) {
        last = message
        batcher.live(message)
      }
    } catch {
      // the run result carries the error
    }
  }

  let note: { text: string; tone: 'info' | 'error' } | undefined
  try {
    const result = await controller.run(text, {
      onRun(run) {
        consumers.push(consume(run))
      },
    })
    await Promise.all(consumers)
    if (result.stop === 'error') {
      note = { text: result.error?.message ?? 'The turn failed.', tone: 'error' }
    } else if (result.stop === 'aborted') {
      note = { text: 'Interrupted.', tone: 'info' }
    } else if (result.stop !== 'complete' && result.stop !== 'tool-pending') {
      note = { text: `Turn stopped: ${result.stop}.`, tone: 'info' }
    }
  } catch (error) {
    await Promise.allSettled(consumers)
    note = { text: error instanceof Error ? error.message : String(error), tone: 'error' }
  }
  batcher.flush()
  dispatch({ type: 'turn-finished', note })
}
