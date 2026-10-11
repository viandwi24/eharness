import type { ModelSettings } from '../agent/types.ts'
import { deepMerge } from './prompt.ts'

export type StepCallSettings = Record<string, unknown>

/** Default idle timeout of a model stream (`settings.timeout.chunkMs` / `firstChunkMs`). */
export const DEFAULT_CHUNK_TIMEOUT_MS = 120_000

/** Default `settings.maxRetries`: the AI SDK default, made explicit (429/5xx before streaming). */
export const DEFAULT_MAX_RETRIES = 2

export function callSettings(settings: ModelSettings): StepCallSettings {
  const { timeout, providerOptions: _p, ...rest } = settings
  const out: StepCallSettings = {}
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) out[key] = value
  if (out.maxRetries === undefined) out.maxRetries = DEFAULT_MAX_RETRIES
  if (timeout !== false) {
    const given =
      timeout === undefined ? {} : typeof timeout === 'number' ? { stepMs: timeout } : timeout
    out.timeout = {
      firstChunkMs: DEFAULT_CHUNK_TIMEOUT_MS,
      chunkMs: DEFAULT_CHUNK_TIMEOUT_MS,
      ...given,
    }
  }
  return out
}

export function mergeSettings(
  base: ModelSettings,
  patch: Partial<ModelSettings> | undefined,
): ModelSettings {
  if (patch === undefined) return base
  const providerOptions = deepMerge(base.providerOptions, patch.providerOptions)
  const merged: ModelSettings = { ...base, ...patch }
  if (providerOptions === undefined) delete merged.providerOptions
  else merged.providerOptions = providerOptions
  return merged
}
