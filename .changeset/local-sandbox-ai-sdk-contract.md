---
"eharness": minor
---

`localSandbox` follows the newer AI SDK sandbox contract (`ai@7.0.15x`, `@ai-sdk/provider-utils` 5.0.76): it implements `stat`, `listDirectory` and `deleteFile` (same root and symlink guard as the other file operations; the root itself is a valid target), and `spawn` rejects `stdin: true` with `EH_INVALID_INPUT` before it starts the command. The sandbox type-checks against both the old and the new `ai` types again (the `ai@latest` peer check was failing on it).
