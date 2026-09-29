/**
 * `mcpServer()`: a `ToolSource` over `@ai-sdk/mcp` (optional peer dependency) with one MCP client
 * per session, allow/deny, prefixing, deferral, lazy/eager connect and definition pinning; and
 * `clearMcpPins()`.
 *
 * `@ai-sdk/mcp` is loaded with a dynamic `import()` at connect time; only its types are imported
 * statically, so importing `eharness/mcp` never fails without it.
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 */
import type { MCPClient, MCPClientConfig } from '@ai-sdk/mcp'
import { detectToolDrift, fingerprintTools, type Tool, type ToolSet } from 'ai'
import {
  defineToolSource,
  type HarnessAgent,
  type HarnessContext,
  HarnessError,
  type SessionStateSnapshot,
  type StateAdapter,
  type ToolSource,
} from '../index.ts'

/** What `createMCPClient({ transport })` accepts: a transport config or an `MCPTransport`. */
export type McpTransportInput = MCPClientConfig['transport']

/**
 * Options of {@link mcpServer}.
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 */
export interface McpServerOptions {
  /** Short name; used as tool prefix and source id `'mcp:<name>'`. `^[a-z0-9-]{1,32}$` */
  name: string
  /**
   * Passed to `createMCPClient({ transport })`, or a resolver called once per session (per-user
   * credentials). Every session gets its own client: pass a transport **config** or a resolver
   * that creates a new `MCPTransport` per call, never one shared `MCPTransport` instance.
   */
  transport:
    | McpTransportInput
    | ((ctx: HarnessContext) => McpTransportInput | Promise<McpTransportInput>)
  /** Tool name prefix. Default `` `${name}_` ``. Use `''` to disable. */
  prefix?: string
  /** Allow list of the server's tool names (before prefixing). */
  allow?: string[]
  /** Deny list of the server's tool names (before prefixing). */
  deny?: string[]
  /**
   * Mark tools deferred (discovered via `tool_search`). Default `'auto'`: deferred when more than
   * 20 tools remain after allow/deny.
   */
  defer?: boolean | 'auto'
  /** `'lazy'` (default): connect at the first turn of the session. `'eager'`: at session open. */
  connect?: 'lazy' | 'eager'
  /** Pin tool definitions on first connect and exclude changed or added tools (drift). Default false. */
  pinDefinitions?: boolean
  /** `createMCPClient` `maxRetries`: retries of `tools/call` requests only (not connect). Default 0. */
  maxRetries?: number
  /** When to list the tools: once per session (default) or before every turn. */
  refresh?: 'session' | 'turn'
}

/** Tools above this count are deferred with `defer: 'auto'`. */
export const MCP_AUTO_DEFER_THRESHOLD = 20

const NAME = /^[a-z0-9-]{1,32}$/

type McpModule = { createMCPClient(config: MCPClientConfig): Promise<MCPClient> }

/** Raised when `@ai-sdk/mcp` cannot be loaded. */
class McpMissingError extends Error {}

const INSTALL_HINT = 'install @ai-sdk/mcp (optional peer dependency of eharness)'

async function importMcp(): Promise<McpModule> {
  return (await import('@ai-sdk/mcp')) as McpModule
}

/** Per-session connection state. */
interface Conn {
  readonly ctx: HarnessContext
  client: MCPClient | undefined
  connecting: Promise<MCPClient> | undefined
  closed: boolean
}

/** Internals of one `mcpServer()` source (tests and `clearMcpPins`). */
export interface McpSourceInternals {
  readonly name: string
  /** Number of sessions with state in this source (open, not yet released). */
  liveSessions(): number
}

// ─── live sessions (for clearMcpPins) ───────────────────────────────────────────────────────
// Holds the contexts of open sessions only: entries are removed when the session closes.

interface LiveEntry {
  readonly name: string
  readonly ctx: HarnessContext
}

const live = new Map<string, Set<LiveEntry>>()
/** `clearMcpPins` requests for sessions being opened just to clear their pins. */
const pendingClears = new Set<string>()

const sessionKey = (agentId: string, sessionId: string) => `${agentId}\u0000${sessionId}`
const clearKey = (agentId: string, sessionId: string, name: string) =>
  `${sessionKey(agentId, sessionId)}\u0000${name}`

/** State key of the pins of server `name` (in the owner plugin's namespace). */
export function mcpPinsKey(name: string): string {
  return `mcp:${name}:pins`
}

function invalid(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', message)
}

