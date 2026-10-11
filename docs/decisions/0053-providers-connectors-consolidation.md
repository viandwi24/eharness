# ADR-0053: One config layer for providers and connectors

Status: **Accepted**

## Context

Providers (spec 23) and connectors (spec 24) share profiles, forms, redaction and the vault, but
the team example still carried duplicates: a second secret box with its own format, two feed
pollers, two error mappings, a tool-prefix workaround and two UI vocabularies for test results,
status badges and read-only environment profiles.

## Decision

- ONE sealing format: `SecretVault` (`webCryptoVault`) behind ONE `sealedProfileStore` for every
  secret-bearing kind. Apps migrating from their own box use `withLegacyVault` and `reseal()`.
- `sealedProfileStore({ onUnreadable })` lets one lost-key row be skipped without hiding the rest.
- `ConnectorDefinition.toolPrefix: 'always' | 'multiple' | 'never'` replaces app-side renaming of
  rules for remote MCP tools.
- `clientConfig(definitionId, flow)` receives the asking flow. A flow step that collects the OAuth
  app was NOT added: the admin credential is a workspace setting shared by every connection of the
  connector, so a per-flow copy would drift; apps keep it as a saved credential.
- Cross-instance invalidation is an app concern (the library has no feed): one poller of the
  event feed with a handler per event type (team example `change-feed.ts`). Event names stay.
- Providers and connectors stay two areas in the UI (Settings > Providers, Connectors); they
  share components (status badge, test button/result, env notice, config card).

## Consequences

Legacy `v1:` rows keep opening and are re-sealed at boot; rotation keeps working with the same
key variables. No new runtime dependency.
