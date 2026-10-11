# Connectors (`eharness/connectors`)

Let people connect tools (built-in plugins, a CRM, a remote MCP server) once, then decide per agent
which ones it uses and how freely. Contract: [spec 24](../specs/24-connectors.md).

## The three layers

- **Definition** (code): `defineConnector(...)`: auth, settings, capabilities, `activate`.
- **Connection** (data): settings, secrets, status, scope (`workspace` or `agent`).
  `defaultEnabled` on a workspace connection means every agent inherits it.
- **Enablement** (per agent): `inherit | on | off` per connection, capability modes
  (`allow | ask | off`) and per-tool overrides.

## Setup

```ts
import { webCryptoVault, sealedProfileStore } from 'eharness/providers'
import {
  builtinConnectors, createConnectorService, ensureBuiltinConnections, remoteMcpConnector,
  connectionStoreFromProfiles, credentialStoreFromProfiles, inMemoryEnablementStore, inMemoryFlowStore,
} from 'eharness/connectors'
import { listRemoteMcpTools, remoteMcpSource } from 'eharness/mcp'
import { filesystem, type FileToolName } from 'eharness/filesystem'
import { memory } from 'eharness/memory'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import { ask } from 'eharness/ask'
import { subagent } from 'eharness/subagent'
import { z } from 'zod/v4'

// yours: keyBytes (32-byte Uint8Array), dbProfileStore (a ProfileStore), fs, search, agents,
// adminOAuthClients, agentId, and a fetch that blocks private networks
const vault = webCryptoVault(keyBytes)                       // or your own SecretVault
const profiles = sealedProfileStore({ inner: dbProfileStore, vault, kinds: ['connection', 'connection-credentials'] })

const definitions = [
  ...builtinConnectors({
    files: { plugin: ({ tools }) => filesystem({ fs, tools: tools as FileToolName[] }) },
    memory: {
      paths: { workspace: '/memory/shared', agent: (id) => `/memory/agents/${id}` },
      plugin: (roots) => memory({ roots: () => roots.map(({ path, write, label }) => ({ path, write, label })) }),
    },
    planning: { plugin: () => todos() },
    web: { search: () => webSearch({ search }), read: () => webFetch() },
    ask: { plugin: () => ask() },
    team: { plugin: () => subagent({ agents }) },
    labels: { files: { name: 'Berkas' } },                  // relabel / translate
  }),
  remoteMcpConnector({ listTools: listRemoteMcpTools }),
  // curated connectors: defineConnector({ ... })
]

const connectors = createConnectorService({
  definitions,
  connections: connectionStoreFromProfiles(profiles),
  credentials: credentialStoreFromProfiles(profiles),
  enablement: inMemoryEnablementStore(),                       // or your adapter
  flows: inMemoryFlowStore(),                                  // or your adapter
  vault, fetch,                                              // fetch: your network policy
  redirectUri: 'https://app.example.com/connectors/oauth/callback',
  clientConfig: (id) => adminOAuthClients[id],               // curated OAuth connectors
})
await ensureBuiltinConnections({ store: connectionStoreFromProfiles(profiles), definitions, agentId })
```

## Giving an agent its connectors

```ts
// base: your own permission rules, { allow?, ask?, deny? } as rule strings
const out = await connectors.activate({ agent: { id: agentId }, mcp: remoteMcpSource, appRules: base })
const agent = defineHarnessAgent({
  model,
  instructions: [BASE_INSTRUCTIONS, ...out.instructions],   // BASE_INSTRUCTIONS: yours; stable order
  plugins: out.plugins,
  tools: out.mcpSources,
})
const engine = createPermissionEngine({
  roots: () => roots,                                         // yours: PermissionRoot[]
  rules: { allow: out.rules.allow, ask: out.rules.ask, deny: out.rules.deny },
  toolKinds: { ...myToolKinds, ...out.rules.toolKinds },      // pinned asks: bypass cannot skip them
})
```

