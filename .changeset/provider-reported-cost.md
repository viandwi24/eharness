---
'eharness': minor
---

Use the cost a provider reports: the settled cost of a step (budget ledger, `usage.costUsd`, `model.call` events) is the provider-billed cost when `providerMetadata` carries one (`openrouter.usage.cost`, gateway `cost`), else the catalog estimate. `model.call` events gain `costSource` and `upstreamProvider`. The OpenRouter provider enables usage accounting and gains optional routing settings (`providerOrder`, `allowFallbacks`, `stickyProvider`). New exports: `providerReportedCost`, `settledCostOf`, `CostSource`. `scriptedModel` steps accept `providerMetadata`.
