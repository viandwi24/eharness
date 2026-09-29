/**
 * Model selection for the examples.
 *
 * With `AI_GATEWAY_API_KEY` set, the examples talk to a real model through the Vercel AI Gateway
 * (`EXAMPLE_MODEL`, default `anthropic/claude-sonnet-4.6`). Without it they use a scripted
 * `MockLanguageModelV4` from `eharness/testing` that plays a fixed conversation, so every example
 * runs offline (and in CI) with `bun examples/<name>.ts`.
 */
import type { LanguageModel } from 'ai'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'

/** True when the examples use a real model. */
export const live: boolean = Boolean(process.env.AI_GATEWAY_API_KEY)

/** A real gateway model when `AI_GATEWAY_API_KEY` is set, otherwise `scriptedModel(script)`. */
export function exampleModel(script: ScriptedStepInput[]): LanguageModel {
  return live ? (process.env.EXAMPLE_MODEL ?? 'anthropic/claude-sonnet-4.6') : scriptedModel(script)
}
