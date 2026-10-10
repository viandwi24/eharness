/**
 * The custom remote MCP connector: a URL plus headers (secret values) or OAuth through MCP
 * discovery (RFC 9728 / 8414, dynamic client registration).
 *
 * @see docs/specs/24-connectors.md#9-remote-mcp
 */
import { z } from 'zod/v4'
import { ehMeta } from '../providers/index.ts'
import { defineConnector } from './definition.ts'
import type { CapabilityDef, ConnectorDefinition, ConnectorTestResult } from './types.ts'

/** One tool of a remote server, as the connector's `listTools` reports it. */
export interface RemoteToolInfo {
  name: string
  description?: string
  annotations?: {
    readOnlyHint?: boolean
    destructiveHint?: boolean
    openWorldHint?: boolean
    [key: string]: unknown
  }
}

/** Options of {@link remoteMcpConnector}. */
export interface RemoteMcpConnectorOptions {
  /** Default `'mcp-remote'`. */
  id?: string
  name?: string
  description?: string
  icon?: string
  category?: string
  /**
   * Lists the server's tools at connect time (`listRemoteMcpTools` from `eharness/mcp`). Without
   * it the connection test only checks the URL, no capabilities are discovered and every tool of
   * the server is offered (the permission engine asks for each unknown tool).
   */
  listTools?: (server: {
    url: string
    headers?: Record<string, string>
    getAccessToken?: () => Promise<string>
  }) => Promise<RemoteToolInfo[]>
  /** Instruction block. */
  instructions?: string
}

const settingsSchema: z.ZodObject = z.object({
  url: z
    .url()
    .refine(
      (value) => {
        try {
          const u = new URL(value)
          return (
            u.protocol === 'https:' ||
            (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))
          )
        } catch {
          return false
        }
      },
      { message: 'Use an https URL.' },
    )
    .meta({
      title: 'Server URL',
      description: 'The MCP server endpoint (streamable HTTP).',
      ...ehMeta({ group: 'endpoint', placeholder: 'https://mcp.example.com/mcp' }),
    }),
  authMode: z
    .enum(['none', 'headers', 'oauth'])
    .default('none')
    .meta({
      title: 'Authentication',
      description: 'How the server authenticates requests.',
      ...ehMeta({
        group: 'auth',
        widget: 'radio',
        optionLabels: {
          none: 'No authentication',
          headers: 'API key or headers',
          oauth: 'OAuth (sign in)',
        },
      }),
    }),
  headers: z
    .record(z.string(), z.string())
    .refine((rec) => Object.keys(rec).every((k) => /^[A-Za-z0-9-]{1,64}$/.test(k)), {
      message: 'Header names may contain letters, digits and hyphens only.',
    })
    .optional()
    .meta({
      title: 'Headers',
      description: 'Sent with every request, for example Authorization.',
      ...ehMeta({
        group: 'auth',
        widget: 'keyvalue',
        secretValues: true,
        showWhen: { field: 'authMode', equals: 'headers' },
      }),
    }),
})

interface Settings {
  url: string
  authMode: 'none' | 'headers' | 'oauth'
  headers?: Record<string, string>
}

/** Group a server's tools into capabilities by their annotations (unannotated tools count as writes). */
export function capabilitiesFromTools(tools: readonly RemoteToolInfo[]): CapabilityDef[] {
  const groups: Record<'read' | 'write' | 'destructive', string[]> = {
    read: [],
    write: [],
    destructive: [],
  }
  for (const tool of tools) {
    const a = tool.annotations
    if (a?.destructiveHint === true) groups.destructive.push(tool.name)
    else if (a?.readOnlyHint === true) groups.read.push(tool.name)
    else groups.write.push(tool.name)
  }
  const out: CapabilityDef[] = []
  if (groups.read.length > 0) {
    out.push({
      id: 'read',
      title: 'Read-only tools',
      description: `Tools that only read: ${groups.read.join(', ')}.`,
      kind: 'read',
      tools: groups.read,
      defaultMode: 'allow',
    })
  }
  if (groups.write.length > 0) {
    out.push({
      id: 'write',
      title: 'Tools that change data',
      description: `Tools that can change data: ${groups.write.join(', ')}.`,
      kind: 'write',
      tools: groups.write,
      defaultMode: 'ask',
    })
  }
  if (groups.destructive.length > 0) {
    out.push({
      id: 'destructive',
      title: 'Destructive tools',
      description: `Tools that can delete or destroy data: ${groups.destructive.join(', ')}.`,
      kind: 'destructive',
      tools: groups.destructive,
      defaultMode: 'ask',
    })
  }
  return out
}

/**
 * The "custom remote MCP" connector. Settings: `url`, `authMode` (`none`, `headers`, `oauth`)
 * and `headers` (secret values). With `oauth` the flow discovers the authorization server from
 * the MCP URL (RFC 9728, RFC 8414), registers a client dynamically (RFC 7591) and runs the code
 * flow with PKCE and a resource indicator. The connection test lists the server's tools (when
 * `listTools` is given) and stores them as capabilities grouped by annotations; read-only tools
 * default to `allow`, the rest to `ask` (pinned: bypass mode does not skip them).
 *
 * Activation contributes a {@link McpSourceSpec}: pass `mcp: remoteMcpSource` (from
 * `eharness/mcp`) to `activateConnectors`.
 */
export function remoteMcpConnector(options: RemoteMcpConnectorOptions = {}): ConnectorDefinition {
  const listTools = options.listTools
  return defineConnector({
    id: options.id ?? 'mcp-remote',
    version: '1',
    name: options.name ?? 'Custom MCP server',
    description: options.description ?? 'Connect any remote MCP server by URL.',
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    category: options.category ?? 'custom',
    source: 'custom',
    scopes: ['workspace', 'agent'],
    settings: settingsSchema,
    auth: {
      type: 'oauth2',
      discovery: 'mcp',
      scopes: [],
      pkce: true,
      dcr: 'auto',
      when: (settings) => settings.authMode === 'oauth',
    },
    capabilities: [],
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    test: async (ctx): Promise<ConnectorTestResult> => {
      const s = ctx.settings as unknown as Settings
      if (listTools === undefined) return { ok: true, message: 'Saved. Tools are not listed.' }
      try {
        const token = ctx.accessToken
        const tools = await listTools({
          url: s.url,
          ...(s.authMode === 'headers' && s.headers !== undefined ? { headers: s.headers } : {}),
          ...(s.authMode === 'oauth' && token !== undefined
            ? { getAccessToken: () => Promise.resolve(token) }
            : {}),
        })
        return {
          ok: true,
          message: `Found ${tools.length} tools.`,
          capabilities: capabilitiesFromTools(tools),
        }
      } catch (error) {
        return {
          ok: false,
          message: `Could not reach the server: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
        }
      }
    },
    activate: (ctx) => {
      const s = ctx.settings as unknown as Settings
      return {
        kind: 'mcp',
        name: ctx.slug,
        url: s.url,
        ...(s.authMode === 'headers' && s.headers !== undefined ? { headers: s.headers } : {}),
        ...(s.authMode === 'oauth' ? { getAccessToken: ctx.connection.getAccessToken } : {}),
      }
    },
  })
}
