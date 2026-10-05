# Spec 07 — Skills

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Module: `src/skills`; filesystem source in `src/filesystem`.

A skill is a reusable instruction bundle the **model** chooses to open when relevant (progressive
disclosure). Format follows the Agent Skills convention (`SKILL.md` + optional files) and AI SDK
harness skills (`{ name, description, content, files }`).

## 1. Naming

`name`: `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars (no leading/trailing/double hyphens).
`description`: 1–1024 chars, written for the model ("Use when …").

## 2. Static skills

```ts
export function defineSkill(skill: Skill): Skill

export interface Skill {
  name: string
  description: string
  /** Optional version, 1–64 printable characters (0.4.0). Shown by load_skill, not in the index. */
  version?: string
  /** Body of SKILL.md (without frontmatter). */
  content: string
  /** Supporting files, paths relative to the skill root (POSIX, no '..', no leading '/'). */
  files?: Array<{ path: string; content: string }>
  /** Extra frontmatter fields (license, compatibility, …), preserved and shown in load_skill. */
  meta?: Record<string, unknown>
}
```

A static skill is internally wrapped in an in-memory `SkillSource` (one per owner, id
`static:<owner>`; manifest sorted by path with UTF-8 byte sizes). There is no separate code path.

`defineSkill` validates the name and description (§1), the optional `version`, a string `content`, an object `meta` and
every file path (§5, already normalized, no duplicates) and throws `EH_CONFIG_INVALID`. Skills and
sources passed without `defineSkill` / `defineSkillSource` get the same checks at boot / session
open, with the owner named in the error.

## 3. Dynamic skills — `SkillSource`

```ts
export function defineSkillSource(src: SkillSource): SkillSource

export interface SkillSource {
  /** Unique id, e.g. 'fs:/skills', 'db:tenant-skills'. */
  id: string
  /** L1: metadata only. Called at the session's first turn, or every turn (refresh). */
  list(ctx: HarnessContext): Promise<SkillMeta[]> | SkillMeta[]
  /** L2: SKILL.md body + manifest of supporting files (paths + sizes, no content). */
  load(name: string, ctx: HarnessContext): Promise<SkillDoc | null> | SkillDoc | null
  /** L3: one supporting file. `path` is already validated relative (§5). */
  readFile(name: string, path: string, ctx: HarnessContext): Promise<SkillFileContent | null> | SkillFileContent | null
  /** Optional L1 alternative for large catalogs (§4.2). */
  search?(query: string, ctx: HarnessContext): Promise<SkillMeta[]> | SkillMeta[]
  /** Optional: physical location, for executors (§7). */
  locate?(name: string, ctx: HarnessContext): { service: string; root: string } | null
  /** When to call list(). Default 'session'. */
  refresh?: 'session' | 'turn'
}

export interface SkillMeta { name: string; description: string; version?: string; meta?: Record<string, unknown> }
export interface SkillDoc extends SkillMeta {
  content: string
  manifest: Array<{ path: string; size?: number }>
}
export type SkillFileContent = { type: 'text'; text: string } | { type: 'binary'; mediaType: string; data: Uint8Array }
```

**Versions (0.4.0).** `SkillMeta.version` (and therefore `SkillDoc.version`, `Skill.version`) is an
optional string of 1–64 characters without control characters and without surrounding
whitespace; an invalid version makes the metadata invalid (`W_INVALID_SKILL` for listed skills,
`EH_CONFIG_INVALID` for `defineSkill`). It is shown by `load_skill` (§4.3) and passed to
`skill.load` hooks as `e.version` (spec 01 §5), so applications with versioned skills can audit
which version a turn used. The skills index (§4.1) and `search_skills` results never show it:
the index stays cache-stable when only versions change.

Contract tests: `skillSourceConformance(factory, options?)` in `eharness/testing`. The factory
receives the fixture skills (`SKILL_SOURCE_FIXTURE`: nested files, non-ASCII text, one extra
frontmatter field, one `version` (0.4.0; opt out with `{ version: false }`)) and returns a source serving exactly them. It checks `id`/`refresh`, metadata-only
`list()` whose items pass §1, `load()` bodies (compared trimmed) and manifests (valid relative
paths, no `SKILL.md`, UTF-8 sizes when given), exact `readFile()` text, `null` for unknown
skills/paths, `SKILL.md`, other skills' files and directories, copies on read, and well-formed `search()` / `locate()` results when
implemented.

Public helpers (exported from `eharness`, used by `fsSkillSource` and by anyone writing a source):

```ts
/** Parse a SKILL.md: YAML-subset frontmatter (§8) + body (leading blank lines removed, `\n` line
 *  endings); `name`/`description` validated (§1, description trimmed), other keys → `meta`
 *  (omitted when empty). */
