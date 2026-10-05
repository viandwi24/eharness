---
"eharness": patch
---

Hardening fixes from the 0.3.1 audit (no action needed; behaviour and type changes are listed in the separate minor changeset).

- A cold session loads its state and messages exactly once, even when `stats()`, `inject()` and `send()` race; plugin state set in `session.start` and the user message are never lost.
- `inject(…, { deliver: 'next-step' })` during turn preparation is delivered once at step 0 and reloads identically.
- A steer that arrives during the last budgeted step is no longer swallowed by the max-steps wrap-up step; it becomes a queued turn.
- `messages({ limit })` keeps paging past messages hidden by `regenerate()` / `edit()`, honours rewinds on cold instances, and never loops on an adapter that ignores `beforeId`.
- `agent.session(id)` while the previous instance of that id is closing waits for the close (no false `EH_TURN_INTERRUPTED`, one writer); `agent.close()` also waits for such closing instances.
- A turn that fails before its commit point reverts only the state its own hooks changed; `clearGrants()` and other plugins' `ctx.state` changes made meanwhile are kept. A failed commit-point state write never leaves a phantom `activeTurn` for a later write; a CAS conflict reloads the other instance's state instead of overwriting it.
- Message ids no longer drift ahead of the clock when many ids are generated in one millisecond.
- The default warning handler's dedupe set is bounded (1 000 keys).
- The guard shrinks JSON-escape-heavy tool outputs instead of failing with `EH_CONTEXT_OVERFLOW`; head + tail truncation never splits an emoji (surrogate pair).
- `describeError` passes on the provider's message only for AI SDK `APICallError` / `StreamProviderError`, with URLs, query strings and key-like tokens redacted and the text capped at 300 characters; other errors with a status read `HTTP <status>`.
- An unknown status returned by an approval policy or `tool.approve` hook (e.g. a typo) now denies the call (fail closed).
- `todos()`: the list survives a restart followed by a compaction; a `todo_write` denied by approval no longer changes the list.
- Skills: `name: 007` / `description: 1.0` keep their raw text.
- New, additive: `toolErrorText` agent option maps thrown tool errors (default `String(error)`, which may carry connection strings or tokens) — identically in the UI, storage and the model wire; `handleChatRequest(session, body, { actor })` passes the actor to `approval.decided`; exports `ChatRequestOptions`, `InputFilesConfig`, `ToolErrorTextFn`, `FILE_UNAVAILABLE`.
- devDependencies `ai@7.0.127`, `@ai-sdk/mcp@2.0.66`; peer floors unchanged (`ai@^7.0.123`, `@ai-sdk/mcp@^2.0.63`).
