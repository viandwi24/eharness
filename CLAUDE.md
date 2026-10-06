# CLAUDE.md — eharness

`eharness` ("easy harness") is a TypeScript library for building your own agent harness on top of
the Vercel AI SDK v7. It standardises the parts every harness reimplements — plugins, context
(instructions/tools/skills/MCP), message model, UI message streaming, session storage and
compaction — and leaves storage, infrastructure and domain logic to the developer.

It is a **library**, published to npm as `eharness`. Everything here is public API or supports it.

## Read before working

| When | Read |
|---|---|
| Always, first session | `docs/README.md` (reading order), `docs/concept.md`, `docs/architecture.md` |
| Touching a module | the matching contract in `docs/specs/` (it is the source of truth) |
| Starting a task | `docs/plans/README.md` (board) → your phase file `docs/plans/Pn-*.md` |
| Writing code | `docs/engineering/conventions.md`, `docs/engineering/testing.md` |
| Anything release/version related | `docs/engineering/release.md`, `docs/engineering/api-stability.md` |
| Wondering "why is it like this?" | `docs/decisions/` (ADRs) |

## Commands

```bash
bun install                 # install (Bun is the dev toolchain only)
bun run lint                # biome check
bun run format              # biome format --write
bun run typecheck           # tsc --noEmit
bun test                    # unit + conformance tests
bun run build               # tsdown → dist/
bun run check:package       # publint + attw on the built package
bun run check:imports       # subpath modules may import core only via src/index.ts
bunx changeset              # add a changeset (required for every user-facing change)
```

## Hard rules

1. **Specs are contracts.** `docs/specs/*` define the public API and behaviour. If code must differ
   from a spec, update the spec (and add an ADR if it changes a decision) **in the same PR**. Never
   let code and spec drift silently.
2. **Build on AI SDK primitives, never parallel types.** Use `UIMessage`, `ModelMessage`, `tool()`,
   `LanguageModel`, `createUIMessageStream`, `convertToModelMessages` directly. Do not invent our
   own message, tool or stream shapes (ADR-0001).
3. **Runtime-neutral source.** `src/` must run on Node ≥ 22 and Bun. No `Bun.*`, no `node:fs` in core.
   Node built-ins are allowed only in clearly Node-only modules (none exist in v0). Use Web APIs
   (`crypto.subtle`, `TextEncoder`, `ReadableStream`).
4. **Shipped plugins use only the public API.** `src/filesystem/**`, `src/mcp/**`, `src/storage/**`,
   `src/todos/**`, `src/memory/**`, `src/guard/**`, `src/openapi/**` and `src/testing/**` may import core only through `src/index.ts`
   (dogfooding, ADR-0008).
5. **The library ships memory adapters only.** Database/S3/JSON-file adapters are examples in
   `examples/`, never dependencies (ADR-0008).
6. **Tools return errors as strings, never throw** for expected failures (bad input, stale file,
   conflict). Throw only for programmer errors. The model must be able to read and self-correct.
7. **Every user-facing change needs a changeset** (`bunx changeset`): anything under `src/` or in
   `package.json` (CI enforces it). Docs/tests/CI/examples need none. Breaking change rules:
   `docs/engineering/api-stability.md`.
8. **Explicit return types on every exported function** (`isolatedDeclarations` is on).
9. **Scaffolding uses official commands** (`bun init`, `bunx changeset init`, `bunx biome init`, …).
   Before running any setup command, read that tool's current official docs for the exact command
   and version. Do not hand-write files a tool is supposed to generate.
10. **No new runtime dependencies** without an ADR. Allowed: peer `ai`, peer `zod`, optional peer
    `@ai-sdk/mcp`. Everything else is a devDependency.
11. **English only** in code, comments, docs, commit messages and changesets.

## Workflow for an agent session

1. Read the board (`docs/plans/README.md`), pick the task you were assigned, mark it `in progress`.
2. Read the spec sections the task links to. If something is ambiguous, write the question under
   "Open questions" in the phase file instead of guessing, and pick the most conservative option.
