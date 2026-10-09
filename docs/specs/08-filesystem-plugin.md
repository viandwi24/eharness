# Spec 08 — Filesystem plugin

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.5.0 (multi-edit `edit_file`, `glob`, `onAdapterError`). Module: `src/filesystem` (`eharness/filesystem`, `eharness/filesystem/memory`).

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
  /**
   * Optional (since 0.5): fast path of the `glob` tool. `pattern` is relative to `prefix` (a
   * directory prefix ending in `/`) and uses the glob syntax of §3; at most `limit` files, any order.
   */
  glob?(pattern: string, opts: { prefix: string; limit: number }): Promise<FileMeta[]>
  /** Optional (since 0.4): atomic rename of one file; never overwrites `to`. */
  move?(from: string, to: string, opts?: { ifVersion?: string }): Promise<MoveResult>
}

export interface FileMeta { path: string; version: string; size: number; updatedAt?: number }
export interface FileEntry extends FileMeta { content: string }
export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict' | 'exists'; currentVersion?: string }
export type DeleteResult = { ok: true } | { ok: false; reason: 'missing' | 'conflict'; currentVersion?: string }
export interface GrepHit { path: string; line: number; text: string }
export type MoveResult = { ok: true } | { ok: false; reason: 'missing' | 'exists' | 'conflict'; currentVersion?: string }

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
  pattern's `g`/`y` flags must not make matching stateful. The tool only passes patterns of its
  conservative safe subset (§3: at most one variable-width quantifier, no quantified groups), a syntactic guard, not a guarantee: an adapter that pushes `grep`
  down (a database, a search service) should run a linear-time engine (e.g. RE2) or apply the
  same limits — at most 512 pattern characters, only the first 2 000 characters of each line
  matched (`memoryFs` does) — so a model's pattern cannot freeze the process or the backend.
- `move` (optional, since 0.4): `to` gets the content — and therefore the version — of `from` and
  `from` disappears, as one atomic step. Checks in this order: `from` missing → `'missing'`;
  `ifVersion` given and not the version of `from` → `'conflict'` (with `currentVersion`); `to`
  exists (also `to === from`) → `'exists'`. A rejected move changes nothing; of concurrent moves
  of one file exactly one wins. The file tools do not use it; the memory plugin (spec 14 §6) does
  and falls back to write + delete when it is absent.
- Returned objects are copies (mutating them never changes stored data).
- Text (UTF-8) is the core of the contract. Binary files are optional, via `readBytes` /
  `writeBytes` and `FileMeta.binary` (§12); an adapter without them is text only.
- Conformance: `fileSystemConformance(factory, { requireStat?, requireGrep?, requireGlob?, requireMove?, requireBytes? })` in
  `eharness/testing`. The factory returns an **empty** file system per case. It checks the rules
  above: round trips (non-ASCII, CRLF, empty file), version iff content, `ifVersion` semantics
  incl. concurrent writers (exactly one wins), `DeleteResult` reasons, `list` order and prefixes,
  metadata-only listings, copies, and `stat` / `grep` / `glob` / `move` / `readBytes` +
  `writeBytes` (`requireBytes`) when implemented. `eharness/testing` does
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
  tools?: Array<'list_files' | 'read_file' | 'write_file' | 'edit_file' | 'delete_file' | 'grep' | 'glob'>
  /**
   * Maps an exception thrown by an adapter method to the model-visible text. Default:
   * `ERROR: <message>` (a leading `Error: ` dropped). Return `undefined` to rethrow (an ordinary
   * tool error).
   */
  onAdapterError?: (error: unknown, info: { tool: FileToolName; path: string }) => string | undefined
  /** Record files before the first change of each turn (§11). Default: off. */
  checkpoints?: CheckpointStore
  /** Binary files `read_file` shows to the model (§12). Needs an adapter with `readBytes`. */
  media?: { images?: boolean /* default true */; pdf?: boolean /* default false */; maxBytes?: number /* default 5 MiB */ }
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
| `read_file` | `{ path, offset?, limit?, charOffset? }` | line-numbered text window; records `lastRead[path] = version`; images (and PDFs with `media.pdf`) are shown as media (§12) |
| `write_file` | `{ path, content }` | create or overwrite; overwrite requires a prior read with matching version |
| `edit_file` | `{ path, old_string, new_string, replace_all? }` or `{ path, edits }` | smart replace (§4); requires prior read; `edits` = 1–50 `{ old_string, new_string, replace_all? }`, all or nothing |
| `delete_file` | `{ path }` | requires prior read; respects `isUndeletable` |
| `grep` | `{ pattern, prefix? }` | regex, max 50 hits |
| `glob` | `{ pattern, path? }` | files matching a glob under `path` (default `/`), max 200 (since 0.5) |

