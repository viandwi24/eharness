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
  id, version, name, description, icon?, publisher?, homepage?, docsUrl?, category,
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
`describeConnector(def)` what a UI shows (no functions, including the form of the settings).

`activate(ctx)` receives: `connection` (`id`, `label`, `scope`, `accountLabel`, `getAccessToken()`),
validated `settings` (secrets included: never log them), `choices`, `agent`, `modes` (every
capability), `capabilities` (not `off`), `tools` (not `off`, the connector's own names),
`toolModes`, `toolPrefix`, `slug`, `fetch`. Every OAuth request (token, refresh, registration, discovery, device code) carries an abort signal with a default 15 000 ms limit (`timeoutMs`; error code `oauth-timeout`), so the `refresh:<id>` lock is never held by a silent identity provider. `OAuth2Auth.when(settings) === false` skips the
authorization step (the custom MCP connector with a header token). Capabilities discovered at
connect time (`test` returns `capabilities`) are stored on the connection and replace the
definition's (`capabilitiesOf`).

`publisher` (a name), `homepage` and `docsUrl` (http(s) URLs, validated by `defineConnector`) are display metadata: `describeConnector` passes them to the catalog so a UI can show who runs the service and link to its documentation. They never affect activation.

## 2. Setup flows

A flow is a list of steps run by a pure engine (ADR-0050). Default steps, derived from the
definition and skipped when they do not apply: `settings` (form of the auth fields and settings),
`authorize` (OAuth: discovery, client from the admin config or dynamic registration, PKCE, state)
or `device`, `choose`, `test`. A definition may replace or edit them (`flow`).

```ts
startFlow({ definition, scope, scopeId?, label?, connection? /* reconnect */, defaultEnabled?, principal? }, deps): FlowState
advanceFlow(state, { viewId, action: 'submit'|'poll'|'back'|'cancel'|'retry', data?, principal? }, deps): AdvanceResult
completeOAuth({ state, code?, error?, errorDescription?, principal? }, flowStore, deps)
flowCompletion(state, deps)    // secrets included: save as a connection; never send to a browser
publicFlow(state)              // strips sealed scratch and state hash
```

**Views** (closed vocabulary; each has `viewId` and `step`):

| `type` | Fields | Actions |
|---|---|---|
| `form` | `title`, `description?`, `fields: FormField[]`, `values` (secrets `{ set, hint? }`), `errors?`, `message?`, `submitLabel` | `submit` (`data` = values; a secret may be `{ keep: true }`), `back`, `cancel`, `resend` |
| `oauth` | `title`, `authorizeUrl`, `pollIntervalMs`, `expiresAt` | `poll`, `cancel` |
| `deviceCode` | `userCode`, `verificationUrl`, `verificationUrlComplete?`, `expiresAt`, `pollIntervalMs` | `poll`, `cancel` |
| `qr` | `title`, `description?`, `url`, `expiresAt`, `pollIntervalMs` | `poll`, `cancel`, `back` |
| `choose` | `title`, `options`, `multiple`, `selected`, `min`, `errors?` | `submit` (`{ selected }`), `back`, `cancel` |
| `confirm` | `title`, `message`, `confirmLabel`, `cancelLabel` | `submit`, `back`, `cancel` |
| `status` | `state: 'running' \| 'success'`, `message`, `account?` | none (finished) |
| `error` | `message`, `retryable` | `retry`, `back`, `cancel` |

`FlowState`: `id`, `definitionId`, `scope`, `scopeId?`, `label`, `connectionId?`, `status`
(`active | done | failed | cancelled`), `step`, `rev`, `view`, timestamps, `expiresAt` (default
15 min), `stateHash?` and `sealed` (the scratch, sealed by the vault). `AdvanceResult` is
`{ ok: true, state }` or `{ ok: false, error: 'stale-view' | 'expired' | 'finished' |
'invalid-action' | 'principal-mismatch', message, state }`; the failure carries the current state. A `viewId` that is not the
current view's is `stale-view` (resume and double-submit safety). Validation problems are a `form`
state with `errors` (a new `viewId`), never values. A thrown step error becomes a retryable `error`
view with secrets scrubbed. `poll` that finds nothing returns the state unchanged (`device`
polls honour the server interval and `slow_down`). `completeOAuth` finds the flow by the hashed
`state` (single use; `unknown-state` otherwise), exchanges the code, persists the new state.

**Principal binding (login CSRF).** `startFlow({ principal })` takes an opaque string (a user id, a
session id); only its SHA-256 is stored (`FlowState.principalHash`). A flow with a principal can only
be advanced or completed by a caller that presents the same `principal` (`FlowInput.principal`,
`OAuthCallback.principal`); a missing or different one fails with `principal-mismatch` (for
`completeOAuth`: `{ ok: false, error: 'principal-mismatch', message }` without a state) and does not
consume the `state`. Flows without a principal behave as before. `service.startConnect({ principal })`
and `service.reconnect(id, { principal })` forward it.

**`qr`** shows `url` as a QR code another device scans (a login token such as `tg://login?token=...`).
The step answers `poll` with `{ pending: true }` while nothing happened; `pending` re-renders the view
without a new `viewId`, so the `url` may change under the same id (a token that rotates every few
seconds) and the UI keeps polling with the id it has.

**`resend`** is a flow action for one-time codes. A `form` view accepts it and the step's
`advance` receives `{ action: 'resend' }`: it sends the code again (SMS, in-app, call) and answers
`{ stay: true, message }` (a new `viewId`; the UI shows the message and keeps the form) or `{ error }`.
The default steps ignore it. Like every action it is subject to `viewId` and principal checks.

Custom steps (`FlowStepDef`): `id`, `skip?`, `auto?`, `enter?`, `view(ctx)`, `advance(ctx, input)`
returning `{ next } | { goto } | { stay, errors?, message? } | { pending } | { error, retryable? }`.
`ctx.scratch` is JSON that is sealed between requests. `ctx.deps.clientConfig(definitionId, ctx)`
works for any definition, not only OAuth ones: a workspace-wide app configuration (for example a
Telegram `{ apiId, apiHash }` the admin entered once) is supplied by the app's `clientConfig` callback and
read by a custom step; unlike OAuth clients it is returned unvalidated, so the step validates it. A step
that finishes a non-OAuth login stores the result in `ctx.scratch.credentials` (for example
`{ session: { format, data } }`, below); `flowCompletion` returns it and the service saves it. `ctx.label` is the connection's label when known (the OAuth and device-code views are titled `Authorize <label>`, else the connector name).

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
Endpoints must be https (`allowInsecure` allows http). Every URL a helper fetches, discovered ones
included (authorization servers, registration, token and device endpoints), must be a public host:
`isPrivateHost` (core, shared with `web_fetch`) refuses loopback, private, link-local and reserved
ranges and local names with `details.reason: 'oauth-url-private'`, unless the app passes
`allowPrivateNetwork: true` (local development servers) or its own `isAllowedUrl(url)`, which
replaces the default check. Requests use `redirect: 'manual'`: a same-origin redirect is followed at
most 3 times (each target re-validated), a cross-origin one is refused (`oauth-redirect-refused`).
Response bodies are capped by `maxResponseBytes` (default 1 MiB, `oauth-response-too-large`).
`FlowDeps.oauth` / `ConnectorServiceOptions.oauth` / `CredentialManagerOptions.oauth` forward these
options (`allowPrivateNetwork`, `isAllowedUrl`, `allowInsecure`, `maxResponseBytes`, `timeoutMs`).

The flow engine and the credential manager use these internal helpers; only
`discoverMcpAuthorization` is public: PKCE S256 and state, the authorization URL (RFC 8707
`resource`), code exchange, token refresh (keeps the old refresh token unless rotated), protected
resource discovery (RFC 9728, from the 401 `resource_metadata` or the well-known URLs; the
`resource` must be on the server's origin), authorization server discovery (RFC 8414, then OIDC;
issuer check, S256 required when methods are listed), dynamic client registration (RFC 7591, public
client) and the device flow (RFC 8628).
`createCredentialManager({ credentials, connections?, lock?, fetch?, now?, skewMs?, timeoutMs?, oauth? })` hands out
`getAccessToken(connectionId)`: refresh (`skewMs` before expiry, default 60 s) under a per-connection `RefreshLock` (default in-process;
pass a distributed lock for several instances), re-reading credentials inside the lock; a rejected
refresh token (`invalid_grant`) marks the connection `needs-auth` and rejects with
`details.reason: 'needs-auth'`. Tokens are only in `CredentialStore` rows and in memory; no public
shape (`PublicConnection`, `PublicFlow`, `ActivatedConnectors`, service results) contains them.

**Session slot.** `ConnectionCredentials.session?: { format: string; data: string }` is an opaque,
app-defined credential for connectors that are neither OAuth nor an API key (a user-account chat
session, a cookie jar). The library never interprets `data`; `format` names its encoding
(`'mtcute-string'`) so a runtime can refuse what it does not understand. It lives in the
`CredentialStore` row with the tokens (sealed with `kinds: ['connection-credentials']`), in the sealed flow scratch
while the flow runs, and is scrubbed from error views. It is in no public shape (`PublicConnection`
has only `authorized: true`, which is also true when a session exists, `PublicFlow`, logs). A reconnect flow that sets
`scratch.credentials` replaces the stored credentials, session included.

**Long-lived runtimes.** `service.credentials(connectionId)` returns the stored credentials (a copy,
session included, tokens as stored and not refreshed) for trusted server code, for example a runtime
holding a chat client open for days; `service.accessToken` remains the way to get a fresh OAuth token.
`service.markNeedsAuth(connectionId, message?)` is how such a runtime reports out of band that the
credential stopped working (`AUTH_KEY_UNREGISTERED`, a revoked session or bot token): it sets
`status: 'needs-auth'` with `statusMessage` (default "Reconnect required."), keeps the credentials and
is a no-op for an unknown connection. Activation skips the connection until a reconnect flow finishes
(which sets `connected` again). The credential manager does the same for a rejected OAuth refresh token.

## 5. Secrets and the vault

`SecretVault`, `webCryptoVault`, `plaintextVault` and `sealedProfileStore` are the generic layer
of spec 23 §8 and are imported from `eharness/providers` (this subpath does not re-export them). Flow scratch is sealed with the vault (context `flow:<id>`);
connection and credential rows are encrypted by wrapping the profile store:
`sealedProfileStore({ inner: db, vault, kinds: ['connection', 'connection-credentials'] })`.

## 6. Stores

- `ConnectionStore` (`list({ scope?, scopeId?, definitionId? })`, `get`, `put`, `delete`,
  `subscribe?`) is a view over any `ProfileStore`: `connectionStoreFromProfiles(profiles)`; a
  connection is a `ConfigProfile` with `kind: 'connection'` plus the `ConnectionRecord` fields, so
  the same store, redaction (`publicConnection`) and secret patch (spec 23 §2) apply.
  `subscribe` has the `ProfileStore` shape (cross-instance invalidation).
- `CredentialStore` (`get`, `put`, `delete` by connection id): `credentialStoreFromProfiles`;
  rows of kind `connection-credentials` (tokens, OAuth client, endpoints), apart from the
  connection, so refreshing never rewrites settings.
- `EnablementStore`, `FlowStore` (`get`, `put`, `delete`, `findByStateHash`, `deleteExpired`).
- Memory adapters: `inMemoryConnectionStore`, `inMemoryCredentialStore({ vault? })`,
  `inMemoryEnablementStore`, `inMemoryFlowStore`. Databases are the app's adapters, checked with
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
  the label, unique; a connection that stores `slug` keeps it, so a rename never renames its tools); `instances: 'single'` keeps the first and warns `duplicate-instance`;
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
| `files` | Read files (`read_file, list_files, grep, glob`), Edit files (`write_file, edit_file`), Delete files (`delete_file`, destructive); with `files.code`: Run Python (`run_python`, write, default `allow`) and, with `code: { install: true }`, Install packages (`install_packages`, external, default `ask`) | `files.plugin(input)` → `filesystem(...)` (+ `code(...)` when `run_python` is in `input.tools`) |
| `memory` | Read memory (`memory_view`), Save to memory (the five write tools); scopes `workspace` ("Workspace memory", shared) and `agent` ("This agent's memory", private) | `memory.paths` and `memory.plugin(roots)` → `memory({ roots })` |
| `planning` | Plan with todos (`todo_write`) | `planning.plugin` |
| `web` | Search the web (`web_search`), Read web pages (`web_fetch`) | `web.search` / `web.read` factories (search backend) |
| `ask` | Ask questions (`ask_user_question`) | `ask.plugin` |
| `team` | Delegate work (`agent, agent_output, agent_stop`), Message agents (`send_message`) | `team.plugin` → `subagent({ agents })`; off by default |

