# Spec 23 — Providers and profiles (`eharness/providers`)

Status: **Draft (0.8)**. Module: `src/providers/*`. Builds on spec 12 (models and cost), ADR-0048.

Applications that let users pick a model provider need the same parts: several providers, several
saved connections ("profiles") per provider, a model list per profile, model metadata (context
window, prices) flowing into the agent, a settings form, and secrets that never reach a browser.
This module provides them. It imports **no provider package** (the app passes `createOpenRouter`,
`createOpenAI`, … into the definition helpers) and imports core only through `src/index.ts`.

**Network.** The core never fetches (spec 12). This module does, and only through an injected
`fetch` (default `globalThis.fetch`): live model lists, connection tests and the public catalogs
(models.dev, OpenRouter). It has no Node-only code.

**Generic machinery.** §2, §3 (`ConfigProfile`, `ProfileStore`, `fromEnv`) and §5 work on any zod
object schema and are not tied to providers: an app can configure other things (for example
connectors) with the same forms, secret handling and store, using another `kind`. They are exported
from `eharness/providers` for now and may move to their own subpath later (the names stay).

## 1. Provider definition

```ts
interface ProviderDefinition<S extends z.ZodObject> {
  id: string; label: string; doc?: string; defaultModel?: string
  settings: S                                   // zod object, field metadata via .meta()
  envMap?: { [field in keyof input<S>]?: string }  // settings field -> environment variable
  create(settings: output<S>): { languageModel(id: string): LanguageModel }
  listModels?(settings, ctx: { fetch; signal? }): Promise<ListedModel[]>
  test?(settings, ctx): Promise<TestResult>
  catalog?: { modelsDevKey?: string | string[]; kind?: 'openrouter' }
}
interface ListedModel { id; name?; description?; info?: ModelInfo; reasoning?; tools? }
```

`defineProvider(def)` types `create` / `listModels` / `test` from the schema and erases it to
`ProviderDefinition`. `catalog` tells the manager where model metadata lives besides the
provider's own listing: `kind: 'openrouter'` is the public OpenRouter list; `modelsDevKey: 'openai'`
is one models.dev provider (plain model ids); an **array** (an aggregator such as the gateway)
lists `<provider>/<model>` ids.

## 2. Forms, redaction and secrets (generic)

Field metadata is the standard zod `.meta()`: `title`, `description`, `default`, plus the
`'x-eh'` key (typed helper `ehMeta`):

| `x-eh` key | Meaning |
|---|---|
| `secret` | value is a secret (redacted, kept on edit unless replaced) |
| `secretValues` | a record field whose values are secrets (headers) |
| `group` | `'auth' \| 'endpoint' \| 'advanced'`; default `auth` for secrets, else `endpoint` |
| `widget` | `'password' \| 'textarea' \| 'keyvalue' \| 'radio' \| 'select'`; defaults: secret → `password`, record → `keyvalue`, enum → `select` |
| `showWhen` | `{ field, equals? , in? }`, show only while another field has a value |
| `placeholder`, `envHint` | UI hints |
| `optionLabels` | display labels of enum values (`{ none: 'No authentication' }`); `options[].label` defaults to the value |

`formSpec(schema)` returns `{ fields: FormField[], jsonSchema }` (`z.toJSONSchema(schema,
{ io: 'input' })`; zod v4 schemas, imported from `zod/v4`). `FormField`: `path` (dotted for nested
objects), `kind` (`string | number | integer | boolean | enum | record | array | json`), `widget`,
`label` (`title`, else the humanized key), `description`, `required`, `secret`, `secretValues`,
`options`, `default`, `group`, `showWhen`, `placeholder`, `envHint`, `format`, `min`, `max`. Order is
the schema's property order. `providerFormSpec(def)` is `formSpec(def.settings)`.

- `redactSettings(schema, settings)` / `redactProfile(schema, profile)`: only fields the schema
  knows are copied (unknown keys are dropped); a secret becomes `SecretStatus = { set: boolean,
  hint? }` (`hint` is `…` + the last 4 characters of values of 12+ characters; `{ hint: false }`
  option disables it); a `secretValues` record maps every key to a `SecretStatus`. The result
  contains no secret and can be serialized or logged.
- `mergeSecretPatch(schema, stored, patch)`: an edit without resending secrets. A field absent
  from the patch keeps its stored value; a secret given as `undefined`, `''` or `{ keep: true }`
  keeps it; `null` removes any field; a `secretValues` record keeps a stored value for a key given
  as `''` / `{ keep: true }` and drops keys missing from the patch; unknown keys are ignored.
