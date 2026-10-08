/**
 * Print mode: one prompt, headless. `text` streams the assistant text to stdout (tool calls as
 * one-line notes on stderr), `json` prints one summary object, `stream-json` prints one JSON line
 * per UI message chunk. Approvals are never asked: the controller is built with the denying broker.
 */
import type { CoderController, PrintOptions } from './contracts.ts'

interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
}

const NOTE_MAX = 120

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > NOTE_MAX ? `${flat.slice(0, NOTE_MAX - 1)}…` : flat
}

/**
 * Run the prompt of `opts` through the controller and print the outcome.
 *
 * @returns The process exit code: 0 when the turn completed, 1 otherwise.
 */
export async function runPrint(controller: CoderController, opts: PrintOptions): Promise<number> {
  let text = ''
  let lastWasText = false
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let costUsd: number | undefined
  const consumers: Promise<void>[] = []

  const consume = async (stream: ReadableStream<unknown>): Promise<void> => {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        const chunk = value as { type: string; [key: string]: unknown }
        if (opts.format === 'stream-json') {
          process.stdout.write(`${JSON.stringify(chunk)}\n`)
          continue
        }
        if (chunk.type === 'text-delta') {
          const delta = String(chunk.delta ?? '')
          text += delta
          lastWasText = true
          if (opts.format === 'text') process.stdout.write(delta)
        } else if (chunk.type === 'tool-input-available') {
          if (lastWasText && opts.format === 'text') process.stdout.write('\n')
          lastWasText = false
          process.stderr.write(`[tool] ${String(chunk.toolName)} ${oneLine(chunk.input)}\n`)
        } else if (chunk.type === 'error') {
          process.stderr.write(`[error] ${String(chunk.errorText ?? '')}\n`)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  const result = await controller.run(opts.prompt, {
    onRun(run) {
      consumers.push(consume(run.stream as ReadableStream<unknown>))
      consumers.push(
        run.result.then((r) => {
          usage.inputTokens += r.usage.inputTokens
          usage.outputTokens += r.usage.outputTokens
          usage.totalTokens += r.usage.totalTokens
          if (r.usage.cachedInputTokens !== undefined) {
            usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + r.usage.cachedInputTokens
          }
          if (r.usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + r.usage.costUsd
        }),
      )
    },
  })
  await Promise.all(consumers)

  if (result.error !== undefined) {
    process.stderr.write(`coder: ${result.stop}: ${result.error.message}\n`)
  } else if (result.stop !== 'complete') {
    process.stderr.write(`coder: turn ended with "${result.stop}"\n`)
  }

  if (opts.format === 'text') {
    if (text !== '' && !text.endsWith('\n')) process.stdout.write('\n')
  } else if (opts.format === 'json') {
    const summary: Record<string, unknown> = {
      stop: result.stop,
      text,
      usage,
      costUsd: costUsd ?? null,
      sessionId: controller.sessionId,
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
  }
  return result.stop === 'complete' ? 0 : 1
}
