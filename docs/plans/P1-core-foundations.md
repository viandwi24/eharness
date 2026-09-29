# P1 — Core foundations

Status: in progress · Branch: `phase/P1-core`

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
`src/registry/**` (static parts), `src/internal/**`, `src/testing/id-generator.conformance.ts`,
`src/testing/types.ts` (plus the shared `src/testing/index.ts` and `scripts/smoke.mjs` edits).

## Checklist

1. [x] `errors.ts`: `HarnessError`, `isHarnessError`, error code union, warning types, `emitWarning`
   helper (dedupe per code+key per agent).
2. [x] `messages/ids.ts`: UUIDv7 with monotonic counter (RFC 9562 §6.2 method 1) using
   `crypto.getRandomValues`; `nextId(floor?)` per-session floor (spec 03 §8); `isUuidV7`;
   `idGeneratorConformance` cases (10k ids strictly increasing, format, floor bump).
3. [x] `messages/types.ts`: `HarnessMetadata`, `HarnessMessageMeta`, `HarnessUIMessage`,
   `InferHarnessUIMessage`, `StopReason`, `TurnResult`, `PendingState` types;
   `HarnessToolError` in `errors.ts`.
4. [x] `messages/data-parts.ts`: `defineDataPart`, registry (namespacing rules, collisions),
   core parts `eh.status|usage|context|warning|input` (`data-eh.input` is persistent).
5. [x] `messages/kinds.ts`: `defineMessageKind`, core kinds `eh.compaction|notice|event|rewind`,
   `createKindMessage(kind, data)`, `isKindMessage`, auto-registration as data part.
6. [x] `messages/project.ts`: async, deterministic `project(view, { registry, tools })` per spec
   03 §6, all steps in order: `partial` trimming (spec 06 §3), kinds with `deliveredIn` dropped,
   interrupted tool calls answered with error results (ADR-0014), split at `data-eh.input`
   (ADR-0011), foreign-provider reasoning dropped on model switch, `convertToModelMessages`,
   sanitize. Golden tests incl. the round-trip rule of spec 03 §6.
7. [x] `messages/validate.ts`: `validateStoredMessages(messages, registry, policy)` over
   `safeValidateUIMessages` with `upgrade` hooks.
8. [x] `plugin/define-plugin.ts`: `definePlugin` with `const` generics; name validation;
   `HarnessHooks` types; `HarnessServices` interface (empty, augmentable).
9. [x] `agent/define-agent.ts`: config normalization, root plugin `app`, `setup` phase, static
   registries (instructions, tools incl. reserved names, skills placeholder list, data parts,
   kinds, services provides/requires/order), all boot errors of spec 01 §7. `agent.session()`
   stub throws `EH_NOT_IMPLEMENTED` until P2.
10. [x] Type-level tests (`*.test-d.ts`): data part namespacing (`data-filesystem.change`),
    `InferHarnessUIMessage` includes plugin + app + core parts, `ctx.stream.data` accepts only own
    keys.
11. [x] Export the public surface from `src/index.ts` explicitly; TSDoc on every export.

## Acceptance criteria

- [x] Every boot error in spec 01 §7 has a test that asserts the `code` and that the message names
      every involved owner.
- [x] Projection golden tests cover: plain chat, tool round-trip, data part omit/text/fn, unknown
      data part, kind projection, older boundary dropped, `partial` trimming, orphan sanitize.
- [x] 100% of exported symbols documented.

## Open questions

Resolved conservatively in P1 (specs updated where the behaviour is normative):

1. **Types of later phases live in P1 folders.** The config and hook types reference `Skill`,
   `SkillSource`, `ToolSource`, storage contracts, `SessionOptions`, `HarnessSession`, `HarnessRun`
   and `CompactionConfig`. They are declared as the specs define them in `src/registry/types.ts`
   (skills, tool sources, instructions), `src/agent/session-types.ts` (spec 05/04/11 types) and
   `src/agent/types.ts` (`CompactionConfig`). Owning phases may move them (keep the exports).
2. **`KindName` / `KindData`.** A message type cannot tell kinds from data parts, so
   `HarnessSession` got a second type parameter `Kinds` (`AgentKindTypes<C>`), and
   `agent['~types']` carries `kinds`. Spec 01 §1.2, 05 §2 and 11 §6.3 updated.
3. **Tool typing of `AgentMessageOf<C>`.** Per spec, only static app tools (`config.tools`
   records) are typed; with none, any tool part is accepted (`UITools`). When an app declares
   static tools, parts of plugin/source tools (e.g. `tool-read_file`) are not in the narrowed
   type. Revisit before 0.1 (P5/P8): maybe widen with the plugin tools' types.
4. **`metadata.eharness.model` format** (needed by projection step 5): gateway strings as-is,
   provider instances `<provider>/<modelId>` (`describeModel` in `src/internal/model.ts`);
   provider family = before `/`, then before `.`. Spec 03 §3 updated.
5. **`'text'` data part projection** uses the part name without `data-`
   (`<data type="filesystem.change">`). Spec 03 §6 updated.
6. **Unregistered kind messages** are skipped on load with `W_UNKNOWN_STORED_PART` (not
   `W_INVALID_MESSAGE`); `'keep'` keeps only message-shaped copies. Spec 03 §7 updated.
7. **Extra boot checks** (fail fast, principle 8): static tool names must match
   `^[a-zA-Z0-9_-]{1,64}$`, unknown hook names, async/throwing `setup()`, missing `model`, invalid
   `contextWindow`, non-`ToolSource` `mcp` entries, missing schemas/roles → `EH_CONFIG_INVALID`.
   Plugin data part/kind keys follow the app rule (no `.`, no `eh` prefix). Spec 01 §7 updated.
8. **Projection details:** only the newest boundary is projected; `role: 'system'` messages are
   dropped; preliminary tool outputs count as missing results; answered parts lose their
   `approval` object and fall back to `input: {}`; pending client tool calls are answered like any
   `input-available` part (spec literal — `respond`/deny patch them before any projection).
   Spec 03 §6 updated.
9. **`createKindMessage` role** is an option (default: core kind role, else `'user'`).
10. **`validateStoredMessages` returns warnings** instead of emitting them (the caller owns the
    agent's emitter and the transient-part/event routing).
11. **`config.generateId` and the id floor:** a custom generator cannot be bumped; the agent's
    internal `generateId(floor?)` ignores the floor for custom generators. Stated as an exception
    in spec 03 §8; P2 is asked to warn when such an id does not sort after the floor.
13. **`EH_NOT_IMPLEMENTED`:** `agent.session()` throws it until P2. Spec 10 §1 forbids it in a
    release, so P2 must remove every use before any release (request added to P2).
12. **`ProjectionContext.sessionId`** is passed to `project()` as `sessionId` (spec 03 §6 updated).

## Requests to other phases

Handoff notes (also added to the phase files concerned):

- P2: boot state is available through `getAgentInternals(agent)` (`src/agent/internals.ts`:
  ordered plugins, message registry, services map, static registry incl. hooks, warning emitter,
  id generator). Internal building blocks: `project()`, `validateStoredMessages()`,
  `answerDanglingToolParts()` (use with `INTERRUPTED_TURN` / `INTERRUPTED_CRASH`),
  `sanitizeModelMessages()`, `describeModel()`. `describeError` (spec 10 §3) is not implemented.
