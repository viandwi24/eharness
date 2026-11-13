---
"eharness": minor
---

`webSearch()` now passes the plugin's session context to the app's `search` function as `options.ctx` (`SearchOptions.ctx`, spec 22 §3), like `webFetch` already does for its `allow`/`deny` functions. A search function that makes its own paid or audited call can attribute, limit or key it per person or tenant (`ctx.principal`, `ctx.session.id`, `ctx.runtime`). Existing search functions are unaffected.
