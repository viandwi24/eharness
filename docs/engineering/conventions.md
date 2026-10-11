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
- Internal helpers that must not be public live in `src/internal/` and are never re-exported (the
  two small exceptions, `errorText` and `isRecord` of `src/internal/util.ts`, are exported from
  `src/index.ts` so subpaths do not copy them).
- Core folders form a layered graph without runtime import cycles: messages/models/errors/internal
  <- plugin/registry/skills <- compaction <- loop <- session <- agent. `scripts/check-cycles.ts`
  (part of `bun run check:imports`) fails on a cycle between top-level core folders. A helper that
  two layers need moves down, it is not imported upwards.
- Long-running operations (a turn, a session handle, the step loop) are module-level phase
  functions that take one explicit state object (`TurnCtx`, `SessionCtx`, `StepsCtx`), not
  closures over dozens of variables; test kits (`test-kit.ts`) are never imported by production
  code.
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
- No classes in the public API except error classes (`HarnessError`, `HarnessToolError` and subclasses of
  `Error` such as `SummarizeError`, `ClassifierUnavailableError`, `HarnessHttpError`): `instanceof` and `code`
  checks need a class. Everything else is a plain object returned by a factory.
- Async boundaries: public methods that may do I/O return `Promise`; pure helpers are sync.
- Use `Awaitable<T> = T | Promise<T>` for user-supplied callbacks.

## Naming

| Thing | Convention | Example |
|---|---|---|
| Definition helpers | `defineX` | `defineHarnessAgent`, `defineSkill`, `defineDataPart` |
| Plugin factories | the plugin's runtime `name`, camelCased (the factory name and `plugin.name` never differ) | `filesystem()`, `ask()`, `guard()`, `permissions()`, `group()`, `subagent()` |
| Tool / skill sources | `<thing>Source` | `mcpServerSource()`, `openApiSource()`, `remoteMcpSource()`, `fsSkillSource()` |
| Service / client factories | `create<Thing>` for things with live state or methods that are not plugins or adapters | `createHarnessHttp()`, `createHarnessClient()`, `createProviderManager()`, `createPermissionEngine()` |
| Adapter factories | lower camel `<backend><Contract>`; the in-memory ones start with `inMemory` (`memory` alone means the memory plugin) | `inMemoryFs()`, `inMemoryMessages()`, `inMemoryState()`, `diskFs()` |
| Factory arguments | every plugin, source, adapter and store factory takes ONE options object, named `options` (no positional arguments mixed with options); pure helpers may stay positional | `diskFs({ root })`, `openApiSource({ spec, name })`, `sealedProfileStore({ inner, vault })` |
| Run / session methods | `run.toResponse()` is the safe HTTP answer (waits for `accepted`, proper status); `run.toStreamResponse()` streams at once; `session.edit({ messageId, input })` and `regenerate({ messageId? })` take one object; `session.abort()` is awaitable and cross-process | |
| Option types | `<Thing>Options` for arguments of a function, plugin factory, service or per-call method (the default); `<Section>Config` only for `HarnessAgentConfig` and the sections nested in it (`LoopConfig`, `CompactionConfig`, `BudgetConfig`, ...) | `SendOptions`, `SubagentOptions`, `CompactionConfig` |
| Error codes | `EH_UPPER_SNAKE` | `EH_SESSION_BUSY` |
| Warning codes | `W_UPPER_SNAKE` | `W_SHADOWED` |
| Core data parts / kinds | `eh.<name>` | `data-eh.status`, `eh.compaction` |
| Tool names | `snake_case` | `read_file`, `load_skill` |
| Hooks | `area.event` | `tool.before`, `compaction.prompt` |

## Behavioural conventions

- **Tools never throw for expected failures**; return `ERROR:` / `STALE:` / `CONFLICT:` / `REJECTED:`
  strings (spec 08 §3). Throwing is reserved for bugs.
- **Public paths throw `HarnessError` with a code**, never a bare `Error` / `TypeError`; codes live in
  `src/codes.ts` and are documented in spec 10. `bun run lint` (`scripts/check-throws.ts`) fails on an
  unmarked `throw new Error(…)` in non-test `src/`; mark internal assertions with
  `// plain-error: <reason>`.
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
- Mark unstable API with `@experimental` in TSDoc. A single experimental symbol gets an
  `experimental_` prefix; Draft modules and sections (api-stability.md, "Draft modules and
  sections") keep their plain names, with the status in the TSDoc and the stability table.

## Commits and PRs

- Conventional Commits: `feat(scope): …`, `fix(scope): …`, `docs: …`, `test: …`, `chore: …`,
  `refactor: …`. Scopes: `agent`, `plugin`, `registry`, `messages`, `stream`, `session`, `loop`,
  `compaction`, `skills`, `filesystem`, `storage`, `mcp`, `testing`, `ci`, `release`.
- One changeset per user-facing change (release.md §3).
- PRs that change a spec or ADR say so in the title (`spec(05): …`).
