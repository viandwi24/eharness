---
"eharness": minor
---

`cache.include` (spec 02 §6.1): an opt-in predicate that also sends the Anthropic prompt-cache markers to models whose provider id is not `anthropic`, for Anthropic models reached through a provider that forwards `providerOptions.anthropic.cacheControl` (for example a router with `anthropic/…` model ids). Use it with `mode: 'breakpoints'`. It only adds models; a predicate that throws counts as false. Without it nothing changes.
