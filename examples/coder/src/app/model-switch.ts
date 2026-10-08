/**
 * Switching the model and the thinking level without rebuilding agents: every agent (main and
 * subagents) carries this plugin, whose `turn.prepare` hook reads the shared {@link ModelState}
 * at the start of each turn (send, respond, regenerate, edit), so a change made while idle or in
 * the middle of a turn applies to the next turn.
 */
import type { LanguageModel } from 'ai'
import { definePlugin, type ModelSettings } from 'eharness'
import type { ModelProvider, ThinkingLevel } from '../contracts.ts'

/** The mutable choice shared by the controller and every agent's plugin. */
export interface ModelState {
  provider: ModelProvider
  model: string
  thinking: ThinkingLevel
}

/**
 * Model settings for a thinking level. `provider-default` sends nothing. The AI SDK `reasoning`
 * option is always set; the OpenRouter provider (3.1.0) does not read it, so for OpenRouter the
 * same effort also goes through `providerOptions.openrouter.reasoning`.
 */
export function thinkingSettings(
  provider: ModelProvider,
  level: ThinkingLevel,
): Partial<ModelSettings> | undefined {
  if (level === 'provider-default') return undefined
  return {
    reasoning: level,
    ...(provider === 'openrouter'
      ? { providerOptions: { openrouter: { reasoning: { effort: level } } } }
      : {}),
  }
}

/** Options of {@link modelSwitchPlugin}. */
export interface ModelSwitchOptions {
  state: ModelState
  /** Model for the current `state.model`; omitted for a subagent that pins its own model. */
  resolve?: (id: string) => LanguageModel
}

/** The plugin (name `model-switch`); it adds no tools, so it never changes the prompt prefix. */
export function modelSwitchPlugin(opts: ModelSwitchOptions): ReturnType<typeof definePlugin> {
  const { state, resolve } = opts
  return definePlugin({
    name: 'model-switch',
    setup: () => ({
      hooks: {
        'turn.prepare': () => {
          const settings = thinkingSettings(state.provider, state.thinking)
          return {
            ...(resolve ? { model: resolve(state.model) } : {}),
            ...(settings ? { settings } : {}),
          }
        },
      },
    }),
  })
}
