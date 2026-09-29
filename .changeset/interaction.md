---
"eharness": patch
---

Interaction: `respond()` answers tool approvals and client tool calls against the server-owned
pending state (all-or-nothing, `unknown-id` / `incomplete` / `stale` run errors, consumed in the
commit-point state write so replays never execute anything) and continues the same assistant
message; session approval grants (`remember: 'session'`, `clearGrants()`, `W_GRANT_IGNORED`) and a
fail-closed approval policy; `approval.onNewInput` (`deny` / `reject` → `EH_PENDING_RESPONSE`);
`regenerate()` and `edit()` with `eh.rewind` markers (hidden messages excluded from projection,
compaction and `messages()`, `not-found` / `beyond-compaction`); `send(…, { ifBusy: 'steer' })`
delivered as `data-eh.input` at the next step boundary and `ifBusy: 'queue'`; `inject()` with
`deliver: 'next-step'` (`deliveredIn`) and `wake`; the `useChat` adapter `handleChatRequest()`.
Client tool outputs pass through `tool.after` and output limits. Run errors carry
`error.details` in `run.result`. Fixes automatically approved tools being executed twice.
`EH_NOT_IMPLEMENTED` is removed from the error codes.
