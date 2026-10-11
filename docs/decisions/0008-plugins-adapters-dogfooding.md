# ADR-0008: Plugins bundle capabilities; adapters implement contracts; shipped plugins use only public API

Status: **Accepted** · Date: 2026-09-29

## Context

Earlier designs mixed "plugin" (capability) and "adapter" (storage backend). Making every
backend a plugin would duplicate logic (file tools per backend). Shipping many adapters would turn
the library into a maintenance sink.

## Decision

- A **plugin** contributes tools/skills/instructions/hooks/services/data parts.
- A **contract** (e.g. `FileSystem`) is exported by the module that needs it; an **adapter**
  implements it. Plugins accept adapters (`filesystem({ fs })`).
- The library ships **memory adapters only** plus conformance suites; other adapters live in
  `examples/` or in user land.
- Shipped plugins (`filesystem`, `mcp`) import core only through the public entry, proving the
  plugin API is sufficient.

## Consequences

+ Clear roles; small maintenance surface; third parties can publish adapters.
− Users must write (small) adapters for real storage; mitigated by examples + conformance tests.

## Alternatives considered

- Adapters-as-plugins (rejected).

## Amendment note (2026-10-11)

Naming (0.8, P39): the factory name of a plugin is its runtime `name` (`ask`, `guard`, `permissions`, `group`, `subagent`), in-memory adapters use the `inMemory` prefix, tool and skill sources end in `Source`, and every plugin, source, adapter and store factory takes one `options` object (conventions.md, "Naming"). Runtime plugin names, and so persisted plugin state, did not change. The shipped modules still use only the public API; the public surface is additionally pinned by a committed exports snapshot (`scripts/exports.snapshot.json`).
