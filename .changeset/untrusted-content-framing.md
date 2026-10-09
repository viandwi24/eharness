---
"eharness": minor
---

Prompt-injection framing. New core helper `untrustedContent(text, { source, url?, name? })` wraps outside text in `<untrusted-content source="…">…</untrusted-content>` (frame and `system-reminder` tags inside the text are neutralised, attributes escaped) and `UNTRUSTED_CONTENT_INSTRUCTIONS` is a recommended system-prompt sentence. `webFetch` (page content), `webSearch` (findings and sources) and `mcpServer` (text parts of tool results) now frame their output by default; opt out with `wrapUntrusted: false`. Errors, images, structured output and `isError` are unchanged.
