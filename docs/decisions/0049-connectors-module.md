# ADR-0049: `eharness/connectors`: definitions, connections, enablement and activation

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0013](0013-cache-friendly-prompt-layout.md), [ADR-0048](0048-providers-module.md)

## Context

Apps that let people connect tools (GitHub, a CRM, a remote MCP server) and decide, per agent, how
freely the model may use them need the same parts: definitions in code, saved connections with
credentials, per-agent choices, a setup UI that differs per connector, OAuth, and a way to turn it
all into plugins, tool sources and permission rules. The shipped plugins (files, memory, todos,
web, ask, subagents) should appear in the same list.

## Decision

1. A new subpath module `eharness/connectors` with three layers: `ConnectorDefinition` (code) →
   `Connection` (settings, status, account label; scope `workspace` | `agent`, `user` reserved;
   `defaultEnabled` = inherited by every agent) → per-agent enablement (`inherit | on | off`,
   capability modes, per-tool overrides, scope choices).
2. **No parallel config system.** A connection is a `ConfigProfile` (`kind: 'connection'`) in the
   same `ProfileStore` providers use; OAuth credentials are rows of kind `connection-credentials`
   (apart from the connection, so a refresh never rewrites settings); forms, redaction, secret
   patches and `fromEnv`-style env profiles are the providers' generic machinery, and secrets are
   encrypted by the generic `SecretVault` / `sealedProfileStore` (ADR-0052). `subscribe` has the
   `ProfileStore` shape for cross-instance invalidation.
3. **Import exception.** `eharness/connectors` may import `src/providers/index.ts` (the generic
   config layer) besides core; `scripts/check-imports.ts` has an explicit allow list. Moving the
   generic layer into core was rejected: it is not needed by the agent loop and would grow the
   core API; a later split into its own subpath keeps the names.
4. **The module imports no plugin and no MCP client.** Built-in connectors take app-supplied
   factories; a remote MCP server is an `McpSourceSpec` the app turns into a source with
   `remoteMcpSource` (`eharness/mcp`), which supplies a fresh bearer per request through the AI SDK
   transport's `authProvider`.
5. **Activation is deterministic**: builtins first in a fixed order, then connectors by id, then
   connections by id, regardless of input order (prompt-cache prefix, ADR-0013). Collisions between
   two connections of one connector are resolved by a connection-slug tool prefix; connectors with
   fixed tool names use `instances: 'single'` or `combine`.
6. **The module fetches only through an injected `fetch`**, no Node-only code.

## Consequences

+ Built-in and external tools share one enablement model and one UI.
+ Apps keep their database and encryption; the library ships memory adapters only (ADR-0008).
− Apps wire factories for built-ins and the MCP source (a few lines each, documented).
