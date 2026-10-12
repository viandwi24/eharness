import { z } from '@hono/zod-openapi'
import { CAPABILITY_MODES, ENABLED_STATES } from '../../app/catalog.ts'
import { ErrorSchema } from './common.ts'
import { ProviderFieldSchema } from './providers.ts'

const Mode = z.enum(CAPABILITY_MODES).openapi('CapabilityMode', {
  description: '`allow` = Allowed, `ask` = Ask first, `off` = Off.',
})

const Scope = z.enum(['workspace', 'agent', 'user'])

export const ConnectionChoicesSchema = z
  .object({
    enabled: z.enum(ENABLED_STATES).optional().openapi({
      description:
        "`on` / `off` forces it; `inherit` (default) follows the connection: a workspace connection with `defaultEnabled` is available to every agent, an agent's own connection to that agent.",
    }),
    capabilities: z.record(z.string(), Mode).optional().openapi({
      description: 'Mode per capability id ("Read files", "Edit files").',
    }),
    tools: z.record(z.string(), Mode).optional().openapi({
      description: 'Mode per individual tool (Advanced). Rarely needed.',
    }),
    choices: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('ConnectionChoices')

const CapabilitySchema = z
  .object({
    id: z.string().openapi({ example: 'read' }),
    title: z.string().openapi({ example: 'Read files' }),
    description: z.string(),
    kind: z.enum(['read', 'write', 'destructive', 'external']),
    tools: z.array(z.string()).openapi({ description: 'Technical tool names (Advanced only).' }),
    defaultMode: Mode,
  })
  .openapi('Capability')

export const OAuthClientSchema = z
  .object({
    required: z.boolean(),
    configured: z.boolean(),
    source: z.enum(['env', 'stored']).nullable(),
    redirectUri: z
      .string()
      .openapi({ description: 'Register this callback URL with the OAuth app.' }),
    envVars: z.array(z.string()),
  })
  .openapi('OAuthClientState')

export const ConnectorSchema = z
  .object({
    id: z.string().openapi({ example: 'github' }),
    name: z.string().openapi({ example: 'GitHub' }),
    description: z.string(),
    icon: z.string().optional().openapi({ description: 'An icon name the UI resolves.' }),
    publisher: z.string().optional().openapi({ description: 'Who makes or runs the service.' }),
    homepage: z.string().optional().openapi({ description: 'The service site (http(s)).' }),
    docsUrl: z.string().optional().openapi({ description: 'Documentation (http(s)).' }),
    category: z.string(),
    source: z.enum(['builtin', 'curated', 'custom']),
    scopes: z.array(Scope),
    auth: z.object({
      type: z.enum(['none', 'apiKey', 'oauth2', 'deviceCode']),
      scopes: z.array(z.string()).optional(),
    }),
    fields: z
      .array(ProviderFieldSchema)
      .openapi({ description: 'The settings form of the connector.' }),
    capabilities: z.array(CapabilitySchema),
    builtin: z.boolean().openapi({ description: 'Included: there is no connect step.' }),
    leadOnly: z.boolean(),
    oauthClient: OAuthClientSchema.optional(),
  })
  .openapi('Connector')

export const ConnectorListSchema = z
  .object({ connectors: z.array(ConnectorSchema) })
  .openapi('ConnectorList')

export const ConnectionAccessSchema = z
  .object({
    mode: z.enum(['all', 'selected']).openapi({
      description:
        '`all`: every agent has it unless it opts out. `selected`: only `agentIds` (empty: registered, not used yet). An agent-scoped connection is `selected` with its one agent.',
    }),
    agentIds: z.array(z.string()).openapi({ description: 'Agents that use it now.' }),
    excludedAgentIds: z.array(z.string()).openapi({
      description: '`all` mode: agents that turned it off.',
    }),
  })
  .openapi('ConnectionAccess')

export const ConnectionAccessPutSchema = z
  .object({
    mode: z.enum(['all', 'selected']),
    agentIds: z.array(z.string()).max(500).optional().openapi({
      description: '`selected`: the agents that use the connection (ids or slugs).',
    }),
    excludedAgentIds: z.array(z.string()).max(500).optional().openapi({
      description: '`all`: the agents that opt out. Omitted: keep the current ones.',
    }),
  })
  .openapi('ConnectionAccessPut')

export const ConnectionSchema = z
  .object({
    id: z.string(),
    definitionId: z.string(),
    label: z.string(),
    enabled: z.boolean(),
    scope: Scope,
    scopeId: z.string().optional(),
    status: z.enum(['connected', 'needs-auth', 'error', 'disabled']),
    statusMessage: z.string().optional(),
    accountLabel: z.string().optional(),
    defaultEnabled: z.boolean().openapi({
      description: 'Workspace scope: every agent has the connection unless it opts out.',
    }),
    defaultModes: z.record(z.string(), Mode).optional(),
    capabilities: z.array(CapabilitySchema).optional().openapi({
      description: 'Discovered at connect time (replace the connector list).',
    }),
    settings: z.record(z.string(), z.unknown()).openapi({
      description: 'Secrets are `{ set, hint? }`; the value is never returned.',
    }),
    authorized: z.boolean(),
    builtin: z.boolean(),
    access: ConnectionAccessSchema.optional().openapi({
      description: 'Which agents use it (absent for built-in connections).',
    }),
    custom: z.boolean().openapi({
      description:
        'A custom (remote MCP) connection: its own connector in the directory, under the name its user gave it.',
    }),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('Connection')

export const ConnectionListSchema = z
  .object({ connections: z.array(ConnectionSchema) })
  .openapi('ConnectionList')

const ViewBase = { viewId: z.string(), step: z.string() }

const ChooseOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
})

export const FlowViewSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('form'),
      ...ViewBase,
      title: z.string(),
      description: z.string().optional(),
      fields: z.array(ProviderFieldSchema),
      values: z.record(z.string(), z.unknown()).openapi({
        description: 'Current values; a secret is `{ set, hint? }`.',
      }),
      errors: z.record(z.string(), z.string()).optional(),
      message: z.string().optional(),
      submitLabel: z.string(),
    }),
    z.object({
      type: z.literal('oauth'),
      ...ViewBase,
      title: z.string(),
      authorizeUrl: z.string(),
      pollIntervalMs: z.number(),
      expiresAt: z.number(),
    }),
    z.object({
      type: z.literal('deviceCode'),
      ...ViewBase,
      title: z.string(),
      userCode: z.string(),
      verificationUrl: z.string(),
      verificationUrlComplete: z.string().optional(),
      expiresAt: z.number(),
      pollIntervalMs: z.number(),
    }),
    z.object({
      type: z.literal('qr'),
      ...ViewBase,
      title: z.string(),
      description: z.string().optional(),
      url: z.string().openapi({
        description:
          'What the QR code encodes (a login token such as `tg://login?token=...`); it may change under the same `viewId` while the view is polled.',
      }),
      expiresAt: z.number(),
      pollIntervalMs: z.number(),
    }),
    z.object({
      type: z.literal('choose'),
      ...ViewBase,
      title: z.string(),
      description: z.string().optional(),
      options: z.array(ChooseOption),
      multiple: z.boolean(),
      selected: z.array(z.string()),
      min: z.number(),
      errors: z.record(z.string(), z.string()).optional(),
      message: z.string().optional(),
    }),
    z.object({
      type: z.literal('confirm'),
      ...ViewBase,
      title: z.string(),
      message: z.string(),
      confirmLabel: z.string(),
      cancelLabel: z.string(),
    }),
    z.object({
      type: z.literal('status'),
      ...ViewBase,
      state: z.enum(['running', 'success']),
      message: z.string(),
      account: z.string().optional(),
    }),
    z.object({
      type: z.literal('error'),
      ...ViewBase,
      message: z.string(),
      retryable: z.boolean(),
    }),
  ])
  .openapi('FlowView', {
    description:
      'What to show now. A closed vocabulary: render by `type`. Every action quotes the `viewId` of the view it answers.',
  })

