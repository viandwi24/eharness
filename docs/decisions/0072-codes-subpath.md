# ADR-0072: `eharness/codes`, a pure-constants subpath for stop reasons and notice codes

Status: **Accepted** · Date: 2026-11-08 · Related: [ADR-0059](0059-client-subpath.md), [ADR-0071](0071-sqlite-adapters-as-subpaths.md) · Spec: [10](../specs/10-errors-and-stop-reasons.md)

## Context

`STOP_REASONS` and `NOTICE_CODES` (0.10, `src/codes.ts`) were exported only from the package root. A
second product (a TUI and server app on eharness) renders `eh.notice` messages and stop
reasons for people. Its UI talks to the core over HTTP, so it must not import the root, which pulls
the whole runtime. It therefore re-typed `'tool-pending'`, `'EH_TURN_INTERRUPTED'` and the rest by
hand, and hand-typed strings drift silently when a code is added or renamed.

`eharness/client` is not the answer: ADR-0059 limits it to runtime imports from `ai` and files inside
`src/client`, so it cannot re-export `src/codes.ts`.

## Decision

Add the subpath `eharness/codes` (`src/codes/index.ts`). It re-exports exactly the symbols the root
exports from `src/codes.ts` (`STOP_REASONS`, `NOTICE_CODES`, `KnownStopReason`, `NoticeCode`). `src/codes.ts`
has no imports, so the entry is pure constants. `src/codes.ts` stays where it is; the entry imports
it directly (the one exception to "subpaths reach core only through `src/index.ts`", which would drag
the root in), and `scripts/check-imports.ts` allows exactly that file. `scripts/check-sqlite-entry.ts`
verifies the built entry imports nothing.

## Consequences

- UIs and clients compare against constants without loading the runtime; a renamed code is a type error.
- The root keeps exporting the same objects (identity is tested), so existing imports do not change.
- Draft stability like the other subpaths; the symbols are as stable as their root exports.
- One more entry in the exports map and snapshot.
