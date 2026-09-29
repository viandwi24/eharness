# ADR-0003: UIMessage is the storage form

Status: **Accepted** · Date: 2026-09-29

## Context

History must render in UIs after reload *and* be re-sent to the model. The predecessor stored
turns in a custom shape and derived both UI and model messages from it.

## Decision

Messages are stored as `UIMessage` (JSON). Model messages are always a projection
(`convertToModelMessages` + registry-driven data part and kind projection). The stored assistant
message is accumulated by AI SDK (`createUIMessageStream` `onStepEnd` / `onEnd`) from the exact
chunks sent to the client.

## Consequences

+ What the user saw is what is stored; reload renders identically.
+ Custom content (data parts, kinds) needs no side tables.
− Every projection rule must be explicit (default: custom parts are omitted).
− Provider-specific round-trip details (reasoning signatures) rely on AI SDK's conversion; covered
  by a round-trip test.

## Alternatives considered

- Store `ModelMessage[]` plus a UI shadow (rejected: two sources of truth).