`out.warnings` lists connections that were left out and why. `out.toolNameMap` tells you which
connection a tool name came from (for UI labels). Cache the result per agent and rebuild when
`connections.subscribe` fires or an enablement changes; the order is stable, so unchanged
connectors keep the prompt-cache prefix.

## Rendering a flow (Svelte or any framework)

Routes (all JSON; the service returns browser-safe data):

```ts
POST /connectors/connect       -> connectors.startConnect({ definitionId, scope, scopeId, label })
GET  /connectors/flows/:id     -> connectors.getFlow(id)
POST /connectors/flows/:id     -> connectors.advance(id, { viewId, action, data })
GET  /connectors/oauth/callback?state&code&error -> connectors.completeOAuth({ state, code, error, principal })
```

Bind the flow to the person who started it: pass the same opaque `principal` (user id or session id)
to `startConnect({ principal })` / `reconnect(id, { principal })` and to `completeOAuth` / `advance`.
A callback opened in another person's browser then fails with `principal-mismatch` instead of
attaching the attacker's account (login CSRF). OAuth requests refuse private and link-local hosts and
cross-origin redirects; local development MCP servers need
`createConnectorService({ oauth: { allowPrivateNetwork: true } })`.

The UI keeps `flow` and renders `flow.view` by `type`; every action quotes `flow.view.viewId`:

```svelte
{#if view.type === 'form'}
  <Form fields={view.fields} values={view.values} errors={view.errors}
        on:submit={(e) => act('submit', e.detail)} />          <!-- secret fields: {set, hint} → placeholder "•••• 1234"; send {keep:true} or omit to keep -->
{:else if view.type === 'oauth'}
  <a href={view.authorizeUrl} target="_blank" rel="noopener">Authorize</a>
  <!-- poll every view.pollIntervalMs: act('poll') -->
{:else if view.type === 'deviceCode'}
  <code>{view.userCode}</code> <a href={view.verificationUrl}>Open</a>   <!-- poll -->
{:else if view.type === 'qr'}
  <QrCode value={view.url} />   <!-- poll every view.pollIntervalMs; view.url may change under the same viewId -->
{:else if view.type === 'choose'}
  <Choose options={view.options} multiple={view.multiple} selected={view.selected}
          on:submit={(e) => act('submit', { selected: e.detail })} />
{:else if view.type === 'confirm'}
  <Confirm {...view} on:yes={() => act('submit')} on:no={() => act('cancel')} />
{:else if view.type === 'status'}
  {view.message}
{:else if view.type === 'error'}
  {view.message} {#if view.retryable}<button on:click={() => act('retry')}>Retry</button>{/if}
{/if}
```

`act` posts the action; on `ok: false` with `error: 'stale-view'` replace the local flow with the
returned `flow` and re-render (nothing is lost). On `finished`, use the returned `connection`. The
OAuth callback tab can show "you can close this tab"; the original tab learns the result by polling.
A `form` view may also be answered with `act('resend')` when the connector's custom step supports it
(one-time codes). The form's field list is a framework-neutral `FormField[]` (`kind`, `widget`, `required`, `secret`,
`showWhen`, `options`, ...): render it with your own components, as for provider profiles.

## Rendering the enablement UI

