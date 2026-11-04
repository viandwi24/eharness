---
"eharness": minor
---

`openRouterProvider` has a new advanced setting, `ignoreProviders`: comma-separated upstream provider slugs that OpenRouter never routes to (`provider.ignore`). An excluded slug is dropped from `providerOrder` and is never put first by `stickyProvider`. Use it for an upstream that keeps failing, for example `morph`.
