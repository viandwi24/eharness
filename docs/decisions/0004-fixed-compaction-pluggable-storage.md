# ADR-0004: Compaction is fixed; storage is the extension point

Status: **Accepted** · Date: 2026-09-29

## Context

We explored pluggable compaction strategies (projection vs write-time, sliding windows,
summaries). Real-world strategies are few and all expressible as "summarize older turns, keep a
tail, guard the rest", whereas storage backends are unbounded (JSON, SQLite, Postgres, Redis,
existing chat tables).

## Decision

One compaction algorithm (spec 06) with knobs (`summarizeAt`, `keepLast`, `model`, `prompt`,
`select` escape hatch) plus an always-on guard. Storage is a two-method `MessageAdapter`
(+ optional `lastId`) and a two-method `StateAdapter`.

## Consequences

+ Adapters are trivial to write; conformance suites verify them.
+ One compaction path to test thoroughly.
− Exotic strategies need the `select` hook or a fork; acceptable for v0.

## Alternatives considered

- `ContextStrategy` interface with project/compact phases (rejected: too much surface for little real variety).
