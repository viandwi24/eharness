# ADR-0007: One package with subpath exports

Status: **Accepted** · Date: 2026-09-29

## Context

We want a small install, independent extensions and simple releases. A monorepo of `@eharness/*`
packages adds versioning overhead before there is any third-party ecosystem.

## Decision

Publish one package `eharness` (ESM-only) with subpaths: `.`, `./filesystem`,
`./filesystem/memory`, `./storage/memory`, `./mcp`, `./testing`. `@ai-sdk/mcp` is an optional peer
used only by `./mcp`. Split into scoped packages only when an extension needs an independent
release cadence (new ADR).

## Consequences

+ One version, one changelog, simple Changesets setup.
− A breaking change in any subpath bumps the whole package.

## Alternatives considered

- Monorepo with `@eharness/core`, `@eharness/filesystem`, … (deferred).
