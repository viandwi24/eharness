# ADR-0010: Bun for development, runtime-neutral library

Status: **Accepted** · Date: 2026-09-29

## Context

The team uses Bun everywhere. Library consumers may run Node, Bun, Deno or edge runtimes.

## Decision

Bun is the package manager, test runner and script runner. Library source uses only Web APIs and
AI SDK; no `Bun.*`, no Node built-ins in core. CI builds, packs and imports the tarball under Node
22 and 24. `engines.node >= 22` (same as `ai@7`).

## Consequences

+ Fast dev loop; broad runtime support.
− Tests run under Bun; a Node smoke test guards against Bun-only behaviour.

## Alternatives considered

- Node-only toolchain (rejected: slower, not the team's stack).
