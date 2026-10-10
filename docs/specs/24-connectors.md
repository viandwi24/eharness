# Spec 24 — Connectors (`eharness/connectors`)

Status: **Draft (0.8)**. Module: `src/connectors/*`. Builds on spec 01 (plugins), 09 (tools and MCP),
18 (permissions), 23 (providers: the generic config layer), ADR-0049..0052.

The library half of a Claude-style connectors system. Three layers:

1. **`ConnectorDefinition`** (code): what a connector is, how it authenticates, its capabilities and
   what it contributes to an agent.
2. **Connection** (data): one configured instance: settings, secrets, status, account label, scope.
3. **Enablement** (data, per agent): whether the agent uses the connection and how freely.

The module imports core through `src/index.ts` and the generic config layer of `eharness/providers`
(ADR-0049); it imports no plugin and no MCP client; it fetches only through an injected `fetch`;
there is no Node-only code. Apps supply storage, encryption, the OAuth callback route and the UI.

## 1. Connector definition

```ts
defineConnector({
  id, version, name, description, icon?, category,
  source: 'builtin' | 'curated' | 'custom',
  scopes: Array<'workspace' | 'agent' | 'user'>,        // 'user' is reserved
  auth: { type: 'none' }
      | { type: 'apiKey', fields: ZodObject }            // merged into the settings form
      | { type: 'oauth2', client?, authorizationUrl?, tokenUrl?, scopes, pkce: true,
          dcr?: 'auto' | 'never', resource?, discovery?: 'mcp', serverUrl?, when?, clientAuth? }
      | { type: 'deviceCode', client?, deviceAuthorizationUrl, tokenUrl, scopes, when? },
  settings?: ZodObject,                                  // ehMeta form hints, secrets declared
  capabilities: Array<{ id, title, description, kind: 'read'|'write'|'destructive'|'external',
                        tools: string[], defaultMode: 'allow'|'ask'|'off' }>,
  instructions?: string,                                 // static block
  scopeDefaults?: { [scope]: { label?, defaultEnabled?, defaultModes? } },
  instances?: 'prefix' | 'single',
  toolPrefix?: 'always' | 'multiple' | 'never',          // default 'multiple'
  activate?(ctx) => plugin | toolSource | McpSourceSpec | array | void,
  combine?(ctxs) => ...,                                 // one contribution for all connections
  test?(ctx) => { ok, message?, accountLabel?, capabilities? },
  choose?(ctx) => ChooseSpec | undefined,
  flow?: FlowStepDef[] | ((defaults) => FlowStepDef[]),
})
```

`defineConnector` validates (id pattern, scopes, unique capability ids, a tool in one capability,
no collision between auth fields and settings) and throws `EH_CONFIG_INVALID`
(`details.reason: 'definition-invalid'`). `connectorSchema(def)` is the merged settings schema,
`connectorForm(def)` its `formSpec`, `describeConnector(def)` what a UI shows (no functions).