export function parseSkillMarkdown(text: string): { meta: SkillMeta; body: string } | { error: string }
/** Validate a skill-relative path (§5). Returns the normalized path or an error string. */
export function validateSkillPath(path: string): { ok: true; path: string } | { ok: false; error: string }
```

## 4. What the model sees

### 4.1 Index (L1) — small catalogs

If the registry has ≤ 50 skills (`config.skillsIndexLimit`), a block is appended to the static
instructions (spec 02 §2, sorted by name; the two intro lines are literal, including the line
break; whitespace inside a description is collapsed to single spaces):

```
# Skills
Skills are playbooks you can open when relevant. Open one with load_skill(name) before doing the
task it covers; read its files with read_skill_file(name, path) only when the skill tells you to.
- pine-v6: Pine Script v6 syntax, execution model and common pitfalls. Use when writing Pine.
- …
```

Static skills (in-memory sources) are listed at the end of system block 1, skills of dynamic
sources at the end of block 2 (spec 02 §5). When both exist, the block 2 part starts with
`# More skills` instead of the header and intro; each part is sorted by name. Static skills always
win name collisions (§6), so block 1 depends only on static skills and stays byte-identical for the
session. Blocks are separated from preceding instruction text by a blank line.

### 4.2 Search — large catalogs

Above the limit, the index is replaced by a one-line hint and a `search_skills(query)` tool
returning ≤ 10 matches as text lines `- <name>: <description>` (or `No skills match.`). Sources
with `search` are queried; the others are matched by the core with a case-insensitive token match
over name + description of their `list()` results.

Layout in search mode (block 1 never depends on dynamic listings):

- static skills ≤ limit: block 1 keeps the static index (§4.1); block 2 holds, instead of the
  dynamic list, `# More skills` + `More skills are available: find them with search_skills(query),
  then open one with load_skill(name).`
- static skills > limit: block 1 holds the hint below; block 2 adds nothing.
- no static skills: block 2 holds the hint below.

```
# Skills
Skills are playbooks you can open when relevant. Find them with search_skills(query), then open one with load_skill(name) before doing the task it covers.
```

Search details: query tokens are the lowercase letter/digit runs of the query; a skill's score is
the number of distinct query tokens contained in `name + ' ' + description`. Core-matched skills
need a score > 0; results of a source's `search()` are kept only for skills that source resolved
this turn (unknown and shadowed names are dropped) and get a score ≥ 1. Ranking: score descending,
ties keep source order, then the source's result order (search) or name order (core). A failing
`search()` falls back to the core matcher (`W_SKILL_SOURCE_FAILED`). An empty query matches
nothing.

### 4.3 Tools (added automatically when any skill source is configured)

| Tool | Input | Output (string) |
|---|---|---|
| `load_skill` | `{ name }` | frontmatter summary + body + `Files:` manifest list (+ notes from `skill.load` hooks) |
| `read_skill_file` | `{ name, path }` | file text (binary → `[binary <mediaType>, N bytes]`), or `ERROR: …` |
| `search_skills` | `{ query }` | when the session can reach search mode (see below) |

Errors are returned as strings (`ERROR: skill "x" not found`, `ERROR: invalid path`). Skill content
enters history as tool results, never the system prompt (prompt-cache rule, spec 02 §6).

Exact formats (model-visible, api-stability.md):

