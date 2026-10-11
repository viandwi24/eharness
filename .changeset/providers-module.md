---
"eharness": minor
---

New subpath `eharness/providers` (spec 23, ADR-0048, ADR-0053; Draft): provider definitions with zod settings (OpenRouter, AI Gateway, OpenAI, Anthropic, OpenAI-compatible; the app passes the provider factory), profiles and a `ProfileStore` port with `memoryProfileStore()`, `createProviderManager()` (`resolve('profile:model')`, merged model lists, `catalog()` for the agent's `models` option, connection tests, redacted `describe()`), a framework-neutral form spec (`formSpec`, with `FieldMeta.optionLabels` for display labels of enum values), secret redaction and edit-without-resending (`redactSettings`, `mergeSecretPatch`), `fromEnv`, and a cached models.dev / OpenRouter loader with an injected `fetch` and a `CatalogCache` port.

- `ProviderManager.models(id, { includeDisabled: true })` also lists the models a profile's `allow` / `deny` hides, each marked `enabled`, so a UI can offer per-model switches. Overlapping profile reloads keep the newest snapshot.
- The generic `SecretVault` (`webCryptoVault` with key rotation, `plaintextVault`, `withLegacyVault(vault, legacy)` to read an older sealing format and write the current one) and `sealedProfileStore({ onUnreadable })` (skips rows that cannot be opened, also in `reseal()`).
- `gatewayProvider` maps only `AI_GATEWAY_API_KEY`: `@ai-sdk/gateway` has no base-URL environment variable.

`eharness/testing` adds `profileStoreConformance` and `scriptedProvider`.
