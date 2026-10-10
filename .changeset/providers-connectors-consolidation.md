---
"eharness": minor
---

Providers and connectors consolidation. `withLegacyVault(vault, legacy)` reads an older sealing format and writes the current one; `sealedProfileStore({ onUnreadable })` skips rows that cannot be opened (also in `reseal()`); `ConnectorDefinition.toolPrefix` (`'always' | 'multiple' | 'never'`, also on `remoteMcpConnector`) controls the connection-slug tool prefix; `clientConfig(definitionId, flow)` receives the asking flow (`flowId`, `scope`, `scopeId`, `reconnect`). See specs 23 and 24, ADR-0053.