- `load_skill`: `---`, the frontmatter summary (`name`, `description`, `version` when the doc
  has one (0.4.0; e.g. `version: "1.0"` — quoted when it would read as a number), then `meta`
  keys in order — a `meta.version` is skipped when the doc has a `version` — serialized with the
  §8 subset), `---`, the body (trimmed); then, separated by blank lines,
  `Files:` with one `- <path>` line per manifest entry (sorted, deduplicated, invalid paths
  dropped, ` (<size> bytes)` when the size is known; omitted without files), then each
  non-empty `skill.load` note.
- Errors: `ERROR: skill "<name>" not found` (unknown in this turn, or `load()` returned `null`);
  `ERROR: skill "<name>" could not be loaded: <message>` (`load()` threw or returned an invalid
  doc); `ERROR: invalid path: <reason>` (§5); `ERROR: file "<path>" not found in skill "<name>"`;
  `ERROR: file "<path>" of skill "<name>" could not be read: <message>`. The tools never throw
  for these.
- Input schemas are zod objects (`z.object({ name: z.string() })`, …). The JSON schema sent to
  the model is draft-07 with a `$schema` key, `required` fields and `additionalProperties: false`
  (pinned by `src/skills/__golden__/skill-tool-schemas.json`). Malformed input (missing or non-string fields) is rejected by
  AI SDK's input validation before `execute` runs: the model gets AI SDK's tool error
  (`AI_InvalidToolInputError: Invalid input for tool <tool>: …`), and the UI and stored part carry
  the same text (spec 04 §8).
- Tool presence is decided per session, never by what one turn resolves (stable tool list, spec
  02 §6 rule 1, ADR-0013): `load_skill` and `read_skill_file` are present whenever the session has
  at least one skill source (static skills count); when nothing resolves they answer
  `ERROR: skill "x" not found`. `search_skills` is present iff `skillsIndexLimit` is finite and
  (the static skill count exceeds it, or any dynamic source exists); it searches the turn's
  skills in index mode too. `skillsIndexLimit: Infinity` disables search entirely. The tools are
  ordinary tools of the turn (wrapped with `tool.before`/`tool.after`, subject to approval).

## 5. Addressing (normative)

- The canonical address of a skill file is `(skillName, relativePath)`. The model never sees a
  filesystem path for reading.
- `relativePath` rules: POSIX separators, no leading `/`, no `..` segment, no `\`, no NUL, no empty
  segments (so no `//`, no trailing `/`), max 512 chars. `.` segments are removed (normalization;
  a path of only `.` segments is invalid). Violations → `ERROR: invalid path: <reason>` (and never
  reach the source; sources receive the normalized path).
- `SKILL.md` itself (at the skill root, compared case-insensitively) is not addressable via
  `read_skill_file` (use `load_skill`).

This makes static skills, filesystem skills, database skills and remote skills interchangeable:
moving a skill between sources never requires editing its `SKILL.md`.

## 6. Registry, collisions, refresh

- Sources are ordered: root (static skills first, then root sources), then plugins in order.
  Within one plugin: its static skills (setup, then session phase) as one in-memory source, then
  its sources (setup, then session phase).
- Static/static duplicate name → boot error `EH_DUPLICATE_SKILL` (session-phase duplicates at
  session open).
- A static skill always wins over a dynamic source (spec 02 §7), whatever the plugin order;
  between dynamic sources the first (registry order) wins. Losers are skipped with `W_SHADOWED`.
- Listed metadata that fails §1 (or is not an object) → skipped, `W_INVALID_SKILL`.
- `list()` results are cached per `refresh` period (`'session'` = listed at the first turn and
  kept; a failed `list()` — thrown or not an array — contributes nothing, warns
  `W_SKILL_SOURCE_FAILED` and is retried at the next turn). The filesystem source additionally caches
  parsed frontmatter by file version (hash), so `refresh: 'turn'` is cheap.
- Per-turn lock (spec 02 §7): the index and the name → source mapping are resolved at turn start;
  the skill tools only address skills of that set, so a skill added mid-turn is found at the next
  turn. `load()` / `readFile()` are called on demand (content may be newer than the index).

## 7. Executable skill files (for executor plugins)

Reading needs only the logical address. Executing (e.g. `scripts/check.py`) needs a real path
inside an executor (sandbox). Rules:

