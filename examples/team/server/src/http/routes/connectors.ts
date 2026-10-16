import { createRoute, OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  acceptConnectionDefinitions,
  actOnFlow,
  createCustomConnector,
  getAgentConnectors,
  getConnectFlow,
  listCatalog,
  listConnections,
  oauthCallback,
  probeCustomConnector,
  putAgentConnectors,
  removeConnection,
  removeOAuthClient,
  setConnectionAccess,
  setOAuthClient,
  startConnectFlow,
  testConnection,
  updateConnection,
} from '../../app/connectors.ts'
import { notFound } from '../../app/errors.ts'
import type { Deps } from '../../app/ports.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'
import {
  AgentConnectorsPutSchema,
  AgentConnectorsSchema,
  ConnectionAccessPutSchema,
  ConnectionIdParam,
  ConnectionListSchema,
  ConnectionPatchSchema,
  ConnectionSchema,
  ConnectionsQuery,
  ConnectionTestSchema,
  ConnectorListSchema,
  CustomConnectorBodySchema,
  CustomConnectorResultSchema,
  CustomProbeBodySchema,
  CustomProbeSchema,
  DefinitionIdParam,
  FlowActSchema,
  FlowConflictSchema,
  FlowIdParam,
  FlowResultSchema,
  FlowStartSchema,
  OAuthCallbackQuery,
  OAuthClientPutSchema,
} from '../schemas/connectors.ts'
import { AcceptDefinitionsSchema } from '../schemas/session-tools.ts'

const security = [{ Bearer: [] }]
const content = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })

const catalog = createRoute({
  method: 'get',
  path: '/connectors',
  tags: ['connectors'],
  summary: 'The connector catalog',
  description:
    'Built-in connectors (Files, Memory, Planning, Web, Ask the user, Team: included, no connect step), curated third-party connectors (GitHub) and the custom connector (any remote MCP URL). Each carries its settings form, what it can do (capabilities, in plain words), how it authenticates and, for OAuth apps, whether the admin credentials are configured.',
  security,
  responses: {
    200: { description: 'Connectors', content: content(ConnectorListSchema) },
    ...errorResponses,
  },
})

const connections = createRoute({
  method: 'get',
  path: '/connections',
  tags: ['connectors'],
  summary: 'Connections (workspace and agent scoped)',
  description:
    'Secrets are redacted (`{ set, hint }`). A workspace connection is connected once; `defaultEnabled` makes it available to every agent. Built-in connectors have one workspace connection each (`builtin: true`).',
  security,
  request: { query: ConnectionsQuery },
  responses: {
    200: { description: 'Connections', content: content(ConnectionListSchema) },
    ...errorResponses,
  },
})

const startFlow = createRoute({
  method: 'post',
  path: '/connections/flows',
  tags: ['connectors'],
  summary: 'Start connecting (or reconnecting) a connector',
  description:
    'Returns a flow whose `view` says what to show: a form, an OAuth authorization to open in a popup, a device code, a choice, a confirmation or the end. Answer it with `POST /connections/flows/{id}/act`.',
  security,
  request: { body: { required: true, content: content(FlowStartSchema) } },
  responses: {
    201: { description: 'The flow', content: content(FlowResultSchema) },
    404: jsonError('Unknown connector, connection or agent'),
    409: jsonError('Built-in connector (nothing to connect)'),
    ...errorResponses,
  },
})

const getFlow = createRoute({
  method: 'get',
  path: '/connections/flows/{id}',
  tags: ['connectors'],
  summary: 'The current state of a flow',
  description: 'A reload (or the OAuth redirect back to the app) resumes here.',
  security,
  request: { params: FlowIdParam },
  responses: {
    200: { description: 'The flow', content: content(FlowResultSchema) },
    404: jsonError('Unknown or expired flow'),
    ...errorResponses,
  },
})

