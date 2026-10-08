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
- Text only in v0 (UTF-8). Binary files are a roadmap item.
- Conformance: `fileSystemConformance(factory, { requireStat?, requireGrep?, requireGlob?, requireMove? })` in
  `eharness/testing`. The factory returns an **empty** file system per case. It checks the rules
  above: round trips (non-ASCII, CRLF, empty file), version iff content, `ifVersion` semantics
  incl. concurrent writers (exactly one wins), `DeleteResult` reasons, `list` order and prefixes,
  metadata-only listings, copies, and `stat` / `grep` / `glob` / `move` when implemented. `eharness/testing` does
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
| `read_file` | `{ path, offset?, limit?, charOffset? }` | line-numbered text window; records `lastRead[path] = version` |
| `write_file` | `{ path, content }` | create or overwrite; overwrite requires a prior read with matching version |
| `edit_file` | `{ path, old_string, new_string, replace_all? }` or `{ path, edits }` | smart replace (§4); requires prior read; `edits` = 1–50 `{ old_string, new_string, replace_all? }`, all or nothing |
| `delete_file` | `{ path }` | requires prior read; respects `isUndeletable` |
| `grep` | `{ pattern, prefix? }` | regex, max 50 hits |
| `glob` | `{ pattern, path? }` | files matching a glob under `path` (default `/`), max 200 (since 0.5) |

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
export function memoryFs(seed?: Record<string, string>): FileSystem
```

Map-backed, versions via `contentVersion`, implements `stat`, `grep` and `move`. Used by tests, examples
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
