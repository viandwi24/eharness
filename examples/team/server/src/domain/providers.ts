/**
 * Provider profiles as the app sees them (DTOs of `eharness/providers`, kept structural so
 * domain / app / http never import the library) and the `{ profileId, modelId }` selection an agent
 * or the workspace default carries. Pure: no I/O.
 */

/** A secret as an API shows it: whether it is set and a short tail, never the value. */
export interface SecretStatusView {
  set: boolean
  hint?: string
}

/** One field of a provider settings form (`FormField` of `eharness/providers`). */
export interface ProviderFieldView {
  path: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'record' | 'array' | 'json'
  widget?: 'password' | 'textarea' | 'keyvalue' | 'radio' | 'select'
  label: string
  description?: string
  required: boolean
  secret: boolean
  secretValues: boolean
  options?: Array<{ value: string | number | boolean; label: string }>
  default?: unknown
  group: 'auth' | 'endpoint' | 'advanced'
  showWhen?: { field: string; equals?: unknown; in?: unknown[] }
  placeholder?: string
  envHint?: string
  format?: string
  min?: number
  max?: number
}

export interface ProviderDefinitionView {
  id: string
  label: string
  doc?: string
  defaultModel?: string
  fields: ProviderFieldView[]
  /** JSON Schema of the settings (input shape). */
  jsonSchema: Record<string, unknown>
  /** Settings field -> environment variable that can supply it. */
  envMap: Record<string, string>
  canListModels: boolean
}

export interface ProfileModelsView {
  allow?: string[]
  deny?: string[]
  extra?: Array<{ id: string; name?: string; contextWindow?: number }>
}

export interface ProfileView {
  id: string
  definitionId: string
  label: string
  enabled: boolean
  /** `env`: from environment variables, read-only. `store`: saved in the database. */
  source: 'env' | 'store'
  /** Secrets are `{ set, hint? }`; everything else is the stored value. */
  settings: Record<string, unknown>
  models?: ProfileModelsView
  updatedAt: number
  /** True for the profile agents without their own pick use. */
  isDefault: boolean
  /** The model this profile uses when nothing picks one (`TEAM_MODEL` on the env default profile, else the provider's default). */
  defaultModel?: string
}

export interface ModelView {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** USD per 1M tokens. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  reasoning?: boolean
  tools?: boolean
  source: 'extra' | 'live' | 'catalog'
  /** Only with `all`: false when the profile's allow / deny hides the model. */
  enabled?: boolean
}

export interface TestResultView {
  ok: boolean
  message?: string
  latencyMs?: number
}

/** Whether a model answered a small tool call (`POST /providers/profiles/{id}/probe`). */
export interface ToolProbeView {
  /** The model was reached and answered. */
  ok: boolean
  /** It called the tool with the right input. */
  tools: boolean
  message: string
  latencyMs: number
}

export interface ProfileCreate {
  providerId: string
  /** Default: the provider id, then `-2`, `-3`, ... */
  id?: string
  label?: string
  settings?: Record<string, unknown>
  enabled?: boolean
}

export interface ProfilePatch {
  label?: string
  /** Secrets omitted, `''` or `{ keep: true }` keep the stored value; `null` removes a field. */
  settings?: Record<string, unknown>
  enabled?: boolean
  models?: ProfileModelsView | null
}

/** A model pick: the profile and the model id. Null parts follow the workspace default. */
export interface ModelSelection {
  profileId: string | null
  modelId: string | null
}

/**
 * Normalize a pick. A legacy `model` of `profile:model` whose prefix names a known profile is
 * split; any other string is a plain model id (OpenRouter ids contain `:` and `/`). A plain id with
 * no profile follows the default profile.
 */
export function normalizeSelection(
  profileId: string | null | undefined,
  modelId: string | null | undefined,
  knownProfiles: readonly string[],
): ModelSelection {
  const model = modelId == null || modelId.trim() === '' ? null : modelId.trim()
  const profile = profileId == null || profileId.trim() === '' ? null : profileId.trim()
  if (profile === null && model !== null) {
    const i = model.indexOf(':')
    if (i > 0 && knownProfiles.includes(model.slice(0, i))) {
      const rest = model.slice(i + 1)
      return { profileId: model.slice(0, i), modelId: rest === '' ? null : rest }
    }
  }
  return { profileId: profile, modelId: model }
}
