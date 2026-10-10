# ADR-0051: Mode precedence, most-restrictive combination and pinned asks

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0017](0017-tool-risk-and-approval-decisions.md), [ADR-0049](0049-connectors-module.md)

## Decision

1. The mode of a tool is `agent tool override ?? agent capability mode ?? connection default ??
   capability default` (`allow | ask | off`).
2. The connector's modes and the app's own permission rules are **combined by the most
   restrictive** (`off` over `ask` over `allow`). The permission engine already evaluates deny,
   ask, allow in that order, so the compiled rules (`allow`, `ask`, `deny`) are simply added to
   the app's; `mergeConnectorRules` makes the same outcome visible in data.
3. **Bypass must not override an explicit ask on writes of external connectors.** An `ask` on a
   `write` or `destructive` capability of a non-built-in connector is *pinned*: listed in
   `rules.pinnedAsk` and as `toolKinds` entries `{ kind: 'other', alwaysAsk: true }`. The
   permission engine's `alwaysAsk` already asks in every mode, `bypassPermissions` included, and
   ignores allow rules, so merging `rules.toolKinds` into the engine is the whole integration.
4. Built-in connectors are never pinned and emit no allow rules: `allow` means "the app's
   permission mode decides", `ask` adds an ask rule, `off` a deny rule. Built-in tools keep the
   engine's path and protected-path analysis.

## Consequences

+ A person who sets "ask" on an external write keeps that guarantee even in bypass mode.
− Shared tools of a `combine`d connector (memory) take the most restrictive mode of the connections
  that keep them on, because rules are per tool name, not per root.
