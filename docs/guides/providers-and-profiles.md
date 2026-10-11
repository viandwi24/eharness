# Providers and profiles (`eharness/providers`)

Let users (or your config) choose between several model providers, keep several saved connections
per provider, list their models live, and have prices and context windows reach the agent.
Contract: [spec 23](../specs/23-providers.md). The module imports no provider package: you pass the
factories.

## Setup

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createGateway } from 'ai'
import { defineHarnessAgent } from 'eharness'
import {
  createProviderManager, gatewayProvider, inMemoryProfileStore, openRouterProvider,
} from 'eharness/providers'

const providers = createProviderManager({
  definitions: [openRouterProvider({ createOpenRouter }), gatewayProvider({ createGateway })],
  store: inMemoryProfileStore(),          // or your encrypted adapter
  env: process.env,                     // OPENROUTER_API_KEY / AI_GATEWAY_API_KEY -> read-only profiles
  catalogs: { offline: process.env.APP_OFFLINE === '1' },
  fetch,                                // the only network access (default: globalThis.fetch)
  onWarning: (message) => console.warn(message), // failed live listing / catalog refresh; no secrets
})
await providers.ready()
await providers.loadCatalogs()          // models.dev / OpenRouter (ttlMs default 24 h, timeoutMs 3 s)

const agent = defineHarnessAgent({
  model: providers.resolve('openrouter:anthropic/claude-sonnet-4.6'),
  models: providers.catalog(),          // usage.costUsd and the context window are right
})
```

Switching models per turn (a `turn.prepare` hook returning `{ model: providers.resolve(ref) }`) is
the same call: `resolve` is synchronous and cached, and it splits `profile:model` on the first `:`
only, so `openrouter-2:meta-llama/llama-3.1-8b-instruct:free` works.

## Profiles

A profile is one saved connection: `{ id, kind: 'provider', definitionId, label, settings,
enabled, models?, source?, updatedAt }`. Environment variables become read-only `source: 'env'`
profiles (id = provider id); everything else is stored. Create or edit with `putProfile`, which
validates and returns a redacted profile:

```ts
// yours: `apiKey` is the secret the user typed
await providers.putProfile({ providerId: 'openrouter', label: 'Work', settings: { apiKey } })
// edit without resending the key:
await providers.putProfile({ id: 'openrouter-2', label: 'Work (renamed)', settings: { apiKey: { keep: true } } })
await providers.putProfile({ id: 'openrouter-2', models: { deny: ['*:free'], extra: [{ id: 'my/model', contextWindow: 64_000 }] } })
```

`models(profileId)` merges profile extras, the live listing and the catalogs (see the spec), so a
model picker is `await providers.models(id)` → `{ id, name, info?, reasoning?, tools?, source }[]`.
`await providers.test(id)` checks the connection and never echoes a secret.

## A settings form from the schema

`describe()` gives every provider as a field list; render it with any framework.

```ts
const { providers: defs, profiles } = await providers.describe()   // send to the browser
```

Svelte 5 sketch (React is the same loop):

```svelte
<script lang="ts">
  let { spec, values = $bindable({}) } = $props()   // spec: ProviderDescription['form']
  const visible = (f) => !f.showWhen || (f.showWhen.in ?? [f.showWhen.equals]).includes(values[f.showWhen.field])
  const groups = ['auth', 'endpoint', 'advanced']
</script>