`input` = `{ tools, modes, capabilities }` (what is on). Memory's `combine` builds one root per
connection (`{ path, write, label, scope, connectionId }`; `write` follows the write capability),
so the workspace connection and the agent's own connection become two roots and another agent's
private root never appears. The memory plugin offers all its tools while a root exists; restrict
them with the capability modes (rules). `labels` relabels names, descriptions, icons, capability
texts and scope labels (translation, rebranding). Built-in capabilities default to `allow` (no
rule), except the files code capabilities `run` and `install`, which default to `ask`. They exist
only when `files.code` is set (`true` or `{ install?: boolean }`); the module still imports no
plugin, so the app's `files.plugin` factory decides what to build: it adds `code()` (spec 28) when
`run_python` is in `input.tools`, and enables package installs when `install_packages` is.
`ensureBuiltinConnections({ store, definitions, agentId? })` creates the workspace
connections (`builtin:<id>`) and, for connectors with `scopeDefaults.agent` (memory), the agent
connection (`builtin:<id>:agent:<agent>`); idempotent.

## 9. Remote MCP

`remoteMcpConnector({ id?, name?, description?, icon?, category?, listTools?, instructions? })`:
settings `url` (https), `authMode` (`none | headers | oauth`), `headers` (secret values). With
`oauth` the flow uses MCP discovery (RFC 9728, RFC 8414), dynamic client registration and PKCE with
the `resource` indicator. `listTools` (`listRemoteMcpTools` from `eharness/mcp`) runs in the
connection test; tools are grouped by annotations into `read`, `write` and `destructive`; all default to `ask`
(annotations are server-controlled and untrusted; `write` and `destructive` are pinned, `read` is
not, so a person can switch it to `allow`) and stored on the connection. `activate` returns an
`McpSourceSpec`; pass `mcp: remoteMcpSource` (`eharness/mcp`), which builds an `mcpServerSource`
transport whose `authProvider` (`bearerAuthProvider`) returns a fresh token for every request, so
refreshed tokens apply without reconnecting (spec 09 §3).

