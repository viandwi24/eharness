# ADR-0052: One generic `SecretVault` and `sealedProfileStore` for providers and connectors

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0048](0048-providers-module.md), [ADR-0049](0049-connectors-module.md)

## Decision

1. `SecretVault` (`seal` / `open` with a bound context, optional `keyId` / `needsReseal` for
   rotation) is part of the generic config layer in `eharness/providers`, with `webCryptoVault`
   (AES-256-GCM) and a test-only `plaintextVault`. `eharness/connectors` re-exports them.
2. `sealedProfileStore(store, vault, { kinds?, schemaOf? })` encrypts the settings (or only the
   secret fields) of any profile kind in front of any `ProfileStore`. An app plugs its secret box
   into the port once and uses it for provider profiles, connection settings, OAuth credentials
   and (through the same vault) flow scratch.
3. The library never stores plaintext secrets in a shipped adapter unless the app chose
   `plaintextVault`; databases remain the app's adapters (ADR-0008).

## Consequences

+ No second encryption or redaction path; rotation works through `reseal()`.
− Whole-settings sealing hides the shape from the database (no queries on settings fields); use
  `schemaOf` when non-secret fields must stay queryable.

## Amendment note (2026-10-11)

Update (0.8, P39): `withLegacyVault` and `LegacyOpener` moved from `eharness/providers` to `examples/team`; the library keeps one sealing format.
