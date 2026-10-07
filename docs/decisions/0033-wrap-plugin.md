# ADR-0033: `wrapPlugin`: composing plugins through the public API

Status: **Accepted** · Date: 2026-10-07 · Builds on: [ADR-0001](0001-build-on-ai-sdk-primitives.md), [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0030](0030-llm-approval-guard-plugin.md)

## Context

A plugin is an opaque value (`HarnessPlugin`). Applications often need per-request configuration
of a shipped plugin: a judge model or policy for `approvalGuard()` resolved per run, extra
instructions for `memory()`, a tenant-specific filesystem. Shipped plugins take their options at
construction, but the request is only known when a session opens. The only way to compose today is
to read the internal `plugin['~def']` shape, which is not public API and may change in any minor.

## Decision

- **`wrapPlugin(plugin, overrides?)` is core public API.** It returns an ordinary plugin built with
  `definePlugin`, preserving the inner plugin's `version`, `provides`, `requires`, `dataParts`,
  `messageKinds` and (by default) `name`, so boot validation (spec 01 §7), the closed hook list and
  hook order are unchanged. `'~def'` stays internal.
- **Interception points are the existing seams:** `setup(ctx, next)`, `session(ctx, next)` and
  `hooks.<name>(...args, next)`. `next` calls the inner implementation. A hook override wraps the
  inner registration where it was made, so ordering never moves; the wrapper decides how to combine
  results (for `tool.approve` it can stay tighten-only by never returning `'approved'`).
- **`next.using(other)`** runs the session phase of another plugin with the same context. This is
  the per-request configuration path for plugins configured at construction: build the plugin from
  `ctx.runtime` inside `session` and delegate. It needs no new option types on shipped plugins.
- **Renaming is allowed but discouraged** (`overrides.name`): it moves data part types and persisted
  state to a new namespace.
- **No read-only accessor to the definition** is exposed: it would freeze the internal shape as
  API; the wrapper covers the use cases.

## Alternatives considered

- Exposing `'~def'` or a `pluginParts()` accessor: freezes internals; callers would re-implement
  phase and hook merging.
- Per-plugin "options resolved from ctx" in every shipped plugin: repeated per plugin, and does not
  help third-party plugins.

## Consequences

- Additive public API (minor in 0.x per `api-stability.md`); no behaviour change when unused.
- A wrapped plugin's `ctx.plugin.name` and state namespace are the wrapper's name.
- Overriding `session` without calling `next` replaces the inner session contribution, including
  its `dispose`; the wrapper owns it from then on.
