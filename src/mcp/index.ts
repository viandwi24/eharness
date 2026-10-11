/**
 * `eharness/mcp`: MCP servers as dynamic tool sources, over the optional peer dependency
 * `@ai-sdk/mcp` (loaded lazily at connect time).
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserversource-eharnessmcp
 */

export {
  bearerAuthProvider,
  listRemoteMcpTools,
  type RemoteMcpSpec,
  type RemoteMcpTool,
  remoteMcpSource,
} from './remote.ts'
export {
  clearMcpPins,
  type McpRiskFunction,
  type McpServerSourceOptions,
  type McpTransportConfig,
  type McpTransportInput,
  mcpServerSource,
} from './server.ts'
