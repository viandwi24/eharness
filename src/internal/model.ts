import type { LanguageModel } from 'ai'

/**
 * Stable string id of a model, as stored in `metadata.eharness.model`.
 *
 * Gateway strings are kept as-is (`anthropic/claude-sonnet-4.6`); provider instances become
 * `<provider>/<modelId>` (`anthropic.messages/claude-sonnet-4-6`).
 */
export function describeModel(model: LanguageModel): string {
  if (typeof model === 'string') return model
  return `${model.provider}/${model.modelId}`
}

/**
 * Provider family of a model or of a stored model id: the part before the first `/`, then before
 * the first `.` (`anthropic.messages/x` → `anthropic`, `openai/gpt-5` → `openai`).
 * `undefined` when it cannot be determined.
 */
export function providerOf(model: LanguageModel | string | undefined): string | undefined {
  if (model === undefined) return undefined
  const id = typeof model === 'string' ? model : `${model.provider}/${model.modelId}`
  const slash = id.indexOf('/')
  if (slash <= 0) return undefined
  const provider = id.slice(0, slash)
  const dot = provider.indexOf('.')
  return dot > 0 ? provider.slice(0, dot) : provider
}
