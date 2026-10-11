---
"eharness": minor
---

**BREAKING:** `eharness/http` `authorize` now fails closed. A result that is not a `Response`, a `{ deny }` or an object (`undefined`, `null`, a string, an array) is answered with `401 EH_HTTP_UNAUTHORIZED` instead of running the route with an empty principal, so `authorize: ({ request }) => userOf(request)` denies anonymous callers. Migration: return an object principal for allowed callers; use `openAccess` for local development.
