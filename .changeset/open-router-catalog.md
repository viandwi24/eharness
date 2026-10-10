---
"eharness": minor
---

`openRouterCatalog(data)` converts the OpenRouter model list (`GET /api/v1/models`) into a `models` catalog (context windows, max output, prices per 1M tokens), next to `modelsDevCatalog`. Pure: the application fetches and caches the list. See spec 12 §1.
