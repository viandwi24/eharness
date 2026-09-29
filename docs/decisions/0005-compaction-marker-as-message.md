# ADR-0005: Compaction markers are ordinary kind messages

Status: **Accepted** · Date: 2026-09-29

## Context

Loading "from the last compaction to the newest message" seemed to force the database adapter
and the compaction logic into one component.

## Decision

A compaction result is saved as a normal `UIMessage` of kind `eh.compaction` (one data part,
`metadata.eharness.kind`). Its payload carries `resumeFromId`. The core stores a pointer
(`markerId`, `resumeFromId`) in session state, so loading is one range query
(`load({ fromId })`). Without the pointer, the loader pages backwards until it finds a boundary.

## Consequences

+ Adapters never know compaction exists; any adapter works.
+ History stays complete (markers render as dividers); crash-safe (append-only).
− Assembly must reorder (marker first) and drop superseded markers; specified in spec 05 §5.

## Alternatives considered

- Separate checkpoint table / adapter method (rejected: couples storage to compaction).
