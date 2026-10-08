---
"eharness": minor
---

Session APIs for interactive harnesses (approval notes, `endTurn`, steer outcome, pending client tool input, `step.prepare` `continuing`).

- **Approval notes.** `respond({ approvals: [{ id, approved, note }] })` (max 4 000 characters, else `EH_INVALID_INPUT`). An approved call's note is read by the model on the first step of the continuation, right after the tool result, as `<user-note tool="…" call="…">…</user-note>` (tags neutralised), and stored as a `data-eh.input` part (`approvalNote: { toolCallId, toolName, text }` is a new optional field of `InputPartData`) at the position the model saw it, so a reload projects the same conversation. A note on a denial is appended to its `reason`. Server side only: `handleChatRequest` reads no note (AI SDK's UI approval object has none).
- **`respond(…, { endTurn: 'after-answers' | 'if-denied' })`.** Records the answers and runs the approved tools without calling the model. The turn stops `'complete'` with `steps: 0` and no usage (no new stop reason); the next `send()` continues normally. `'if-denied'` ends only when an approval was denied.
- **`PendingState.clientTools[].input`** (+ `inputTruncated: true` when the JSON is above 16 KB, then `input` is omitted). The pending state stays `v: 2` (additive optional fields). Existing assertions that compare `clientTools` entries with `toEqual` now see `input`.
- **`run.delivery`** on `send(input, { ifBusy: 'steer' })`: `Promise<'step' | 'turn' | 'dropped'>` (new type `SteerDelivery`). **Behaviour change:** when the running turn refuses a steer at once (its step loop ended, a manual `compact()` runs), the returned run is now the queued turn's run instead of an `attach()` of the running turn.
- **`StepPrepareEvent.continuing?: { approved: string[]; denied: string[] }`** on step 0 of a `respond()` continuation (final tool names, each once).
