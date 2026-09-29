/**
 * Helpers for the compaction tests (not part of the public API, not bundled).
 */
import type { ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ScriptedCallOptions, ScriptedStep } from '../testing/scripted-model.ts'
import { defaultCountTokens, wireTokens } from './tokens.ts'

type DoGenerate = MockLanguageModelV4['doGenerate']
type GenerateCall = Parameters<DoGenerate>[0]

/** A summarizer model (`doGenerate`) that answers with `summaries[i]` (or a function) and records calls. */
export type SummarizerModel = MockLanguageModelV4 & { readonly calls: GenerateCall[] }

/** Create a summarizer mock. A thrown / rejected entry makes that call fail. */
export function summarizerModel(
  summaries: Array<string | Error> | ((call: GenerateCall, index: number) => string),
): SummarizerModel {
  const calls: GenerateCall[] = []
  const model = new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'summarizer',
    doGenerate: async (call) => {
      const index = calls.length
      calls.push(call)
      const entry =
        typeof summaries === 'function'
          ? summaries(call, index)
          : (summaries[index] ?? summaries.at(-1) ?? '')
      if (entry instanceof Error) throw entry
      return {
        content: entry.length === 0 ? [] : [{ type: 'text', text: entry }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  Object.defineProperty(model, 'calls', { get: () => calls, enumerable: true })
  return model as SummarizerModel
}

/** Text of the user prompt of a summarizer call. */
export function summarizerPromptText(call: GenerateCall): string {
  const user = call.prompt.find((m) => m.role === 'user')
  if (user === undefined || typeof user.content === 'string') return String(user?.content ?? '')
  return user.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** Provider-reported input tokens that match the core's own estimate of a call's prompt. */
export function estimatedInput(call: ScriptedCallOptions): number {
  return wireTokens(call.prompt as unknown as ModelMessage[], defaultCountTokens)
}

/** A scripted step answering `text` that reports realistic input usage (calibration ≈ 1). */
export function answer(text: string): (call: ScriptedCallOptions) => ScriptedStep {
  return (call) => ({ text, usage: { inputTokens: estimatedInput(call), outputTokens: 5 } })
}
