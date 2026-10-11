---
"eharness": minor
---

Attachments in practice. `subagent({ files: { resolve } })` adds an optional `files` argument to the `agent` tool: the references the model passes (paths or library refs) become file parts of the child's first user message, with readable `ERROR:` strings for a missing, oversize or unsupported file. `inputFiles.describe` adds a text note after each referenced file of a user message at projection time (for example its path), so the model can pass an attachment on. `ModelInfo.inputModalities` (read by `modelsDevCatalog` and `openRouterCatalog`) lets a turn refuse a new image, PDF, audio or video file the model cannot read before anything is stored, with `EH_INVALID_INPUT` (`details.reason: 'unsupported-modality'`) and a message naming the model and the fix; unknown modalities never block. Spec 05 now documents that a provider failure leaves an empty assistant message next to the `eh.notice` on purpose.