All tools **return strings**, except `read_file` of an image or PDF, which returns a media
reference (§12). Expected failures use prefixes the model (and UIs) can recognise:

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
  `cat -n` style: the number right-aligned to 6 characters, a tab, the text. `charOffset` (default
  0, added in 0.4.0) is a character offset inside the first line of the window: that line is shown
  from there (line numbers stay the file's lines, which `edit_file` users rely on). The window
  stops before `maxReadChars` output characters. A single longer line is cut, ending in
  ` … [line truncated]`, followed by a blank line and
  `(Line <n> continues; use offset=<n> charOffset=<c>.)`, so every character of a very long line
  (minified code, an evicted single-line JSON output) is reachable. Otherwise, when lines remain: a
  blank line and `(Showing lines <a>-<b> of <n>. Continue with offset=<b+1>.)`. The hint counts toward
  `maxReadChars` (the whole result stays within it), so a full window is never cut by the core's
  tool output limit (spec 09 §4). Empty file → `(empty file)`;
  `offset` past the end → `ERROR: offset <o> is past the end of the file (<n> lines)`;
  `charOffset` at or past the end of a non-empty line →
  `ERROR: charOffset <c> is past the end of line <o> (<len> characters)`; missing →
  `ERROR: file not found: <path>`. Every successful read records `lastRead[path]`.
- `write_file` → `Created <path> (<bytes> bytes).` / `Wrote <path> (<bytes> bytes).`
- `edit_file` → `Edited <path> (1 replacement).` / `(<n> replacements).`; missing file →
  `ERROR: file not found: <path> (use write_file to create it)`; smart replace failures →
  `ERROR: <reason>`.
- `edit_file` with `edits` (since 0.5): exactly one form per call — both →
  `ERROR: pass either old_string and new_string, or edits, not both.`, neither →
  `ERROR: pass old_string and new_string, or edits.`, `old_string` without `new_string` (or the
  reverse) → `ERROR: old_string and new_string must be given together.`, not 1–50 entries →
  `ERROR: edits must contain 1 to 50 entries (got <n>).`. The edits apply in order to the
  in-memory content (each sees the result of the previous ones) with the §4 cascade and ambiguity
  rules per edit. All or nothing: the first failing edit returns
  `ERROR: edit <i> of <n>: <reason>` (1-based) and nothing is written. One read-before-write
  check, one staleness check, one `ifVersion` write and one change part for the whole call.
  Result `Edited <path> (<n> edits, <m> replacements).` (`1 edit`, `1 replacement` singular).
  The single form's texts are unchanged.
- `glob` (since 0.5): `pattern` is relative to `path` and supports `**` (any number of
  directories), `*`, `?`, `[abc]` / `[!abc]` / `[a-z]` and `{a,b}` (nested, at most 64
  alternatives). Paths are virtual; a pattern with a leading `/` or `~`, a `..` segment or a `\`
  is `ERROR: invalid pattern: <reason>`. A segment that does not start with a literal `.` never
  matches a name starting with `.` (so `*` and `**` skip dotfiles and dot directories; `.*` and
  `.github/**` name them). Hidden prefixes are excluded and the tool outputs directory only
  appears when `path` is inside it (like `list_files`). Output: one absolute path per line, newest
  first (`updatedAt` descending, ties by path) when every match has `updatedAt`, else sorted by
  path; at most 200, then `(Showing 200 of <n> matches; narrow the pattern.)`; none (or a hidden
  `path`) → `No files match.` The adapter's `glob` (when implemented) is tried first with a
  budget of 5000 results, filtered for hidden paths afterwards; a full budget falls back to
  `list` + the built-in matcher. The matcher is exported as `compileGlob(pattern)`.
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
- `grep`: `pattern` is a JavaScript regular expression without flags, matched per line (only
  the first 2 000 characters of a line are matched; a pattern without regex metacharacters is a
  plain substring search); `ERROR: invalid pattern: <message>` when it does not compile.
  **Safe subset (0.4.0)** — a conservative guard against slow backtracking, so an accepted
  pattern is at worst quadratic in the 2 000 scanned characters (a few ms per line). The rule,
  exactly: at most 512 characters; **at most one variable-width quantifier in the whole pattern**,
  counting `*`, `+`, `?`, their lazy variants, `{n,}` and `{n,m}` with m > n (a fixed `{n}` on a
  single atom is fine); **no quantified group** — `(…)` or `(?:…)` followed by any quantifier,
  even a fixed `{n}`; no backreferences; no lookarounds. Alternation is allowed (outside
  quantified groups, which do not exist). So `foo|bar`, `import .* from`, `^\s*export`,
  `[A-Z][a-z]+Error`, `a.{0,90}b` work, while `.*foo.*bar`, `\w+\d{0,99}x`,
  `(\d+\.)+\d+`, `(ab){3}` are refused with
  `ERROR: invalid pattern: <reason>. grep accepts only a safe subset of regular expressions: at
  most one variable-width quantifier (*, +, ?, {n,m}) in the whole pattern, no quantified groups,
  no backreferences or lookarounds. Search for a plain literal, or split the search into simpler
  ones.` — reason `longer than 512 characters`, `more than one variable-width quantifier`,
  `a quantified group`, `backreferences are not supported` or
  `lookaround assertions are not supported`. One line
  `<path>:<line>: <text>` per hit (text cut to 300 characters + ` …`; a cut line ends with
  ` (match at charOffset=<c>)`, the 0-based character offset of the first match, for
  `read_file`), sorted by path and line,
  at most 50, then `(Stopped at 50 matches; narrow the pattern or the prefix.)` when more exist;
  none → `No matches.` The adapter's `grep` (when implemented) is always tried first, with a
  budget of 500 hits; hidden and unlisted hits are filtered out afterwards. When the adapter
  returned a full budget and fewer than 51 hits remain visible (hidden files used up the
  budget), the tool falls back to list + read, so hidden files never hide visible hits.
- Order of checks for mutations: path → policy (`REJECTED`) → existence → read-before-write →
  staleness → operation (`CONFLICT`). Adapter exceptions (I/O failures, e.g. a binary or
  oversized file) are mapped by `onAdapterError` (since 0.5): by default the tool returns
  `ERROR: <message>` (a leading `Error: ` is dropped), so the model reads an ordinary `ERROR:`
  string and `classifyToolResult` says `'error'`. The callback receives `{ tool, path }` (the
  normalized requested path); returning `undefined` rethrows, i.e. the pre-0.5 behaviour of an
  ordinary tool error.

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
export function memoryFs(seed?: Record<string, string | Uint8Array>): FileSystem
```

Map-backed, versions via `contentVersion`, implements `stat`, `grep`, `move`, `readBytes` and
`writeBytes` (§12; the seed may hold `Uint8Array` values too). Used by tests, examples
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

## 8. Node adapter

`eharness/filesystem/node` (Node-only module, ADR-0036: it imports `node:` built-ins; the rest of
the library does not). It runs on Node >= 22 and Bun; it never uses `Bun.*`.

```ts
export function diskFs(root: string, opts?: DiskFsOptions): FileSystem

export interface DiskFsOptions {
  readonly?: boolean                                  // write/delete/move throw `read-only directory: <path>`
  ignore?: { gitignore?: boolean; hidden?: string[] } // default gitignore: true
  maxFileBytes?: number                               // default 2 MiB (DEFAULT_MAX_FILE_BYTES): text files
  maxBinaryBytes?: number                             // default 10 MiB (DEFAULT_MAX_BINARY_BYTES): binary files
  grep?: 'auto' | 'js'                                // default 'auto'
}
```

`root` is a real directory and the virtual `/`. `diskFs` implements every optional method of the
contract: `stat`, `grep`, `glob`, `move`, `readBytes` and `writeBytes`; it passes
`fileSystemConformance` with `requireStat`, `requireGrep`, `requireGlob`, `requireMove` and
`requireBytes`.

- **Containment.** Every call resolves the virtual path below the root and then through symlinks
  (`realpath` of the nearest existing parent); a result outside the real root throws `path outside
  the workspace: <path>`. Relative paths, `..` segments and NUL do too. This covers a symlinked
  file or directory that points outside, and a symlink swapped in between a read and a write
  (the check runs again on every call). Symlinks that stay inside the root work. `list`, `grep`
  and `glob` silently skip dangling or escaping links.
- **Text and binary.** A file is binary when its first 8000 bytes contain a NUL byte or it is not
  valid UTF-8 (`looksBinary`). `read` throws `binary file: <path> (it cannot be read as text; use
  readBytes)` for a binary file and `too large file: <path> (text files up to 2 MB only)` for a
  text file over `maxFileBytes` (the limit in the message follows the option); the filesystem
  plugin turns the exception into `ERROR: …` (§2, `onAdapterError`). `list`, `glob` and `stat`
  show binary files (`binary: true`, `size` in bytes, version = SHA-1 of the bytes) up to
  `maxBinaryBytes`; `grep` skips them; text files over `maxFileBytes` are skipped. `readBytes`
  throws `too large file: <path> (up to 10 MB only)` above `maxBinaryBytes`; special files throw
  the binary error.
- **Writes.** Content goes to a temp file next to the target and is renamed over it (atomic on the
  same volume); the mode of an existing file (e.g. `+x`) is carried over. Parent directories are
  created. `ifVersion` is compare-and-set under a per-path in-process mutex (not a cross-process
  lock: two processes writing the same file can still race). `move` is `rename` under the mutexes
  of both paths, never overwrites, and creates parent directories.
- **Ignore rules** hide paths from `list`, `grep` and `glob` (explicit `read`/`write` still work):
  `.git/` and `node_modules/` at any depth, always; the root `.gitignore` unless
  `ignore.gitignore` is `false`; then `ignore.hidden` (extra patterns in the same syntax). The
  matcher is a subset of gitignore, implemented without dependencies (`compileIgnore`):

  | Supported | Example |
  |---|---|
  | blank lines, `#` comments, `\#` / `\!` escapes, trailing spaces trimmed | `# build output` |
  | `*`, `?`, `[abc]`, `[!abc]`, `[a-z]` (never match `/`) | `*.log`, `f?.txt` |
  | pattern without `/` matches at any depth | `cache` |
  | leading or inner `/` anchors to the root | `/dist`, `src/gen` |
  | trailing `/` matches directories only | `dist/` |
  | `**` as a whole segment (leading, trailing, middle) | `**/cache`, `out/**`, `docs/**/*.tmp` |
  | `!` negation, last matching pattern wins | `*.log` then `!keep.log` |
  | a file below an ignored directory is ignored and cannot be re-included | `build/` then `!build/keep` has no effect |

  Not supported: nested `.gitignore` files, `.git/info/exclude`, the global excludes file,
  case-insensitive matching, `**` inside a segment (`a**b` is `a*b`).
- **Grep.** `'auto'` looks for `rg` on `PATH` on every call and runs it (`node:child_process`,
  `--json --no-ignore --hidden`, size limit = `maxFileBytes`); ignore rules are applied by
  `diskFs` to rg's output, so rg and the JavaScript path see the same files. Flags other than `i`,
  an rg exit code other than 0/1 (e.g. a pattern rg cannot compile) and a failure to spawn fall
  back to the JavaScript implementation. `'js'` never spawns. Hits: sorted by path then line,
  line breaks stripped.
- **Glob.** `glob(pattern, { prefix, limit })` walks the visible tree, matches with `compileGlob`
  against the path relative to `prefix`, and reads metadata only for the matches.

## 9. Mounts

```ts
export function mountFs(mounts: () => FsMount[]): FileSystem
export interface FsMount { virtual: string; fs: FileSystem; readonly?: boolean }
```

A composite file system: `virtual` starts and ends with `/` (`'/'`, `'/@dirs/lib/'`; otherwise
`TypeError`), and the mount's `fs` sees its own `/` at that prefix. Any `FileSystem` can be mounted
(`diskFs`, `memoryFs`, your adapter). The list is read on every call, so mounts added later are
visible at once.

- `read`, `write`, `delete`, `stat`: the mount with the longest matching prefix serves the path
  (results carry the virtual path); a path outside every mount throws `path outside the
  workspace: <path>`.
- `list`, `grep`, `glob`: merged over every mount that can hold results below the prefix, sorted
  by path (and line); a file of a less specific mount below a more specific mount point is
  shadowed.
- `readonly: true` makes `write`, `delete` and `move` into that mount throw `read-only directory:
  <path>` (the underlying adapter may also be read-only).
- `move` inside one mount is that mount's `move` (atomic when the adapter's is). **A move across
  mounts is not atomic**: it creates `to` only if absent (`exists` otherwise), then deletes
  `from`; a crash in between leaves both files. The same fallback is used for an adapter without
  `move`.

## 10. Node workspace

```ts
export function nodeWorkspace(opts: NodeWorkspaceOptions): Promise<NodeWorkspace>

export interface NodeWorkspaceOptions {
  root: string                // real project directory, mounted at '/'
  extraDirs?: string[]        // mounted at '/@dirs/<basename>/' ('-2', '-3' on a clash)
  toolOutputsDir?: string     // created if missing; mounted at '/.eharness/tool-outputs/', writable
  diskFs?: DiskFsOptions      // applied to every mount
}
export interface NodeWorkspace {
  readonly root: string       // realpath of `root`
  readonly fs: FileSystem     // mountFs over one diskFs per mount
  mounts(): Array<{ virtual: string; real: string; readonly: boolean }>
  addDirectory(real: string): Promise<string>   // virtual prefix; idempotent; throws `not a directory: <path>`
  toReal(virtual: string): Promise<string | null>
  toVirtual(real: string): string | null
}
```

The convenience for "a project plus a few more directories". `toReal` applies the same
containment as `diskFs` (`null` for an escaping or unmounted path); `toVirtual` is the inverse for
an absolute real path (`null` outside every mount). Pass `fs` to `filesystem({ fs })`; with
`toolOutputsDir` the evicted tool outputs (§2) land outside the project tree.

## 11. Checkpoints

`filesystem({ checkpoints })` records, for every file a turn changes, the content the file had
before the turn's **first** change, so an app can undo the agent's file edits ("rewind code").

```ts
export type FileSnapshot = { content: string } | { missing: true }

export interface CheckpointStore {
  /** First write wins: an existing snapshot for the key is kept. */
  save(key: { sessionId: string; turnKey: string; path: string }, before: FileSnapshot): Promise<void>
  load(key: { sessionId: string; turnKey: string; path: string }): Promise<FileSnapshot | null>
  /** Sorted by turnKey, then path. */
  list(sessionId: string): Promise<CheckpointRecord[]> // { turnKey, path, before, at }
  /** The given turns, or the whole session when `turnKeys` is omitted. */
  delete(sessionId: string, turnKeys?: readonly string[]): Promise<void>
}

export function memoryCheckpointStore(opts?: { keepTurns?: number }): CheckpointStore // eharness/filesystem
export function nodeCheckpointStore(dir: string, opts?: { keepTurns?: number }): CheckpointStore // eharness/filesystem/node

export function checkpointsSince(args: { store; sessionId; fromTurnKey; fs? }): Promise<FileCheckpoint[]>
export function rewindFiles(args: { fs; store; sessionId; fromTurnKey; keepRecords? }): Promise<RewindFilesResult>
export function checkpointTurnKey(turn: { id: string; input?: { id: string } }): string
```

- **What is recorded.** The plugin hands the tools and the `fs` service a recording wrapper of the
  adapter: before the first `write`, `delete` or `move` (both ends) of a path in a turn it reads
  the current content and saves it. That covers `write_file`, `edit_file`, `delete_file` and any
  other plugin writing through `ctx.services.fs`. Not recorded: writes outside a turn, paths under
  the tool outputs directory, binary files (snapshots are text; nothing is logged), files that
  cannot be read (oversized: a warning is logged and the change still goes through), and everything that does not go through the `fs` service
  (the shell, other processes, an app writing to the adapter directly).
- **Turn key.** `checkpointTurnKey(turn)` = the id of the turn's user message, else the turn id
  (`respond`, `regenerate`, wake and input-less turns have no user message). Both are UUIDv7, so
  keys sort by creation time; "at or after a point" compares keys as strings, and the point does
  not need a checkpoint of its own. The natural point of a UI is the id of a user message.
- **Sessions.** The key's `sessionId` is the id of the session that ran the tool; a subagent's
  child session has its own checkpoints (the plugin does not map them to the parent's turn).
- **`checkpointsSince`** returns the earliest snapshot per path among turns `>= fromTurnKey`
  (`{ path, turnKey, before, changed? }`, sorted by path); with `fs`, `changed` says whether the
  file differs from the snapshot now (a UI shows "N files will be restored").
- **`rewindFiles`** writes the earliest snapshot of every such path back through `fs` (or deletes
  the file when it did not exist) and returns `{ restored, deleted, unchanged, failed }`; one
  failing path (read-only, outside the workspace) does not stop the others. When nothing failed it
  deletes the snapshots of the rewound turns (they no longer describe the files) unless
  `keepRecords` is true. It uses the `fs` you pass: pass the same adapter (or the plugin's
  `fs` service), not a recording one, so the rewind itself is not checkpointed.
- **Independent of conversation rewind.** Checkpoints only know files, sessions and turn keys;
  forking or truncating the conversation (`session.fork`) is a separate operation the app combines
  with `rewindFiles`.
- **Durability.** The store is the only state: use `nodeCheckpointStore(dir)` (one JSON file per
  turn, atomic writes, survives restarts, last `keepTurns` = 50 turns per session) for a CLI or a
  single server, and implement `CheckpointStore` over your database for a split web/server
  deployment (a conformance-style contract: first-write-wins `save`, sorted `list`). The memory
  store is for tests and processes that need no restart.

## 12. Binary files and images

*Since 0.7 (P31 R9). Works in every deployment profile (ADR-0034): `Uint8Array`, `TextDecoder`,
`btoa`; no Node built-ins outside `eharness/filesystem/node`.*

**Contract (optional methods).**

```ts
interface FileMeta { /* … */ binary?: boolean; mediaType?: string }
interface BinaryFile { bytes: Uint8Array; meta: FileMeta; mediaType?: string }
interface FileSystem {
  readBytes?(path: string): Promise<BinaryFile | null>
  writeBytes?(path: string, bytes: Uint8Array, opts?: { ifVersion?: string | null }): Promise<WriteResult>
}
```

- `readBytes` works for any file (text too: its UTF-8 bytes); `null` if missing. `writeBytes` has
  the `write` rules (`ifVersion` string / `null` / unconditional, atomic compare-and-set, same
  `WriteResult`); the version comes from the bytes.
- `FileMeta.binary: true` marks a file that is not text: `read` does not handle it (adapters
  throw), `size` is the length in bytes. `list`, `stat` and `glob` return it like any file.
- **Versions.** Binary: `bytesVersion(bytes)` (SHA-1 hex of the bytes). Bytes that are valid UTF-8
  text are text: `writeBytes` stores them as a text file with `contentVersion` of the decoded
  text, so `write(text)` and `writeBytes(utf8(text))` give the same version. A text `write` over a
  binary file replaces it.
- `binary` classification is the same everywhere (`looksBinary`, exported): NUL byte in the first
  8000 bytes, or invalid UTF-8.
- `mediaType` on `FileMeta`/`BinaryFile` is optional (an object store knows it); the plugin falls
  back to `detectMediaType(bytes, path)` (magic bytes for PNG, JPEG, GIF, WebP, PDF, BMP, ZIP,
  gzip, then the extension; `undefined` when unknown). `imageDimensions`, `bytesToBase64`,
  `looksBinary` and `bytesVersion` are exported helpers.
- `memoryFs`, `diskFs` and `mountFs` implement both; `checkpointedFs` passes them through (binary
  files are not snapshotted). The plugin only treats a file as binary when the adapter has
  `readBytes`; without it everything is text and nothing changes.
- Conformance: `fileSystemConformance(factory, { requireBytes: true })`.
- `fsSkillSource(fs).readFile()` uses `readBytes` when present: a binary skill asset is returned as `{ type: 'binary', mediaType, data }` (spec 07), text as `{ type: 'text' }`.

**`read_file` of a binary file** (needs `readBytes`; the check is one `stat`):

| File | Result |
|---|---|
| image `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `media.images` (default true), size ≤ `media.maxBytes` (default 5 MiB) | the model sees the image plus `Image <path> (<w>x<h>, <bytes> bytes, <mediaType>)` (`<w>x<h>, ` only when the PNG/GIF/JPEG/WebP header parses) |
| PDF, `media.pdf: true` (default false: not every provider accepts PDFs), size ≤ `media.maxBytes` | the model sees the file part plus `PDF <path> (<bytes> bytes, application/pdf)` |
| image or PDF over the limit | `ERROR: image <path> is too large (<bytes> bytes; the limit is <max> bytes).` (`PDF` for a PDF) |
| anything else (also images with `media.images: false`, PDFs without `media.pdf`) | `ERROR: binary file <path> (<mediaType or unknown>, <bytes> bytes); it cannot be shown as text.` |

`offset`, `limit` and `charOffset` are ignored for binary files. A successful or refused binary
read records `lastRead[path]` (so a binary file can be deleted after the model has looked at it).
`write_file` and `edit_file` on an existing binary file →
`ERROR: <path> is a binary file; <tool> only handles text files. Delete it first to replace it.`
(policy checks first; the staleness rules are not involved). `delete_file` works with the usual
read-before-delete rule (`ERROR: read <path> with read_file before deleting it.` /
`STALE: <path> changed since you last read it; read it again before deleting it.`). `list_files`
and `glob` list binary files like any file; `grep` never searches them. Binary files cannot be
created by the tools: an app or another plugin writes them with `writeBytes` (e.g.
`ctx.services.fs.writeBytes`).

**Output shape and storage.** `read_file` returns, for media, a `FileMediaRef`
(`isFileMediaRef`):

```ts
{ type: 'media-ref', path, version, mediaType, bytes, text }
```

This is the `output` that the UI tool part stores, the stream carries and `tool.after` hooks see:
a few hundred bytes, so messages stay small and the §4 / spec 09 §4 output limit never applies to
the media (`text` is the line the model reads). The tool's `toModelOutput` (AI SDK:
async, invoked by `convertToModelMessages` with the turn's tools) turns it into
`{ type: 'content', value: [{ type: 'text', text }, { type: 'file', mediaType, data: { type: 'data', data: <base64> } }] }`
(PDFs add `filename`). `toModelOutput` re-reads the bytes from the file system, because base64 in
the stored message would cost ~1.37x the file size in every storage and on every reload; it
checks that the file still has the recorded `version`:

- unchanged file → the same model input on every projection (steps, turns and reloads; a small
  per-session cache of the last 32 MiB avoids re-reading on every step);
- changed or deleted file, or an adapter error → the text line plus
  `[The content of <path> is no longer available: the file changed or was removed after it was read.]`
  (never throws, since it runs while the history is projected). Consequence: the image is
  visible to the model only while the file stays as it was; an app that needs permanent images
  keeps its own copy (or reads it into a message file part). The prompt-cache prefix changes at
  that point, like after any history edit.

`compaction.prune` (spec 06 §5.0) sees the projected content output: an old image counts its
base64 characters, so it is replaced by the `[output of read_file pruned: <n> chars]` placeholder
once past `keepTurns`; the stored reference is untouched. Alternatives rejected: base64 in the
stored output (megabytes per message, hits the 50 000-character output limit, duplicated into
every adapter and reload) and a core change for media outputs (not needed).