Per agent, list `connectors.list()` (workspace connections and the agent's own) with
`connectors.enablement(agentId)`:

| Control | Writes |
|---|---|
| Connection switch (inherit / on / off) | `setEnablement(agent, connection, { enabled })` |
| Capability mode (Allow / Ask / Off) per capability of `catalog()[definition].capabilities` (or the connection's discovered `capabilities`) | `{ capabilities: { [id]: mode } }` |
| Per-tool override (advanced) | `{ tools: { [tool]: mode } }` |
| Scope choices (repositories) | `{ choices: { ... } }` |

Show the effective mode with `resolveModes(capabilities, connection, enablement)`; show an `Ask`
on a write of an external connector as "always asks, even in bypass mode". Connection-level
defaults (`update(id, { defaultEnabled, defaultModes })`) belong on the workspace connections page.

## Custom connectors

```ts
defineConnector({
  id: 'crm', version: '1', name: 'CRM', description: '…', category: 'sales', source: 'curated',
  scopes: ['workspace', 'agent'],
  auth: { type: 'apiKey', fields: z.object({ apiKey: z.string().meta(ehMeta({ secret: true })) }) },
  settings: z.object({ region: z.enum(['eu', 'us']).default('eu') }),
  capabilities: [
    { id: 'read', title: 'Read contacts', description: '…', kind: 'read', tools: ['search_contacts'], defaultMode: 'allow' },
    { id: 'write', title: 'Edit contacts', description: '…', kind: 'write', tools: ['update_contact'], defaultMode: 'ask' },
  ],
  test: async ({ settings, fetch }) => ({ ok: true, accountLabel: 'acme' }),
  // myCrmPlugin: yours, a plugin whose tools are named ctx.toolPrefix + tool
  activate: (ctx) => myCrmPlugin({ apiKey: ctx.settings.apiKey, prefix: ctx.toolPrefix }),
})
```

Name tools `ctx.toolPrefix + tool` (or let `mcp` apply the prefix) so two connections of one
connector never collide. For OAuth connectors use `auth: { type: 'oauth2', authorizationUrl,
tokenUrl, scopes, pkce: true }`, give the admin client with `clientConfig`, and read tokens with
`ctx.connection.getAccessToken()` (refreshed under a lock).

## Security notes

- **Secrets stay with their endpoint.** The custom MCP `url` is an endpoint field. `service.update`
  with a different `url` drops the stored header values the patch does not resend, deletes the OAuth
  credentials and sets `needs-auth` (for OAuth connectors): the old token is never presented to a
  new host. Your own definitions get the same by using `z.url()` (or `ehMeta({ endpoint: true })`)
  for any field that decides where requests go ([Providers](providers-and-profiles.md)).
- **Annotations come from the remote server.** `remoteMcpConnector` groups a tool with
  `readOnlyHint: true` into the `read` capability when the connection is tested, but that
  capability defaults to `ask` like the others (a hostile server can mislabel a mutating tool).
  Switch it to `allow` (a capability mode on the enablement, `modes: { read: 'allow' }`) only for servers you
  trust. Curated connectors you define yourself keep the defaults you give them
  ([tools and MCP](tools-and-mcp.md#mcp-servers-eharnessmcp)).
- Provider and MCP URLs are fetched by your injected `fetch`: apply your network policy there
  (private ranges, redirects) when the URLs come from untrusted people.

## Reference

Exported from `eharness/connectors`: `defineConnector`, `connectorSchema`, `describeConnector`,
`publicConnection`, `startFlow`, `advanceFlow`, `completeOAuth`, `flowCompletion`, `publicFlow`,
`defaultFlowSteps`, `discoverMcpAuthorization`, `createCredentialManager`, `activateConnectors`,
`compileConnectorRules`, `mergeConnectorRules`, `resolveModes`, `mostRestrictive`,
`capabilitiesOf`, `capabilitiesFromTools`, `isConnectionEnabled`, `builtinConnectors`,
`builtinConnectionId`, `ensureBuiltinConnections`, `remoteMcpConnector`, `createConnectorService`,
the `inMemory*` stores (`inMemoryConnectionStore`, `inMemoryCredentialStore`,
`inMemoryEnablementStore`, `inMemoryFlowStore`, `inMemoryRefreshLock`) and
`connectionStoreFromProfiles` / `credentialStoreFromProfiles`. The OAuth step helpers (PKCE,
authorization URL, code exchange, refresh, dynamic client registration, device code) are internal:
the service and flows call them for you. Secret vaults (`webCryptoVault`, `plaintextVault`) come
from `eharness/providers`. Conformance suites for your adapters: `connectionStoreConformance`,
`credentialStoreConformance`, `enablementStoreConformance`, `flowStoreConformance`
(`eharness/testing`).