## 10. The connector service

`createConnectorService({ definitions, connections, credentials, enablement, flows, vault, fetch?,
redirectUri?, clientConfig?, lock?, ttlMs?, oauth?, onError?, now?, newId? })` is what an app's routes call; every
return value is browser-safe (redacted connections, flows without scratch, no tokens):
`clientConfig(definitionId, { flowId, scope, scopeId, reconnect, settings })` returns the OAuth app of
the asking flow (an app may keep one per scope or hand out one entered earlier in the same flow;
a dedicated "enter the OAuth app" flow step is not part of the library: apps save the client
before connecting, see ADR-0053). `catalog()`, `list`, `get`, `startConnect`, `reconnect`, `getFlow`, `advance`, `completeOAuth`
(the callback route), `update` (secret patch + validation; a changed endpoint field, e.g. the custom MCP `url`, drops every stored
secret the patch does not resend, deletes the stored OAuth credentials and sets `needs-auth` for `oauth2` / `deviceCode`
connectors: spec 23 §2, endpoint-bound secrets), `remove` (connection, credentials,
every agent's entry), `enablement`, `setEnablement`, `test` (records status, account, discovered
capabilities; only a missing or rejected credential answers "Reconnect required.", any other failure (provider outage, network, store error) answers "Temporarily unavailable (<reason>)", is reported to `onError` (default `console.warn`) and leaves the stored status untouched), `accessToken`, `credentials` and `markNeedsAuth` (server side only; §4), `activate`, `sweep`. A finished flow saves the
connection and credentials, stays for 5 minutes (a polling tab gets `finished` with the
connection) with its scratch cleared. `defaultEnabled` defaults to the connector's scope default,
else `false` (agent scope: `true`).

## Security notes

Discovery and OAuth fetches run on the server with user-supplied URLs: give the injected `fetch`
private-network blocking for connector `test` calls; the OAuth helpers themselves refuse private hosts and cross-origin redirects (§4). Redirect URIs are the app's fixed
callback; `state` is single use; PKCE S256 is mandatory; tokens are bound to the resource. MCP tool
results are framed as untrusted by `mcpServerSource` (`wrapUntrusted`).
