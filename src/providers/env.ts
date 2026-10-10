/**
 * Profiles from environment variables.
 *
 * @see docs/specs/23-providers.md#3-profiles-and-the-store
 */
import type { z } from 'zod/v4'
import type { ConfigProfile } from './types.ts'

/** What {@link fromEnv} needs of a definition (a provider definition fits). */
export interface EnvConfigurable {
  id: string
  label: string
  settings: z.ZodObject
  envMap?: Partial<Record<string, string>>
}

/** Options of {@link fromEnv}. */
export interface FromEnvOptions {
  /** Clock for `updatedAt`. Default `Date.now`. */
  now?: () => number
  /** Profile `kind`. Default `'provider'`. */
  kind?: string
}

/**
 * Profiles (`source: 'env'`) over any definitions with a zod `settings` and an `envMap`: every definition whose `envMap` variables are set and whose
 * settings then validate. The profile id is the definition id. Empty variables count as unset.
 * Definitions without a usable environment are skipped silently (a missing key is not an error
 * here; resolving the profile later is).
 *
 * @example
 * ```ts
 * const profiles = fromEnv([openRouter, gateway], process.env)
 * ```
 */
export function fromEnv(
  definitions: readonly EnvConfigurable[],
  env: Record<string, string | undefined>,
  options: FromEnvOptions = {},
): ConfigProfile[] {
  const now = options.now ?? Date.now
  const out: ConfigProfile[] = []
  for (const def of definitions) {
    const settings: Record<string, unknown> = {}
    for (const [field, variable] of Object.entries(def.envMap ?? {})) {
      const value = env[variable as string]
      if (value !== undefined && value !== '') settings[field] = value
    }
    if (Object.keys(settings).length === 0) continue
    if (!def.settings.safeParse(settings).success) continue
    out.push({
      id: def.id,
      kind: options.kind ?? 'provider',
      definitionId: def.id,
      label: def.label,
      settings,
      enabled: true,
      source: 'env',
      updatedAt: now(),
    })
  }
  return out
}
