# ADR-0071: SQLite adapters ship as subpaths of `eharness`

Status: **Accepted** · Date: 2026-11-08 · Supersedes: [ADR-0068](0068-sqlite-adapter-package.md) · Plan: [P62](../plans/P62-adopter-gaps.md) · Relaxes: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0062](0062-platform-rings-and-rule-of-two.md) rule 1 (for dependency-free adapters)

## Context

ADR-0068 shipped the SQLite adapters as a separate package, `@eharness/sqlite`, because ADR-0008 and
ADR-0062 rule 1 keep database adapters out of the core package. Building it showed that the
separation buys nothing here:

- The adapters need **no npm dependency**. `bun:sqlite` and `node:sqlite` are runtime built-ins, and
  the drivers take a handle the app opened; they never import the binding (spec 36 §1).
- The split by environment is already solved by subpaths: `eharness/filesystem/node` and
  `eharness/web/node` do the same job for Node-only code.
- The npm scope `@eharness` does not exist and cannot be created, so the package could not be
  published under its name.
- A second package means a second version, a second changelog, a second trusted publisher and a
  peer-range to keep in step with `eharness`.

## Decision

1. **The adapters live in `eharness`**, in `src/sqlite`, as three subpaths:
   - `eharness/sqlite`: the adapters, `createSqliteStorage`, `migrate`, `schemaSql`, the `SqlDriver`
     types. Runtime-neutral; imports no `bun:` or `node:` module.
   - `eharness/sqlite/bun`: `bunSqlite(db, options?)` for a `bun:sqlite` handle.
   - `eharness/sqlite/node`: `nodeSqlite(db, options?)` for a `node:sqlite` handle (Node >= 22.5).
   The public API and behavior are those of spec 36, unchanged apart from the import paths.
2. **One version, one release flow.** `changeset` versions the adapters with `eharness`. The package
   `packages/sqlite`, its release wiring and the "Additional packages" section of `release.md` are
   removed.
3. **ADR-0008 and ADR-0062 rule 1 are relaxed for dependency-free adapters over runtime
   built-ins.** Rule of thumb: an adapter that needs only runtime built-ins and `eharness` itself may
   be a subpath; an adapter that needs a **third-party npm dependency** (a Postgres client, a Redis
   client, a vendor SDK) still ships as a separate package, so `eharness` never gains a dependency.
   The core still never imports an adapter subpath.
4. **Guard rails stay.** `scripts/check-imports.ts` lets `src/sqlite` import the subpaths whose ports
   it implements (`activity`, `channels`, `handoff`, `identity`, `providers`, `scheduler`) and treats
   `src/sqlite/conformance*.ts` as test support. `scripts/check-sqlite-entry.ts` proves on the built
   output that no sqlite entry imports `bun:` or `node:`, directly or through a shared chunk.
   The `node:sqlite` conformance run is `bun run test:node-sqlite`.
5. The decisions of ADR-0068 on the driver interface, one adapter per port, package-owned schema,
   polling wake-ups, stricter behavior where the copies differ, and no Postgres in this phase still
   hold.

## Consequences

+ An app installs `eharness` and imports `eharness/sqlite`; nothing else to install, version or trust.
+ No npm scope is needed. Bug fixes and releases follow the one `eharness` flow.
− `eharness` grows by about 3,000 lines and a larger export snapshot. Tree-shaking keeps unused
  adapters out of an app (`sideEffects: false`).
− The adapters follow `eharness`' version and stability tags: they start as Draft and a schema change
  needs a migration, not an edit.
− `node:sqlite` is still experimental in Node 22; the Node driver follows its API changes.

## Alternatives considered

- **Keep the separate package** (ADR-0068). Rejected: the scope is unavailable and the split bought
  nothing without a dependency to isolate.
- **A differently named package** (`eharness-sqlite`). Rejected: still a second release flow for code
  that has no dependency to isolate.
