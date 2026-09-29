# ADR-0002: Manual step loop (one streamText per step)

Status: **Accepted** · Date: 2026-09-29

## Context

`ToolLoopAgent`/`stopWhen` run the whole loop inside one call. We need to act *between* steps:
compaction mid-turn, per-step persistence, cost caps, hooks (`step.prepare`, `step.end`), and
guarding the wire before every request.

## Decision

The core runs a `while` loop; each iteration is one `streamText({ stopWhen: isStepCount(1) })`
whose stream is merged into one UI message stream. `prepareStep` is not used for our own logic;
hooks run in the loop instead.

## Consequences

+ Full control over what the model sees each step; proven in the predecessor harness.
− We re-implement a little of what `ToolLoopAgent` does (continue-while-tool-calls).
− An eharness agent does not implement AI SDK's `Agent` interface in v0 (roadmap: adapter).

## Alternatives considered

- Wrap `ToolLoopAgent` and use `prepareStep` (rejected: cannot persist or compact between steps cleanly; `prepareStep` cannot end the turn with custom reasons).
