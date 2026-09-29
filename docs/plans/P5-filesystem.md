# P5 — Filesystem plugin

Status: done · Branch: `phase/P5-filesystem`

## Goal

The reference plugin: `FileSystem` contract, `memoryFs`, `filesystem()` plugin with the six file
tools and editing rules, the `data-filesystem.change` part, skills autoload, and the conformance
suite. Built **only** with the public API (`check:imports`).

## Specs

- 08 (all)
- 07 §8
- 01 §6 (services), 04 §3 (writer)

## Owns

`src/filesystem/**`, `src/testing/file-system.conformance.ts`.

## Checklist

1. [x] Contract types + `declare module 'eharness'` service augmentation.
2. [x] `paths.ts`: `normalizePath` (+ tests), hidden/readonly prefix helpers.
3. [x] `version.ts`: `contentVersion` (SHA-1 hex via `crypto.subtle`).
4. [x] `memory.ts`: `memoryFs(seed)` incl. `stat`, `grep`, `ifVersion` semantics, `DeleteResult`.
5. [x] `fileSystemConformance` (read/write/delete/list/ifVersion/conflict/exists/sorting/prefix/
   version-changes-iff-content-changes); run against `memoryFs`.
6. [x] `smart-replace.ts` cascade + tests ported from the predecessor behaviour (exact, trimmed,
   whitespace-normalized, ambiguity rejection, `replace_all`).
7. [x] Tools (`list_files`, `read_file` with line numbers + offset/limit, `write_file`, `edit_file`,
   `delete_file`, `grep`) with result prefixes and `classifyToolResult`.
8. [x] `lastRead` in `ctx.state` (LRU 500), staleness, read-before-edit, optimistic lock.
   Type test: `ctx.services.fs` is typed as `FileSystem` once `eharness/filesystem` is imported.
9. [x] Data part `change` written on every mutation (id = path).
10. [x] `fsSkillSource` + `skills` option + `hideSkillsRoot` default.
11. [x] Resolver form `fs: (ctx) => FileSystem` (one fs per session).
11a. [x] `toolOutputs` service (`ToolOutputStore`, spec 08 §2): read-only `/.eharness/tool-outputs`,
    hidden from `list_files`; used by `toolOutput.strategy: 'evict'`.
12. [x] Integration tests: scenario 9 and the fs half of scenario 8 of testing.md.

## Acceptance criteria

- [x] `check:imports` passes (no deep imports into core).
- [x] STALE flow: external write between read and edit → `STALE:` with new content → retry
      succeeds.
- [x] A new `SKILL.md` written to the skills root appears at the next turn with `refresh: 'turn'`.

## Open questions

- **Cross-subpath test imports** (resolved conservatively): `scripts/check-imports.ts` rejected
  any import from a subpath file outside its own subpath or `src/index.ts`, including test files,
  so `src/filesystem/*.test.ts` could not run `fileSystemConformance` / `scriptedModel` from
  `src/testing`. The script (P0-owned; P0 is done) now lets **test files** of a subpath import
  other subpaths (never core internals); non-test files keep the strict rule. The
  `fileSystemConformance` source therefore does not import `eharness/filesystem` and types its
  parameter with the structural mirror `FileSystemUnderTest` (spec 08 §1). Noted for P8.
- **`list(prefix)` semantics** (spec 08 said only "files under prefix"): adapters treat it as a
  plain string prefix (like the spec's `LIKE prefix || '%'` example); the plugin always passes
  directory prefixes ending in `/` and filters with directory semantics. Recorded in spec 08 §1.
- **`FileMeta.size`** was unspecified: UTF-8 bytes (needed for skill manifests, spec 07 §3).
- **Model-visible formats** of the file tools were unspecified: pinned in spec 08 §3 (`cat -n`
  numbering, 2000-line windows, continuation hint, exact `ERROR`/`STALE`/`CONFLICT`/`REJECTED`
  texts, grep line format and 50-hit notice).
- **Hidden paths**: `read_file` answers like a missing file, listings skip them, mutations answer
  `REJECTED: <path> is not accessible.` (a write must never silently create a hidden file).
- **"Listed explicitly"** for the tool-outputs dir means the requested `list_files` / `grep`
  prefix is the directory or inside it (`/.eharness` alone does not show it).
- **Service augmentation** targets `'eharness'` (not `'../index.ts'`), so the built
  `dist/filesystem/index.d.ts` augments the package the consumer imports; verified with a
  consumer `tsc` run (bundler and nodenext) against the packed tarball. In-repo it resolves
  through the tsconfig `paths`. Two casts in `src/session/hooks.int.test.ts` and
  `src/testing/skill-source.conformance.ts` needed `as unknown as` once `HarnessServices` gained
  required members.
- **Line-trimmed replace range** (not specified; fixed after review): ends before the last line's
  trailing whitespace; an indented needle replaces whole lines from the line start (no double
  indentation), an unindented needle keeps the file's indentation of the first line.

## Requests to other phases

- From P4 (skills, for checklist item 10 / spec 07 §8):
  - Public helpers in `eharness`: `parseSkillMarkdown(text)` (YAML subset of spec 07 §8,
    validates `name`/`description`, other keys → `meta`, body with leading blank lines removed)
    and `validateSkillPath(path)` (returns the normalized path; rejects `SKILL.md`). Build
    `fsSkillSource` with `defineSkillSource` and test it with
    `skillSourceConformance((skills) => …)` from `eharness/testing` (seed `memoryFs` with
    `<root>/<name>/SKILL.md` = `---\n<frontmatter>\n---\n<content>` plus the files). The suite
    requires `readFile` of a directory (e.g. `scripts`), of `SKILL.md` and of unknown paths to
    return `null`, the manifest to exclude `SKILL.md`, and every listed item to pass spec 07 §1.
  - The core never calls `readFile` with a path that failed `validateSkillPath`; `readFile` should
    still re-validate (defence in depth) before `fs.read(join(root, name, path))`.
  - Warnings: use `ctx.warn({ code: 'W_INVALID_SKILL', message, details: { source, path } })`
    (new `HarnessContext.warn`, spec 01 §4) for an unparsable or mismatched `SKILL.md`, and skip
    that skill. The core additionally warns `W_INVALID_SKILL` for invalid metadata returned by
    `list()`.
  - Static skills always win over your source on name collisions (spec 02 §7 / 07 §6).
  - Scenario 8's fs part (static skill + fs source, duplicates, `refresh: 'turn'` picks up a new
    `SKILL.md` next turn but not mid-turn) is yours; P4's static/dynamic part is in
    `src/skills/skills.int.test.ts` and can serve as a template.
  - `locate()` results reach `skill.load` hooks as `e.location` (spec 07 §7).
- From P6: the core now limits every tool output to `toolOutput.maxChars` (default 50_000,
  spec 09 §4). `read_file`'s window stops before `maxReadChars` (also 50_000) but the
  `(Showing lines …)` footer is appended after it, so a full-budget read is ~70 characters over
  the default limit and gets a middle cut (`TOOL_OUTPUT_TRUNCATED`) that drops a few lines.
  Suggested fix: reserve the footer inside `maxReadChars` in `renderWindow()`
  (`src/filesystem/tools.ts`), or default `maxReadChars` slightly below the core limit.
  - Resolved in P6 (orchestrator decision): `renderWindow()` now reserves room for the hint, so
    the whole `read_file` result stays within `maxReadChars`; regression tests in
    `src/filesystem/tools.test.ts` and `src/registry/tool-sources.int.test.ts`, spec 08 updated.
