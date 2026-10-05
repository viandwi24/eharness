---
"eharness": patch
---

Hardening fixes from the 0.3.1 audit.

**Sessions and turns**

- A cold session loads its state and messages exactly once, even when `stats()`, `inject()` and `send()` race; plugin state set in `session.start` and the user message are never lost.
- `inject(…, { deliver: 'next-step' })` during turn preparation is delivered once at step 0 and reloads identically.
- **Behaviour change:** the turn stream (`run.stream`, `attach()`, `toResponse()`) now ends only after the turn is persisted and the session is free. A client that saw `finish` can `send()` at once — no more `EH_SESSION_BUSY` from its own previous turn.
- New `SendOptions.ifBusy: 'wait'` for `send()` and `respond()`: wait for the running turn and the queue, then run (honours `abortSignal`; a waiting `send()` never denies approvals created by the turn it waited for). New `session.idle()` resolves when no turn runs and nothing is queued.
- **Behaviour change:** `handleChatRequest` no longer throws `EH_SESSION_BUSY`; it returns a failed run (`error.code: 'EH_SESSION_BUSY'`) whose `toResponse()` / `pipeTo()` answer **409** with `{ error: { code, message } }`. New `handleChatRequest(session, body, { actor })`: the actor reaches `approval.decided` for every approval answer.
- A steer that arrives during the last budgeted step is no longer swallowed by the max-steps wrap-up step; it becomes a queued turn.
- `messages({ limit })` keeps paging past messages hidden by `regenerate()` / `edit()` and honours rewinds on cold instances.
- `agent.session(id)` while the previous instance of that id is closing waits for the close (no false `EH_TURN_INTERRUPTED`, one writer).
- A turn that fails before its commit point reverts only the state its own hooks changed; `clearGrants()` and other plugins' `ctx.state` changes made meanwhile are kept.
- Message ids no longer drift ahead of the clock when many ids are generated in one millisecond.
- The default warning handler's dedupe set is bounded (1 000 keys).

**Compaction and cost**

- **Behaviour change:** summarizer usage now counts toward `TurnResult.usage`, `costUsd`, `state.core.usage` and budgets (manual `compact()` charges the session). A used-up budget skips compaction (`W_BUDGET` with `details.compaction: true`); a compaction that uses up the budget stops the turn with `'cost-cap'`.
- The guard shrinks JSON-escape-heavy tool outputs instead of failing with `EH_CONTEXT_OVERFLOW`; head + tail truncation never splits an emoji (surrogate pair).

**Security**

- New `toolErrorText` agent option maps thrown tool errors (default `String(error)`, which may carry connection strings or tokens) — identically in the UI, storage and the model wire.
- `describeError` passes on the provider's message only for AI SDK `APICallError` / `StreamProviderError`, with URLs, query strings and key-like tokens redacted and the text capped at 300 characters; other errors with a status read `HTTP <status>`.
- **Behaviour change:** new `inputFiles` agent option: file URLs of user input outside `['data:', 'https:']` and `data:` URLs over 20 MB are `EH_INVALID_INPUT` (opt in to `http:` with `inputFiles.protocols`).
- An unknown status returned by an approval policy or `tool.approve` hook (e.g. a typo) now denies the call (fail closed).

**Configuration and DX**

- **Behaviour change:** out-of-range numeric options (`loop.maxSteps: 0`, `compaction.summarizeAt` outside (0, 1), negative budgets, …) throw `EH_CONFIG_INVALID` at `defineHarnessAgent` instead of misbehaving silently.
- **Behaviour change:** `messageAdapterConformance` is stricter (an upsert must replace, not merge; `fromId` between stored ids; `beforeId` without `limit`). Third-party adapters may now fail it — they were wrong before.
- `todos()`: the list survives a restart followed by a compaction; a `todo_write` denied by approval no longer changes the list.
- Skills: `name: 007` / `description: 1.0` keep their raw text.
- Type-level: `SendOptions.ifBusy` gains `'wait'` (exhaustive switches must add it); `HarnessSession` gains `idle()` (custom implementations and mocks must add it); `compaction.prompt` hooks receive the messages being summarized as `out.messages`; new exports `ChatRequestOptions`, `InputFilesConfig`, `ToolErrorTextFn`, `FILE_UNAVAILABLE`.
- devDependencies `ai@7.0.127`, `@ai-sdk/mcp@2.0.66`; peer floors unchanged (`ai@^7.0.123`, `@ai-sdk/mcp@^2.0.63`).
