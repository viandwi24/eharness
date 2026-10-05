---
"eharness": minor
---

New subpath `eharness/memory`: the `memory()` plugin gives agents file-based long-term memory on
the `fs` service — six tools (`memory_view`, `memory_create`, `memory_str_replace`,
`memory_insert`, `memory_delete`, `memory_rename`) with the command contract of Anthropic's memory
tool, application-chosen roots resolved per turn (read-only or writable), pinned files in the turn
reminder (prompt-cache safe), size limits, optimistic concurrency and an `onWrite` audit callback.
`executeMemoryCommand()` runs one command directly, and the `tool` option lets the application
supply its own (e.g. provider-defined) memory tool. Exports `MEMORY_PROTOCOL` and `MEMORY_TOOLS`.

`FileSystem` gains an optional atomic `move(from, to, { ifVersion })` (`MoveResult`); `memoryFs`
implements it and `fileSystemConformance` checks it (`requireMove`).

Model-visible: six new tool names when the plugin is used.
