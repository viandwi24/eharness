---
"eharness": minor
---

`eharness/http` hooks learned from migrating the team example: `chat.validate` (runs after the body was sanitised; may deny or return a normalised `{ body }`), `attention.decorate` (adds `item.extra` to `GET /attention`, `null` hides an item; new wire type `AttentionItemWire`), `attention.parseAnswer` now receives `defaultParse()` and may return `undefined` to fall back to the whitelist (`maxNoteChars`, `allowRemember`), `attention.agentId` may be a function of the session id, and `attention.onSettled` runs when the continuation of a `resumed` answer ends. A turn running on another instance is now a `409 EH_SESSION_BUSY` for a send with `ifBusy=reject`, respond, regenerate and edit.

Core fix: a run that waits before it starts (queued, `ifBusy: 'wait'`, or held behind an inbox drain) now carries the `accepted` of the turn it becomes, so `run.toHttpResponse()` answers `409` for a lock held by another instance instead of a `200` stream with an in-stream `EH_SESSION_BUSY` error (spec 04 §7.1, ADR-0059).
