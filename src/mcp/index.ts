/**
 * `eharness/mcp`: MCP servers as dynamic tool sources, over the optional peer dependency
 * `@ai-sdk/mcp` (loaded lazily at connect time).
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 */
export {
  clearMcpPins,
  MCP_AUTO_DEFER_THRESHOLD,
  type McpServerOptions,
  type McpTransportConfig,
  type McpTransportInput,
  mcpServer,
} from './server.ts'
