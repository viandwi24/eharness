# P1 — Core foundations

Status: todo · Branch: `phase/P1-core`

## Goal

All pure, I/O-free building blocks of the core: errors, ids, the message model (metadata, data
parts, message kinds, projection, validation), plugin and agent definitions with boot validation,
services, and the static parts of the registry. No model calls yet.

## Specs

- 01 (all), 02 §1–§2, §3.1, §5–§7, 03 (all), 10 §1–§2, §4
- 06 §3 (`CompactionPayload` schema), §5.1 (turn grouping, `partial` semantics), §6 step 1
  (sanitize) — needed by projection

## Owns

`src/errors.ts`, `src/messages/**`, `src/plugin/**`, `src/agent/**` (definition + validation only),
`src/registry/**` (static parts), `src/internal/**`.

## Checklist

1. [ ] `errors.ts`: `HarnessError`, `isHarnessError`, error code union, warning types, `emitWarning`
   helper (dedupe per code+key per agent).
2. [ ] `messages/ids.ts`: UUIDv7 with monotonic counter (RFC 9562 §6.2 method 1) using
   `crypto.getRandomValues`; `nextId(floor?)` per-session floor (spec 03 §8); `isUuidV7`;
   `idGeneratorConformance` cases (10k ids strictly increasing, format, floor bump).
3. [ ] `messages/types.ts`: `HarnessMetadata`, `HarnessMessageMeta`, `HarnessUIMessage`,
   `InferHarnessUIMessage`, `StopReason`, `TurnResult`, `PendingState` types;
   `HarnessToolError` in `errors.ts`.
4. [ ] `messages/data-parts.ts`: `defineDataPart`, registry (namespacing rules, collisions),
   core parts `eh.status|usage|context|warning|input` (`data-eh.input` is persistent).
5. [ ] `messages/kinds.ts`: `defineMessageKind`, core kinds `eh.compaction|notice|event|rewind`,
   `createKindMessage(kind, data)`, `isKindMessage`, auto-registration as data part.
6. [ ] `messages/project.ts`: async, deterministic `project(view, { registry, tools })` per spec
   03 §6, all steps in order: `partial` trimming (spec 06 §3), kinds with `deliveredIn` dropped,
   interrupted tool calls answered with error results (ADR-0014), split at `data-eh.input`
   (ADR-0011), foreign-provider reasoning dropped on model switch, `convertToModelMessages`,
   sanitize. Golden tests incl. the round-trip rule of spec 03 §6.
7. [ ] `messages/validate.ts`: `validateStoredMessages(messages, registry, policy)` over
   `safeValidateUIMessages` with `upgrade` hooks.
8. [ ] `plugin/define-plugin.ts`: `definePlugin` with `const` generics; name validation;
   `HarnessHooks` types; `HarnessServices` interface (empty, augmentable).
9. [ ] `agent/define-agent.ts`: config normalization, root plugin `app`, `setup` phase, static
   registries (instructions, tools incl. reserved names, skills placeholder list, data parts,
   kinds, services provides/requires/order), all boot errors of spec 01 §7. `agent.session()`
   stub throws `EH_NOT_IMPLEMENTED` until P2.
10. [ ] Type-level tests (`*.test-d.ts`): data part namespacing (`data-filesystem.change`),
    `InferHarnessUIMessage` includes plugin + app + core parts, `ctx.stream.data` accepts only own
    keys.
11. [ ] Export the public surface from `src/index.ts` explicitly; TSDoc on every export.

## Acceptance criteria

- [ ] Every boot error in spec 01 §7 has a test that asserts the `code` and that the message names
      every involved owner.
- [ ] Projection golden tests cover: plain chat, tool round-trip, data part omit/text/fn, unknown
      data part, kind projection, older boundary dropped, `partial` trimming, orphan sanitize.
- [ ] 100% of exported symbols documented.

## Open questions

## Requests to other phases
