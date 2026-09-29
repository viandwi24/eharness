# Spec 08 — Filesystem plugin

Status: **Accepted** (v0). Module: `src/filesystem` (`eharness/filesystem`, `eharness/filesystem/memory`).

The filesystem plugin is the **reference plugin**: it shows how a plugin provides a service, tools,
skills, state and data parts using only the public API. It ships one adapter (`memoryFs`). Anything
else (JSON file, Postgres, S3, a sandbox's disk) implements the `FileSystem` contract.

## 1. Contract

```ts
export interface FileSystem {
  /** null if missing. */
  read(path: string): Promise<FileEntry | null>
  /**
   * Write text. `ifVersion`: string → only if current version matches; null → only if the file does
   * not exist; undefined → unconditional.
   */
  write(path: string, content: string, opts?: { ifVersion?: string | null }): Promise<WriteResult>
  delete(path: string, opts?: { ifVersion?: string }): Promise<DeleteResult>
  /** Files under `prefix` (default '/'), recursive, sorted by path. */
  list(prefix?: string): Promise<FileMeta[]>
  /** Optional fast paths; the plugin falls back to list+read when absent. */
  stat?(path: string): Promise<FileMeta | null>
  grep?(pattern: RegExp, opts?: { prefix?: string; maxHits?: number }): Promise<GrepHit[]>
}

export interface FileMeta { path: string; version: string; size: number; updatedAt?: number }
export interface FileEntry extends FileMeta { content: string }
export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
export type DeleteResult = { ok: true } | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }
export interface GrepHit { path: string; line: number; text: string }

declare module 'eharness' {
  interface HarnessServices { fs: FileSystem }
}
```

Rules for adapters:

- Paths are **normalized absolute POSIX** (`/src/main.pine`). The plugin normalizes before calling
  the adapter (`normalizePath`: collapse `//`, resolve `.`/`..` inside the root, reject escaping).
- `version` is opaque and must change iff content changes. Recommended: SHA-1 hex of the UTF-8
  content (`contentVersion(content)` helper, Web Crypto). Using mtime or counters is a bug
  (stale detection depends on content identity).
- Text only in v0 (UTF-8). Binary files are a roadmap item.
- Conformance: `fileSystemConformance(factory)` in `eharness/testing`.

## 2. Plugin

```ts
export function filesystem(opts: FilesystemOptions): HarnessPlugin

export interface FilesystemOptions {
  /** Adapter instance, or a resolver called at session open (e.g. one fs per session/project). */
  fs: FileSystem | ((ctx: HarnessContext) => FileSystem | Promise<FileSystem>)
  /** Autoload skills from this fs (spec 07 §8). */
  skills?: { root: string; refresh?: 'session' | 'turn'; hideSkillsRoot?: boolean }
  /** Allowed extensions for writes (e.g. ['.md', '.pine']). Default: any. */
  allowedExtensions?: string[]
  /** Read-only prefixes (writes/deletes rejected). */
  readonlyPrefixes?: string[]
  /** Hidden prefixes (invisible to all file tools). Skills root is added when hideSkillsRoot. */
  hiddenPrefixes?: string[]
  /** Files that may be edited but never deleted. */
  isUndeletable?: (path: string) => boolean
  /** Max characters returned by read_file per call. Default 50_000. */
  maxReadChars?: number
  /** Which tools to expose. Default all. */
  tools?: Array<'list_files' | 'read_file' | 'write_file' | 'edit_file' | 'delete_file' | 'grep'>
}
```

Definition: `name: 'filesystem'`, `provides: ['fs', 'toolOutputs']`, `dataParts: { change }`.

Option `toolOutputs?: false | { dir?: string }` (default `{ dir: '/.eharness/tool-outputs' }`)
controls the second service, used by `toolOutput.strategy: 'evict'` (spec 09 §4):

```ts
export interface ToolOutputStore {
  /** Store a full tool output; returns the path the model can read with read_file. */
  put(toolCallId: string, text: string): Promise<string>
}
```

The directory is read-only for the model (writes/deletes rejected) and omitted from `list_files`
unless listed explicitly; `read_file` with `offset`/`limit` pages through evicted outputs. Evicted
files are never cleaned up by the core (the application owns retention).

## 3. Tools

| Tool | Input | Behaviour |
|---|---|---|
| `list_files` | `{ prefix? }` | paths + sizes, hidden prefixes excluded |
| `read_file` | `{ path, offset?, limit? }` | line-numbered text window; records `lastRead[path] = version` |
| `write_file` | `{ path, content }` | create or overwrite; overwrite requires a prior read with matching version |
| `edit_file` | `{ path, old_string, new_string, replace_all? }` | smart replace (§4); requires prior read |
| `delete_file` | `{ path }` | requires prior read; respects `isUndeletable` |
| `grep` | `{ pattern, prefix? }` | regex, max 50 hits |

All tools **return strings**. Expected failures use prefixes the model (and UIs) can recognise:

| Prefix | Meaning |
|---|---|
| `ERROR:` | invalid input, not found, rejected by policy |
| `STALE:` | file changed since last read; includes current content so the model can retry immediately |
| `CONFLICT:` | concurrent write detected via `ifVersion` |
| `REJECTED:` | policy denial (readonly, undeletable, extension) |

Helper `classifyToolResult(text)` is exported for UIs.

## 4. Editing rules (from the predecessor harness, proven in production)

- **Read-before-edit/overwrite/delete:** the path must be in `lastRead` for this session.
- **Staleness:** if `lastRead[path] !== current.version` → `STALE:` + current content; `lastRead`
  is updated to the new version so a retry succeeds.
- **Smart replace cascade:** exact match → line-trimmed match → whitespace-normalized match. More
  than one exact match without `replace_all` → `ERROR:` (never guess the location).
- **Optimistic lock:** all writes use `ifVersion` with the version read; `{ ok: false }` →
  `CONFLICT:`.
- `lastRead` lives in `ctx.state` (`plugins.filesystem.lastRead`: path → version), so it survives
  restarts when a persistent `StateAdapter` is used. Cap: 500 entries (LRU) to respect the state
  size guideline (spec 05 §7).

## 5. Data part

`data-filesystem.change` (persistent, `id` = path):

```ts
{ path: string; action: 'create' | 'write' | 'edit' | 'delete'; version: string | null; bytes?: number }
```

Model projection: `omit` (the model already saw the tool result).

## 6. `memoryFs`

```ts
export function memoryFs(seed?: Record<string, string>): FileSystem
```

Map-backed, versions via `contentVersion`, implements `stat` and `grep`. Used by tests, examples
and as the default for demos. Not persistent.

## 7. Writing your own adapter (guide excerpt)

```ts
import type { FileSystem } from 'eharness/filesystem'
import { contentVersion } from 'eharness/filesystem'

export function postgresFs(db: Db, projectId: string): FileSystem {
  return {
    async read(path) { /* SELECT content, version … */ },
    async write(path, content, { ifVersion } = {}) {
      const version = await contentVersion(content)
      // UPDATE … WHERE version = $ifVersion  / INSERT … ON CONFLICT DO NOTHING when ifVersion === null
    },
    async delete(path, { ifVersion } = {}) { /* … */ },
    async list(prefix = '/') { /* SELECT path, version, size … WHERE path LIKE prefix || '%' ORDER BY path */ },
  }
}
```

Run `fileSystemConformance(() => postgresFs(testDb, crypto.randomUUID()))` in your test suite.
