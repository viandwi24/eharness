/**
 * Remote MCP servers with a fresh bearer token per request, and a tool lister: the pieces
 * `eharness/connectors` needs (`ActivateOptions.mcp`, the custom MCP connector's test) without
 * importing this module itself.
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 * @see docs/specs/24-connectors.md#9-remote-mcp
 */
import type {
  MCPClient,
  MCPClientConfig,
  McpToolAnnotations,
  OAuthClientProvider,
} from '@ai-sdk/mcp'
import type { ToolRisk, ToolSource } from '../index.ts'
import { createMcpServer, type McpTransportConfig } from './server.ts'

/** A remote (streamable HTTP) MCP server, as `eharness/connectors` describes it. */
export interface RemoteMcpSpec {
  /** Source name (`^[a-z0-9-]{1,32}$`). */
  name: string
  url: string
  /** Static headers (API keys). */
  headers?: Record<string, string>
  /** Bearer token per request: refreshed tokens are picked up without reconnecting. */
  getAccessToken?: () => Promise<string>
  allow?: string[]
  deny?: string[]
  /** Tool name prefix. Default `` `${name}_` ``; `''` for none. */
  prefix?: string
  defer?: boolean | 'auto'
  risk?: ToolRisk
}

/**
 * An `OAuthClientProvider` that only supplies a bearer token (`tokens()` is called for every
 * request by the HTTP transport). It never starts an authorization: on a 401 the transport fails
 * with an error and the connection should be marked as needing a reconnect.
 */
export function bearerAuthProvider(getAccessToken: () => Promise<string>): OAuthClientProvider {
  const reconnect = (): never => {
    throw new Error('The access token was rejected; reconnect the connector.')
  }
  return {
    tokens: async () => ({ access_token: await getAccessToken(), token_type: 'Bearer' }),
    saveTokens: () => undefined,
    redirectToAuthorization: reconnect,
    saveCodeVerifier: () => undefined,
    codeVerifier: reconnect,
    get redirectUrl(): string {
      return 'about:blank'
    },
    get clientMetadata() {
      return { redirect_uris: [], client_name: 'eharness' }
    },
    clientInformation: () => undefined,
  }
}

/** The HTTP transport config of a {@link RemoteMcpSpec}. */
export function remoteMcpTransport(spec: RemoteMcpSpec): McpTransportConfig {
  return {
    type: 'http',
    url: spec.url,
    ...(spec.headers === undefined ? {} : { headers: { ...spec.headers } }),
    ...(spec.getAccessToken === undefined
      ? {}
      : { authProvider: bearerAuthProvider(spec.getAccessToken) }),
  }
}

type McpModule = {
  createMCPClient(config: MCPClientConfig): Promise<Pick<MCPClient, 'tools' | 'close'>>
}

/**
 * A {@link mcpServer}-style tool source for a remote server, with a per-request bearer token
 * when `getAccessToken` is given. Use it as `activateConnectors({ mcp: remoteMcpSource })`.
 *
 * @example
 * ```ts
 * const { mcpSources } = await activateConnectors({ ..., mcp: remoteMcpSource })
 * ```
 */
export function remoteMcpSource(spec: RemoteMcpSpec & { kind?: 'mcp' }): ToolSource {
  return createRemoteMcpSource(spec)
}

/** @internal injectable module loader for tests */
export function createRemoteMcpSource(
  spec: RemoteMcpSpec,
  load?: () => Promise<McpModule>,
): ToolSource {
  return createMcpServer(
    {
      name: spec.name,
      transport: () => remoteMcpTransport(spec),
      ...(spec.prefix === undefined ? {} : { prefix: spec.prefix }),
      ...(spec.allow === undefined ? {} : { allow: spec.allow }),
      ...(spec.deny === undefined ? {} : { deny: spec.deny }),
      ...(spec.defer === undefined ? {} : { defer: spec.defer }),
      ...(spec.risk === undefined ? {} : { risk: spec.risk }),
    },
    load as never,
  )
}

/** One tool a remote server lists. */
export interface RemoteMcpTool {
  name: string
  description?: string
  /** The annotations the server sent (untrusted hints). */
  annotations?: McpToolAnnotations
}

/**
 * Connect to a remote server once and list its tools (name, description, annotations); closes the
 * client. Rejects when the server cannot be reached or `@ai-sdk/mcp` is not installed.
 */
export async function listRemoteMcpTools(
  spec: Omit<RemoteMcpSpec, 'name'>,
  load: () => Promise<McpModule> = async () => (await import('@ai-sdk/mcp')) as McpModule,
): Promise<RemoteMcpTool[]> {
  const mod = await load()
  const client = await mod.createMCPClient({
    transport: remoteMcpTransport({ name: 'probe', ...spec }),
  })
  try {
    const tools = (await client.tools()) as unknown as Record<
      string,
      { description?: string; metadata?: { annotations?: McpToolAnnotations } }
    >
    return Object.entries(tools).map(([name, tool]) => ({
      name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.metadata?.annotations === undefined
        ? {}
        : { annotations: tool.metadata.annotations }),
    }))
  } finally {
    await client.close().catch(() => undefined)
  }
}
