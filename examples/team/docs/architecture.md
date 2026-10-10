# Architecture (stub)

See [P32](../../../docs/plans/P32-team-example.md) §3-§6. Layers of `server/src`:

- `domain/` pure types and rules; `app/` use cases over ports; `infra/` SQLite, Drizzle and the
  eharness wiring (the only layer importing `eharness`, `drizzle-orm`, `bun:sqlite`); `http/`
  OpenAPIHono routes and zod schemas; `main.ts` the composition root. `test/layering.test.ts`
  enforces it.
- `infra/eh/storage.ts`: message, state, lock, inbox and budget-ledger adapters.
  `infra/eh/library-fs.ts`: the library and memory `FileSystem`.
  `infra/eh/agent-factory.ts`: definition row -> `HarnessAgent`, cached per `agentId@version`.

To be written as milestones land: memory model, chat and approval flows (M3-M4), routines (M7),
run and deploy (M8).