export const FlowSchema = z
  .object({
    id: z.string(),
    definitionId: z.string(),
    scope: Scope,
    scopeId: z.string().optional(),
    label: z.string(),
    connectionId: z.string().optional(),
    status: z.enum(['active', 'done', 'failed', 'cancelled']),
    step: z.string(),
    rev: z.number().int(),
    view: FlowViewSchema,
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    expiresAt: z.number().int(),
  })
  .openapi('ConnectFlow')

export const FlowResultSchema = z
  .object({
    flow: FlowSchema,
    connection: ConnectionSchema.optional().openapi({
      description: 'Set once the flow finished and the connection was saved.',
    }),
  })
  .openapi('FlowResult')

export const FlowConflictSchema = z
  .object({
    error: ErrorSchema.shape.error,
    flow: FlowSchema.optional().openapi({
      description: 'The current state of the flow: re-render it (nothing is lost).',
    }),
    connection: ConnectionSchema.optional(),
  })
  .openapi('FlowConflict')

export const FlowStartSchema = z
  .object({
    definitionId: z
      .string()
      .optional()
      .openapi({ description: 'Connect a new connection of this connector.' }),
    connectionId: z
      .string()
      .optional()
      .openapi({ description: 'Or re-authorize this connection.' }),
    scope: z
      .enum(['workspace', 'agent'])
      .optional()
      .openapi({ description: 'Default `workspace`.' }),
    scopeId: z.string().optional().openapi({ description: 'The agent id or slug (agent scope).' }),
    label: z.string().min(1).max(80).optional(),
    defaultEnabled: z.boolean().optional().openapi({
      description: 'Workspace scope: available to all agents. Default false.',
    }),
  })
  .openapi('FlowStart')

