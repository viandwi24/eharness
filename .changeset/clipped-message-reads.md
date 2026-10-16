---
'eharness': minor
---

eharness/http and eharness/client: `GET /sessions/:id/messages?clip=<chars>` replaces big tool `input`/`output` and data part `data` with a `{ eharnessClipped, chars, preview }` marker (read view only), `GET /sessions/:id/messages/:messageId` returns one full message, and the client gains `sessions.message`, `clip` on `sessions.messages` and `createChatSession`, `session.loadFull(messageId)` and `isClippedPart`.
