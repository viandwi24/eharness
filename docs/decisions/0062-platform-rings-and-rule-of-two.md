# ADR-0062: Platform rings and the rule of two

Status: **Accepted** · Date: 2026-10-14 · Plan: [P46](../plans/P46-platform-rings.md)

## Context

eharness is both an open-source library and the base of four products of its maintainer: a team
agent, a coding agent, a live chat and an automation system. Until now the library grew from one
in-repo app (the team example), which pulled product features into the library and left generic
machinery stranded in the app. AI SDK 7 covers more of the agent loop itself (approvals, telemetry,
sandboxes, durable runs), so the library must be clear about what it owns.

## Decision

1. **Four rings.** Ring 0 is the core (`eharness`: session, loop, compaction, plugins, messages,
   stream, permissions, filesystem, subagent, testing); it heads to a stable 1.0 and changes only by
   ADR. Ring 1 are official modules (subpaths, Draft until they prove stable): scheduler, channels,
   identity, handoff, limits, clock, connectors, providers, http, client, code, activity. Ring 2 are
   adapters (database stores, platform transports) shipped as separate packages, never as
   dependencies of the core (ADR-0008 holds). Ring 3 are products, built on released versions.
2. **Rule of two.** A capability moves from a product into the library when two of the products
   need it. One consumer keeps it in the product.
3. **Ports first.** Every Ring 1 module that keeps state defines an async port, ships a memory
   adapter and a conformance suite in `eharness/testing`. Products keep their own database adapters.
4. **AI SDK first.** Where AI SDK 7 ships a primitive (tool approval, telemetry, sandbox sessions,
   durable agents), eharness adopts or wraps it instead of running a parallel layer.
5. **Unused modules are deprecated.** A Draft module no product uses is marked deprecated and
   removed at 1.0 unless a product adopts it (`group`, `guard`, `openapi` today; `client/react` stays
   because the live chat's web widget is a planned consumer).

## Consequences

+ A smaller, stable core for adopters; fast-moving modules are labelled as such.
+ Products stop duplicating delivery, scheduling, identity and handoff machinery.
− More subpaths to wire and document; each new module costs a spec and a conformance suite.
− Deprecations are breaking at 1.0 for anyone who adopted those modules.
