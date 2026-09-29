/**
 * An in-process MCP server behind a custom `MCPTransport` test double (no network). Used by the
 * `eharness/mcp` tests only; not an entry point, not bundled.
 */
import type { JSONRPCMessage, MCPTransport } from '@ai-sdk/mcp'

/** One tool the fake server exposes. */
export interface FakeMcpTool {
  name: string
  description?: string
  title?: string
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
  /** Result text; a function receives the call arguments. Throwing → JSON-RPC error. */
  call?: (args: Record<string, unknown>) => string | Promise<string>
}

/** A fake MCP server whose tool list can be changed between connects. */
export interface FakeMcpServer {
  tools: FakeMcpTool[]
  /** Transports created so far. */
  readonly transports: FakeTransport[]
  /** Number of `start()` / `close()` calls over all transports. */
  readonly started: number
  readonly closed: number
  /** Names of every `tools/call` request, in order. */
  readonly calls: string[]
  /** Make the next `start()` calls fail (connection failure). */
  failStart: number
  /** Create a transport connected to this server. */
  transport(): FakeTransport
}

/** The transport test double. */
export interface FakeTransport extends MCPTransport {
  readonly isOpen: boolean
}

/** Create a fake MCP server. */
export function fakeMcpServer(tools: FakeMcpTool[] = []): FakeMcpServer {
  const server: FakeMcpServer = {
    tools,
    transports: [],
    started: 0,
    closed: 0,
    calls: [],
    failStart: 0,
    transport() {
      let open = false
      const reply = (message: JSONRPCMessage) => {
        // asynchronous delivery, like a real transport
        queueMicrotask(() => {
          if (open) transport.onmessage?.(message)
        })
      }
      const transport: FakeTransport = {
        get isOpen() {
          return open
        },
        async start() {
          ;(server as { started: number }).started++
          if (server.failStart > 0) {
            server.failStart--
            throw new Error('connection refused')
          }
          open = true
        },
        async close() {
          if (!open) return
          open = false
          ;(server as { closed: number }).closed++
          transport.onclose?.()
        },
        async send(message) {
          if (!open) throw new Error('transport closed')
          if (!('method' in message) || !('id' in message)) return // notifications
          const id = message.id
          const params = (message.params ?? {}) as Record<string, unknown>
          try {
            const result = await handle(message.method, params)
            reply({ jsonrpc: '2.0', id, result } as JSONRPCMessage)
          } catch (error) {
            reply({
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: error instanceof Error ? error.message : 'error' },
            } as JSONRPCMessage)
          }
        },
      }
      server.transports.push(transport)
      return transport
    },
  }

  async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.0.0' },
        }
      case 'tools/list':
        return {
          tools: server.tools.map((t) => ({
            name: t.name,
            ...(t.title === undefined ? {} : { title: t.title }),
            ...(t.description === undefined ? {} : { description: t.description }),
            inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
            ...(t.annotations === undefined ? {} : { annotations: t.annotations }),
          })),
        }
      case 'tools/call': {
        const name = String(params.name)
        server.calls.push(name)
        const tool = server.tools.find((t) => t.name === name)
        if (tool === undefined) throw new Error(`unknown tool ${name}`)
        const args = (params.arguments ?? {}) as Record<string, unknown>
        const text = tool.call === undefined ? `${name} ok` : await tool.call(args)
        return { content: [{ type: 'text', text }], isError: false }
      }
      default:
        throw new Error(`unsupported method ${method}`)
    }
  }

  return server
}