`activate(ctx)` receives: `connection` (`id`, `label`, `scope`, `accountLabel`, `getAccessToken()`),
validated `settings` (secrets included: never log them), `choices`, `agent`, `modes` (every
capability), `capabilities` (not `off`), `tools` (not `off`, the connector's own names),
`toolModes`, `toolPrefix`, `slug`, `fetch`. `OAuth2Auth.when(settings) === false` skips the
authorization step (the custom MCP connector with a header token). Capabilities discovered at
connect time (`test` returns `capabilities`) are stored on the connection and replace the
definition's (`capabilitiesOf`).

## 2. Setup flows

A flow is a list of steps run by a pure engine (ADR-0050). Default steps, derived from the
definition and skipped when they do not apply: `settings` (form of the auth fields and settings),
`authorize` (OAuth: discovery, client from the admin config or dynamic registration, PKCE, state)
or `device`, `choose`, `test`. A definition may replace or edit them (`flow`).

```ts
startFlow({ definition, scope, scopeId?, label?, connection? /* reconnect */, defaultEnabled? }, deps): FlowState
advanceFlow(state, { viewId, action: 'submit'|'poll'|'back'|'cancel'|'retry', data? }, deps): AdvanceResult
completeOAuth({ state, code?, error?, errorDescription? }, flowStore, deps)
flowCompletion(state, deps)    // secrets included: save as a connection; never send to a browser
publicFlow(state)              // strips sealed scratch and state hash
```

**Views** (closed vocabulary; each has `viewId` and `step`):

| `type` | Fields | Actions |
|---|---|---|
| `form` | `title`, `description?`, `fields: FormField[]`, `values` (secrets `{ set, hint? }`), `errors?`, `message?`, `submitLabel` | `submit` (`data` = values; a secret may be `{ keep: true }`), `back`, `cancel` |
| `oauth` | `title`, `authorizeUrl`, `pollIntervalMs`, `expiresAt` | `poll`, `cancel` |
| `deviceCode` | `userCode`, `verificationUrl`, `verificationUrlComplete?`, `expiresAt`, `pollIntervalMs` | `poll`, `cancel` |
| `choose` | `title`, `options`, `multiple`, `selected`, `min`, `errors?` | `submit` (`{ selected }`), `back`, `cancel` |
| `confirm` | `title`, `message`, `confirmLabel`, `cancelLabel` | `submit`, `back`, `cancel` |
| `status` | `state: 'running' \| 'success'`, `message`, `account?` | none (finished) |
| `error` | `message`, `retryable` | `retry`, `back`, `cancel` |

`FlowState`: `id`, `definitionId`, `scope`, `scopeId?`, `label`, `connectionId?`, `status`
(`active | done | failed | cancelled`), `step`, `rev`, `view`, timestamps, `expiresAt` (default
15 min), `stateHash?` and `sealed` (the scratch, sealed by the vault). `AdvanceResult` is
`{ ok: true, state }` or `{ ok: false, error: 'stale-view' | 'expired' | 'finished' |
'invalid-action', message, state }`; the failure carries the current state. A `viewId` that is not the
current view's is `stale-view` (resume and double-submit safety). Validation problems are a `form`
state with `errors` (a new `viewId`), never values. A thrown step error becomes a retryable `error`
view with secrets scrubbed. `poll` that finds nothing returns the state unchanged (`device`
polls honour the server interval and `slow_down`). `completeOAuth` finds the flow by the hashed
`state` (single use; `unknown-state` otherwise), exchanges the code, persists the new state.

Custom steps (`FlowStepDef`): `id`, `skip?`, `auto?`, `enter?`, `view(ctx)`, `advance(ctx, input)`
returning `{ next } | { goto } | { stay, errors?, message? } | { pending } | { error, retryable? }`.
`ctx.scratch` is JSON that is sealed between requests.

## 3. Enablement and precedence

```ts
type AgentEnablement = Record<connectionId, {
  enabled?: 'inherit' | 'on' | 'off'
  capabilities?: Record<capabilityId, 'allow' | 'ask' | 'off'>
  tools?: Record<toolName, 'allow' | 'ask' | 'off'>
  choices?: Record<string, unknown>
}>
```

A connection applies to an agent when it is `enabled`, `connected` and valid, and: `agent` scope:
it is the agent's own (an `off` entry still switches it off); `workspace` scope: `on`, or `inherit`
with `defaultEnabled`; `user` scope: only for its user. Mode of a tool: agent tool override ??
agent capability mode ?? connection `defaultModes` ?? capability `defaultMode` (`resolveModes`).
Combined with the app's own rules the **most restrictive** wins (`mostRestrictive`: `off` > `ask` >
`allow`; ADR-0051). `EnablementStore` is a small port (`get`, `set`, `removeConnection`,
`removeAgent`); `activateConnectors` takes plain `AgentEnablement` data.

## 4. OAuth helpers

All take an injected `fetch` and use `crypto.subtle`; failures throw `EH_CONFIG_INVALID`
(`details.reason: 'oauth-*'`, `details.oauthError`) without tokens, codes or secrets in messages.
Endpoints must be https (localhost excepted).

`generatePkce()` / `pkceChallenge` (S256), `generateState`, `buildAuthorizationUrl` (RFC 8707
`resource`), `exchangeCode`, `refreshTokens` (keeps the old refresh token unless rotated),
`discoverProtectedResource` (RFC 9728, from the 401 `resource_metadata` or the well-known URLs;
the `resource` must be on the server's origin), `discoverAuthorizationServer` (RFC 8414, then OIDC;
issuer check, S256 required when methods are listed), `discoverMcpAuthorization`,
`registerClient` (RFC 7591, public client), `requestDeviceCode` / `pollDeviceToken` (RFC 8628).
`createCredentialManager({ credentials, connections?, lock?, fetch? })` hands out
`getAccessToken(connectionId)`: refresh under a per-connection `RefreshLock` (default in-process;
pass a distributed lock for several instances), re-reading credentials inside the lock; a rejected
refresh token (`invalid_grant`) marks the connection `needs-auth` and rejects with
`details.reason: 'needs-auth'`. Tokens are only in `CredentialStore` rows and in memory; no public
shape (`PublicConnection`, `PublicFlow`, `ActivatedConnectors`, service results) contains them.

