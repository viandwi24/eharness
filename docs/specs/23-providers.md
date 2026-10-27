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
the schema's property order. `formSpec(def.settings)` gives the form of a provider definition (the manager's `describe()` does it for every definition).

- `redactSettings(schema, settings)` / `redactProfile(schema, profile)`: only fields the schema
  knows are copied (unknown keys are dropped); a secret becomes `SecretStatus = { set: boolean,
  hint? }` (`hint` is `…` + the last 4 characters of values of 12+ characters; `{ hint: false }`
  option disables it); a `secretValues` record maps every key to a `SecretStatus`. The result
  contains no secret and can be serialized or logged.
- Secret-preserving edits (internal `mergeSecretPatch`, used by `putProfile`): an edit without resending secrets. A field absent
  from the patch keeps its stored value; a secret given as `undefined`, `''` or `{ keep: true }`
  keeps it; `null` removes any field; a `secretValues` record keeps a stored value for a key given
  as `''` / `{ keep: true }` and drops keys missing from the patch; unknown keys are ignored.
  **Secrets are bound to the endpoint**: a field is an *endpoint* when its JSON Schema `format` is
  `uri` / `url` (`z.url()`) or its meta says `ehMeta({ endpoint: true })` (`endpoint: false` opts a
  URL out; `FormField.endpoint` tells a UI). When a patch changes an endpoint (a different value, or `null` on a stored one) no stored secret is kept: `secret` fields and
  `secretValues` entries absent from the patch, or given as `''` / `{ keep: true }`, are cleared and
  must be resent in the same patch. A required one then fails `validateSettings` with the usual
  `EH_CONFIG_INVALID` (`apiKey: …`). Otherwise an edit of only `baseURL` would make `test()` /
  `models()` send the stored key to the new host. An unchanged endpoint keeps everything.
- `validateSettings(schema, settings, name?)`: `safeParse`; failure throws `EH_CONFIG_INVALID`
  (`details.reason: 'settings-invalid'`, `details.issues`) with `path: message` lines and never a
  value.
- Messages produced by the manager (warnings, `test()` results) have every known secret value scrubbed (internal helpers).

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
library ships `inMemoryProfileStore()`; databases are the app's adapters (**encrypt `settings`
there**, see the guide) and are checked with `profileStoreConformance` from `eharness/testing`.
Adapters return copies. `allow` / `deny` entries may use `*`.

`fromEnv(definitions, env, { kind?, now? })` works over anything with `{ id, label, settings,
envMap? }`: for each definition it collects the `envMap` variables that are set (empty counts as
unset), and returns a `source: 'env'` profile (id = definition id) when at least one is set and the
settings validate.

## 4. The provider manager

