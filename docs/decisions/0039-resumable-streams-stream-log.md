# ADR-0039: Resumable streams via a stream log port

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0003](0003-uimessage-storage-form.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0034](0034-deployment-profiles.md)

## Context

`session.attach()` replays an in-memory, per-process turn buffer (spec 04 §6). In a split
deployment (several server instances, profile c of ADR-0034) a client that reloads and lands on
another instance sees nothing until the turn ends: the stored messages are written at step
boundaries and the end only. AI SDK `useChat({ resume: true })` expects a `GET` route that answers
`204` when no stream is active and the SSE stream otherwise. Research (OpenAI background mode
`sequence_number`, LangGraph `lastEventId`, LibreChat Redis Streams, AI SDK `resumable-stream`,
Cloudflare Agents) shows two families: a **cursor log** that survives the producer, and pub/sub
with replay by the producer (`resumable-stream`), which does not survive it and has no cursor.

## Decision

1. **A core port `StreamLogAdapter`** (`storage.streams`, also per session): an append-only log of
   JSON chunks per `{ sessionId, turnId }` — `append(key, chunks, { at? })` (idempotent by length),
   `close(key, status)`, `read(key, from, { limit? })` with `status`, optional `subscribe` and
   `expire`. The cursor is the 0-based chunk index inside the turn. Chunk order stays public API:
   the log stores exactly the chunks of the turn buffer.
2. **The turn owner is the only writer.** After the commit point (spec 05 §3, unchanged: nothing
   is written for a turn that never committed) a batched background drainer appends clones of the
   buffer's chunks every `streams.flushMs` (100), at most `streams.batchSize` (64) per call; at the
   end it flushes, `close`s (`done` / `error` / `aborted`) and calls `expire(key, retentionMs)`.
   Adapter failures are `W_STREAM_LOG_FAILED` warnings, once per turn and operation; a log that
   could not be completed is never closed. They never fail or slow the turn.
3. **Readers**: `session.attachRemote({ from, signal })` replays from `from` and follows (via
   `subscribe`, else polling every `streams.pollMs`, 500) until the log closes. A turn of this
   process is still served from the turn buffer. It resolves `undefined` when nothing is active
   in the stored state, no log is configured, or the log is missing/expired: the client falls back
   to the stored messages. A reader that disconnects never aborts the turn (stop stays
   `requestAbort`). A log whose turn is no longer active in the state and that does not close
   within 5 s (crashed owner) ends the stream without a terminal chunk.
4. **`handleResumeRequest(session, request, opts)`** next to `handleChatRequest`: `204` when no
   active stream, else the UI message stream (`createUIMessageStreamResponse`). The cursor comes
   from `?from=` or `Last-Event-ID`; AI SDK's SSE helpers do not write event ids, so clients that
   track a position send it with `prepareReconnectToStreamRequest`. Authorization is the
   application's, as for the chat route.
5. **The shipped adapter is in-memory** (`memoryStreamLog()`); durable ones (SQLite, Redis
   Streams, a table) are application code, validated by `streamLogConformance` (`eharness/testing`).

## Consequences

- Committed messages remain the truth; the log is short-lived (default retention 10 minutes after
  close). A client that finds no log uses the stored messages.
- A `respond()` continuation has its own turn id and log; it holds only the continuation chunks.
- Extra cost without a configured adapter: none. With one: one append per flush interval.
- A remote `HarnessRun.result` carries only `turnId`, `kind` and `stop` (from the stream's
  metadata); `messages`, `usage` and `steps` are empty.
- Not chosen: pub/sub with producer replay (no cursor, dies with the producer); writing chunks
  synchronously (adds latency to every token); a side table in `MessageAdapter` (ADR-0008, kind
  messages and storage stay free of transport data).