function validate(opts: McpServerOptions): void {
  if (typeof opts !== 'object' || opts === null) invalid('mcpServer: options are required.')
  if (typeof opts.name !== 'string' || !NAME.test(opts.name)) {
    invalid(`mcpServer: \`name\` must match ${NAME} (got '${String(opts.name)}').`)
  }
  const at = `mcpServer('${opts.name}')`
  if (
    opts.transport === undefined ||
    opts.transport === null ||
    (typeof opts.transport !== 'object' && typeof opts.transport !== 'function')
  ) {
    invalid(`${at}: \`transport\` must be a transport config, an MCPTransport or a resolver.`)
  }
  if (opts.prefix !== undefined && typeof opts.prefix !== 'string') {
    invalid(`${at}: \`prefix\` must be a string.`)
  }
  for (const list of ['allow', 'deny'] as const) {
    const value = opts[list]
    if (
      value !== undefined &&
      (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    ) {
      invalid(`${at}: \`${list}\` must be an array of tool names.`)
    }
  }
  if (opts.defer !== undefined && typeof opts.defer !== 'boolean' && opts.defer !== 'auto') {
    invalid(`${at}: \`defer\` must be true, false or 'auto'.`)
  }
  if (opts.connect !== undefined && opts.connect !== 'lazy' && opts.connect !== 'eager') {
    invalid(`${at}: \`connect\` must be 'lazy' or 'eager'.`)
  }
  if (
    opts.maxRetries !== undefined &&
    (!Number.isInteger(opts.maxRetries) || (opts.maxRetries as number) < 0)
  ) {
    invalid(`${at}: \`maxRetries\` must be a non-negative integer.`)
  }
  if (opts.pinDefinitions !== undefined && typeof opts.pinDefinitions !== 'boolean') {
    invalid(`${at}: \`pinDefinitions\` must be a boolean.`)
  }
}

const internalsOf = new WeakMap<ToolSource, McpSourceInternals>()

/** Internals of a source created by `mcpServer()` (`undefined` for other sources). */
export function mcpSourceInternals(source: ToolSource): McpSourceInternals | undefined {
  return internalsOf.get(source)
}

/**
 * Create the MCP tool source with an injectable module loader (tests). Use {@link mcpServer}.
 *
 * @internal
 */
export function createMcpServer(
  opts: McpServerOptions,
  load: () => Promise<McpModule> = importMcp,
): ToolSource {
  validate(opts)
  const name = opts.name
  const id = `mcp:${name}`
  const prefix = opts.prefix ?? `${name}_`
  const allow = opts.allow === undefined ? undefined : new Set(opts.allow)
  const deny = new Set(opts.deny ?? [])
  const defer = opts.defer ?? 'auto'
  const pinsKey = mcpPinsKey(name)
  const conns = new Map<HarnessContext, Conn>()
  const closings = new Set<Promise<void>>()

  const loadModule = async (): Promise<McpModule> => {
    try {
      const mod = await load()
      if (typeof mod?.createMCPClient !== 'function') throw new Error('createMCPClient missing')
      return mod
    } catch (error) {
      throw new McpMissingError(
        `MCP server '${name}': @ai-sdk/mcp could not be loaded; ${INSTALL_HINT}. (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      )
    }
  }

  function release(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    if (conns.get(conn.ctx) === conn) conns.delete(conn.ctx)
    const key = sessionKey(conn.ctx.agent.id, conn.ctx.session.id)
    const entries = live.get(key)
    if (entries !== undefined) {
      for (const entry of entries)
        if (entry.ctx === conn.ctx && entry.name === name) entries.delete(entry)
      if (entries.size === 0) live.delete(key)
    }
    const closing = (async () => {
      // a connect in flight closes its own client when it sees `closed`
      await conn.connecting?.catch(() => undefined)
      const client = conn.client
      conn.client = undefined
      try {
        await client?.close()
      } catch (error) {
        conn.ctx.log.warn(`eharness: closing MCP client '${name}' failed`, { error })
      }
    })()
    closings.add(closing)
    void closing.finally(() => closings.delete(closing))
  }

  function register(ctx: HarnessContext): Conn {
    const existing = conns.get(ctx)
    if (existing !== undefined && !existing.closed) return existing
    const conn: Conn = { ctx, client: undefined, connecting: undefined, closed: false }
    conns.set(ctx, conn)
    const key = sessionKey(ctx.agent.id, ctx.session.id)
    let entries = live.get(key)
    if (entries === undefined) {
      entries = new Set()
      live.set(key, entries)
    }
    entries.add({ name, ctx })
    if (ctx.signal.aborted) release(conn)
    else ctx.signal.addEventListener('abort', () => release(conn), { once: true })
    return conn
  }

  function connect(conn: Conn): Promise<MCPClient> {
    if (conn.client !== undefined) return Promise.resolve(conn.client)
    if (conn.connecting !== undefined) return conn.connecting
    const connecting = (async () => {
      if (conn.closed) throw new Error(`MCP server '${name}': the session is closed.`)
      const mod = await loadModule()
      const transport =
        typeof opts.transport === 'function' ? await opts.transport(conn.ctx) : opts.transport
      const client = await mod.createMCPClient({
        transport,
        ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
        onUncaughtError: (error: unknown) =>
          conn.ctx.log.warn(`eharness: MCP server '${name}' error`, { error }),
      })
      if (conn.closed) {
        await client.close().catch(() => undefined)
        throw new Error(`MCP server '${name}': the session is closed.`)
      }
      conn.client = client
      return client
    })()
    conn.connecting = connecting
    void connecting.then(
      () => {
        if (conn.connecting === connecting) conn.connecting = undefined
      },
      () => {
        if (conn.connecting === connecting) conn.connecting = undefined
      },
    )
    return connecting
  }

  async function serverTools(conn: Conn): Promise<ToolSet> {
    const client = await connect(conn)
    try {
      return await client.tools()
    } catch (error) {
      // a broken connection: drop the client so the next turn reconnects
      if (conn.client === client) conn.client = undefined
      await client.close().catch(() => undefined)
      throw error
    }
  }

  async function pinned(ctx: HarnessContext, tools: ToolSet): Promise<Set<string>> {
    const current = await fingerprintTools(tools)
    const pins = ctx.state.get<Record<string, string>>(pinsKey)
    if (pins === undefined || typeof pins !== 'object' || pins === null || Array.isArray(pins)) {
      ctx.state.set(pinsKey, current)
      return new Set()
    }
    const drift = detectToolDrift(current, pins)
    return new Set([...drift.changed, ...drift.added])
  }

  const source = defineToolSource({
    id,
    ...(opts.refresh === undefined ? {} : { refresh: opts.refresh }),
    async open(ctx) {
      const conn = register(ctx)
      if (pendingClears.has(clearKey(ctx.agent.id, ctx.session.id, name))) {
        ctx.state.set(pinsKey, undefined) // opened by clearMcpPins: clear, do not connect
        return
      }
      if (opts.connect !== 'eager') return
      try {
        await connect(conn)
      } catch (error) {
        if (error instanceof McpMissingError) {
          release(conn)
          throw new HarnessError(
            'EH_CONFIG_INVALID',
            `mcpServer('${name}') with connect: 'eager' needs @ai-sdk/mcp; ${INSTALL_HINT}.`,
            { cause: error, details: { source: id } },
          )
        }
        // other connection failures: retried at the first list (W_TOOL_SOURCE_FAILED)
        ctx.log.warn(
          `eharness: eager connect of MCP server '${name}' failed; retrying at the next turn`,
          {
            error,
          },
        )
      }
    },
    async list(ctx) {
      const conn = register(ctx)
      const all = await serverTools(conn)
      const blocked = opts.pinDefinitions === true ? await pinned(ctx, all) : new Set<string>()
      const exposed: Array<[string, Tool]> = []
      const drifted: string[] = []
      for (const [serverName, tool] of Object.entries(all)) {
        if (allow !== undefined && !allow.has(serverName)) continue
        if (deny.has(serverName)) continue
        if (blocked.has(serverName)) {
          drifted.push(serverName)
          continue
        }
        exposed.push([serverName, tool])
      }
      if (drifted.length > 0) {
        ctx.warn({
          code: 'W_MCP_DRIFT',
          message: `MCP server '${name}': the definitions of ${drifted.map((t) => `'${t}'`).join(', ')} changed or were added since they were pinned; excluded until the pins are cleared (clearMcpPins).`,
          details: { source: id, tools: drifted },
        })
      }
      const deferred = defer === 'auto' ? exposed.length > MCP_AUTO_DEFER_THRESHOLD : defer
      const out: ToolSet = {}
      for (const [serverName, tool] of exposed) {
        out[`${prefix}${serverName}`] = deferred ? ({ ...tool, deferLoading: true } as Tool) : tool
      }
      return out
    },
    async close() {
      // `close()` carries no session: release every session whose context was closed (the
      // abort listener normally did already) and wait for their clients to close.
      for (const conn of [...conns.values()]) if (conn.ctx.signal.aborted) release(conn)
      await Promise.allSettled([...closings])
    },
  })
  internalsOf.set(source, { name, liveSessions: () => conns.size })
  return source
}

/**
 * An MCP server as a dynamic tool source (`'mcp:<name>'`). One MCP client per session, created at
 * the first turn (`connect: 'lazy'`) or at session open (`'eager'`) and closed with the session.
 *
 * Requires the optional peer dependency `@ai-sdk/mcp` at connect time: without it, lazy connects
 * warn `W_TOOL_SOURCE_FAILED` and `connect: 'eager'` fails the session open with
 * `EH_CONFIG_INVALID`. Connection failures contribute no tools and are retried at the next turn.
 *
 * MCP tool annotations (`readOnlyHint`, `destructiveHint`, …) stay in the tool's metadata; they
 * are untrusted hints — use a `tool.before` or `tool.approve` hook to gate destructive tools.
 *
 * @example
 * ```ts
 * // mcpServer comes from the 'eharness/mcp' entry point
 * defineHarnessAgent({
 *   model,
 *   mcp: [
 *     mcpServer({
 *       name: 'github',
 *       transport: (ctx) => ({
 *         type: 'http',
 *         url: 'https://api.githubcopilot.com/mcp/',
 *         headers: { authorization: `Bearer ${ctx.runtime.githubToken}` },
 *       }),
 *       allow: ['search_issues', 'get_issue'],
 *       pinDefinitions: true,
 *     }),
 *   ],
 * })
 * ```
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 */
export function mcpServer(opts: McpServerOptions): ToolSource {
  return createMcpServer(opts)
}

function stripPins(snapshot: SessionStateSnapshot, key: string): SessionStateSnapshot | undefined {
  let changed = false
  const plugins: SessionStateSnapshot['plugins'] = {}
  for (const [plugin, values] of Object.entries(snapshot.plugins ?? {})) {
    if (values !== null && typeof values === 'object' && key in values) {
      changed = true
      const { [key]: _removed, ...rest } = values
      if (Object.keys(rest).length > 0) plugins[plugin] = rest
    } else {
      plugins[plugin] = values
    }
  }
  return changed ? { ...snapshot, plugins } : undefined
}

/**
 * Forget the pinned tool definitions of MCP server `name` in one session, so they are pinned
 * again (trusting the current definitions) at the next connect.
 *
 * A live session is cleared through its in-memory state (so the turn-end state write cannot
 * restore the old pins). Otherwise the session's state is edited through `opts.stateAdapter` (pass
 * it when the session used a `SessionOptions.storage.state` override) or the agent's
 * `storage.state`; with the agent's default in-memory storage the session is opened to clear it.
 *
 * @example
 * ```ts
 * await clearMcpPins(agent, sessionId, 'github') // after reviewing the changed tools
 * ```
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserver-eharnessmcp
 */
export async function clearMcpPins(
  agent: HarnessAgent<unknown>,
  sessionId: string,
  name: string,
  opts: { stateAdapter?: StateAdapter } = {},
): Promise<void> {
  if (typeof name !== 'string' || !NAME.test(name)) {
    invalid(`clearMcpPins: \`name\` must match ${NAME} (got '${String(name)}').`)
  }
  const key = mcpPinsKey(name)
  const entries = [...(live.get(sessionKey(agent.id, sessionId)) ?? [])].filter(
    (entry) => entry.name === name && !entry.ctx.signal.aborted,
  )
  if (entries.length > 0) {
    for (const entry of entries) entry.ctx.state.set(key, undefined)
    return
  }
  const config = agent.config as { storage?: { state?: StateAdapter } }
  const adapter = opts.stateAdapter ?? config.storage?.state
  if (adapter === undefined) {
    // default in-memory storage: only reachable through the session itself
    const pending = clearKey(agent.id, sessionId, name)
    pendingClears.add(pending)
    try {
      await agent.session(sessionId).ready()
    } finally {
      pendingClears.delete(pending)
    }
    return
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let stored: SessionStateSnapshot | null
    try {
      stored = await adapter.get(sessionId)
    } catch (error) {
      throw new HarnessError('EH_STORAGE', 'State storage failed (get).', { cause: error })
    }
    if (stored === null) return
    const next = stripPins(stored, key)
    if (next === undefined) return
    const rev = typeof stored.rev === 'number' ? stored.rev : 0
    const write: SessionStateSnapshot = { ...next, rev: rev + 1 }
    try {
      if (adapter.setIf === undefined) {
        await adapter.set(sessionId, write)
        return
      }
      if (await adapter.setIf(sessionId, write, rev)) return
    } catch (error) {
      throw new HarnessError('EH_STORAGE', 'State storage failed (set).', { cause: error })
    }
  }
  throw new HarnessError(
    'EH_STORAGE',
    `clearMcpPins: the state of session '${sessionId}' kept changing; try again.`,
    { details: { sessionId } },
  )
}
