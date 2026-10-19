---
"eharness": patch
---

Docs: every entry point now carries its stability label in the JSDoc of its `index.ts` (`**Stable:**`, `**Draft:**` with `@experimental`, `@deprecated` with the ADR), and every export of `eharness/group`, `eharness/guard` and `eharness/openapi` has `@deprecated` with its replacement ("removed in 1.0", ADR-0062). No runtime change. New guide `docs/guides/start-here.md` (which module do I need) and migration notes for the three deprecated modules.