3. Implement in small commits. Tests first for contracts (conformance, projection, loader).
4. Run `bun run lint && bun run typecheck && bun test` before every commit; `bun run build &&
   bun run check:package` before finishing a task that touches exports.
5. Update the phase file checklist, the board, and any spec you changed. Add a changeset.
6. Commit messages: Conventional Commits (`feat(session): …`, `fix(filesystem): …`, `docs: …`).

## Layout (target)

```
src/
  index.ts          public core API (the only entry other subpaths may import)
  agent/ plugin/ registry/ messages/ stream/ session/ loop/ compaction/ skills/ errors.ts
  filesystem/       eharness/filesystem + eharness/filesystem/memory
  storage/          eharness/storage/memory
  mcp/              eharness/mcp
  todos/            eharness/todos
  memory/           eharness/memory
  guard/            eharness/guard
  openapi/          eharness/openapi
  models/           model catalog, cost (core)
  testing/          eharness/testing (conformance suites, mocks)
examples/           runnable examples, NOT published
docs/               concept, architecture, specs, decisions, engineering, plans
```

## Things that are easy to get wrong

- Message ids must sort by creation time (UUIDv7 from `src/messages/ids.ts`). Adapters rely on it.
- Kind messages (e.g. `eh.compaction`) are ordinary `UIMessage`s with `metadata.eharness.kind` and
  exactly one `data-<kind>` part. Do not add side tables for them.
- Transient data parts are never persisted and never projected to the model.
- Static instructions/tools must come before dynamic ones in the prompt (prompt-cache prefix).
- Skill file paths are relative to the skill, never filesystem paths (spec 07).
- `persistEachStep` upserts the same assistant message id repeatedly; adapters must upsert by id.
- Copy step streams with `for await … writer.write`, never `writer.merge` (chunk order is public
  API), and pass an `onError` to `toUIMessageStream` too (`uiErrorText`, spec 04 §2).
- AI SDK tracks `toolSearch` discoveries per `streamText` call; our loop has one call per step, so
  the core tracks discoveries itself (spec 02 §3.3).
- Turn operations (`send`, `respond`, `regenerate`, `edit`) throw only `EH_SESSION_BUSY` /
  `EH_SESSION_CLOSED`; everything else is a run error and `run.result` never rejects (spec 05 §2).
- Never trust client messages: only `text`/`file` parts, server-generated ids, rebuilt
  `metadata.eharness` (spec 05 §3).
- Use `instructions` (not the deprecated `system`) and `result.responseMessages` (not
  `result.response`) with AI SDK v7.
- Tool approval uses `streamText({ toolApproval })`; never `needsApproval` (deprecated). A
  `respond()` continuation must stream into the **same** UI message (`originalMessages`), and
  pending ids are consumed atomically before any tool runs (spec 11, ADR-0012).
- `await result.responseMessages` rejects on abort and when the provider call failed before
  streaming — always guard it. Aborted steps fire no `onStepEnd`; persist in `onEnd` too.
- Chunks written to the UI stream are mutated later by AI SDK (data part reconciliation):
  `structuredClone` anything you keep (turn buffer, logs).
- Tool errors: pass `String(error)` for `HarnessToolError` in `toUIMessageStream` `onError`, so UI,
  storage and the model wire carry the same text.
- Never drop a tool call without a result — answer it with an `Interrupted:` error result
  (ADR-0014). Never re-execute interrupted tools.
- Input that arrives during a turn is stored as `data-eh.input` inside the assistant message at the
  step boundary where the model saw it (ADR-0011). Stored order must equal model order.
- Volatile context goes into turn/step reminders, never into `instructions`; keep tool order stable
  (`toolOrder`) — prompt-cache prefix (spec 02 §5–6, ADR-0013).
- Nothing is persisted before the commit point of a turn (spec 05 §3); failures before it leave
  storage untouched.
