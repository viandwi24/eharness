---
"eharness": patch
---

Fix: an approved call of a tool without `execute` (a request-scoped client tool, or a client tool
registered on the server) now parks as a client call instead of ending `complete` with an
`Interrupted:` error. The approving `respond()` / `handleChatRequest` stops `'tool-pending'` with
the call in `pending.clientTools` (with `waitId` / `timeoutAt` / `onTimeout` when `timeoutMs` is
set) and no model step; the client's output streams into the same message. Approved server calls
of the same batch wait until the client answered. Denials are unchanged.

Request-scoped client tools hardening: `__proto__`, `constructor` and `prototype` are rejected as
names and the per-turn tool record has no prototype; escaped page context descriptions count
toward `pageContext.maxChars`; a schema property named `$ref` is no longer rejected, `$dynamicRef`
and `$recursiveRef` are; descriptions are cut without splitting surrogate pairs.