export const FlowIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
})

export const FlowActSchema = z
  .object({
    viewId: z.string().min(1),
    action: z.enum(['submit', 'poll', 'back', 'cancel', 'retry', 'resend']),
    data: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        '`form`: the values (a secret may be `{ keep: true }`); `choose`: `{ selected }`.',
    }),
  })
  .openapi('FlowAct')

export const ConnectionIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' } }),
})

export const ConnectionsQuery = z.object({
  scope: z.enum(['workspace', 'agent']).optional(),
  scopeId: z.string().optional().openapi({ description: 'With `scope=agent`: the agent id.' }),
})

export const ConnectionPatchSchema = z
  .object({
    label: z.string().min(1).max(80).optional(),
    enabled: z
      .boolean()
      .optional()
      .openapi({ description: 'False switches the connection off for everyone.' }),
    settings: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'Keep-secret semantics: a secret omitted, `""` or `{ "keep": true }` keeps the stored value; `null` removes a value.',
    }),
    scope: z
      .enum(['workspace', 'agent'])
      .optional()
      .openapi({ description: 'Move between scopes.' }),
    scopeId: z.string().optional().openapi({ description: 'The agent (with `scope: "agent"`).' }),
    defaultEnabled: z.boolean().optional(),
    defaultModes: z.record(z.string(), Mode).optional().openapi({
      description: 'Default mode per capability for agents that do not choose.',
    }),
  })
  .openapi('ConnectionPatch')

export const ConnectionTestSchema = z
  .object({
    ok: z.boolean(),
    message: z.string().optional(),
    accountLabel: z.string().optional(),
    tools: z.number().int().optional(),
    connection: ConnectionSchema,
  })
  .openapi('ConnectionTest')

const ToolModeSchema = z.object({
  name: z.string(),
  mode: Mode,
  override: Mode.optional(),
})

