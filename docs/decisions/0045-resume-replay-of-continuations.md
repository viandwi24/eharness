# ADR-0045: Resume replays the continued message of a respond() continuation

Status: **Accepted** · Date: 2026-10-10 · Amends: [ADR-0039](0039-resumable-streams-stream-log.md)

## Context

ADR-0039 made the stream log (and the turn buffer) the exact chunks of the turn. A `respond()`
continuation streams into the stored assistant message (`start { messageId: A.id }`, then tool
outputs, then new steps). AI SDK 7's `resumeStream()` expects a full replay: on the first `start`
it resets its message state, so the next `tool-output-available` throws `No tool invocation found
for tool call ID` and the chat stays in error. The team example worked around it in the web client.

## Decision

1. Keep the live stream and the buffer as is (chunk order is public API; the responding client
   already holds A').
2. Give the turn buffer an optional **replay prefix**: for a continuation, `messageToChunks(A')`
   (A' is the patched message the stream opens with). The **replay view** is the prefix followed by
   the raw chunks after the turn's own `start`. `attach()`, `attachRemote()` and the stream log
   drainer use the view, so the log cursor is a position in the view; other turns are unchanged.
3. `messageToChunks()` is implemented once in the library (AI SDK has no UIMessage→chunks helper)
   and exported. It never emits transient parts or `finish`.
4. Cursor: `from` counts view chunks; `from = 0` (what AI SDK sends) is the full replay.

## Consequences

- `useChat({ resume: true })` / `chat.resumeStream()` works for continuations on any instance with
  no client code.
- The prefix is a snapshot at continuation start, so persisted later steps are never duplicated.
- A `from` cursor recorded against a log written by an older version points at raw chunks; logs are
  short-lived (retention), so this is accepted.
- `onRun` listeners keep the raw buffer.
