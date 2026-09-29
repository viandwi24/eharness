# P5 — Filesystem plugin

Status: todo · Branch: `phase/P5-filesystem`

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

1. [ ] Contract types + `declare module 'eharness'` service augmentation.
2. [ ] `paths.ts`: `normalizePath` (+ tests), hidden/readonly prefix helpers.
3. [ ] `version.ts`: `contentVersion` (SHA-1 hex via `crypto.subtle`).
4. [ ] `memory.ts`: `memoryFs(seed)` incl. `stat`, `grep`, `ifVersion` semantics, `DeleteResult`.
5. [ ] `fileSystemConformance` (read/write/delete/list/ifVersion/conflict/exists/sorting/prefix/
   version-changes-iff-content-changes); run against `memoryFs`.
6. [ ] `smart-replace.ts` cascade + tests ported from the predecessor behaviour (exact, trimmed,
   whitespace-normalized, ambiguity rejection, `replace_all`).
7. [ ] Tools (`list_files`, `read_file` with line numbers + offset/limit, `write_file`, `edit_file`,
   `delete_file`, `grep`) with result prefixes and `classifyToolResult`.
8. [ ] `lastRead` in `ctx.state` (LRU 500), staleness, read-before-edit, optimistic lock.
   Type test: `ctx.services.fs` is typed as `FileSystem` once `eharness/filesystem` is imported.
9. [ ] Data part `change` written on every mutation (id = path).
10. [ ] `fsSkillSource` + `skills` option + `hideSkillsRoot` default.
11. [ ] Resolver form `fs: (ctx) => FileSystem` (one fs per session).
11a. [ ] `toolOutputs` service (`ToolOutputStore`, spec 08 §2): read-only `/.eharness/tool-outputs`,
    hidden from `list_files`; used by `toolOutput.strategy: 'evict'`.
12. [ ] Integration tests: scenario 9 and the fs half of scenario 8 of testing.md.

## Acceptance criteria

- [ ] `check:imports` passes (no deep imports into core).
- [ ] STALE flow: external write between read and edit → `STALE:` with new content → retry
      succeeds.
- [ ] A new `SKILL.md` written to the skills root appears at the next turn with `refresh: 'turn'`.

## Open questions

## Requests to other phases

- From P4 (skills, for checklist item 10 / spec 07 §8):
  - Public helpers in `eharness`: `parseSkillMarkdown(text)` (YAML subset of spec 07 §8,
    validates `name`/`description`, other keys → `meta`, body with leading blank lines removed)
    and `validateSkillPath(path)` (returns the normalized path; rejects `SKILL.md`). Build
    `fsSkillSource` with `defineSkillSource` and test it with
    `skillSourceConformance((skills) => …)` from `eharness/testing` (seed `memoryFs` with
    `<root>/<name>/SKILL.md` = `---\n<frontmatter>\n---\n<content>` plus the files). The suite
    requires `readFile` of a directory (e.g. `scripts`) and of unknown paths to return `null`, and
    the manifest to exclude `SKILL.md`.
  - The core never calls `readFile` with a path that failed `validateSkillPath`; `readFile` should
    still re-validate (defence in depth) before `fs.read(join(root, name, path))`.
  - `SkillSource.list()` has no warning channel: `HarnessContext` exposes no `warn`. Spec 07 §8
    asks for `W_INVALID_SKILL` on unparsable/mismatched `SKILL.md`. Options: return nothing for
    the bad skill and log via `ctx.log.warn` (conservative), or request a core warning API from
    the orchestrator. The core itself warns `W_INVALID_SKILL` only for invalid metadata returned
    by `list()`.
  - Scenario 8's fs part (static skill + fs source, duplicates, `refresh: 'turn'` picks up a new
    `SKILL.md` next turn but not mid-turn) is yours; P4's static/dynamic part is in
    `src/skills/skills.int.test.ts` and can serve as a template.
  - `locate()` results reach `skill.load` hooks as `e.location` (spec 07 §7).
