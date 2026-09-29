/**
 * `scriptedModel`: a `MockLanguageModelV4` that plays a scripted conversation, one entry per
 * model call (= one eharness step, or one `generateText` call such as the compaction summarizer),
 * and records every call's prompt.
 *
 * @see docs/engineering/testing.md#model-mocking
 */
import { MockLanguageModelV4 } from 'ai/test'

type DoStream = MockLanguageModelV4['doStream']
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>
type GenerateContent = GenerateResult['content'][number]

/** Options AI SDK passed to one `doStream` / `doGenerate` call (prompt, tools, provider options, …). */
export type ScriptedCallOptions = Parameters<DoStream>[0]

/** The prompt (model wire) of one call, as the provider receives it. */
export type ScriptedPrompt = ScriptedCallOptions['prompt']

/** One raw language model stream part (escape hatch for exotic scripts). */
export type ScriptedStreamPart =
  Awaited<ReturnType<DoStream>>['stream'] extends ReadableStream<infer P> ? P : never

/** Finish reasons a scripted step can report. */
export type ScriptedFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'

/**
 * One scripted model call.
 *
 * Without `parts`, the stream is: optional reasoning, optional text, tool calls, optional stream
 * error, finish. `finishReason` defaults to `'tool-calls'` when there are tool calls, else `'stop'`.
 */
export interface ScriptedStep {
  text?: string
  reasoning?: string
  /** Tool calls; `toolCallId` defaults to `call-<call index>-<i>`. */
  toolCalls?: Array<{ toolName: string; input: unknown; toolCallId?: string }>
  finishReason?: ScriptedFinishReason
  /** Default `{ inputTokens: 10, outputTokens: 5 }`. */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  /** Thrown by `doStream` before streaming starts (e.g. an `APICallError` with status 429). */
  throws?: unknown
  /** Emitted as a stream `error` part before `finish` (thrown by a `doGenerate` call). */
  streamError?: unknown
  /** Delay before every stream part, in ms (for abort and timeout tests). */
  delayMs?: number
  /** Raw stream parts; replaces everything above except `throws` and `delayMs`. */
  parts?: ScriptedStreamPart[]
}

/** A scripted step, or a function that builds one from the call options. */
export type ScriptedStepInput = ScriptedStep | ((call: ScriptedCallOptions) => ScriptedStep)

/** Options of {@link scriptedModel}. */
export interface ScriptedModelOptions {
  /** Provider id. Default `'mock'` (use e.g. `'anthropic.messages'` to test cache options). */
  provider?: string
  /** Model id. Default `'scripted'`. */
  modelId?: string
}

/** The model returned by {@link scriptedModel}. */
export type ScriptedModel = MockLanguageModelV4 & {
  /** Prompts of every call so far (`doStream` and `doGenerate`), in call order. */
  readonly prompts: ScriptedPrompt[]
  /** Full options of every call so far (tools, tool choice, provider options, …), in call order. */
  readonly calls: ScriptedCallOptions[]
}

function buildParts(step: ScriptedStep, callIndex: number): ScriptedStreamPart[] {
  if (step.parts !== undefined) return step.parts
  const parts: ScriptedStreamPart[] = [{ type: 'stream-start', warnings: [] }]
  if (step.reasoning !== undefined) {
    const id = `r${callIndex}`
    parts.push(
      { type: 'reasoning-start', id },
      { type: 'reasoning-delta', id, delta: step.reasoning },
      { type: 'reasoning-end', id },
    )
  }
  if (step.text !== undefined) {
    const id = `t${callIndex}`
    parts.push(
      { type: 'text-start', id },
      { type: 'text-delta', id, delta: step.text },
      { type: 'text-end', id },
    )
  }
  const calls = step.toolCalls ?? []
  for (const [i, call] of calls.entries()) {
    parts.push({
      type: 'tool-call',
      toolCallId: call.toolCallId ?? `call-${callIndex}-${i}`,
      toolName: call.toolName,
      input: JSON.stringify(call.input),
    })
  }
  if (step.streamError !== undefined) parts.push({ type: 'error', error: step.streamError })
  const unified = step.finishReason ?? (calls.length > 0 ? 'tool-calls' : 'stop')
  const input = step.usage?.inputTokens ?? 10
  const output = step.usage?.outputTokens ?? 5
  const cacheRead = step.usage?.cacheReadTokens
  const cacheWrite = step.usage?.cacheWriteTokens
  parts.push({
    type: 'finish',
    finishReason: { unified, raw: unified },
    usage: {
      inputTokens: {
        total: input,
        noCache: input - (cacheRead ?? 0) - (cacheWrite ?? 0),
        cacheRead,
        cacheWrite,
      },
      outputTokens: { total: output, text: output, reasoning: undefined },
    },
  })
  return parts
}