- `validateSettings(schema, settings, name?)`: `safeParse`; failure throws `EH_CONFIG_INVALID`
  (`details.reason: 'settings-invalid'`, `details.issues`) with `path: message` lines and never a
  value.
- `scrub(text, secrets)` and `secretValuesOf(schema, settings)` remove secrets from messages.

## 3. Profiles and the store

```ts
interface ConfigProfile<Settings> {
  id: string; kind: string; definitionId: string; label: string
  settings: Settings; enabled: boolean
  source?: 'env' | 'store'; updatedAt: number
}
interface ProviderProfile extends ConfigProfile { kind: 'provider'; models?: ProfileModels }
interface ProfileModels { allow?: string[]; deny?: string[]; extra?: Array<{ id; name? } & ModelInfo> }
interface ProfileStore {
  list(query?: { kind? }): Promise<ConfigProfile[]>
  get(kind, id): Promise<ConfigProfile | undefined>
  put(profile): Promise<void>          // replace by (kind, id)
  delete(kind, id): Promise<void>      // idempotent
  subscribe?(listener): () => void     // optional change feed
}
```

`kind` namespaces profiles so one store can hold providers and other kinds. Providers use
`kind: 'provider'`; the profile id has no `:` (a model reference is `profile:model`). The
library ships `memoryProfileStore()`; databases are the app's adapters (**encrypt `settings`
there**, see the guide) and are checked with `profileStoreConformance` from `eharness/testing`.
Adapters return copies. `allow` / `deny` entries may use `*`.

`fromEnv(definitions, env, { kind?, now? })` works over anything with `{ id, label, settings,
envMap? }`: for each definition it collects the `envMap` variables that are set (empty counts as
unset), and returns a `source: 'env'` profile (id = definition id) when at least one is set and the
settings validate.

## 4. The provider manager

```ts
createProviderManager({ definitions, store?, fetch?, cache?, catalogs?, env?, seed?, now?, onWarning?, listTtlMs? })
```

- `ready()` loads profiles (and persists `seed` once when the store has no provider profile);
  `env` profiles are overlaid (win on the same id), read-only and never persisted. With
  `store.subscribe` the snapshot follows external changes. `reload()` re-reads.
- `resolve(ref)` is synchronous on the loaded snapshot (it throws `EH_CONFIG_INVALID`,
  `details.reason: 'not-ready'`, before `ready()`). `ref` is `{ profile, model }` or
  `'profile:model'` split on the **first** `:` (`parseModelRef`; OpenRouter ids contain `:` and
  `/`). Settings are validated with the schema, the provider instance is cached per profile and
  rebuilt when its settings change, models are cached per instance. Errors are
  `EH_CONFIG_INVALID` with `details.reason`: `profile-not-found`, `profile-disabled`,
  `model-not-allowed`, `unknown-provider`, `settings-invalid`, `create-failed`, `model-ref-invalid`,
  `read-only`, `profile-exists`, `profile-id-invalid`, `provider-required`, `provider-immutable`.
- `putProfile(input)` creates or edits a store profile (settings patch through `mergeSecretPatch`,
  full validation, new ids default to the provider id then `-2`, …); returns the redacted profile.
  `deleteProfile`, `listProfiles`, `getProfile`, `describe()` (`{ providers: ProviderDescription[]
  (id, label, doc, defaultModel, form, envMap, canListModels, canTest), profiles }`).
- `models(profileId, { refresh?, includeDisabled? })` merges, per model id and field by field: **profile extra >
  live `listModels` > catalogs**. If the live listing is absent or fails (a warning, secrets
  scrubbed), the catalog-derived list is the list; when it succeeds, catalogs only enrich it.
  `allow` / `deny` apply (`{ includeDisabled: true }` lists the models they hide too, each entry
  with `enabled: boolean`, for a model-toggle UI); extras come first, then models with `tools` first, by name. Live lists
  are reused for `listTtlMs` (5 min).
- `loadCatalogs({ refresh? })` loads the catalogs the enabled profiles' definitions need (§5);
  `refresh` resolves when a background refresh of stale data finished and the manager has taken it.
- `catalog()` is a `ModelCatalog` function for `defineHarnessAgent({ models })`. A model created
  by `resolve` is mapped (WeakMap; gateway string ids in a Map) to its profile and priced from
  the merged info of that profile, computed at call time, so late-loaded catalogs and edited
  extras apply. Other models fall back to `lookupModel` on the loaded catalogs (OpenRouter wins
  over models.dev). Result: `usage.costUsd` and the context window are right (spec 12 §1, §3).
  Two gateway profiles resolving the same id *string* share one mapping (last wins); give the
  gateway `createGateway` to get model objects.
