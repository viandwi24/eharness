# ADR-0050: Setup flows are server-driven views from a closed vocabulary

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0049](0049-connectors-module.md)

## Context

Connecting a tool needs a different UI per connector (a key form, OAuth in a new tab, a device
code, a repository picker). Shipping UI code per connector into every app does not scale, and a
generic UI cannot be written against free-form HTML.

## Decision

1. A flow is a list of steps run by a pure engine: `startFlow`, `advanceFlow(state, { viewId,
   action, data }, deps)`, `completeOAuth({ state, code })`. The result is a `FlowState` holding
   one **view** from a closed vocabulary: `form`, `oauth`, `deviceCode`, `choose`, `confirm`,
   `status`, `error`. A UI renders these seven and nothing else; connectors add behaviour (custom
   steps), never new view types.
2. Every view has `viewId` (a salted hash of flow, step and revision) and `step`. An action must
   quote the `viewId` it answers; otherwise the engine returns `stale-view` together with the
   current state, so double submits and old tabs are harmless and a reload resumes at the same
   view. Validation problems are views with `errors`, not failures.
3. Whatever must not reach a browser (PKCE verifier, typed secrets, tokens before the connection
   exists, DCR client secrets) lives in a **scratch** that is sealed with the `SecretVault` and
   bound to the flow id; `PublicFlow` omits it. Form views show secrets as `{ set, hint }` and
   accept `{ keep: true }`.
4. The OAuth `state` is single-use and stored as a SHA-256 hash; the callback is delivered by
   `completeOAuth`, which finds the flow by it. The browser cannot inject a callback through
   `advanceFlow`.
5. Default flows are derived from `auth`, `settings`, `choose` and `test` (settings form →
   authorize or device → choose → test → status); a definition may replace or edit the steps.

## Consequences

+ One small renderer serves every connector, including future ones.
+ Flows are resumable and storable (`FlowStore`) across instances.
− Connectors needing a bespoke screen must express it in the seven views.
