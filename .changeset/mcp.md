---
"eharness": minor
---

**BREAKING:** `mcpServer` frames tool results as untrusted content by default.

The text parts of every MCP tool result (including tools without `toModelOutput`, where a string output is framed as text) reach the model inside `<untrusted-content source="mcp" name="<server>/<tool>">…</untrusted-content>`. Images, structured JSON output and `isError` are unchanged, and the UI keeps the raw result. Migration: add `UNTRUSTED_CONTENT_INSTRUCTIONS` to your `instructions` so the model knows what the frame means; pass `mcpServer({ wrapUntrusted: false })` to keep the old output, and update golden prompts that contain MCP results.
