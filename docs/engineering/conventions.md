# Conventions

## Toolchain

| Concern | Tool | Notes |
|---|---|---|
| Package manager, scripts, tests | Bun (`packageManager: bun@<pinned>`) | dev only |
| Types | TypeScript 7 (`tsc --noEmit`) | `strict`, `isolatedDeclarations`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` |
| Build | tsdown | ESM only, `.js` + `.d.ts` (`"type": "module"`) via isolated declarations, `exports` generated |
| Lint + format | Biome | `biome check` in CI, `biome format --write` locally |
| Package checks | publint, `@arethetypeswrong/cli` (profile `esm-only`) | `bun run check:package` |
| Versioning | Changesets v3 | see release.md |

Install versions are whatever the official docs recommend at scaffold time (P0); after that,
Dependabot keeps them current. TypeScript 7 is the native (Go) compiler: P0 verifies that tsdown's
isolated-declarations dts path and attw work with it, and pins the major here if they do not.
Verified in P0 with TypeScript 7.0.2, tsdown 0.23.0 and attw 0.18.5: no pin needed.

## Source layout

- One concept per folder (`src/session`, `src/compaction`, …). Folder exports through its own
  `index.ts`; `src/index.ts` re-exports the public surface explicitly (no `export *`).
- File names: kebab-case (`load-context.ts`). Tests next to code: `load-context.test.ts`.
- Internal helpers that must not be public live in `src/internal/` and are never re-exported.
- Subpath modules (`src/filesystem`, `src/storage`, `src/mcp`, `src/testing`) import core only via
  `../index.ts` (rule enforced by `scripts/check-imports.ts` in CI). Test files of a subpath may
  also import other subpaths (e.g. a filesystem test using `src/testing`), never core internals.

## TypeScript style

- Exported functions/constants have explicit types (required by `isolatedDeclarations`).
- Prefer `interface` for public object contracts, `type` for unions and helpers.
- Public generics use descriptive names (`Message`, `Tools`), not single letters, when exported.
- `const` type parameters for `define*` functions so literal names (plugin names, part keys) are
  preserved for inference.
- No `any` in public types. `unknown` + narrowing inside.
- No classes in the public API except `HarnessError`. Factories return plain objects.
- Async boundaries: public methods that may do I/O return `Promise`; pure helpers are sync.
- Use `Awaitable<T> = T | Promise<T>` for user-supplied callbacks.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Definition helpers | `defineX` | `defineHarnessAgent`, `defineSkill`, `defineDataPart` |
| Plugin factories | lower camel noun | `filesystem()`, `mcpServer()` |
| Adapter factories | lower camel `<backend><Contract>` | `memoryFs()`, `memoryMessages()`, `memoryState()` |
| Error codes | `EH_UPPER_SNAKE` | `EH_SESSION_BUSY` |
| Warning codes | `W_UPPER_SNAKE` | `W_SHADOWED` |
| Core data parts / kinds | `eh.<name>` | `data-eh.status`, `eh.compaction` |
| Tool names | `snake_case` | `read_file`, `load_skill` |
| Hooks | `area.event` | `tool.before`, `compaction.prompt` |

## Behavioural conventions

- **Tools never throw for expected failures**; return `ERROR:` / `STALE:` / `CONFLICT:` / `REJECTED:`
  strings (spec 08 §3). Throwing is reserved for bugs.
- **No hidden I/O at definition time.** `define*` functions and `setup` are pure.
- **No global state.** Everything hangs off an agent or session instance. Two agents in one process
  never share caches.
- **Deterministic output** for anything that reaches the prompt (sorting, stable joins).
- **Logging** through `ctx.log` (default: no-op for debug, `console.warn` for warn/error). Never
  log message content at info level.
- **Web APIs only** in `src/` (`crypto.subtle`, `TextEncoder`, `ReadableStream`, `AbortSignal`).

## Docs in code

- Every exported symbol has a TSDoc comment: one-line summary, then details, `@example` for
  entry points. Link to the spec section (`@see docs/specs/05-session-and-storage.md#4`).
- Mark unstable API with `@experimental` in TSDoc **and** an `experimental_` prefix
  (api-stability.md).

## Commits and PRs

- Conventional Commits: `feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`, `chore: …`,
  `refactor: …`. Scopes: `agent`, `plugin`, `registry`, `messages`, `stream`, `session`, `loop`,
  `compaction`, `skills`, `filesystem`, `storage`, `mcp`, `testing`, `ci`, `release`.
- One changeset per user-facing change (release.md §3).
- PRs that change a spec or ADR say so in the title (`spec(05): …`).