export const AgentConnectorSchema = z
  .object({
    connectionId: z.string(),
    connectorId: z.string(),
    name: z.string().openapi({ example: 'GitHub' }),
    icon: z.string().optional(),
    category: z.string(),
    source: z.enum(['builtin', 'curated', 'custom']),
    label: z.string(),
    accountLabel: z.string().optional(),
    status: z.enum(['connected', 'needs-auth', 'error', 'disabled']),
    statusMessage: z.string().optional(),
    scope: z.enum(['workspace', 'agent']),
    ownership: z.enum(['workspace', 'agent']).openapi({
      description: '`workspace`: "From workspace"; `agent`: "This agent only".',
    }),
    defaultEnabled: z.boolean(),
    state: z.enum(ENABLED_STATES).openapi({ description: "This agent's own switch." }),
    enabled: z.boolean().openapi({ description: 'Whether the agent uses it now.' }),
    capabilities: z.array(
      CapabilitySchema.extend({
        mode: Mode.openapi({ description: 'Effective mode for this agent.' }),
        inherited: Mode.openapi({ description: "The mode without this agent's choice." }),
        override: Mode.optional(),
        pinned: z.boolean().openapi({
          description: 'Always asks, even in Bypass mode (write or destructive, not built in).',
        }),
        toolModes: z.array(ToolModeSchema),
        agentTools: z.array(z.string()).optional().openapi({
          description:
            "The names this agent calls the capability's tools by (`<connection>_<tool>` when the connection prefixes its tools). Programs name tools by these. Absent until the agent has been prepared.",
        }),
      }),
    ),
  })
  .openapi('AgentConnector')

export const AgentConnectorsSchema = z
  .object({ connectors: z.array(AgentConnectorSchema) })
  .openapi('AgentConnectorList')

export const AgentConnectorsPutSchema = z
  .object({
    connections: z.record(z.string(), ConnectionChoicesSchema.nullable()).openapi({
      description:
        'Connection id to its new choices (replaces that entry); `null` removes it (back to inherit).',
    }),
  })
  .openapi('AgentConnectorsPut')

export const OAuthClientPutSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().optional(),
  })
  .openapi('OAuthClientPut')

export const DefinitionIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Connector id.' }),
})

export const OAuthCallbackQuery = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export const CustomProbeBodySchema = z
  .object({ url: z.string().min(1).max(2048).openapi({ example: 'https://mcp.example.com/mcp' }) })
  .openapi('CustomProbeBody')

export const CustomProbeSchema = z
  .object({
    detected: z.enum(['none', 'oauth', 'unknown']).openapi({
      description:
        '`oauth`: the server answered 401, sign in needed. `none`: it answered without credentials. `unknown`: could not tell (unreachable, other status).',
    }),
    message: z.string(),
    serverName: z.string().optional(),
    tools: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'Tools listed without credentials.' }),
    oauth: z
      .object({
        discovered: z.boolean().openapi({ description: 'RFC 9728 / RFC 8414 metadata was found.' }),
        issuer: z.string().optional(),
        dynamicRegistration: z
          .boolean()
          .openapi({ description: 'The server registers clients itself: no client id needed.' }),
      })
      .optional(),
  })
  .openapi('CustomProbe')

export const CustomConnectorBodySchema = z
  .object({
    name: z.string().min(1).max(60).openapi({ example: 'Company docs' }),
    url: z.string().min(1).max(2048),
    signIn: z.enum(['now', 'later', 'none']).openapi({
      description:
        '`now`: sign in right after adding (the response carries the OAuth `flow` to open). `later`: saved as needs-auth, signed in when needed. `none`: no sign in; tools are discovered now.',
    }),
    oauthClient: z
      .object({
        clientId: z.string().min(1).max(512),
        clientSecret: z.string().max(2048).optional(),
      })
      .optional()
      .openapi({ description: 'Your own OAuth client (otherwise the server registers one).' }),
    headers: z
      .record(z.string(), z.string().max(4096))
      .optional()
      .openapi({ description: 'Request headers; values are secrets, stored encrypted.' }),
    availableToAll: z
      .boolean()
      .optional()
      .openapi({ description: 'Every agent gets it (workspace scope).' }),
    scope: z.enum(['workspace', 'agent']).optional(),
    scopeId: z.string().optional(),
    agentIds: z.array(z.string()).max(500).optional().openapi({
      description:
        'Workspace scope without `availableToAll`: the agents that use it from the start (none by default: registered, not used yet).',
    }),
  })
  .openapi('CustomConnectorBody')

export const CustomConnectorResultSchema = z
  .object({ connection: ConnectionSchema, flow: FlowSchema.optional() })
  .openapi('CustomConnectorResult')
