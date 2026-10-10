/**
 * Types of `eharness/providers`: provider definitions, profiles, the profile store port and the
 * framework-neutral form description.
 *
 * @see docs/specs/23-providers.md
 */
import type { LanguageModel } from 'ai'
import type { z } from 'zod/v4'
import type { ModelInfo } from '../index.ts'

/** Where a settings field is shown in a form. */
export type FieldGroup = 'auth' | 'endpoint' | 'advanced'

/** Suggested input widget of a settings field. */
export type FieldWidget = 'password' | 'textarea' | 'keyvalue' | 'radio' | 'select'

/** Show a field only while another field has a given value. */
export interface ShowWhen {
  /** Path of the controlling field. */
  field: string
  equals?: unknown
  in?: unknown[]
}

/**
 * Form metadata of a settings field, stored under the `'x-eh'` key of the zod `.meta()` (use
 * {@link ehMeta}).
 */
export interface FieldMeta {
  /** The value is a secret: redacted in {@link PublicProfile}, kept on edit unless replaced. */
  secret?: boolean
  /** For a `keyvalue` (record) field: the values are secrets (for example header values). */
  secretValues?: boolean
  group?: FieldGroup
  widget?: FieldWidget
  showWhen?: ShowWhen
  placeholder?: string
  /** Environment variable that can supply the field (shown as a hint; see `envMap`). */
  envHint?: string
}

/** Context of the network calls of a provider (`listModels`, `test`). */
export interface ProviderContext {
  /** The injected fetch (never the global one implicitly). */
  fetch: typeof fetch
  signal?: AbortSignal
}

/** What `ProviderDefinition.create` returns: a factory of language models. */
export interface ProviderInstance {
  languageModel(id: string): LanguageModel
}

/** One model reported by a provider or a catalog. */
export interface ListedModel {
  id: string
  /** Display name. Default: the id. */
  name?: string
  description?: string
  /** Limits and prices (spec 12 §1). */
  info?: ModelInfo
  reasoning?: boolean
  tools?: boolean
}

/** Result of a connection test. `message` never contains a secret. */
export interface TestResult {
  ok: boolean
  message?: string
  latencyMs?: number
}

/** Where the manager finds model metadata for a provider besides its own listing. */
export interface ProviderCatalogHint {
  /**
   * models.dev provider key(s). A single key lists its models under their plain ids; an array
   * (aggregators such as the AI Gateway) lists `<provider>/<model>` ids.
   */
  modelsDevKey?: string | string[]
  /** `'openrouter'`: the public OpenRouter model list (`GET /api/v1/models`). */
  kind?: 'openrouter'
}

/**
 * A model provider: its settings (a zod object with form metadata), how to build models from
 * them and how to list and test them. The provider package factory is passed in by the app, so
 * the library imports no provider package.
 *
 * @see docs/specs/23-providers.md#1-provider-definition
 */
/** A zod object schema of settings. */
export type SettingsSchema = z.ZodObject

export interface ProviderDefinition<S extends z.ZodObject = z.ZodObject> {
  /** Stable id (`openrouter`, `openai-compatible`); profile ids are separate. */
  id: string
  label: string
  doc?: string
  /** Settings schema; field metadata (`title`, `description`, `default`, `x-eh`) drives forms. */
  settings: S
  /** Settings field (top-level) → environment variable, for {@link fromEnv} and form hints. */
  envMap?: Partial<Record<keyof z.input<S> & string, string>>
  /** A sensible default model id of the provider (informational). */
  defaultModel?: string
  create(settings: z.output<S>): ProviderInstance
  /** Live model list. Failures are tolerated: the manager falls back to catalogs. */
  listModels?(settings: z.output<S>, ctx: ProviderContext): Promise<ListedModel[]>
  /** Connection test. Default (manager): `listModels` when present, else a settings check. */
  test?(settings: z.output<S>, ctx: ProviderContext): Promise<TestResult>
  catalog?: ProviderCatalogHint
}

/** A provider definition with any settings schema. */
// biome-ignore lint/suspicious/noExplicitAny: variance of the settings schema
export type AnyProviderDefinition = ProviderDefinition<any>

/** A model added to a profile by hand (not in any list). */
export type ExtraModel = { id: string; name?: string } & ModelInfo

/** Per-profile model policy. Ids may use `*` as a wildcard. */
export interface ProfileModels {
  /** When set, only these models are listed and resolvable. */
  allow?: string[]
  deny?: string[]
  extra?: ExtraModel[]
}

