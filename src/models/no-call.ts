/**
 * The "no model call" model of `respond(…, { endTurn })` (internal): AI SDK runs the approved
 * tools of a continuation inside the step's `streamText` call, before the model is asked. A turn
 * that must end after the answers lets that call run against this model, which answers with an
 * empty stream and never reaches a provider.
 *
 * @see docs/specs/11-interaction.md#4-respond
 */
import type { LanguageModel } from 'ai'

/** A language model whose stream is empty (stop, zero usage). It makes no provider request. */
export function noCallModel(): LanguageModel {
  const usage = {
    inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: 0, reasoning: undefined },
  }
  const finishReason = { unified: 'stop', raw: 'stop' }
  return {
    specificationVersion: 'v4',
    provider: 'eharness',
    modelId: 'end-turn',
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason, usage, warnings: [] }
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'finish', finishReason, usage })
            controller.close()
          },
        }),
      }
    },
  } as unknown as LanguageModel
}