```ts
createProviderManager({ definitions, store?, fetch?, cache?, catalogs?, env?, seed?, now?, onWarning?(message, { profileId? }), listTtlMs? })
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

The loader (internal `loadCachedJson({ key, url, fetch, cache?, now?, ttlMs?, timeoutMs?, offline?, force?, signal?, validate?, maxBytes?, onWarning? })`)
works like this: cache miss → fetch (bounded by `timeoutMs`, default 3 s); cache older than `ttlMs` (default 24 h)
→ returned as is plus a background `refresh` promise; a failed download keeps the stale cache;
`offline` never fetches. The body is read up to `maxBytes` (default 16 MiB) and must pass `validate`
(`loadModelsDev` / `loadOpenRouterModels` check the shape per source with zod: a non-empty provider map /
a non-empty `data` array of `{ id }`); an oversized, invalid or empty document is never cached, never
replaces a valid cache entry, and is reported through `onWarning(message)` (an invalid cached entry is
ignored the same way). It never throws. `CatalogCache` is a port (`get` / `set` of
`{ data, fetchedAt }`; `inMemoryCatalogCache()` ships, apps bring file/DB adapters). Public
helpers: `loadModelsDev` (key `models.dev`) and `loadOpenRouterModels` (key `openrouter`); the parsers
are internal. The manager's `catalogs` option: `offline`,
`ttlMs`, `timeoutMs`, URLs, and `data` (raw JSON supplied by the app, never fetched).

## 6. Built-in definitions

Each takes the provider package factory and optional `id` / `label`; settings fields:
`apiKey` (secret, `auth`), `baseURL` (`endpoint`), `headers` (`keyvalue`, secret values,
`advanced`).

| Helper | Factory option | envMap | Models / catalog |
|---|---|---|---|
| `openRouterProvider` | `createOpenRouter` | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | `catalog.kind: 'openrouter'`; `live: true` lists from `GET <baseURL>/models` instead |
| `gatewayProvider` | `createGateway?` (none: plain id strings, key from the AI SDK environment) | `AI_GATEWAY_API_KEY` (the AI SDK gateway has no base-URL environment variable: set `baseURL` on the profile) | models.dev providers (a fixed internal list); with `createGateway`, live `getAvailableModels()` with prices |
| `openAICompatibleProvider` | `createOpenAICompatible` | none | live `GET <baseURL>/models`; `baseURL` required, `apiKeyOptional`, `defaultBaseURL`, `id` for presets; vLLM's `max_model_len` becomes the context window; optional `contextWindow` setting fills unknown windows |
| `ollamaProvider`, `lmStudioProvider`, `vllmProvider`, `llamaCppProvider` | `createOpenAICompatible` | none | OpenAI-compatible presets for local servers (below) |
| `openAIProvider` | `createOpenAI` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` | models.dev `openai` + live `GET /models` (embedding/audio/image ids dropped) |
| `anthropicProvider` | `createAnthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | models.dev `anthropic` + live `GET /v1/models` |

**Local servers.** The four presets are `openAICompatibleProvider` with the API key optional, the
server's usual address as the `baseURL` default (`http://localhost:11434/v1`, `:1234/v1`,
`:8000/v1`, `:8080/v1`), ids `ollama`, `lmstudio`, `vllm`, `llamacpp`, and listings that add what
the server knows to the ids of `GET <baseURL>/models` (native endpoints at the URL without `/v1`,
with the profile's headers; any failure keeps the plain ids, never throws):

- the context window is the one the server **runs** the model with, never the trained maximum: a
  local server cuts a longer prompt silently, so compaction must happen before it. Order: what the
  server reports for the model (Ollama `GET /api/ps` `context_length` of a loaded model, LM Studio
  `loaded_instances[0].config.context_length` of `GET /api/v1/models` (else `/api/v0/models`),
  vLLM `max_model_len`, llama.cpp `default_generation_settings.n_ctx` of `GET /props`), then the
  model's own setting (an Ollama Modelfile `num_ctx` from `POST /api/show`), then the profile's
  `contextWindow` setting, then 4096 (Ollama's and LM Studio's default on small GPUs), capped at the
  trained maximum when known. The model's `description` says which applied;
- Ollama `capabilities` (`/api/show`) set `tools`, `reasoning` (`thinking`) and
  `inputModalities` (`vision` adds `image`); LM Studio `capabilities` set `tools` and vision, its
  `display_name` the name, and embedding models are left out;
- the price is zero (`{ input: 0, output: 0 }`), except Ollama cloud models (`*-cloud`).

`openRouterProvider` also has three optional `advanced` settings and always turns usage accounting
on (`usage: { include: true }` on the model, so the response carries the billed cost,
`providerMetadata.openrouter.usage.cost`, which the core settles instead of the catalog estimate,
spec 12 §3):

- `providerOrder`: comma-separated OpenRouter provider slugs, sent as `provider.order`;
- `allowFallbacks` (default on): `false` sends `provider.allow_fallbacks: false`;
- `stickyProvider` (default off): app-side stickiness. OpenRouter's prompt cache only works within
  one upstream provider, so the provider that served the previous call of a conversation
  (`providerMetadata.openrouter.provider`, lowercased and dashed to a slug) is sent first in
  `provider.order` of the next call. A conversation is told apart by its first two prompt messages;
  the memory is per provider instance (bounded). A wrong slug is only skipped by OpenRouter while
  fallbacks are allowed.

With none of them set, no `provider` key is sent: behaviour is unchanged.

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
  An app that has blobs of an older format wraps the port itself: `open` reads both formats and
  `needsReseal` is true for legacy blobs, so `reseal()` migrates them (`examples/team` has one).
  `plaintextVault()` is for tests only. An app that already has a secret box implements the
  three-method port around it.
- `sealedProfileStore({ inner, vault, kinds?, schemaOf? })` wraps any `ProfileStore`: `put`
  seals, `get` / `list` open, so the manager and the connector service see plain settings and the
  database only ciphertext. Default: the whole `settings` JSON becomes `{ "~sealed": blob }`,
  bound to `profile:<kind>:<id>` (a row cannot be moved to another id). With `schemaOf(profile)`
  only the `secret` / `secretValues` fields are sealed (the rest stays queryable). `kinds` limits
  sealing to some kinds. `onUnreadable({ kind, id, error })` makes `list` / `reseal` skip rows that
  cannot be opened (lost key) and report them instead of rejecting. `subscribe` is passed through. `reseal()` rewrites rows sealed with an
  old key and returns how many. An unopenable row makes `get` / `list` reject with
  `EH_CONFIG_INVALID` (`details.reason: 'vault-open'`).
