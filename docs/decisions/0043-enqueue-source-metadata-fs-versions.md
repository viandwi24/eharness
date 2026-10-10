# ADR-0043: Caller id on the turn, `enqueue` app metadata, optional `FileSystem` versions

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0040](0040-enqueue-timers-and-ids.md), [ADR-0042](0042-peek-child-identity-spawn-cap.md)

## Context

The team example (P32 R18, R21-R24) found generic gaps: a turn made from `enqueue(…, { id })` did
not expose the caller id, so an app matched it by the inbox id only known after `enqueue` returned;
`enqueue` could not mark its input; `FileSystem` kept no history so apps could not list or restore
versions; and two requests (sweeper mapping, peek token stats) looked app-specific.

## Decision

- **R22**: `TurnInfo.source = { kind: 'inbox', id, key?, ids, keys }` and
  `metadata.eharness.inboxKey` (and `collected[].inboxKey`). Derived from the item's existing
  `dedupeKey`; no adapter change.
- **R23**: `EnqueueOptions.metadata` (plain JSON, 16 KiB) stored as `metadata.app`. `enqueue` is a
  server API, so it is trusted; a client `app` key (only with `acceptClientMetadata`) is overridden by it and
  `input.submit` cannot alter it. The namespaced key keeps it apart from client-accepted flat keys and from the rebuilt
  `metadata.eharness`. Serialized in the inbox as `SerializedInput.app` (re-validation on the
  holder keeps it, unlike `appMetadata`).
- **R21**: optional `FileSystem.versions?` / `readVersion?` (+ `author` hint on writes), newest
  first, restore = write. Optional methods follow the `move` / `readBytes` style; `memoryFs`
  implements them (bounded, survives delete); conformance `requireVersions`. Tools unchanged.
- **R24 closed as app code**: `pending()` yields session ids only, and a session id carries no
  agent identity; the agent mapping is application knowledge. Guide note added.
- **R18 residue closed**: context tokens need the resolved registry (plugins, tools, instructions),
  which is what `peek` deliberately does not run, and they are not stored. Documented in spec 05.

## Consequences

Minor release, additive. Third-party `FileSystem` adapters are unaffected; adapters that keep
history can implement the two methods and run the conformance flag.