const act = createRoute({
  method: 'post',
  path: '/connections/flows/{id}/act',
  tags: ['connectors'],
  summary: 'Answer the current view of a flow',
  description:
    'Quote the `viewId` of the view you answer. A stale `viewId` (a double submit, another tab) is a 409 `STALE_VIEW` that carries the current `flow`: re-render it. A finished flow returns the saved `connection`.',
  security,
  request: { params: FlowIdParam, body: { required: true, content: content(FlowActSchema) } },
  responses: {
    200: { description: 'The next state', content: content(FlowResultSchema) },
    404: jsonError('Unknown or expired flow'),
    409: {
      description: 'Stale view, expired or already finished (with the current flow)',
      content: content(FlowConflictSchema),
    },
    ...errorResponses,
  },
})

const callback = createRoute({
  method: 'get',
  path: '/oauth/callback',
  tags: ['connectors'],
  summary: 'OAuth redirect target',
  description:
    'Register this URL with the OAuth app. Not authenticated (a browser redirect cannot carry the token; the single-use `state` is the proof). Completes the flow and redirects to the web app at `/connectors?flow=<id>`.',
  request: { query: OAuthCallbackQuery },
  responses: { 302: { description: 'Redirect to the web app' } },
})

const patch = createRoute({
  method: 'patch',
  path: '/connections/{id}',
  tags: ['connectors'],
  summary: 'Edit a connection',
  description:
    'Label, settings (keep-secret semantics), scope, availability to all agents (`defaultEnabled`) and the default mode per capability.',
  security,
  request: {
    params: ConnectionIdParam,
    body: { required: true, content: content(ConnectionPatchSchema) },
  },
  responses: {
    200: { description: 'The connection, redacted', content: content(ConnectionSchema) },
    404: jsonError('Unknown connection'),
    409: jsonError('Built-in connection'),
    ...errorResponses,
  },
})

const accessPut = createRoute({
  method: 'put',
  path: '/connections/{id}/access',
  tags: ['connectors'],
  summary: 'Choose which agents use a connection',
  description:
    "One concept for workspace and agent connections. `all`: workspace connection available to every agent (agents may still opt out: `excludedAgentIds`). `selected`: only `agentIds` (empty: registered but unused). Moving agents is just changing this list; an agent-scoped connection is converted to workspace scope keeping its id, credentials, tool prefix and the agent's own capability modes. Returns the connection with its `access`.",
  security,
  request: {
    params: ConnectionIdParam,
    body: { required: true, content: content(ConnectionAccessPutSchema) },
  },
  responses: {
    200: { description: 'The connection, redacted', content: content(ConnectionSchema) },
    404: jsonError('Unknown connection'),
    409: jsonError('Built-in connection'),
    ...errorResponses,
  },
})

const remove = createRoute({
  method: 'delete',
  path: '/connections/{id}',
  tags: ['connectors'],
  summary: 'Disconnect',
  description:
    "Deletes the connection, its stored credentials and every agent's choices for it. Built-in connections can not be removed.",
  security,
  request: { params: ConnectionIdParam },
  responses: {
    204: { description: 'Disconnected' },
    404: jsonError('Unknown connection'),
    409: jsonError('Built-in connection'),
    ...errorResponses,
  },
})

