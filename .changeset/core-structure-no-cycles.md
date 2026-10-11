---
'eharness': minor
---

Internal restructuring of the core with no behaviour change: the runtime import cycles between core
folders are gone (hook running, token estimates, text truncation and model call observation moved
to the layer that owns them, and `bun run check:imports` now fails on a new cycle), the turn
lifecycle, the session handle and the step loop are split into phase functions over one explicit
state object, and the shared `errorText(error)` and `isRecord(value)` helpers are exported for
plugins and subpath modules.