## 5. Secrets and the vault

`SecretVault`, `webCryptoVault`, `plaintextVault` and `sealedProfileStore` are the generic layer
of spec 23 §8, re-exported here. Flow scratch is sealed with the vault (context `flow:<id>`);
connection and credential rows are encrypted by wrapping the profile store:
`sealedProfileStore(db, vault, { kinds: ['connection', 'connection-credentials'] })`.

## 6. Stores

- `ConnectionStore` (`list({ scope?, scopeId?, definitionId? })`, `get`, `put`, `delete`,
  `subscribe?`) is a view over any `ProfileStore`: `connectionStoreFromProfiles(profiles)`; a
  connection is a `ConfigProfile` with `kind: 'connection'` plus the `ConnectionRecord` fields, so
  the same store, redaction (`publicConnection`) and secret patch (`mergeSecretPatch`) apply.
  `subscribe` has the `ProfileStore` shape (cross-instance invalidation).
- `CredentialStore` (`get`, `put`, `delete` by connection id): `credentialStoreFromProfiles`;
  rows of kind `connection-credentials` (tokens, OAuth client, endpoints), apart from the
  connection, so refreshing never rewrites settings.
- `EnablementStore`, `FlowStore` (`get`, `put`, `delete`, `findByStateHash`, `deleteExpired`).
- Memory adapters: `memoryConnectionStore`, `memoryCredentialStore({ vault? })`,
  `memoryEnablementStore`, `memoryFlowStore`. Databases are the app's adapters, checked with
  `connectionStoreConformance`, `credentialStoreConformance`, `enablementStoreConformance`,
  `flowStoreConformance` from `eharness/testing`.

## 7. Activation

```ts
activateConnectors({ definitions, connections, enablement?, agent, user?, ordering?, accessToken?,
                     fetch?, mcp?, appRules?, allowRulesForBuiltin? }): Promise<{
  plugins, mcpSources, rules: { allow, ask, deny, pinnedAsk, toolKinds },
  instructions, toolNameMap, connections, warnings }>
```

- **Order** is stable and independent of input order: built-in connectors first in
  `DEFAULT_BUILTIN_ORDER` (`files, memory, planning, web, ask, team`; `ordering.builtin`
  overrides), then connectors by id, within one by connection id (spec 02 §5–6, ADR-0013). The
  same order applies to `plugins`, `mcpSources` and `instructions` (one block per connector, only
  when something is on).
- **Several connections of one connector**: each is activated with `toolPrefix` `<slug>_` (slug of
  the label, unique); `instances: 'single'` keeps the first and warns `duplicate-instance`;
  `combine(ctxs)` merges them (memory). `toolPrefix` sets when the prefix applies: `'multiple'`
  (default, as described), `'always'` (also for a single connection, so a remote server's tool names
  never depend on how many connections exist and rules keep the same names), `'never'` (fixed names). `toolNameMap` maps each final tool name to
  `{ connectorId, connectionIds, capabilityId, tool }`.
- **Contributions**: a plugin goes to `plugins`, a `ToolSource` to `mcpSources`, an `McpSourceSpec`
  (`{ kind: 'mcp', name, url, headers?, getAccessToken?, … }`) is passed to `mcp(spec)` with
  `prefix`, `allow` (tools not `off`) and `deny` (tools `off`) filled in; without `mcp` a warning
  `mcp-factory-missing`. A capability set where everything is `off` is not activated.
