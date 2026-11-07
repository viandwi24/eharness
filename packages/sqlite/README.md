# @eharness/sqlite

SQLite implementations of every storage port that [`eharness`](../../README.md) defines: messages,
state (with compare-and-set), session lock (lease), inbox, stream log, budget ledger, activity,
schedules, outbox, handoffs, people and provider profiles (optionally sealed). Contract:
[spec 36](../../docs/specs/36-sqlite-adapters.md), decision: [ADR-0068](../../docs/decisions/0068-sqlite-adapter-package.md).

`eharness` and `ai` are peer dependencies. SQLite fits one machine: several processes on one local
file are supported, a file on a network share is not.

## Use

```ts
import { Database } from 'bun:sqlite' // or: import { DatabaseSync } from 'node:sqlite'
import { createSqliteStorage, migrate } from '@eharness/sqlite'
import { bunSqlite } from '@eharness/sqlite/bun' // or: nodeSqlite from '@eharness/sqlite/node'

const driver = bunSqlite(new Database('app.db'), { owned: true }) // WAL, foreign_keys, busy_timeout
migrate(driver) // creates what is missing, records the schema version
const storage = createSqliteStorage(driver)

const agent = createAgent({
  // ...
  messages: storage.messages,
  state: storage.state,
  lock: storage.lock,
  inbox: storage.inbox,
  streams: storage.streams,
})
// storage.budget, .activity, .schedules, .outbox, .handoffs, .people, .profiles
```

- The drivers never open a database and import no runtime module: pass the handle you opened.
  `owned: true` applies the pragmas this package wants (`journal_mode = WAL`, `foreign_keys = ON`,
  `busy_timeout` 5 000 ms). A handle without it keeps your pragmas, except `busy_timeout`, which is
  raised to at least 1 000 ms with a warning (`onWarn`).
- `prefix` (default `eh_`) names every table; `schemaSql({ prefix })` returns the DDL as
  `{ version, sql }[]` for apps that run their own migrations. Adapters never create tables.
- Pass `vault` to `createSqliteStorage` to get a `SealedProfileStore` for `profiles`.
- Wake-ups of `inbox.subscribe` and `streams.subscribe` poll every `pollMs` (default 250).

## Tests

The suites of `eharness/testing` run against both drivers (`src/conformance-suites.ts`), plus
`multiInstanceConformance` with two drivers on one temp file.

```sh
bun test ./packages/sqlite                                   # bun:sqlite (from the repo root)
bun run build                                                # Node resolves `eharness` to dist/
node --test packages/sqlite/src/conformance.node.ts          # node:sqlite, Node >= 22.5
```

On Node 22.5 to 22.12 add `--experimental-sqlite`; Node 22.18+ and 23.6+ strip TypeScript types
without a flag (older: use `--experimental-strip-types`). `node:sqlite` is experimental in Node 22
and the Node driver follows its API.

## Package checks

```sh
cd packages/sqlite && bun run build && bun run check:package
```

`check:package` runs `scripts/check-entry.ts` (no entry imports `bun:` or `node:`; the root entry
loads), publint and attw.
