---
"eharness": minor
---

New `model.call` plugin hook (observe-only) that fires after every model call of a session — turn steps, the compaction summarizer, the pre-compaction flush and calls routed through the new `ctx.observeModel()` — with the call options, the raw request body, response headers, the assembled output, usage, cost, finish reason and timings (`ModelCallEvent`). Implemented with an AI SDK language model middleware; nothing is wrapped when no plugin listens. New public helper `observeModel(model, report)`, `modelClassifier({ onModelCall })`, and `scriptedModel` steps accept `requestBody` / `responseHeaders`. See ADR-0047 and spec 12 §7.
