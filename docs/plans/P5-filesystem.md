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