const test = createRoute({
  method: 'post',
  path: '/connections/{id}/test',
  tags: ['connectors'],
  summary: 'Test a connection',
  description:
    'Never fails with an error status for a bad key: `ok: false` carries the reason. Records the status, the account and the tools found.',
  security,
  request: { params: ConnectionIdParam },
  responses: {
    200: { description: 'Result', content: content(ConnectionTestSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})

const acceptDefinitions = createRoute({
  method: 'post',
  path: '/connections/{id}/accept-definitions',
  tags: ['connectors'],
  summary: 'Accept the current tool definitions of a remote server in every chat',
  description:
    'A chat pins the tool definitions a remote MCP server first showed it and keeps tools the server changed afterwards off (a server must not silently rewrite what a tool does). This is the owner accepting what the server offers now: the pins of this connection are cleared in every chat of every agent that uses it, and those chats reload (a running turn is not cut). `pinsCleared` counts the sets cleared.',
  security,
  request: { params: ConnectionIdParam },
  responses: {
    200: { description: 'What was reloaded', content: content(AcceptDefinitionsSchema) },
    404: jsonError('Unknown connection'),
    ...errorResponses,
  },
})

const agentGet = createRoute({
  method: 'get',
  path: '/agents/{id}/connectors',
  tags: ['connectors'],
  summary: 'The connectors an agent can use',
  description:
    'Every connection available to the agent: workspace connections (`ownership: "workspace"`, "From workspace") and its own (`"agent"`, "This agent only"), with the effective state and the effective mode per capability. Technical tool names are only in `toolModes` (Advanced).',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Connectors', content: content(AgentConnectorsSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const agentPut = createRoute({
  method: 'put',
  path: '/agents/{id}/connectors',
  tags: ['connectors'],
  summary: 'Change what an agent uses',
  description:
    "Replaces the agent's choices for each connection given (`null` goes back to inherit) and returns the new view. Stricter of the agent's own rules and these modes wins; writes of non-built-in connectors that ask always ask, even in Bypass mode.",
  security,
  request: {
    params: IdParam,
    body: { required: true, content: content(AgentConnectorsPutSchema) },
  },
  responses: {
    200: { description: 'Connectors', content: content(AgentConnectorsSchema) },
    404: jsonError('Unknown agent or connection'),
    ...errorResponses,
  },
})

const clientPut = createRoute({
  method: 'put',
  path: '/connectors/{id}/oauth-client',
  tags: ['connectors'],
  summary: 'Save the OAuth app credentials of a connector',
  description:
    'For connectors that need an OAuth app (GitHub): the client id and secret are stored encrypted and never returned. `TEAM_<CONNECTOR>_CLIENT_ID` / `_CLIENT_SECRET` in the environment win.',
  security,
  request: {
    params: DefinitionIdParam,
    body: { required: true, content: content(OAuthClientPutSchema) },
  },
  responses: {
    204: { description: 'Saved' },
    404: jsonError('Unknown connector'),
    ...errorResponses,
  },
})

const clientDelete = createRoute({
  method: 'delete',
  path: '/connectors/{id}/oauth-client',
  tags: ['connectors'],
  summary: 'Remove the saved OAuth app credentials',
  security,
  request: { params: DefinitionIdParam },
  responses: {
    204: { description: 'Removed' },
    404: jsonError('Unknown connector'),
    ...errorResponses,
  },
})

const probeRoute = createRoute({
  method: 'post',
  path: '/connectors/custom/probe',
  tags: ['connectors'],
  summary: 'Find out which sign-in a remote MCP server needs',
  description:
    'Sends an unauthenticated MCP `initialize` to the URL. `401` means sign in is needed (OAuth is detected through RFC 9728 / RFC 8414 discovery); a normal answer means no sign in. Nothing is saved. Never fails for an unreachable server: `detected: "unknown"` says why.',
  security,
  request: { body: { required: true, content: content(CustomProbeBodySchema) } },
  responses: {
    200: { description: 'What was found', content: content(CustomProbeSchema) },
    ...errorResponses,
  },
})

const createCustomRoute = createRoute({
  method: 'post',
  path: '/connectors/custom',
  tags: ['connectors'],
  summary: 'Add a custom connector',
  description:
    'Creates a new connection of the custom connector under its own name (like Claude\'s "Add custom connector"). `signIn: "none"` connects now and discovers the tools (a server that can not be reached saves nothing, 400 `CONNECT_FAILED`); `later` saves it as needs-auth; `now` also returns the OAuth `flow` to open. The tool prefix is derived from the name once, unique in the workspace, and never changes on rename.',
  security,
  request: { body: { required: true, content: content(CustomConnectorBodySchema) } },
  responses: {
    201: { description: 'The connector', content: content(CustomConnectorResultSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const FLOW_STATUS = {
  'stale-view': 409,
  expired: 409,
  finished: 409,
  'invalid-action': 400,
  'not-found': 404,
  'principal-mismatch': 403,
} as const
const FLOW_CODE = {
  'stale-view': 'STALE_VIEW',
  expired: 'FLOW_EXPIRED',
  finished: 'FLOW_FINISHED',
  'invalid-action': 'INVALID_ACTION',
  'not-found': 'NOT_FOUND',
  'principal-mismatch': 'FORBIDDEN',
} as const

export function connectorRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(catalog, async (c) => c.json({ connectors: await listCatalog(deps) }, 200))
    .openapi(connections, async (c) =>
      c.json({ connections: await listConnections(deps, c.req.valid('query')) }, 200),
    )
    .openapi(probeRoute, async (c) =>
      c.json(await probeCustomConnector(deps, c.req.valid('json')), 200),
    )
    .openapi(createCustomRoute, async (c) =>
      c.json((await createCustomConnector(deps, c.req.valid('json'))) as never, 201),
    )
    .openapi(startFlow, async (c) =>
      c.json((await startConnectFlow(deps, c.req.valid('json'))) as never, 201),
    )
    .openapi(getFlow, async (c) => {
      const id = c.req.valid('param').id
      const flow = await getConnectFlow(deps, id)
      if (flow === undefined) throw notFound('flow', id)
      return c.json(flow as never, 200)
    })
    .openapi(act, async (c) => {
      const result = await actOnFlow(deps, c.req.valid('param').id, c.req.valid('json'))
      if (result.ok) {
        return c.json(
          {
            flow: result.flow,
            ...(result.connection ? { connection: result.connection } : {}),
          } as never,
          200,
        )
      }
      const body = {
        error: { code: FLOW_CODE[result.error], message: result.message },
        ...(result.flow === undefined ? {} : { flow: result.flow }),
        ...(result.connection === undefined ? {} : { connection: result.connection }),
      }
      return c.json(body as never, FLOW_STATUS[result.error] as 409)
    })
    .openapi(callback, async (c) => {
      const q = c.req.valid('query')
      const result = await oauthCallback(deps, {
        ...(q.state === undefined ? {} : { state: q.state }),
        ...(q.code === undefined ? {} : { code: q.code }),
        ...(q.error === undefined ? {} : { error: q.error }),
        ...(q.error_description === undefined ? {} : { errorDescription: q.error_description }),
      })
      const base = `${deps.webUrl.replace(/\/$/, '')}/connectors`
      return c.redirect(
        result.flowId === undefined
          ? `${base}?oauth_error=${encodeURIComponent(result.error ?? 'unknown')}`
          : `${base}?flow=${encodeURIComponent(result.flowId)}`,
        302,
      )
    })
    .openapi(patch, async (c) =>
      c.json(await updateConnection(deps, c.req.valid('param').id, c.req.valid('json')), 200),
    )
    .openapi(accessPut, async (c) =>
      c.json(
        (await setConnectionAccess(deps, c.req.valid('param').id, c.req.valid('json'))) as never,
        200,
      ),
    )
    .openapi(remove, async (c) => {
      await removeConnection(deps, c.req.valid('param').id)
      return c.body(null, 204)
    })
    .openapi(test, async (c) => c.json(await testConnection(deps, c.req.valid('param').id), 200))
    .openapi(acceptDefinitions, async (c) =>
      c.json(await acceptConnectionDefinitions(deps, c.req.valid('param').id), 200),
    )
    .openapi(agentGet, async (c) =>
      c.json({ connectors: await getAgentConnectors(deps, c.req.valid('param').id) }, 200),
    )
    .openapi(agentPut, async (c) =>
      c.json(
        {
          connectors: await putAgentConnectors(
            deps,
            c.req.valid('param').id,
            c.req.valid('json').connections,
          ),
        },
        200,
      ),
    )
    .openapi(clientPut, async (c) => {
      await setOAuthClient(deps, c.req.valid('param').id, c.req.valid('json'))
      return c.body(null, 204)
    })
    .openapi(clientDelete, async (c) => {
      await removeOAuthClient(deps, c.req.valid('param').id)
      return c.body(null, 204)
    })
}
