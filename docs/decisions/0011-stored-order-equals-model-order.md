# ADR-0011: Stored order equals model order (inline input parts)

Status: **Accepted** · Date: 2026-09-29

## Context

Harnesses let users (and background events) talk to the agent while it works: Claude Code queues
messages and injects them between tool calls, opencode and Codex support steering. The naive
implementations store the steer as a new user message *after* the assistant message. On reload,
projection then shows the model a different conversation than the one it actually saw (the steer
moves from the middle of the tool loop to the end), which changes behaviour after compaction,
regenerate or a crash, and breaks prompt-cache prefixes.

## Decision

Everything the model saw is stored where it saw it. Input delivered inside a running turn is a
persistent core part `data-eh.input { source, text, files?, clientId? }` written into the running
assistant message at the step boundary. Projection splits the assistant message at each such part
into `assistant(before) → user(input) → assistant(after)`. The same rule covers `next-step`
injections and hook-provided context (`source: 'event' | 'plugin:<name>'`). History is
append-only; regenerate/edit hide ranges with `eh.rewind` markers instead of deleting.

## Consequences

+ Reloads, compaction and recovery project exactly the conversation the model saw.
+ One assistant message per turn is kept (UI and `useChat` stay simple).
− Projection has one more step (split at `data-eh.input`), covered by round-trip tests.
− UIs must render `data-eh.input` parts inside the assistant message (the stock `useChat` UI shows
  them as data parts; a renderer is a few lines).

## Alternatives considered

- Store steers as separate user messages with a `deliveredIn` pointer and reorder at projection
  (rejected: two sources of truth for order; breaks id-ordered loading).
- Only allow input between turns (rejected: long-running agents need steering).
