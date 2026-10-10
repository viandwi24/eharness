---
"eharness": minor
---

New subpath `eharness/providers` (spec 23, ADR-0048): provider definitions with zod settings (OpenRouter, AI Gateway, OpenAI, Anthropic, OpenAI-compatible; the app passes the provider factory), profiles and a `ProfileStore` port with `memoryProfileStore()`, `createProviderManager()` (`resolve('profile:model')`, merged model lists, `catalog()` for the agent's `models` option, connection tests, redacted `describe()`), a framework-neutral form spec (`formSpec`), secret redaction and edit-without-resending (`redactSettings`, `mergeSecretPatch`), `fromEnv`, and a cached models.dev / OpenRouter loader with an injected `fetch` and a `CatalogCache` port. `eharness/testing` adds `profileStoreConformance` and `scriptedProvider`.
