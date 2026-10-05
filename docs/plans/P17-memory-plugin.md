# P17 — Memory plugin (`eharness/memory`)

Status: in progress · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: BTeams proposal item **U5** (roadmap item "Memory plugin").

## Goal

A shipped plugin `eharness/memory` gives agents file-based long-term memory on top of the
`FileSystem` service: six tools with the same command contract as Anthropic's memory tool,
application-chosen roots (namespaces per user / contact / org), pinned files reminded every turn
without breaking the prompt cache, size limits, optimistic concurrency, and an audit callback.
The plugin decides nothing about who may read whose memory — the application does, through
`roots`. Applications that want a provider-defined memory tool supply it themselves; eharness
takes no dependency on `@ai-sdk/anthropic`.

## Specs / docs to read

- `docs/specs/08-filesystem-plugin.md` §1 (contract, `normalizePath`, `ifVersion`, conformance),
  §2 (plugin, services, prefix semantics), §3 (tool result prefixes), §4 (editing rules)
- `docs/specs/01-agent-and-plugins.md` §2 (`definePlugin`), §5 (hooks), §6 (services, `requires`)
- `docs/specs/02-context-registry.md` §2 (instructions, `refresh: 'turn'`), §5–§6 (layout, cache)
- `docs/specs/13-todos-plugin.md` (shape of a shipped-plugin spec)
- ADR-0006, ADR-0007 (subpaths), ADR-0008 (dogfooding, memory adapters only), ADR-0013
- `docs/engineering/conventions.md` (subpath import rule), `scripts/check-imports.ts`,
  `tsdown.config.ts`, `scripts/smoke.mjs`, `package.json` `exports`

**AI SDK / provider verified (2026-10-05):**

- `@ai-sdk/anthropic` latest is 4.0.71 (`https://registry.npmjs.org/@ai-sdk/anthropic/latest`).
  Its memory tool is `anthropic.tools.memory_20250818({ execute })`, model-facing name `memory`,
  provider tool id `anthropic.memory_20250818`, input a discriminated union on `command`
  (`https://github.com/vercel/ai/blob/main/packages/anthropic/src/tool/memory_20250818.ts`,
  `https://ai-sdk.dev/providers/ai-sdk-providers/anthropic`):
  `view { path, view_range?: [number, number] }`, `create { path, file_text }`,
  `str_replace { path, old_str, new_str }`, `insert { path, insert_line, insert_text }`,
  `delete { path }`, `rename { old_path, new_path }`. The app supplies `execute`.
- Therefore eharness exports an executor for that input shape and lets the app build the provider
  tool; **no dependency** (rule 10).

## Owns

`src/memory/**` (new), subpath wiring (`package.json` `exports`, `tsdown.config.ts` entry
`memory/index`, `scripts/check-imports.ts` subpaths list, `scripts/smoke.mjs`), `CLAUDE.md` rule 4
list, `src/filesystem/{types,memory}.ts` + `src/testing/file-system.conformance.ts` (optional
`move`), new spec `docs/specs/14-memory-plugin.md`, spec 08 §1, ADR-0022,
`docs/guides/memory.md` (new), `examples/memory.ts`.

## Design

```ts
import { memory } from 'eharness/memory'

memory({
  /** Resolved per turn. Paths are directory prefixes (normalized, trailing '/'). */
  roots: (ctx: HarnessContext) => Awaitable<MemoryRoot[]>,
  /** Files shown (trimmed) in the turn reminder every turn. */
  pinned?: (ctx: HarnessContext) => Awaitable<string[]>,
  maxPinnedChars?: number,      // default 2_000 (total over all pinned files)
  maxFileChars?: number,        // default 20_000 per file (create / after edit)
  protocol?: string | false,    // default MEMORY_PROTOCOL (static instruction, block 1)
  /** App-supplied single tool (e.g. a provider-defined memory tool) replacing the six tools. */
  tool?: (execute: (input: MemoryCommand) => Promise<string>) => Tool,
  /** Audit / provenance callback after every successful write. Errors → W_HOOK_FAILED. */
  onWrite?: (e: MemoryWriteEvent, ctx: HarnessContext) => Awaitable<void>,
  /** Registers compaction.before with a default flush prompt (P15). Default false. */
  flushOnCompaction?: boolean | { prompt?: string },
})

export interface MemoryRoot { path: string; write?: boolean /* default false */; label?: string }
export type MemoryCommand =                       // same shape as Anthropic memory_20250818 input
  | { command: 'view'; path: string; view_range?: [number, number] }
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; insert_text: string }
  | { command: 'delete'; path: string }
  | { command: 'rename'; old_path: string; new_path: string }
export interface MemoryWriteEvent {
  op: 'create' | 'str_replace' | 'insert' | 'delete' | 'rename'
  path: string; to?: string
  before?: { version: string; size: number }; after?: { version: string; size: number }
  toolCallId?: string
}
```

