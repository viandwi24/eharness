# The filesystem plugin

`filesystem()` from `eharness/filesystem` gives the model file tools over a `FileSystem` adapter
you choose: an in-memory map, a database table, object storage, a per-project folder. It is the
reference plugin — written only with the public API — and also provides skills autoload and the
store for evicted tool outputs. Contract: spec 08. Runnable:
[`examples/basic-cli.ts`](../../examples/basic-cli.ts) and
[`examples/custom-fs-adapter.ts`](../../examples/custom-fs-adapter.ts).

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  plugins: [
    filesystem({
      fs: memoryFs({ '/README.md': '# Notes\n' }), // or (ctx) => fsFor(ctx.runtime.projectId)
      readonlyPrefixes: ['/templates/'],
      hiddenPrefixes: ['/secrets/'],
      allowedExtensions: ['.md', '.txt'], // writes only; default any
      isUndeletable: (path) => path === '/README.md',
      maxReadChars: 50_000, // default (DEFAULT_MAX_READ_CHARS)
      tools: ['list_files', 'read_file', 'edit_file', 'grep'], // default: all six
      skills: { root: '/skills', refresh: 'turn' }, // SKILL.md folders → skill tools
      toolOutputs: { dir: '/.eharness/tool-outputs' }, // default; false disables the service
    }),
  ],
})
```

`fs` may be a resolver `(ctx) => FileSystem`, called once per session at session open — one file
tree per user, project or session.

## Tools

| Tool | Input | Does |
|---|---|---|
| `list_files` | `{ prefix? }` | paths and sizes (hidden prefixes excluded) |
| `read_file` | `{ path, offset?, limit? }` | line-numbered window (up to 2000 lines, `maxReadChars`), with a "continue with offset=…" hint |
| `write_file` | `{ path, content }` | create, or overwrite a file read before |
| `edit_file` | `{ path, old_string, new_string, replace_all? }` | smart replace in a file read before |
| `delete_file` | `{ path }` | delete a file read before (not `isUndeletable` ones) |
| `grep` | `{ pattern, prefix? }` | JavaScript regex per line, at most 50 hits |

The rules that make them safe for a model:

- **Read before you change.** Overwriting, editing or deleting needs a prior `read_file` in the
  session (creating a new file does not). `lastRead` lives in plugin state, so it survives restarts
  with a persistent `StateAdapter`.
- **Stale reads are caught.** When the file changed since the model read it, the tool answers
  `STALE:` with the current content, so the model can reapply its change at once.
- **Concurrent writes are caught.** Writes are conditional on the version read (`ifVersion`); a
  lost race answers `CONFLICT:`.
- **Smart replace.** `edit_file` tries an exact match, then a line-trimmed match, then a
  whitespace-normalized match; an ambiguous match is an error, never a guess.
- **Errors are text.** Results start with `ERROR:`, `STALE:`, `CONFLICT:` or `REJECTED:` (policy).
  `classifyToolResult(text)` → `'ok' | 'error' | 'stale' | 'conflict' | 'rejected'` lets a UI
  colour them.

## UI data and services

Every change writes a persistent `data-filesystem.change` part
`{ path, action: 'create' | 'write' | 'edit' | 'delete', version, bytes? }` (id = path, so a
message shows the latest change per file). The plugin provides two services other plugins and
tools can use:

```ts
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { z } from 'zod/v4'

defineHarnessAgent({
  model,
  plugins: [filesystem({ fs: memoryFs() })],
  tools: {
    export_notes: (ctx) =>
      tool({
        inputSchema: z.object({}),
        execute: async () => {
          const files = await ctx.services.fs.list('/notes/') // typed: FileSystem
          return files.map((f) => f.path).join('\n')
        },
      }),
  },
})
```

- `ctx.services.fs` — the session's `FileSystem` (bypasses the tool policies; you are the app).
- `ctx.services.toolOutputs` — where `toolOutput.strategy: 'evict'` stores oversized tool results
  ([tools and MCP](tools-and-mcp.md#tool-output-limits)). With `toolOutputs: false` it is not
  provided: accessing it throws `EH_SERVICE_MISSING` (declare `requires: ['toolOutputs']` to get a
  boot error instead).

## Skills from files

With `skills: { root }`, every `<root>/<name>/SKILL.md` becomes a skill, and the skills root is
hidden from the file tools (`hideSkillsRoot`, default `true`) so the model uses the skill tools
instead. Without the plugin, `fsSkillSource(fs, { root, refresh })` is the same skill source on its
own. See [skills](skills.md).

## Your own adapter

A `FileSystem` has four required methods — `read`, `write` (with `ifVersion`), `delete`, `list` —
and optional `stat` and `grep` fast paths. Paths are normalized absolute paths (`normalizePath`),
and `version` must change exactly when the content changes (`contentVersion(content)` is the
SHA-1 hex the memory adapter uses). Prove it with the conformance suite:

```ts
import { test } from 'bun:test'
import type { FileSystem } from 'eharness/filesystem'
import { fileSystemConformance } from 'eharness/testing'

declare function myFs(): FileSystem // your adapter over Redis, S3, a SQL table, …

for (const c of fileSystemConformance(() => myFs(), { requireStat: true })) test(c.name, c.run)
```

[`examples/custom-fs-adapter.ts`](../../examples/custom-fs-adapter.ts) implements one over a
key-value store in about 100 lines.