- `test(profileId)` runs `def.test`, else `listModels`, else a settings check; it never throws and
  its message never contains a secret. `invalidate(profileId?)`, `dispose()`.

## 5. Catalog loader

`loadCachedJson({ key, url, fetch, cache?, now?, ttlMs?, timeoutMs?, offline?, force?, signal? })`:
cache miss → fetch (bounded by `timeoutMs`, default 3 s); cache older than `ttlMs` (default 24 h)
→ returned as is plus a background `refresh` promise; a failed download keeps the stale cache;
`offline` never fetches. It never throws. `CatalogCache` is a port (`get` / `set` of
`{ data, fetchedAt }`; `memoryCatalogCache()` ships, apps bring file/DB adapters). Helpers:
`loadModelsDev` (key `models.dev`), `loadOpenRouterModels` (key `openrouter`),
`parseOpenRouterModels`, `parseModelsDevModels`. The manager's `catalogs` option: `offline`,
`ttlMs`, `timeoutMs`, URLs, and `data` (raw JSON supplied by the app, never fetched).

## 6. Built-in definitions

Each takes the provider package factory and optional `id` / `label`; settings fields:
`apiKey` (secret, `auth`), `baseURL` (`endpoint`), `headers` (`keyvalue`, secret values,
`advanced`).

| Helper | Factory option | envMap | Models / catalog |
|---|---|---|---|
| `openRouterProvider` | `createOpenRouter` | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | `catalog.kind: 'openrouter'`; `live: true` adds `GET <baseURL>/models` |
| `gatewayProvider` | `createGateway?` (none: plain id strings, key from the AI SDK environment) | `AI_GATEWAY_API_KEY` (the AI SDK gateway has no base-URL environment variable: set `baseURL` on the profile) | models.dev providers (`GATEWAY_MODELS_DEV_PROVIDERS`); with `createGateway`, live `getAvailableModels()` with prices |
| `openAICompatibleProvider` | `createOpenAICompatible` | none | live `GET <baseURL>/models`; `baseURL` required, `apiKeyOptional`, `defaultBaseURL`, `id` for presets |
| `openAIProvider` | `createOpenAI` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | models.dev `openai` + live `GET /models` (embedding/audio/image ids dropped) |
| `anthropicProvider` | `createAnthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | models.dev `anthropic` + live `GET /v1/models` |

`eharness/testing` adds `scriptedProvider({ id?, models: { id: steps }, info? })`
and `profileStoreConformance`.

## 7. Security

Secrets live only in `ProfileStore` rows and in memory of the process that resolves models. They
are never in `PublicProfile`, `describe()`, `ProviderDescription`, warnings, `test()` messages or
`HarnessError` messages produced here. A `ProfileStore` adapter should encrypt `settings`; the
library cannot.

## 8. Sealing secrets at rest (generic)

`SecretVault` is the one port that encrypts secrets, shared by providers, connectors and any other
profile kind (ADR-0052):

```ts
interface SecretVault {
  keyId?: string
  seal(plaintext: string, context: string): Promise<string>   // context is bound to the blob
  open(sealed: string, context: string): Promise<string>      // rejects: wrong context, key, tampering
  needsReseal?(sealed: string): boolean                       // blob made with an old key
}
```

- `webCryptoVault(key | { keys, current })`: AES-256-GCM over `crypto.subtle`, fresh IV per seal,
  `context` authenticated, blob `v2.<keyId>.<base64url(iv || ct)>`. Several keys support rotation.
  `withLegacyVault(vault, { matches, open })` reads blobs of an older format and writes the
  current one (`needsReseal` is true for legacy blobs, so `reseal()` migrates them).
  `plaintextVault()` is for tests only. An app that already has a secret box implements the
  three-method port around it.
- `sealedProfileStore(inner, vault, { kinds?, schemaOf? })` wraps any `ProfileStore`: `put`
  seals, `get` / `list` open, so the manager and the connector service see plain settings and the
  database only ciphertext. Default: the whole `settings` JSON becomes `{ "~sealed": blob }`,
  bound to `profile:<kind>:<id>` (a row cannot be moved to another id). With `schemaOf(profile)`
  only the `secret` / `secretValues` fields are sealed (the rest stays queryable). `kinds` limits
  sealing to some kinds. `onUnreadable({ kind, id, error })` makes `list` / `reseal` skip rows that
  cannot be opened (lost key) and report them instead of rejecting. `subscribe` is passed through. `reseal()` rewrites rows sealed with an
  old key and returns how many. An unopenable row makes `get` / `list` reject with
  `EH_CONFIG_INVALID` (`details.reason: 'vault-open'`).
