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
      tools: ['list_files', 'read_file', 'edit_file', 'grep'], // default: all seven
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
| `edit_file` | `{ path, old_string, new_string, replace_all? }` or `{ path, edits }` | smart replace in a file read before; `edits` applies up to 50 replacements in order, all or nothing (`ERROR: edit 3 of 5: …`) |
| `delete_file` | `{ path }` | delete a file read before (not `isUndeletable` ones) |
| `grep` | `{ pattern, prefix? }` | JavaScript regex per line, at most 50 hits |
| `glob` | `{ pattern, path? }` | files by glob (`**`, `*`, `?`, `[abc]`, `{a,b}`), newest first when the adapter has `updatedAt`, at most 200; adapters may add a `glob` fast path |

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
- **Adapter errors are text too.** An exception thrown by the adapter (an oversized file,
  an I/O failure) reaches the model as `ERROR: <message>`; map or rethrow it with
  `filesystem({ onAdapterError: (error, { tool, path }) => string | undefined })`.
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

## Images and binary files

With an adapter that has `readBytes` / `writeBytes` (`memoryFs`, `diskFs`, `mountFs`),
`read_file` on a PNG, JPEG, GIF or WebP shows the image to the model, next to a line like
`Image /shots/a.png (640x480, 18231 bytes, image/png)`. PDFs are off by default (not every
provider takes them): `filesystem({ fs, media: { pdf: true } })`. Other binary files answer
`ERROR: binary file …; it cannot be shown as text.`, `write_file` / `edit_file` refuse them, and
`grep` skips them.

```ts
filesystem({ fs: memoryFs({ '/shots/a.png': pngBytes }), media: { images: true, maxBytes: 2_000_000 } })
```

The stored message keeps only a small reference (`{ type: 'media-ref', path, version, … }`); the
bytes are read again from the file system whenever the history is sent to the model. If the file
changed or was deleted since, the model reads a text note instead of the image. Write binary
files from your app with `fs.writeBytes(path, bytes)`. A custom adapter adds `readBytes`,
`writeBytes` and `FileMeta.binary` and checks them with
`fileSystemConformance(factory, { requireBytes: true })`. See spec 08 §12.

## Real directories: `eharness/filesystem/node`

For an agent that works on files on disk (a CLI, a server with a checkout), `diskFs(root)` is a
ready adapter. It refuses symlink escapes, hides `.git`, `node_modules` and the root `.gitignore`
from listings (a documented subset of the syntax, no nested files), keeps file modes on write,
lists binary files (and shows images to the model), rejects oversized text files with a readable error, and uses ripgrep for `grep` when it is
on `PATH` (JavaScript otherwise). Node-only: the subpath imports `node:` built-ins.

```ts
import { filesystem } from 'eharness/filesystem'
import { diskFs, nodeWorkspace } from 'eharness/filesystem/node'

filesystem({ fs: diskFs(process.cwd(), { ignore: { hidden: ['dist/'] } }) })

// a project plus extra directories and a folder for evicted tool outputs
const ws = await nodeWorkspace({
  root: process.cwd(),
  extraDirs: ['/home/me/shared-lib'], // visible at /@dirs/shared-lib/
  toolOutputsDir: '.agent/tool-outputs', // visible at /.eharness/tool-outputs/
})
filesystem({ fs: ws.fs })
await ws.addDirectory('/home/me/another') // mounted at runtime, visible immediately
ws.toReal('/@dirs/shared-lib/a.ts') // → real path, or null
```

`mountFs(() => [{ virtual: '/', fs }, { virtual: '/docs/', fs: otherFs, readonly: true }])`
composes any adapters by longest prefix. A move across mounts is copy-then-delete, not atomic.

## Undo the agent's edits: checkpoints

`filesystem({ checkpoints: store })` saves what a file held before the first change of each turn.
Later, `rewindFiles` puts the files back:

```ts
import { checkpointsSince, filesystem, rewindFiles } from 'eharness/filesystem'
import { diskFs, nodeCheckpointStore } from 'eharness/filesystem/node'

const fs = diskFs(root)
const store = nodeCheckpointStore('.agent/checkpoints') // JSON files; survives restarts
const agent = defineHarnessAgent({ model, plugins: [filesystem({ fs, checkpoints: store })] })

// "rewind code to just before this message"
const point = userMessage.id // the turn key of a turn with input
const preview = await checkpointsSince({ store, sessionId, fromTurnKey: point, fs })
const { restored, deleted, failed } = await rewindFiles({ fs, store, sessionId, fromTurnKey: point })
```

Only changes made through the file tools (and other writers of the `fs` service) are tracked, not
shell commands or edits made outside the agent. Turns without a user message (`respond`,
`regenerate`, wake) are keyed by the turn id. Rewinding files does not touch the conversation;
combine it with a session fork if you also want that. `memoryCheckpointStore()` is for tests; for
a web app with separate server processes implement the four-method `CheckpointStore` over your
database.

## Project instructions (`CLAUDE.md` / `AGENTS.md`)

`projectInstructions()` loads the repository's instruction files from the `fs` service into the
system prompt. Per directory the first existing file of `['CLAUDE.md', 'AGENTS.md']` wins; if
both exist, `CLAUDE.md` is used and `AGENTS.md` is ignored for that directory. The root file is
inlined once per session (static, cache-friendly); files in subdirectories are only listed so the
model reads them before working there.

```ts
import { filesystem, projectInstructions } from 'eharness/filesystem'

plugins: [
  filesystem({ fs: diskFs('/work/project') }),
  projectInstructions({ files: ['AGENTS.md', 'CLAUDE.md'], maxChars: 20_000 }), // optional
]
// ctx.services.projectInstructions → { root, nested, nestedOmitted } for a /memory page
```

Use `loadProjectInstructions(fs, opts)` to read the same information without a session, and
`frame` / `nestedFrame` to change the wording. See spec 08 §13.

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
