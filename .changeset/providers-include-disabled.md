---
"eharness": patch
---

`ProviderManager.models(id, { includeDisabled: true })` also lists the models a profile's `allow` / `deny` hides, each entry marked `enabled`, so a UI can offer per-model switches. See spec 23 §3.
