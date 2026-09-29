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
  interface HarnessServices { fs: FileSystem; toolOutputs: ToolOutputStore }
}
```

The augmentation declares both services as present; `toolOutputs` is not provided with
`toolOutputs: false` (§2), and accessing a service that no plugin provides throws
`EH_SERVICE_MISSING` (spec 01 §6). Code that may run without it (e.g. the core's `evict`
strategy) looks the service up by name and falls back.

Rules for adapters:

- Paths are **normalized absolute POSIX** (`/src/main.pine`). The plugin normalizes before calling
  the adapter with the exported helper
  `normalizePath(path): { ok: true; path } | { ok: false; error }`: relative paths are resolved
  from `/`, `//` collapses, `.` segments are removed, `..` goes up one directory and may not leave
  the root, a trailing `/` is dropped (`'/'` stays `'/'`). Rejected: non-strings, empty/blank
  paths, NUL, `\`, paths escaping the root, normalized paths over 4096 characters.
- `version` is opaque and must change iff content changes. Recommended: SHA-1 hex of the UTF-8
  content (`contentVersion(content)` helper, Web Crypto). Using mtime or counters is a bug
  (stale detection depends on content identity).
- `size` is the content length in **UTF-8 bytes** (it becomes the skill manifest size, spec 07 §3).
- `list(prefix)` returns the files whose path **starts with** `prefix` (a plain string prefix, so
  `LIKE prefix || '%'` is fine). The plugin always passes directory prefixes ending in `/` (or
  `'/'`) and filters the result with directory semantics itself. Sorted by path in code-unit order.
- `write` with `ifVersion: string` on a missing file → `{ ok: false, reason: 'conflict' }` (no
  `currentVersion`); `ifVersion: null` on an existing file → `'exists'`. `currentVersion`, when
  given, is the stored version. Conditional writes and deletes are atomic compare-and-set.
- `grep` (optional): lines are split on `\n` with a trailing `\r` removed; `line` is 1-based;
  hits sorted by path then line, at most `maxHits`; `prefix` has the `list` semantics; the
  pattern's `g`/`y` flags must not make matching stateful.
- Returned objects are copies (mutating them never changes stored data).
- Text only in v0 (UTF-8). Binary files are a roadmap item.
- Conformance: `fileSystemConformance(factory, { requireStat?, requireGrep? })` in
  `eharness/testing`. The factory returns an **empty** file system per case. It checks the rules
  above: round trips (non-ASCII, CRLF, empty file), version iff content, `ifVersion` semantics
  incl. concurrent writers (exactly one wins), `DeleteResult` reasons, `list` order and prefixes,
  metadata-only listings, copies, and `stat` / `grep` when implemented. `eharness/testing` does
  not import `eharness/filesystem`, so the suite types its parameter with the structural mirror
  `FileSystemUnderTest` (every `FileSystem` is assignable).

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

Definition: `name: 'filesystem'`, `provides: ['fs', 'toolOutputs']` (only `['fs']` with
`toolOutputs: false`), `dataParts: { change }`. Tools, services and the skill source are
contributed in the session phase, so every session gets its own `fs` from the resolver, called
once per live session with the plugin's context. Invalid options throw `EH_CONFIG_INVALID` from
`filesystem()`; a resolver that returns no `FileSystem` (an object with `read`, `write`,
`delete`, `list` functions) fails session open with `EH_CONFIG_INVALID`. Prefix options are
normalized with `normalizePath` and use directory semantics (`'/skills'` covers `/skills` and
`/skills/**`, not `/skillsx`). `allowedExtensions` entries may omit the dot and are compared
case-insensitively with the last `.ext` of the file name (a name without extension never matches).
Exported constants: `DEFAULT_MAX_READ_CHARS` (50_000) and `DEFAULT_TOOL_OUTPUTS_DIR`.

Option `toolOutputs?: false | { dir?: string }` (default `{ dir: '/.eharness/tool-outputs' }`)
controls the second service, used by `toolOutput.strategy: 'evict'` (spec 09 §4):

```ts
export interface ToolOutputStore {
  /** Store a full tool output; returns the path the model can read with read_file. */
  put(toolCallId: string, text: string): Promise<string>
}
```

`put` writes `<dir>/<toolCallId>.txt` unconditionally and returns that path. Characters outside
`[A-Za-z0-9_-]` in the id become `_`, and a changed (or empty) id gets `-<first 8 hex of
contentVersion(id)>` appended, so distinct ids never share a file (`call/1` →
`call_1-<hash>.txt`). The directory is read-only for the model (writes/deletes
rejected) and omitted from `list_files` and `grep` unless the requested prefix is the directory or
inside it; `read_file` with `offset`/`limit` pages through evicted outputs. Evicted files are never
cleaned up by the core (the application owns retention). `dir` must not be `/`.

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

Helper `classifyToolResult(text): 'ok' | 'error' | 'stale' | 'conflict' | 'rejected'` is exported
for UIs (non-strings are `'ok'`).

Exact formats (model-visible, api-stability.md):

- Invalid path → `ERROR: invalid path: <reason>` (reason from `normalizePath`; `write_file` on `/`
  → `the path does not name a file`).
- `list_files`: one line `<path> (<size> bytes)` per visible file, sorted; none →
  `No files under <prefix>.`
- `read_file`: `offset` is the 1-based first line (default 1), `limit` the line count (default and
  maximum 2000). Lines are split like `grep` (a final line break does not start a line) and shown
  `cat -n` style: the number right-aligned to 6 characters, a tab, the text. The window stops
  before `maxReadChars` output characters (a single longer line is cut, ending in
  ` … [line truncated]`). When lines remain: a blank line and
  `(Showing lines <a>-<b> of <n>. Continue with offset=<b+1>.)`. Empty file → `(empty file)`;
  `offset` past the end → `ERROR: offset <o> is past the end of the file (<n> lines)`; missing →
  `ERROR: file not found: <path>`. Every successful read records `lastRead[path]`.
- `write_file` → `Created <path> (<bytes> bytes).` / `Wrote <path> (<bytes> bytes).`
- `edit_file` → `Edited <path> (1 replacement).` / `(<n> replacements).`; missing file →
  `ERROR: file not found: <path> (use write_file to create it)`; smart replace failures →
  `ERROR: <reason>`.
- `delete_file` → `Deleted <path>.`
- Read-before-write: `ERROR: read <path> with read_file before overwriting|editing|deleting it.`
- `STALE: <path> changed since you last read it. Its current content is below; apply your change
  to this version.`, a blank line, then the `read_file` window of the file from line 1.
- `CONFLICT: <path> was changed by someone else at the same time; read it again and retry.`
- `REJECTED: <path> is not accessible.` (hidden), `REJECTED: <path> is read-only.`,
  `REJECTED: <path> cannot be deleted.` (`isUndeletable`),
  `REJECTED: <path>: extension not allowed (allowed: .md, .pine).`
- Hidden prefixes: `read_file` answers exactly like a missing file, `list_files` / `grep` skip
  them (a hidden prefix lists `No files under <prefix>.`), mutations are `REJECTED`.
- `grep`: `pattern` is a JavaScript regular expression without flags, matched per line;
  `ERROR: invalid pattern: <message>` when it does not compile. One line
  `<path>:<line>: <text>` per hit (text cut to 300 characters + ` …`), sorted by path and line,
  at most 50, then `(Stopped at 50 matches; narrow the pattern or the prefix.)` when more exist;
  none → `No matches.` The adapter's `grep` is used unless a hidden or unlisted prefix lies inside
  the searched prefix (then list + read, so hidden files never use up the hit budget).
- Order of checks for mutations: path → policy (`REJECTED`) → existence → read-before-write →
  staleness → operation (`CONFLICT`). Adapter exceptions (I/O failures) are not caught: they
  become ordinary tool errors.

## 4. Editing rules (from the predecessor harness, proven in production)

- **Read-before-edit/overwrite/delete:** the path must be in `lastRead` for this session. Creating a
  new file needs no read (it uses `ifVersion: null`); a successful write/edit records the new
  version, so the model can keep editing its own changes; a delete removes the entry.
- **Staleness:** if `lastRead[path] !== current.version` → `STALE:` + current content; `lastRead`
  is updated to the new version so a retry succeeds.
- **Smart replace cascade:** exact match → line-trimmed match → whitespace-normalized match. More
  than one exact match without `replace_all` → `ERROR:` (never guess the location). The first level
  with any match decides, and the ambiguity rule applies at every level. Line-trimmed: the needle's
  lines (blank lines around it ignored, CRLF tolerated) are compared with whole file lines, both
  trimmed; the replaced range ends before the last line's trailing whitespace. When the needle's
  first line is indented, whole lines are replaced from the line start (`new_string` carries its
  own indentation, so nothing is indented twice); an unindented needle keeps the file's
  indentation of the first line. Whitespace-normalized: every whitespace run counts as one space.
  `new_string` is inserted verbatim; `replace_all` replaces all non-overlapping matches. An empty
  `old_string` or one equal to `new_string` → `ERROR:`.
- **Optimistic lock:** all writes use `ifVersion` with the version read; `{ ok: false }` →
  `CONFLICT:`.
- `lastRead` lives in `ctx.state` (`plugins.filesystem.lastRead`: path → version), so it survives
  restarts when a persistent `StateAdapter` is used. Cap: 500 entries (LRU) to respect the state
  size guideline (spec 05 §7): key order is recency order (every recorded read/write moves the
  path to the end), the oldest keys are dropped.

## 5. Data part

`data-filesystem.change` (persistent, `id` = path):

```ts
{ path: string; action: 'create' | 'write' | 'edit' | 'delete'; version: string | null; bytes?: number }
```

Exported as `FileChangeData`. `version` is the new version (`null` after a delete); `bytes` is the
new UTF-8 size (absent after a delete). Written once per successful mutation; failed attempts
(`ERROR`/`STALE`/`CONFLICT`/`REJECTED`) write nothing. Because the id is the path, the stored
assistant message keeps the latest change per path.

Model projection: `omit` (the model already saw the tool result).

## 6. `memoryFs`

```ts
export function memoryFs(seed?: Record<string, string>): FileSystem
```

Map-backed, versions via `contentVersion`, implements `stat` and `grep`. Used by tests, examples
and as the default for demos. Not persistent. Seed keys are normalized with `normalizePath`
(invalid key or non-string content → `TypeError`); methods expect normalized paths like every
adapter. `updatedAt` is set on every write.

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