- Definition: `name: 'memory'`, `requires: ['fs']` (must come after `filesystem()` — the
  application may hide the memory roots from the generic file tools with `hiddenPrefixes`).
- **Tools** (snake_case, static order): `memory_view`, `memory_create`, `memory_str_replace`,
  `memory_insert`, `memory_delete`, `memory_rename`; inputs mirror `MemoryCommand` without
  `command`. All go through one internal `executeMemoryCommand`, also exported for `tool`.
  Results are strings; expected failures use spec 08 prefixes (`ERROR:`, `CONFLICT:`,
  `REJECTED:`); never throw (rule 6).
- **Paths:** `normalizePath` (spec 08 §1) then must lie under a root (directory semantics);
  traversal/outside → `REJECTED: <path> is outside the memory roots.`; write to a read-only root →
  `REJECTED: <path> is read-only.`; `view` of a directory lists files (path + size), of a file
  shows `cat -n` lines (`view_range` 1-based inclusive).
- **Size:** content over `maxFileChars` → `ERROR: <path> would exceed <n> characters.`
- **Concurrency:** every mutation reads the file, applies the change, writes with
  `ifVersion: <read version>` (create: `ifVersion: null` → `ERROR: <path> already exists`);
  a conflict → `CONFLICT:` (model retries). No read-before-write requirement (memory files are
  small and re-read by every command).
- **`FileSystem.move?(from, to, { ifVersion? })`** (optional, spec 08 §1): atomic rename,
  `{ ok: false, reason: 'missing' | 'exists' | 'conflict' }`. `memoryFs` implements it.
  Fallback when absent: read → write(`to`, `ifVersion: null`) → delete(`from`, `ifVersion`);
  a failure after the write deletes the copy (best effort) and returns `CONFLICT:`.
  `fileSystemConformance` gains `move` cases (`requireMove?` option, checked when present).
- **Roots / pinned in the prompt:** roots and pinned file contents are volatile per user → they
  go into a **turn-refresh instruction** (turn reminder, ADR-0013): `Memory roots:` list (path,
  read-only/writable, label) + `<pinned path="…">…</pinned>` blocks trimmed to `maxPinnedChars`
  (head + tail helper). Tool definitions and block 1 stay identical across users and turns.
- **Protocol** (block 1, static): "check memory before starting, record progress and decisions,
  assume the context may be reset at any time; keep files small and organized". Exact text is a
  constant `MEMORY_PROTOCOL` (structure public, wording not).
- **`tool` option:** when set, the six tools are not registered; the app's tool (e.g.
  `(execute) => anthropic.tools.memory_20250818({ execute })`) is added under its own name with
  the same execute semantics. Documented in the guide with that exact snippet; the plugin never
  imports a provider package.
- **`flushOnCompaction`:** registers `compaction.before` returning `{ flush: { prompt, tools:
  [memory write tools] } }` (P15).
- Nothing is stored outside the `FileSystem` (no plugin state except per-turn caches).

## Checklist

- [x] ADR-0022 "Memory on FileSystem; provider memory tools are app-supplied" (why files, why the
      Anthropic command contract, why `onWrite` is an option not a core hook — the hook list is
      closed, spec 01 §7 — why no provider dependency). Status `Proposed`.
- [x] Spec 14 `14-memory-plugin.md` (usage, tools + exact formats, paths, roots, pinned, limits,
      concurrency, `tool`, `onWrite`; flush deferred, §9); spec 08 §1 `move` + conformance; spec
      index in `docs/README.md` / `docs/architecture.md` module map.
