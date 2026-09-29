# Spec 07 — Skills

Status: **Accepted** (v0). Module: `src/skills`; filesystem source in `src/filesystem`.

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
  /** Body of SKILL.md (without frontmatter). */
  content: string
  /** Supporting files, paths relative to the skill root (POSIX, no '..', no leading '/'). */
  files?: Array<{ path: string; content: string }>
  /** Extra frontmatter fields (license, compatibility, …), preserved and shown in load_skill. */
  meta?: Record<string, unknown>
}
```

A static skill is internally wrapped in an in-memory `SkillSource`. There is no separate code path.

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

export interface SkillMeta { name: string; description: string; meta?: Record<string, unknown> }
export interface SkillDoc extends SkillMeta {
  content: string
  manifest: Array<{ path: string; size?: number }>
}
export type SkillFileContent = { type: 'text'; text: string } | { type: 'binary'; mediaType: string; data: Uint8Array }
```

Contract tests: `skillSourceConformance(factory)` in `eharness/testing`.

Public helpers (exported from `eharness`, used by `fsSkillSource` and by anyone writing a source):

```ts
/** Parse a SKILL.md: YAML-subset frontmatter (§8) + body. */
export function parseSkillMarkdown(text: string): { meta: SkillMeta; body: string } | { error: string }
/** Validate a skill-relative path (§5). Returns the normalized path or an error string. */
export function validateSkillPath(path: string): { ok: true; path: string } | { ok: false; error: string }
```

## 4. What the model sees

### 4.1 Index (L1) — small catalogs

If the registry has ≤ 50 skills (`config.skillsIndexLimit`), a block is appended to the static
instructions (spec 02 §2, sorted by name):

```
# Skills
Skills are playbooks you can open when relevant. Open one with load_skill(name) before doing the
task it covers; read its files with read_skill_file(name, path) only when the skill tells you to.
- pine-v6: Pine Script v6 syntax, execution model and common pitfalls. Use when writing Pine.
- …
```

### 4.2 Search — large catalogs

Above the limit, the index is replaced by a one-line hint and a `search_skills(query)` tool
returning ≤ 10 matches as text lines `- <name>: <description>` (or `No skills match.`). Sources
with `search` are queried; the others are matched by the core with a case-insensitive token match
over name + description of their `list()` results.

### 4.3 Tools (added automatically when any skill exists)

| Tool | Input | Output (string) |
|---|---|---|
| `load_skill` | `{ name }` | frontmatter summary + body + `Files:` manifest list (+ notes from `skill.load` hooks) |
| `read_skill_file` | `{ name, path }` | file text (binary → `[binary <mediaType>, N bytes]`), or `ERROR: …` |
| `search_skills` | `{ query }` | only in search mode (§4.2) |

Errors are returned as strings (`ERROR: skill "x" not found`, `ERROR: invalid path`). Skill content
enters history as tool results, never the system prompt (prompt-cache rule, spec 02 §6).

## 5. Addressing (normative)

- The canonical address of a skill file is `(skillName, relativePath)`. The model never sees a
  filesystem path for reading.
- `relativePath` rules: POSIX separators, no leading `/`, no `..` segment, no `\`, no NUL, no empty
  segments, max 512 chars. Violations → `ERROR: invalid path` (and never reach the source).
- `SKILL.md` itself is not addressable via `read_skill_file` (use `load_skill`).

This makes static skills, filesystem skills, database skills and remote skills interchangeable:
moving a skill between sources never requires editing its `SKILL.md`.

## 6. Registry, collisions, refresh

- Sources are ordered: root (static skills first, then root sources), then plugins in order.
- Static/static duplicate name → boot error `EH_DUPLICATE_SKILL`.
- Anything involving a dynamic source → first wins, `W_SHADOWED` warning.
- `list()` results are cached per `refresh` period (`'session'` = listed at the first turn and
  kept; a failed `list()` is retried at the next turn). The filesystem source additionally caches
  parsed frontmatter by file version (hash), so `refresh: 'turn'` is cheap.

## 7. Executable skill files (for executor plugins)

Reading needs only the logical address. Executing (e.g. `scripts/check.py`) needs a real path
inside an executor (sandbox). Rules:

- A source may implement `locate(name)` → `{ service, root }`, e.g. `{ service: 'fs', root: '/skills/pine-v6' }`.
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
  `W_INVALID_SKILL`.
- `load`: body + manifest of every other file under `<root>/<name>/`.
- `readFile`: `fs.read(join(root, name, path))` after §5 validation.
- `locate`: `{ service: 'fs', root: '<root>/<name>' }`.
- The skills root is **hidden** from the file tools by default (`hideSkillsRoot: true`), so there
  is one official way to read skills and the agent cannot edit its own skills unless explicitly
  allowed.
