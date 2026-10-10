/**
 * `scriptedProvider`: a provider definition whose models are scripted, for tests of code that
 * uses `eharness/providers` (it is structurally a `ProviderDefinition` and imports nothing from it).
 *
 * @see docs/engineering/testing.md#model-mocking
 */
import { z } from 'zod/v4'
import type { ModelInfo } from '../index.ts'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from './scripted-model.ts'

/** Options of {@link scriptedProvider}. */
export interface ScriptedProviderOptions {
  /** Default `'scripted'`. */
  id?: string
  label?: string
  /** Model id → steps. A model id that is not listed gets an empty script (it fails when called). */
  models: Record<string, ScriptedStepInput[]>
  /** Limits and prices reported by `listModels`, per model id. */
  info?: Record<string, ModelInfo>
}

/** The structural provider definition returned by {@link scriptedProvider}. */
export interface ScriptedProviderDefinition {
  id: string
  label: string
  settings: z.ZodObject
  create(settings: Record<string, unknown>): { languageModel(id: string): ScriptedModel }
  listModels(
    settings: Record<string, unknown>,
  ): Promise<Array<{ id: string; name: string; info?: ModelInfo; tools: boolean }>>
  /** The scripted models created so far, by id (assert on their prompts). */
  readonly created: Map<string, ScriptedModel>
}

/**
 * A provider with no settings whose `languageModel(id)` returns one {@link scriptedModel} per id
 * (provider id as the model's `provider`).
 */
export function scriptedProvider(options: ScriptedProviderOptions): ScriptedProviderDefinition {
  const id = options.id ?? 'scripted'
  const created = new Map<string, ScriptedModel>()
  return {
    id,
    label: options.label ?? 'Scripted',
    settings: z.object({}),
    created,
    create: () => ({
      languageModel: (modelId) => {
        let model = created.get(modelId)
        if (model === undefined) {
          model = scriptedModel(options.models[modelId] ?? [], { provider: id, modelId })
          created.set(modelId, model)
        }
        return model
      },
    }),
    listModels: async () =>
      Object.keys(options.models).map((modelId) => ({
        id: modelId,
        name: modelId,
        tools: true,
        ...(options.info?.[modelId] ? { info: options.info[modelId] } : {}),
      })),
  }
}