- [x] Tests first:
  - [x] `src/memory/tools.test.ts`: every command (happy path, exact strings), traversal
        (`../`, `//`, `\`, NUL), outside root, read-only root, size limit, `ifVersion` conflict
        (concurrent writer), rename with and without `move`, rename fallback partial failure,
        `view_range` bounds, directory view, error strings never thrown; property test over
        generated paths (with and without `move`); `normalizeMemoryPath` ≡ `normalizePath`;
  - [x] `src/memory/plugin.int.test.ts`: roots resolved per turn from `ctx.runtime`; pinned files
        in the turn reminder, not in instructions (prompt-cache golden: block 1 + tools identical
        for two users); `onWrite` called once per successful write, its error → `W_HOOK_FAILED`;
        `tool` option replaces the six tools and receives a working executor; ~~`flushOnCompaction`
        registers the flush (needs P15)~~ → deferred (see Open questions);
  - [x] `src/filesystem/memory.test.ts` runs `fileSystemConformance` with `requireMove`.
- [x] Implement `src/memory/{index,plugin,tools,execute,texts,paths}.ts` importing core only via
      `../index.ts`; `memoryFs.move`.
- [x] Subpath wiring: `package.json` `exports["./memory"]` (generated by the build),
      `tsdown.config.ts` `'memory/index': 'src/memory/index.ts'`, `scripts/check-imports.ts`
      subpaths list, `scripts/smoke.mjs` import + one scripted turn, `CLAUDE.md` rule 4 list and
      layout block, `api-stability.md` subpath list.
- [x] Guide `docs/guides/memory.md`: per-user namespace + read-only org root, pinned profile,
      provider tool snippet, flush note, hiding roots from file tools; `guides/README.md` row;
      offline example `examples/memory.ts` with `memoryFs` in `examples.test.ts`.
- [x] `reference.md` (shipped plugins table); README entry point / example / guide rows;
      changeset `.changeset/memory-plugin.md` (minor); board.
- [ ] `flushOnCompaction` — blocked on P15 (`compaction.before` does not exist yet; registering an
      unknown hook is a boot error).

## Acceptance criteria

- [x] All six commands work on `memoryFs` and on an adapter without `move`.
- [x] No path outside the resolved roots can be read or written (property test over generated
      paths).
- [x] Tool list and instructions block 1 are byte-identical across two users with different
      roots/pinned files (cache golden).
- [x] `bun run check:imports` passes with `memory` in the subpath list; `node-compat` smoke
      imports `eharness/memory` (smoke script verified locally with Bun only).
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New subpath `eharness/memory` (`memory()` plugin, `executeMemoryCommand`, `MEMORY_PROTOCOL`).
- `FileSystem.move` (optional) and `memoryFs` support; `fileSystemConformance` `requireMove`.
- Model-visible: six new tool names when the plugin is used.

## Open questions

- Proposal `providerTool?: boolean` → replaced by `tool?: (execute) => Tool` (no provider
  dependency). Proposal hook `memory.write` → option `onWrite` (core hook names are a closed
  set). Both recorded for the BTeams results table.
- `roots` resolved per turn (not per session) so `runtime` changes per turn are honoured. Cost:
  one resolver call per turn. Decision made.
- Read-before-write is not required for memory tools (unlike `edit_file`): every command
  re-reads, and `ifVersion` protects concurrent writers. Decision made.
- **`flushOnCompaction` not shipped in P17.** P15 (`compaction.before` / flush) has not landed;
  the core hook list is closed, so registering `compaction.before` now would fail at boot. Most
  conservative: omit the option (no dead API), document it as "follows P15" (spec 14 §9, guide).
  `MEMORY_TOOLS` is exported so the follow-up (or an app) can pass the write tools by name.
- **Pinned paths outside the roots** are skipped (and logged via `ctx.log.warn`, no new warning
  code — core `WarningCode` untouched) rather than shown: the reminder never shows content the
  model could not `view` itself.
- **Ancestors of roots** (`view /memories` with root `/memories/u1`) are `REJECTED` like any
  outside path (strict reading of the design). Could later list only the roots below it.
- **`create` on an existing file** is an error (design: `ifVersion: null`), unlike some reference
  handlers of Anthropic's tool that overwrite. Hint text names the commands (`str_replace`,
  `insert`, `delete`), not our tool names, so it reads right with a provider tool too.
- **Directories:** `delete` / `rename` of a directory are errors (one file at a time); a
  non-atomic multi-file operation was judged too risky for 0.4.
- **`str_replace` is exact** (no whitespace-tolerant cascade like `edit_file`): the smart-replace
  helper lives in `eharness/filesystem` and may not be imported (ADR-0008); exact matching is
  the Anthropic contract.
- **`tool` option name:** the app tool is always registered as `memory` (the provider tool's
  name). No `toolName` option until someone needs it.
- **Standalone `executeMemoryCommand`** catches `onWrite` errors and passes them to an optional
  `onWriteError` (the write already happened; the result must stay truthful).
- **Invalid roots** (non-normalizable path, non-array) throw `EH_CONFIG_INVALID` — a programmer
  error — which fails the turn via the turn instruction before the commit point.

## Requests to other phases

- P15: `compaction.before` / flush API must accept the memory write tools by name. P17 did not
  ship `flushOnCompaction`; whoever lands P15 (or a P17 follow-up after it) adds the option to
  `src/memory/plugin.ts` (`compaction.before` → `{ flush: { prompt, tools: MEMORY_TOOLS minus
  memory_view } }`), spec 14 §9 and the guide's last section.
- P20: production guide links memory patterns (per-user namespace, episodic summaries via
  `compaction.after`); results table U5.

## Dependencies

P13 recommended first. Soft dependency on P15 (only for `flushOnCompaction`; land P15 first or
ship that option in P15's follow-up commit).