- A source may implement `locate(name)` → `{ service, root }`, e.g. `{ service: 'fs', root: '/skills/pine-v6' }`.
- The core calls `locate(name)` when a `skill.load` hook exists and passes the result as
  `location` in the hook event (omitted when `locate` is absent or returns `null`; a throwing
  `locate` warns `W_SKILL_SOURCE_FAILED`).
- An executor plugin (future `sandbox`) implements the `skill.load` hook:
  - if `locate()` points to the executor's own filesystem service → use `root` directly;
  - otherwise materialize the skill files into the executor (once per session, keyed by content
    hash) and use that path.
- The hook appends a note to the `load_skill` result, e.g.
  `Executable copy: /skills/pine-v6 (sandbox). Run scripts from there.`

The core knows nothing about executors; this is entirely hook-driven.

## 8. Filesystem autoload (in `eharness/filesystem`)

```ts
filesystem({ fs: memoryFs(seed), skills: { root: '/skills', refresh: 'turn' } })
```

Adds `fsSkillSource(fs, { root })`:

- `list`: find `<root>/<name>/SKILL.md` (one level deep), parse YAML frontmatter
  (`name`, `description`, others → `meta`). Invalid or mismatched `name` → skip + `W_INVALID_SKILL`.
  The parser is a small built-in YAML **subset** (scalars, quoted strings, flow/block lists of
  scalars, one level of nesting) — no YAML dependency (CLAUDE.md rule 10). Unsupported syntax →
  `W_INVALID_SKILL`. Exactly (implemented in `parseSkillMarkdown`, P4): plain scalars (`true`/
  `false`, `null`/`~`/empty, numbers, strings), `'…'` (`''` escape) and `"…"` (JSON escapes)
  strings, one-line flow lists, block lists (`- item`, indented or not), block scalars for
  strings (`|`, `|-` literal; `>`, `>-` folded; clip or strip chomping; indentation taken from the
  first content line, no explicit indentation indicator), one nested map level whose values are
  scalars, flow lists or block scalars, blank lines, `#` comments (full line, or after whitespace
  in plain values). Rejected: `+` chomping and indentation indicators, multi-line plain/quoted
  scalars, anchors/aliases/tags, flow maps, deeper nesting, tabs in indentation, duplicate keys,
  the keys `__proto__`/`constructor`/`prototype`, several documents. `name` and `description`
  are always text: a plain value that looks like a number or a boolean keeps its raw text
  (`name: 007` → `'007'`, `description: 1.0` → `'1.0'`). The same holds for `version` (0.4.0:
  `version: 1.0` → `'1.0'`), which is read into `SkillMeta.version` (not `meta`); `version: null`
  or an empty value means no version.
- Warnings: a source reports `W_INVALID_SKILL` itself through `ctx.warn` (spec 01 §4) and skips
  the skill. `fsSkillSource` warns once per file version (`details: { source, path }`), so
  `refresh: 'turn'` does not repeat the warning every turn.
- `load`: body + manifest of every other file under `<root>/<name>/` (relative paths that pass §5
  unchanged, UTF-8 sizes from `FileMeta.size`). A name that is not a valid skill name, a missing
  `SKILL.md` or a mismatched `name` → `null`; an unparsable `SKILL.md` throws (the core answers
  `ERROR: skill "<name>" could not be loaded: invalid SKILL.md: …`).
- `readFile`: `fs.read(join(root, name, path))` after §5 validation (re-validated by the source;
  invalid names or paths → `null`).
- `locate`: `{ service: 'fs', root: '<root>/<name>' }` (the service name of the filesystem plugin).
- Exported as `fsSkillSource(fs, { root, refresh? })` from `eharness/filesystem` (id
  `fs:<normalized root>`, default `refresh: 'session'`; an invalid root or refresh throws
  `EH_CONFIG_INVALID`), usable without the plugin. The plugin's `skills` option adds one per
  session over its `fs`.
- The skills root is **hidden** from the file tools by default (`hideSkillsRoot: true`), so there
  is one official way to read skills and the agent cannot edit its own skills unless explicitly
  allowed.
