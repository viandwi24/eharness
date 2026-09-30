# Contributing

## Setup

```bash
bun install
bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports
```

`bun test` also runs every example offline (`examples/examples.test.ts`, scripted models) and
checks that the README quick start equals `examples/quick-start.ts`.

Requires Bun (version pinned in `package.json` → `packageManager`). The published library itself
runs on Node ≥ 22 and Bun.

## Before you code

1. Read `docs/concept.md` and `docs/architecture.md`.
2. Find the spec for the area you change in `docs/specs/`. Specs are contracts: if your change
   alters behaviour or API, update the spec in the same PR. If it changes a design decision, add
   or supersede an ADR in `docs/decisions/`.
3. Check `docs/plans/README.md` for who owns what.

## Pull requests

- Small and focused. Conventional Commit title (`feat(session): …`).
- Tests for every behaviour change (`docs/engineering/testing.md`).
- A changeset for anything under `src/` or in `package.json`: `bunx changeset`
  (`docs/engineering/release.md` §3). CI enforces it. Docs, tests, CI and examples need none.
- User-facing features need docs: the README overview, a guide in `docs/guides/` for depth, and a
  runnable offline example registered in `examples/examples.test.ts`.
- Breaking changes follow `docs/engineering/api-stability.md`.

## Writing adapters

You do not need to contribute adapters here: implement `MessageAdapter`, `StateAdapter`,
`FileSystem` or `SkillSource` in your own project and verify them with the conformance suites from
`eharness/testing`. Publishing them as separate packages (`eharness-adapter-*`) is welcome.

## Releases

Maintainers only; fully automated through the "version packages" PR
(`docs/engineering/release.md`).