/**
 * A configured instance of a definition (a provider, a connector, ...): one set of settings and
 * credentials. Generic: `kind` namespaces profiles so one store can hold several kinds.
 */
export interface ConfigProfile<Settings = Record<string, unknown>> {
  /** Unique within its kind; for providers without `:` (`profile:model` splits on the first `:`). */
  id: string
  /** Namespace: `'provider'` for model providers; apps pick their own (`'connector'`). */
  kind: string
  /** Id of the definition this profile configures (the provider id). */
  definitionId: string
  label: string
  /** Settings (input shape of the schema). Contains secrets: store it encrypted. */
  settings: Settings
  enabled: boolean
  /** `'env'` profiles come from the environment and are read-only. Default `'store'`. */
  source?: 'env' | 'store'
  /** Epoch ms. */
  updatedAt: number
}

/** A model-provider profile (`kind: 'provider'`). */
export interface ProviderProfile extends ConfigProfile {
  kind: 'provider'
  models?: ProfileModels
}

/** A redacted secret: whether it is set and a short tail of it. */
export interface SecretStatus {
  set: boolean
  hint?: string
}

/** A profile safe to send to a browser: secrets replaced by {@link SecretStatus}. */
export type PublicConfigProfile<P extends ConfigProfile = ConfigProfile> = Omit<P, 'settings'> & {
  settings: Record<string, unknown>
}

/** A redacted {@link ProviderProfile}. */
export type PublicProfile = PublicConfigProfile<ProviderProfile>

/** Patch value of a secret field that keeps the stored value. */
export interface KeepSecret {
  keep: true
}

/**
 * Where profiles of any kind live (keyed by `(kind, id)`). The library ships a memory adapter; databases are the app's adapters
 * (encrypt `settings` there). Implementations return copies.
 */
export interface ProfileStore {
  /** All profiles, or only those of `kind`. */
  list(query?: { kind?: string }): Promise<ConfigProfile[]>
  get(kind: string, id: string): Promise<ConfigProfile | undefined>
  /** Insert or replace by `(kind, id)`. */
  put(profile: ConfigProfile): Promise<void>
  /** Idempotent. */
  delete(kind: string, id: string): Promise<void>
  /** Optional change feed (other process, other tab). Returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void
}

/** One field of a provider form. */
export interface FormField {
  /** Dotted path in the settings object. */
  path: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'record' | 'array' | 'json'
  widget?: FieldWidget
  label: string
  description?: string
  required: boolean
  secret: boolean
  /** `keyvalue` fields: the values are secrets. */
  secretValues: boolean
  options?: Array<{ value: string | number | boolean; label: string }>
  default?: unknown
  group: FieldGroup
  showWhen?: ShowWhen
  placeholder?: string
  envHint?: string
  /** JSON Schema `format` (`uri`, `email`, …). */
  format?: string
  min?: number
  max?: number
}

/** Form description of a provider: the field list plus the JSON Schema it came from. */
export interface ProviderFormSpec {
  fields: FormField[]
  jsonSchema: Record<string, unknown>
}

/** What `describe()` reports for one provider definition. */
export interface ProviderDescription {
  id: string
  label: string
  doc?: string
  defaultModel?: string
  form: ProviderFormSpec
  envMap: Record<string, string>
  canListModels: boolean
  canTest: boolean
}

/** A model in a merged list. */
export interface ModelEntry extends ListedModel {
  name: string
  /** Where the entry (or its main data) came from. */
  source: 'extra' | 'live' | 'catalog'
}

/** A model reference: `{ profile, model }` or `'profile:model'` (split on the first `:`). */
export type ModelRef = string | { profile: string; model: string }

/**
 * Encrypts secrets at rest. Generic: `sealedProfileStore` uses it for any profile kind and
 * `eharness/connectors` for connection credentials and flow scratch. The app supplies a real
 * implementation (its existing secret box) or uses `webCryptoVault`. `context` is bound to the
 * ciphertext (row or flow id), so a blob cannot be replayed elsewhere.
 */
export interface SecretVault {
  /** Id of the key new blobs are sealed with (informational, for rotation). */
  keyId?: string
  seal(plaintext: string, context: string): Promise<string>
  /** Rejects (`EH_CONFIG_INVALID`, `details.reason: 'vault-open'`) for a wrong context, key or tampering. */
  open(sealed: string, context: string): Promise<string>
  /** True when `sealed` was made with an old key (see `sealedProfileStore().reseal()`). */
  needsReseal?(sealed: string): boolean
}
