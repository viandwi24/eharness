---
"eharness": patch
---

Filesystem plugin (`eharness/filesystem`, `eharness/filesystem/memory`): the `FileSystem` adapter
contract with `normalizePath` and `contentVersion`, the in-memory `memoryFs()` adapter, and the
`filesystem()` plugin providing the typed `fs` and `toolOutputs` services, the file tools
`list_files`, `read_file` (line-numbered windows with `offset`/`limit`), `write_file`, `edit_file`
(smart replace: exact, line-trimmed, whitespace-normalized; ambiguity rejected), `delete_file` and
`grep`, with read-before-edit, `STALE:` results carrying the current content, optimistic locking
(`CONFLICT:`), read-only/hidden prefixes, allowed extensions and undeletable files
(`REJECTED:`), `lastRead` in plugin state, the `data-filesystem.change` part, a per-session `fs`
resolver, and skills autoload through `fsSkillSource` (hidden skills root by default).
`classifyToolResult` classifies tool results for UIs. `eharness/testing` adds
`fileSystemConformance` for custom adapters. The `experimental_placeholder` exports of both
filesystem entry points are removed.
