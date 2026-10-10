---
"eharness": minor
---

**BREAKING:** message projection escapes and neutralises framing in kind messages; new framing helper.

- **BREAKING (model-visible):** the projections of `eh.event` and `eh.compaction` escape attribute values (the event `name`) and neutralise `event`, `system-reminder` and `untrusted-content` tags (plus `conversation-summary` in summaries) inside their text, so stored content cannot close or forge a frame. Text without such tags projects exactly as before; assertions on raw projected text with tags need an update.
- New core helper `untrustedContent(text, { source, url?, name? })` (Draft) wraps outside text in `<untrusted-content source="…">…</untrusted-content>` with frame and `system-reminder` tags neutralised and attributes escaped; `UNTRUSTED_CONTENT_INSTRUCTIONS` is a recommended system-prompt sentence. New types: `UntrustedContentOptions`.
- **BREAKING (stored shape):** tool parts in state `output-error` that carry the deprecated `rawInput` field (set by AI SDK's UI stream when a tool call's input fails to parse) are normalised to `input` before persisting, validating on load and projecting to the model, so AI SDK's `rawInput` deprecation warning is no longer logged.
- The reasoning duration key `providerMetadata.eharness` is removed from reasoning parts on the provider wire.
