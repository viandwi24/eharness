# ADR-0048: `eharness/providers`: definitions, profiles, a manager and a catalog loader

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0001](0001-build-on-ai-sdk-primitives.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0016](0016-model-catalog-and-budgets.md)

## Context

Two example apps each reimplemented multiple providers (OpenRouter, gateway), dynamic model lists,
model metadata and a cached catalog loader, and wired prices and context windows into the agent.
Adding more providers, saved profiles with credentials and a settings form would multiply that.

## Decision

1. A new subpath module `eharness/providers` (dogfooding: core only through `src/index.ts`).
2. **No provider package is imported.** Definition helpers take the factory (`createOpenRouter`,
   `createOpenAI`, …) from the app; the library stays dependency-free (peer `zod` only).
3. **Settings are a zod object with `.meta()`**; a framework-neutral form spec and the JSON Schema
   are derived from it (`z.toJSONSchema`, input shape). Form hints live under the `'x-eh'` key.
   Secrets are declared in the schema (`secret`, `secretValues`), so redaction and the
   edit-without-resending merge are schema-driven.
4. **Generic configuration machinery**: forms, secret handling, `ConfigProfile` with a `kind`,
   `ProfileStore` (keyed by `(kind, id)`), `fromEnv` and the conformance suite do not depend on
   providers, so other configurable things (connectors) reuse them. They may move to their own
   subpath later.
5. **The manager owns resolution and the catalog**: `resolve` is synchronous on a loaded snapshot
   (the agent's `turn.prepare` hook stays simple); `catalog()` maps created models back to their
   profile (WeakMap) and computes merged info at call time, so spec 12 cost and context window
   work unchanged. Merge order is profile extra > live listing > public catalog.
6. **The module fetches, the core still does not.** Model listing, connection tests and the
   public catalogs use an injected `fetch`; raw catalog JSON is cached through a `CatalogCache`
   port (memory adapter shipped; file/DB adapters are the app's, per ADR-0008).
7. **Env profiles are read-only and not persisted**, so a rotated environment key is always
   current and no env secret is copied into a database. `seed` is the one-time, editable variant.
8. **Errors reuse `EH_CONFIG_INVALID`** with `details.reason` instead of new codes.

## Consequences

+ Both apps can drop their provider and catalog code; adding a provider is a definition.
+ Secrets stay server-side by construction; the browser sees `{ set, hint }`.
− The library cannot encrypt: the `ProfileStore` adapter must (documented).
− Zod v4 schemas are required for this module (`zod/v4`).
− Two gateway profiles resolving the same id string share one catalog mapping (use `createGateway`).
