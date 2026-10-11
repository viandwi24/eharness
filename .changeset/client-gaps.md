---
"eharness": minor
---

`eharness/client` gaps found by the team web: `createAttentionList` is generic over the item (`AttentionList<Item, Answer>`) and takes a `list` source (an app's enriched view instead of `GET /attention`) and `events` (the activity types that refetch; `ATTENTION_EVENTS` is the default, apps extend it). `AnswerRequest` / `attention.answer` accept app-defined answer kinds (`parseAnswer`) without casts. `headers` may be a function returning a record with `undefined` values (dropped). Every JSON call takes `init` (`cache`, `keepalive`, ...); `health()` is always `cache: 'no-store'`. New `followSessionStream(client, sessionId, { signal, onMessage, onChunk, onError })`: a read-only follower of the active turn of a session this tab did not start, built on the AI SDK transport and `readUIMessageStream`. See spec 27.