- **Rules** (`compileConnectorRules`): `off` → deny; `ask` → ask, and **pinned** for write or
  destructive capabilities of non-built-in connectors (`pinnedAsk`, `toolKinds[tool] = { kind:
  'other', alwaysAsk: true }`); `allow` → allow (non-built-in only; built-in `allow` adds no rule so
  the app's mode and path analysis govern). Shared tools take the most restrictive mode of the
  connections that keep them on. `appRules` are merged most-restrictive-wins (`mergeConnectorRules`).
- Never throws for one bad connection: `warnings` (`unknown-definition`, `connection-unavailable`,
  `invalid-settings`, `duplicate-instance`, `activate-failed`, `mcp-factory-missing`).

**Permissions wiring.** Merge the compiled data into the engine and bypass mode cannot skip the
pinned asks:

```ts
const out = await connectors.activate({ agent: { id }, mcp: remoteMcpSource, appRules: base })
const engine = createPermissionEngine({
  roots, mode, rules: out.rules,           // allow / ask / deny
  toolKinds: { ...myToolKinds, ...out.rules.toolKinds },   // pinned asks (alwaysAsk)
})
```

## 8. Built-in connectors

`builtinConnectors({ labels?, files?, memory?, planning?, web?, ask?, team? })` returns
definitions only for the factories the app passes (the module imports no plugin):

| Connector | Capabilities (tools) | Needs from the app |
|---|---|---|
| `files` | Read files (`read_file, list_files, grep, glob`), Edit files (`write_file, edit_file`), Delete files (`delete_file`, destructive) | `files.plugin(input)` → `filesystem(...)` |
| `memory` | Read memory (`memory_view`), Save to memory (the five write tools); scopes `workspace` ("Workspace memory", shared) and `agent` ("This agent's memory", private) | `memory.paths` and `memory.plugin(roots)` → `memory({ roots })` |
| `planning` | Plan with todos (`todo_write`) | `planning.plugin` |
| `web` | Search the web (`web_search`), Read web pages (`web_fetch`) | `web.search` / `web.read` factories (search backend) |
| `ask` | Ask questions (`ask_user_question`) | `ask.plugin` |
| `team` | Delegate work (`agent, agent_output, agent_stop`), Message agents (`send_message`) | `team.plugin` → `subagents({ agents })`; off by default |

`input` = `{ tools, modes, capabilities }` (what is on). Memory's `combine` builds one root per
connection (`{ path, write, label, scope, connectionId }`; `write` follows the write capability),
so the workspace connection and the agent's own connection become two roots and another agent's
private root never appears. The memory plugin offers all its tools while a root exists; restrict
them with the capability modes (rules). `labels` relabels names, descriptions, icons, capability
texts and scope labels (translation, rebranding). Built-in capabilities default to `allow` (no
rule). `ensureBuiltinConnections({ store, definitions, agentId? })` creates the workspace
connections (`builtin:<id>`) and, for connectors with `scopeDefaults.agent` (memory), the agent
connection (`builtin:<id>:agent:<agent>`); idempotent.

## 9. Remote MCP

`remoteMcpConnector({ id?, name?, description?, icon?, category?, listTools?, instructions? })`:
settings `url` (https), `authMode` (`none | headers | oauth`), `headers` (secret values). With
`oauth` the flow uses MCP discovery (RFC 9728, RFC 8414), dynamic client registration and PKCE with
the `resource` indicator. `listTools` (`listRemoteMcpTools` from `eharness/mcp`) runs in the
connection test; tools are grouped by annotations into `read` (default `allow`), `write` and
`destructive` (default `ask`, pinned) and stored on the connection. `activate` returns an
`McpSourceSpec`; pass `mcp: remoteMcpSource` (`eharness/mcp`), which builds an `mcpServer`
transport whose `authProvider` (`bearerAuthProvider`) returns a fresh token for every request, so
refreshed tokens apply without reconnecting (spec 09 §3).

## 10. The connector service

`createConnectorService({ definitions, connections, credentials, enablement, flows, vault, fetch?,
redirectUri?, clientConfig?, lock?, ttlMs?, now?, newId? })` is what an app's routes call; every
return value is browser-safe (redacted connections, flows without scratch, no tokens):
`clientConfig(definitionId, { flowId, scope, scopeId, reconnect })` returns the OAuth app of
the asking flow (an app may keep one per scope or hand out one entered earlier in the same flow;
a dedicated "enter the OAuth app" flow step is not part of the library: apps save the client
before connecting, see ADR-0053). `catalog()`, `list`, `get`, `startConnect`, `reconnect`, `getFlow`, `advance`, `completeOAuth`
(the callback route), `update` (secret patch + validation), `remove` (connection, credentials,
every agent's entry), `enablement`, `setEnablement`, `test` (records status, account, discovered
capabilities), `accessToken` (server side only), `activate`, `sweep`. A finished flow saves the
connection and credentials, stays for 5 minutes (a polling tab gets `finished` with the
connection) with its scratch cleared. `defaultEnabled` defaults to the connector's scope default,
else `false` (agent scope: `true`).

## Security notes

Discovery and OAuth fetches run on the server with user-supplied URLs: give the injected `fetch`
private-network blocking (the module only enforces https). Redirect URIs are the app's fixed
callback; `state` is single use; PKCE S256 is mandatory; tokens are bound to the resource. MCP tool
results are framed as untrusted by `mcpServer` (`wrapUntrusted`).