{#each groups as g}
  <fieldset><legend>{g}</legend>
  {#each spec.fields.filter((f) => f.group === g && visible(f)) as f (f.path)}
    <label>{f.label}
      {#if f.widget === 'password'}
        <input type="password" placeholder={f.placeholder} bind:value={values[f.path]} />
        <!-- an untouched password input sends '' and keeps the stored key -->
      {:else if f.kind === 'enum'}
        <select bind:value={values[f.path]}>{#each f.options as o}<option value={o.value}>{o.label}</option>{/each}</select>
      {:else if f.widget === 'keyvalue'}
        <!-- rows of key + value; send { key: '' } for an unchanged secret value -->
      {:else}
        <input placeholder={f.placeholder} bind:value={values[f.path]} />
      {/if}
    </label>
    {#if f.description}<small>{f.description}</small>{/if}
  {/each}</fieldset>
{/each}
```

Paths are dotted for nested objects; show "set …1234" from `profile.settings.apiKey` (`{ set, hint }`).

**Changing the endpoint resets the secrets.** A `format: 'uri'` field (`z.url()`), or one marked
`ehMeta({ endpoint: true })` (`FormField.endpoint` is `true`), says where the stored secrets are
sent. If an edit changes it (a new `baseURL`), `putProfile` does not keep the
old key or header values: the form must resend them, otherwise the save fails with
`EH_CONFIG_INVALID` for a required key (and an optional secret is cleared). So an edit that only
repoints a profile cannot make `test()` / `models()` send the old key to another host. Show "enter
the key again" in the UI when the person edits the URL.
The same machinery works on any zod object (`formSpec`, `redactSettings`, `fromEnv`,
`ConfigProfile`, `ProfileStore` with another `kind`).

## Writing your own provider

```ts
import { z } from 'zod/v4'
import { defineProvider, ehMeta } from 'eharness/providers'

// yours: `createAcme` is the provider SDK factory
const settings = z.object({
  apiKey: z.string().min(1).meta({ title: 'API key', ...ehMeta({ secret: true, group: 'auth' }) }),
  region: z.enum(['us', 'eu']).default('us').meta({ ...ehMeta({ group: 'endpoint', widget: 'radio' }) }),
})
export const acme = defineProvider({
  id: 'acme', label: 'Acme', settings,
  envMap: { apiKey: 'ACME_API_KEY' },
  create: (s) => { const p = createAcme({ apiKey: s.apiKey, region: s.region }); return { languageModel: (id) => p(id) } },
  listModels: async (s, { fetch, signal }) => /* GET models, map to ListedModel[] */ [],
  catalog: { modelsDevKey: 'acme' },
})
```

## A `ProfileStore` that encrypts

The library stores secrets only in the `ProfileStore` you give it, so encrypt there. The ready way
is `sealedProfileStore({ inner, vault })`, which encrypts the settings of any profile kind with a
`SecretVault` (`webCryptoVault(keys)`, `plaintextVault()` for tests) in front of your store:

```ts
import { sealedProfileStore, webCryptoVault } from 'eharness/providers'

// yours: `rawStore` (any ProfileStore), `keyBytes` (a 32-byte Uint8Array from your KMS or env)
const store = sealedProfileStore({ inner: rawStore, vault: webCryptoVault(keyBytes) })
```

To do it by hand instead, encrypt the
whole `settings` object (it is JSON) with an app key (KMS or an env key), keep `id`, `kind`,
`definitionId`, `label`, `enabled`, `source`, `updatedAt` and `models` in clear columns:

```ts
// yours: `Db` and `box` are your database client and cipher
function encryptedStore(db: Db, box: { seal(text: string): string; open(text: string): string }): ProfileStore {
  const row = (p: ConfigProfile) => ({ ...p, settings: box.seal(JSON.stringify(p.settings)) })
  const unrow = (r): ConfigProfile => ({ ...r, settings: JSON.parse(box.open(r.settings)) })
  return {
    list: async (q) => (await db.select(q?.kind)).map(unrow),
    get: async (kind, id) => { const r = await db.find(kind, id); return r && unrow(r) },
    put: async (p) => db.upsert(row(p)),           // key: (kind, id)
    delete: async (kind, id) => db.remove(kind, id),
  }
}
```

Run `profileStoreConformance(() => encryptedStore(...))` from `eharness/testing`. Never log a profile
read from the store; send `describe()` / `listProfiles()` output to browsers.

## Offline and caches

`catalogs.offline: true` never fetches. Pass `cache` (a `CatalogCache`: `get(key)` / `set(key,
{ data, fetchedAt })`, keys `models.dev` and `openrouter`) to persist the raw catalog between runs
(a file, a table); the default is memory. Pass `catalogs.data` to ship a snapshot.

## Reference

| Export | Use |
|---|---|
| `createProviderManager`, `parseModelRef`, `formatModelRef` | the manager |
| `defineProvider`, `openRouterProvider`, `gatewayProvider`, `openAIProvider`, `anthropicProvider`, `openAICompatibleProvider` | definitions |
| `formSpec`, `ehMeta` | form description |
| `redactSettings`, `redactProfile`, `validateSettings`, `secretStatus` | secrets (any zod schema) |
| `inMemoryProfileStore`, `sealedProfileStore`, `plaintextVault`, `webCryptoVault`, `fromEnv` | profiles and sealing |
| `loadModelsDev`, `loadOpenRouterModels`, `inMemoryCatalogCache` | catalogs |
| `profileStoreConformance`, `scriptedProvider` (`eharness/testing`) | tests |
