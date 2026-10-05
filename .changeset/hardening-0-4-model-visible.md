---
"eharness": minor
---

Behaviour, type-level and model-visible changes of the 0.4.0 hardening — check these when upgrading.

**Behaviour**

- The turn stream (`run.stream`, `attach()`, `toResponse()`) ends only after the turn is persisted and the session is free: a client that saw `finish` can `send()` without hitting `EH_SESSION_BUSY` from that turn. New `SendOptions.ifBusy: 'wait'` (`send()` and `respond()`: wait for the running turn and the queue, FIFO, honours `abortSignal`) and `session.idle()`.
- `handleChatRequest` no longer throws `EH_SESSION_BUSY`: it returns a failed run (`error.code: 'EH_SESSION_BUSY'`) whose `toResponse()` / `pipeTo()` answer **409** with `{ error: { code, message } }`. Routes that caught the exception should handle the 409 (or pass `{ ifBusy: 'wait' }`).
- New `inputFiles` agent option: file URLs of user input outside `['data:', 'https:']` (e.g. `http:`) and `data:` URLs over 20 MB are now `EH_INVALID_INPUT`. Opt in with `inputFiles: { protocols: ['data:', 'https:', 'http:'] }`.
- Out-of-range numeric options (`loop.maxSteps: 0`, `compaction.summarizeAt` outside (0, 1), negative budgets, …) now throw `EH_CONFIG_INVALID` at `defineHarnessAgent`.
- Summarizer usage now counts toward `TurnResult.usage`, `costUsd`, `state.core.usage` and budgets (manual `compact()` charges the session). A used-up budget skips compaction (`W_BUDGET`, `details.compaction: true`); a compaction that uses up the budget stops the turn with `'cost-cap'`.
- `messageAdapterConformance` is stricter (an upsert must replace, not merge; `fromId` between stored ids; `beforeId` without `limit`). Third-party adapters may now fail it — they were wrong before.
- Chunk order: the transient `data-eh.status { state: 'tool' }` chunk may now arrive before the step's `start-step` (AI SDK ≥ 7.0.124 internals); it never changes the message.

**Types**

- `HarnessSession` gains `idle()` (custom implementations and mocks must add it); `SendOptions.ifBusy` gains `'wait'` (exhaustive switches must add it); `compaction.prompt` hooks receive the messages being summarized as `out.messages`.

**Model-visible**

- `read_file` (`eharness/filesystem`) gains the input `charOffset`. A line longer than the window ends with `(Line <n> continues; use offset=<n> charOffset=<c>.)`, so very long lines (minified code, evicted single-line JSON outputs) are fully readable.
- `grep` accepts only a conservative safe subset of regular expressions: at most one variable-width quantifier in the whole pattern (`*`, `+`, `?`, lazy variants, `{n,}`, `{n,m}` with m > n; a fixed `{n}` is fine), no quantified groups (`(…)` / `(?:…)` followed by any quantifier), no backreferences or lookarounds, at most 512 characters. `foo|bar`, `import .* from`, `^\s*export`, `a.{0,90}b` work; `.*foo.*bar`, `(\d+\.)+\d+`, `(ab){3}` are refused with `ERROR: invalid pattern: …` (search for a literal, or split into simpler searches). Only the first 2 000 characters of a line are matched; a line cut at 300 characters ends with ` (match at charOffset=<c>)`. Adapters that push `grep` down should apply the same rule or use a linear-time engine (RE2).
- A file of an earlier turn whose URL can no longer be downloaded (e.g. an expired link) is replaced on the wire by the new fixed text `FILE_UNAVAILABLE` (`[file unavailable: <mediaType> <filename>]`) and the step is retried, instead of failing every later turn.
- A compaction summary cut at `maxSummaryTokens` (`finishReason: 'length'`) is a compaction failure (`W_COMPACTION_FAILED` / `EH_COMPACTION_FAILED`, `details.reason: 'length'`).