/** The `doGenerate` result equivalent to a scripted step's stream parts. */
function generateResult(parts: ScriptedStreamPart[]): GenerateResult {
  const content: GenerateContent[] = []
  const open = new Map<string, { type: 'text' | 'reasoning'; text: string }>()
  let finish: Extract<ScriptedStreamPart, { type: 'finish' }> | undefined
  for (const part of parts) {
    switch (part.type) {
      case 'text-start':
      case 'reasoning-start': {
        const entry: { type: 'text' | 'reasoning'; text: string } = {
          type: part.type === 'text-start' ? 'text' : 'reasoning',
          text: '',
        }
        open.set(part.id, entry)
        content.push(entry)
        break
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const entry = open.get(part.id)
        if (entry !== undefined) entry.text += part.delta
        break
      }
      case 'tool-call':
        content.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        })
        break
      case 'error':
        throw part.error
      case 'finish':
        finish = part
        break
      default:
        break
    }
  }
  if (finish === undefined) throw new Error('scriptedModel: a scripted step has no finish part')
  return { content, finishReason: finish.finishReason, usage: finish.usage, warnings: [] }
}

/** Resolves after `ms`, or rejects with the abort reason when `signal` aborts first. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      if (signal !== undefined) reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException(String(signal.reason ?? 'aborted'), 'AbortError')
}

/**
 * Create a model that plays `steps` in order and records every prompt. Every model call takes
 * the next entry: `doStream` calls (eharness steps) and `doGenerate` calls (e.g. the compaction
 * summarizer, which uses `generateText`) share one script, so a single scripted model can drive a
 * whole conversation including compaction. A `doGenerate` call answers with the step's reasoning,
 * text and tool calls as content (`streamError` is thrown). A call beyond the script rejects.
 * Calls honour their abort signal.
 *
 * @example
 * ```ts
 * const model = scriptedModel([
 *   { toolCalls: [{ toolName: 'read_file', input: { path: '/a.md' } }] }, // step 0
 *   { text: 'Done.' },                                                     // step 1
 * ])
 * const agent = defineHarnessAgent({ model, tools: { read_file } })
 * await agent.session('s1').send('Summarize /a.md').result
 * model.prompts[1] // the wire of step 1
 * ```
 * @see docs/engineering/testing.md#model-mocking
 */
export function scriptedModel(
  steps: ScriptedStepInput[],
  options: ScriptedModelOptions = {},
): ScriptedModel {
  const calls: ScriptedCallOptions[] = []
  const next = (call: ScriptedCallOptions): { step: ScriptedStep; index: number } => {
    const index = calls.length
    calls.push(call)
    const input = steps[index]
    if (input === undefined) {
      throw new Error(`scriptedModel: no scripted step for call #${index}`)
    }
    const step = typeof input === 'function' ? input(call) : input
    if (step.throws !== undefined) throw step.throws
    return { step, index }
  }
  const model = new MockLanguageModelV4({
    provider: options.provider ?? 'mock',
    modelId: options.modelId ?? 'scripted',
    doGenerate: async (call) => {
      const { step, index } = next(call)
      if (step.delayMs !== undefined && step.delayMs > 0)
        await delay(step.delayMs, call.abortSignal)
      return generateResult(buildParts(step, index))
    },
    doStream: async (call) => {
      const { step, index } = next(call)
      const parts = buildParts(step, index)
      const delayMs = step.delayMs ?? 0
      const signal = call.abortSignal
      return {
        stream: new ReadableStream<ScriptedStreamPart>({
          async start(controller) {
            for (const part of parts) {
              if (delayMs > 0) {
                const aborted = await new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort)
                    resolve(false)
                  }, delayMs)
                  const onAbort = () => {
                    clearTimeout(timer)
                    resolve(true)
                  }
                  if (signal?.aborted) onAbort()
                  else signal?.addEventListener('abort', onAbort, { once: true })
                })
                if (aborted && signal !== undefined) {
                  controller.error(abortError(signal))
                  return
                }
              }
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
      }
    },
  })
  Object.defineProperties(model, {
    calls: { get: () => calls, enumerable: true },
    prompts: { get: () => calls.map((c) => c.prompt), enumerable: true },
  })
  return model as ScriptedModel
}
