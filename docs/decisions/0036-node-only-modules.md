# ADR-0036: Node-only modules

Status: **Accepted** · Date: 2026-10-09 · Builds on: [ADR-0007](0007-single-package-subpaths.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0034](0034-deployment-profiles.md)

## Context

The core and the shipped modules are runtime-neutral (Web APIs only). Real harnesses also need the
local disk, child processes and OS sandboxes (a CLI coding agent, a server agent running commands).
Those need `node:` built-ins. The library must offer them without making the core depend on Node.

## Decision

- **`eharness/filesystem/node` and `eharness/shell` import `node:` built-ins.** They are the only
  paths allowed to. `scripts/check-imports.ts` enforces this through its `nodeOnly` list: any
  `node:` import elsewhere in `src/` fails `bun run check:imports`.
- **They work on Node >= 22 and Bun** (Bun implements `node:`). No `Bun.*` APIs.
- **No new runtime dependencies.** Ripgrep and sandbox tools (Seatbelt, bubblewrap) are optional
  external binaries detected at runtime, with a pure fallback where one exists (grep) or a clear
  "unavailable" error string where none does (sandbox driver).
- **The core and all other subpaths stay runtime-neutral.** Node-only modules import core only
  through `src/index.ts` like every shipped module (ADR-0008) and are never imported by them.
- **Policy stays in options** (ADR-0034): root directory, ignore rules, sandbox driver, limits.

## Consequences

- Edge runtimes (workers, browsers) cannot import `eharness/filesystem/node` or `eharness/shell`;
  the rest of the package, including `memoryFs()` and the permission and subagent modules, works
  there.
- Importing a Node-only subpath on an unsupported runtime fails at import time, not at call time.
- Future Node-only modules must be added to `nodeOnly` and documented in architecture §2.
- Packaging checks (`check:package`) cover the new subpaths like any other export.
