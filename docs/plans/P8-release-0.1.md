# P8 — Examples, README, 0.1.0 release

Status: todo · Branch: `phase/P8-release`

## Goal

Make eharness usable by someone who has never seen this repo, and publish `0.1.0`.

## Owns

`examples/**`, `README.md`, `docs/guides/**` (new), release housekeeping.

## Checklist

1. [ ] `examples/basic-cli.ts` — agent + filesystem(memoryFs) + terminal rendering via
   `readUIMessageStream` (`@ai-sdk/tui` needs the `Agent`-interface adapter, roadmap).
2. [ ] `examples/next-route.ts` — POST `handleChatRequest` + GET attach route handlers,
   `useChat<InferHarnessUIMessage>` snippet with approvals (`sendAutomaticallyWhen`) and a
   `data-eh.input` renderer.
3. [ ] `examples/json-file-storage.ts` — `MessageAdapter` + `StateAdapter` on JSON files (Node),
   passing conformance.
4. [ ] `examples/postgres-storage.ts` — spec 05 §10 schema, adapter, advisory-lock `SessionLock`,
   passing conformance when `DATABASE_URL` is set (skipped otherwise).
5. [ ] `examples/custom-fs-adapter.ts` — a `FileSystem` over a key-value store, passing conformance.
6. [ ] `examples/plugin-authoring.ts` — a small plugin with a service, data part, hook, state.
7. [ ] `docs/guides/`: getting-started, writing-a-plugin, writing-a-storage-adapter,
   rendering-data-parts, skills, approvals-and-interaction, subagents (tool + child session +
   preliminary results + `addUsage`). Short, runnable snippets only.
8. [ ] README: install, 30-line quick start, links to guides/specs, status badge, compatibility
   table (eharness ↔ ai).
9. [ ] Examples are typechecked in CI (`tsconfig` includes `examples`).
10. [ ] Set every spec's status line to "Accepted (reviewed for 0.1.0)"; list anything that stays `experimental_`.
11. [ ] Changeset `minor` → `0.1.0` with a summary of the feature set; merge the version PR;
    verify provenance on npm.

## Acceptance criteria

- [ ] Following getting-started from a clean directory works on Node 22 and Bun.
- [ ] `eharness@0.1.0` on npm with provenance; GitHub release created by the workflow.

## Open questions

## Requests to other phases
