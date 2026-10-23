/**
 * `mcpServerSource()`: a `ToolSource` over `@ai-sdk/mcp` (optional peer dependency) with one MCP client
 * per session, allow/deny, prefixing, deferral, lazy/eager connect and definition pinning; and
 * `clearMcpPins()`.
 *
 * `@ai-sdk/mcp` is loaded with a dynamic `import()` at connect time; only its types are imported
 * statically, so importing `eharness/mcp` never fails without it.
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserversource-eharnessmcp
 */
import type { MCPClient, MCPClientConfig, MCPTransport, McpToolAnnotations } from '@ai-sdk/mcp'
import { detectToolDrift, fingerprintTools, type Tool, type ToolSet } from 'ai'
import {
  defineToolSource,
  errorText,
  type HarnessAgent,
  type HarnessContext,
  HarnessError,
  type SessionStateSnapshot,
  type StateAdapter,
  type ToolRisk,
  type ToolSource,
  untrustedContent,
  withToolExecute,
  withToolFields,
} from '../index.ts'

/** A transport config accepted by `createMCPClient({ transport })` (`{ type: 'http' | 'sse', url, … }`). */
export type McpTransportConfig = Exclude<MCPClientConfig['transport'], MCPTransport>

/** What a transport resolver may return: a config, or a **new** `MCPTransport` for this session. */
export type McpTransportInput = MCPClientConfig['transport']

/** Default of `McpServerSourceOptions.timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Settle with `promise`, or reject with `EH_MCP_TIMEOUT` after `ms`. A value that arrives after the
 * timeout goes to `onLate` (to close a client that connected too late).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      done = true
      reject(new HarnessError('EH_MCP_TIMEOUT', `${what} within ${ms} ms.`, { details: { ms } }))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        if (done) onLate?.(value)
        else resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        if (!done) reject(error)
      },
    )
  })
}

/**
 * Options of {@link mcpServerSource}.
 *
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserversource-eharnessmcp
 */
export interface McpServerSourceOptions {
  /** Short name; used as tool prefix and source id `'mcp:<name>'`. `^[a-z0-9-]{1,32}$` */
  name: string
  /**
   * A transport config passed to `createMCPClient({ transport })`, or a resolver called once per
   * session (per-user credentials, custom transports). Every session gets its own client, so an
   * `MCPTransport` instance is only accepted from a resolver that creates a new one per call.
   */
  transport:
    | McpTransportConfig
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
  /**
   * Wrap the text parts of tool results in an `<untrusted-content source="mcp" name="<server>/<tool>">`
   * frame (`untrustedContent()`, spec 03 §10) so the model treats them as data (the frame's meaning is
   * stated by the app with `UNTRUSTED_CONTENT_INSTRUCTIONS`; content inside it is data, never
   * instructions). A tool without `toModelOutput` is framed too (string output as text). Images and other
   * non-text parts and `isError` results are unchanged; structured JSON output is serialized and framed as text. Default `true`.
   */
  wrapUntrusted?: boolean
  /**
   * Pin tool definitions on first connect and exclude changed or added tools (drift). Default:
   * `true` for a remote server (`transport` config or resolver result with `type: 'http' | 'sse'`,
   * whose tool list the operator does not control), `false` for stdio and `MCPTransport` instances.
   * Pass `false` to accept every change of a remote server.
   */
  pinDefinitions?: boolean
  /** `createMCPClient` `maxRetries`: retries of `tools/call` requests only (not connect). Default 0. */
  maxRetries?: number
  /**
   * Default 15 000 — limit for connecting (`initialize`) and for listing the tools. A server that
   * does not answer in time fails with `EH_MCP_TIMEOUT`, which the registry reports as
   * `W_TOOL_SOURCE_FAILED`; the other sources and the turn are not held up.
   */
  timeoutMs?: number
  /** When to list the tools: once per session (default) or before every turn. */
  refresh?: 'session' | 'turn'
  /**
   * A **trusted** risk for this server's tools (spec 11 §3.2), written to each tool's
   * `metadata.risk`; it wins over the server's annotations, so it may be lower than they suggest.
   * A constant, or a function per server tool (name before prefixing, annotations as sent);
   * `undefined` keeps the risk derived from the annotations (tighten-only). A function that throws
   * or returns an invalid value keeps the derived risk and logs `ctx.log.warn`.
   */
  risk?: ToolRisk | McpRiskFunction
}

/** Per-tool risk resolver of {@link McpServerSourceOptions.risk}. */
export type McpRiskFunction = (tool: {
  /** The server's tool name (before prefixing). */
  name: string
  /** The annotations the server sent (untrusted), if any. */
  annotations?: McpToolAnnotations
}) => ToolRisk | undefined

/** Tools above this count are deferred with `defer: 'auto'`. */
export const MCP_AUTO_DEFER_THRESHOLD = 20

const NAME = /^[a-z0-9-]{1,32}$/

type ModelOutput = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>

/**
 * The part of an MCP client the plugin uses. `@ai-sdk/mcp` 2.0.7x returns `MCPClient | ManagedMCPClient`
 * (the managed client omits `experimental_events`); both have `tools()` and `close()`.
 */
type McpClient = Pick<MCPClient, 'tools' | 'close'>

type McpModule = { createMCPClient(config: MCPClientConfig): Promise<McpClient> }

/** Raised when `@ai-sdk/mcp` cannot be loaded. */
class McpMissingError extends Error {}

const INSTALL_HINT = 'install @ai-sdk/mcp (optional peer dependency of eharness)'

async function importMcp(): Promise<McpModule> {
  return (await import('@ai-sdk/mcp')) as McpModule
}

/** Per-session connection state. */
interface Conn {
  readonly ctx: HarnessContext
  client: McpClient | undefined
  connecting: Promise<McpClient> | undefined
  closed: boolean
  /** Tool calls currently running on this connection's client(s). */
  active: number
  /** Dropped clients that could not close yet because a call was still running on them. */
  lingering: Set<McpClient>
  /** The resolved transport is a remote (`http` / `sse`) config. */
  remote?: boolean
}

/** Internals of one `mcpServerSource()` source (tests and `clearMcpPins`). */
export interface McpSourceInternals {
  readonly name: string
  /** Number of sessions with state in this source (open, not yet released). */
  liveSessions(): number
  /** Contexts of the open sessions with this id. */
  contexts(sessionId: string): HarnessContext[]
  /** True once sessions of more than one agent used this source instance. */
  shared(): boolean
  /** Session ids opened by `clearMcpPins` only to clear their pins (no connect). */
  readonly pendingClears: Set<string>
}

/** State key of the pins of server `name` (in the owner plugin's namespace). */
export function mcpPinsKey(name: string): string {
  return `mcp:${name}:pins`
}

function invalid(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', message)
}

function validate(opts: McpServerSourceOptions): void {
  if (typeof opts !== 'object' || opts === null) invalid('mcpServerSource: options are required.')
  if (typeof opts.name !== 'string' || !NAME.test(opts.name)) {
    invalid(`mcpServerSource: \`name\` must match ${NAME} (got '${String(opts.name)}').`)
  }
  const at = `mcpServerSource('${opts.name}')`
  const transport = opts.transport as unknown
  if (
    transport === undefined ||
    transport === null ||
    (typeof transport !== 'object' && typeof transport !== 'function')
  ) {
    invalid(
      `${at}: \`transport\` must be a transport config ({ type, url }) or a resolver (ctx) => transport.`,
    )
  }
  if (
    typeof transport === 'object' &&
    typeof (transport as { start?: unknown }).start === 'function' &&
    typeof (transport as { send?: unknown }).send === 'function'
  ) {
    invalid(
      `${at}: an MCPTransport instance cannot be shared by the per-session clients; pass a resolver that creates a new transport per session: transport: () => createTransport().`,
    )
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
  if (opts.timeoutMs !== undefined && !(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)) {
    invalid(`${at}: \`timeoutMs\` must be a positive number.`)
  }
  if (opts.pinDefinitions !== undefined && typeof opts.pinDefinitions !== 'boolean') {
    invalid(`${at}: \`pinDefinitions\` must be a boolean.`)
  }
  if (opts.risk !== undefined && typeof opts.risk !== 'function' && !RISKS.has(opts.risk)) {
    invalid(
      `${at}: \`risk\` must be 'read', 'write', 'destructive', 'external' or a function (got '${String(opts.risk)}').`,
    )
  }
}

const RISKS: ReadonlySet<unknown> = new Set(['read', 'write', 'destructive', 'external'])

/** `@ai-sdk/mcp` rejects with this when the request was never sent: the client (or transport) is closed. */
function isClosedClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /Attempted to send a request from a closed client|MCP SSE Transport Error: Not connected/.test(
    error.message,
  )
}

const internalsOf = new WeakMap<ToolSource, McpSourceInternals>()

/** Internals of a source created by `mcpServerSource()` (`undefined` for other sources). */
export function mcpSourceInternals(source: ToolSource): McpSourceInternals | undefined {
  return internalsOf.get(source)
}

/** A `{ type: 'http' | 'sse', url }` config (an `MCPTransport` instance is not known to be remote). */
function isRemoteTransport(transport: McpTransportInput): boolean {
  const type = (transport as { type?: unknown }).type
  return type === 'http' || type === 'sse'
}

/**
 * Create the MCP tool source with an injectable module loader (tests). Use {@link mcpServerSource}.
 *
 * @internal
 */
export function createMcpServer(
  opts: McpServerSourceOptions,
  load: () => Promise<McpModule> = importMcp,
): ToolSource {
  validate(opts)
  const name = opts.name
  const id = `mcp:${name}`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const prefix = opts.prefix ?? `${name}_`
  const allow = opts.allow === undefined ? undefined : new Set(opts.allow)
  const deny = new Set(opts.deny ?? [])
  const defer = opts.defer ?? 'auto'
  const pinsKey = mcpPinsKey(name)
  const conns = new Map<HarnessContext, Conn>()
  const closings = new Set<Promise<void>>()
  const agentIds = new Set<string>()
  let sharedSessions = false
  const pendingClears = new Set<string>()

  const loadModule = async (): Promise<McpModule> => {
    try {
      const mod = await load()
      // plain-error: internal, rethrown below as McpMissingError
      if (typeof mod?.createMCPClient !== 'function') throw new Error('createMCPClient missing')
      return mod
    } catch (error) {
      throw new McpMissingError(
        `MCP server '${name}': @ai-sdk/mcp could not be loaded; ${INSTALL_HINT}. (${errorText(error)})`,
        { cause: error },
      )
    }
  }

  function release(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    if (conns.get(conn.ctx) === conn) conns.delete(conn.ctx)
    const closing = (async () => {
      // a connect in flight closes its own client when it sees `closed`
      await conn.connecting?.catch(() => undefined)
      const client = conn.client
      conn.client = undefined
      const all = [...conn.lingering]
      conn.lingering.clear()
      if (client !== undefined) all.push(client)
      for (const c of all) {
        try {
          await c.close()
        } catch (error) {
          conn.ctx.log.warn(`eharness: closing MCP client '${name}' failed`, { error })
        }
      }
    })()
    closings.add(closing)
    void closing.finally(() => closings.delete(closing))
  }

  function register(ctx: HarnessContext): Conn {
    const existing = conns.get(ctx)
    if (existing !== undefined && !existing.closed) return existing
    const conn: Conn = {
      ctx,
      client: undefined,
      connecting: undefined,
      closed: false,
      active: 0,
      lingering: new Set(),
    }
    agentIds.add(ctx.agent.id)
    for (const other of conns.values()) {
      // one agent has at most one open session per id: a second one belongs to another agent
      if (other.ctx.session.id === ctx.session.id && !other.ctx.signal.aborted)
        sharedSessions = true
    }
    conns.set(ctx, conn)
    // the session signal aborts on close and on a failed open (spec 05 §2): release then
    if (ctx.signal.aborted) release(conn)
    else ctx.signal.addEventListener('abort', () => release(conn), { once: true })
    return conn
  }

  function connect(conn: Conn): Promise<McpClient> {
    if (conn.client !== undefined) return Promise.resolve(conn.client)
    if (conn.connecting !== undefined) return conn.connecting
    const connecting = (async () => {
      if (conn.closed)
        throw new HarnessError('EH_SESSION_CLOSED', `MCP server '${name}': the session is closed.`)
      const mod = await loadModule()
      const transport =
        typeof opts.transport === 'function' ? await opts.transport(conn.ctx) : opts.transport
      conn.remote = isRemoteTransport(transport)
      const client = await withTimeout(
        mod.createMCPClient({
          transport,
          ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
          onUncaughtError: (error: unknown) =>
            conn.ctx.log.warn(`eharness: MCP server '${name}' error`, { error }),
        }),
        timeoutMs,
        `MCP server '${name}' did not finish connecting`,
        (late) => void late.close().catch(() => undefined),
      )
      if (conn.closed) {
        await client.close().catch(() => undefined)
        throw new HarnessError('EH_SESSION_CLOSED', `MCP server '${name}': the session is closed.`)
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

  /**
   * Drop a broken client: the next connect makes a new one. A client that still has a call running
   * is closed only when the last call ends (closing it would reject that call mid-request).
   */
  function dropClient(conn: Conn, client: McpClient): void {
    if (conn.client === client) conn.client = undefined
    if (conn.active > 0 && !conn.closed) conn.lingering.add(client)
    else void client.close().catch(() => undefined)
  }

  async function listClientTools(conn: Conn, client: McpClient): Promise<ToolSet> {
    try {
      // `@ai-sdk/mcp` types its tools with its own `inputSchema` generics; at runtime they are AI SDK
      // tools, so the plugin treats them as a `ToolSet`
      return (await withTimeout(
        client.tools(),
        timeoutMs,
        `MCP server '${name}' did not list its tools`,
      )) as unknown as ToolSet
    } catch (error) {
      // a broken connection: drop the client so the next turn reconnects
      dropClient(conn, client)
      throw error
    }
  }

  async function serverTools(conn: Conn): Promise<{ client: McpClient; tools: ToolSet }> {
    const client = await connect(conn)
    return { client, tools: await listClientTools(conn, client) }
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

  /** The trusted risk of `mcpServerSource({ risk })` for one server tool (`undefined` = derived). */
  function riskFor(ctx: HarnessContext, serverName: string, tool: Tool): ToolRisk | undefined {
    const option = opts.risk
    if (option === undefined) return undefined
    if (typeof option !== 'function') return option
    const annotations = (tool as { metadata?: { annotations?: McpToolAnnotations } }).metadata
      ?.annotations
    try {
      const risk = option({
        name: serverName,
        ...(annotations === undefined ? {} : { annotations: structuredClone(annotations) }),
      })
      if (risk === undefined || RISKS.has(risk)) return risk
      ctx.log.warn(
        `eharness: mcpServerSource('${name}') risk function returned an invalid risk for '${serverName}'; using the derived risk`,
        { risk },
      )
    } catch (error) {
      ctx.log.warn(
        `eharness: mcpServerSource('${name}') risk function failed for '${serverName}'; using the derived risk`,
        { error },
      )
    }
    return undefined
  }

  /**
   * Make a tool call survive a client that our own code closed while the turn was running (session
   * rebuilt, failed listing elsewhere): a call that fails with the closed-client error never reached
   * the server, so it is retried once on a reopened client. Any other error (including a
   * `Connection closed` that rejected an in-flight request) is returned as is, so a write that may
   * have reached the server is never executed twice. A closed or aborted session keeps the error.
   */
  function reconnecting(conn: Conn, client: McpClient, serverName: string, tool: Tool): Tool {
    const first = tool.execute
    if (first === undefined) return tool
    type Execute = NonNullable<Tool['execute']>
    let current: { client: McpClient; execute: Execute } = { client, execute: first }
    return withToolExecute(tool, async (...args: Parameters<Execute>) => {
      const [, options] = args
      conn.active++
      try {
        const used = current
        try {
          return await used.execute(...args)
        } catch (error) {
          const aborted = conn.closed || conn.ctx.signal.aborted || options?.abortSignal?.aborted
          if (aborted === true || !isClosedClientError(error)) throw error
          if (current === used) {
            // still the broken client: drop it and reconnect (concurrent calls share one connect)
            dropClient(conn, used.client)
            conn.ctx.log.warn(
              `eharness: MCP client '${name}' was closed during a turn; reopening it and retrying '${serverName}' once`,
              { error },
            )
          }
          let next: { client: McpClient; execute: Execute }
          try {
            if (current !== used) next = current
            else {
              const reopened = await connect(conn)
              const tools = await listClientTools(conn, reopened)
              const fresh = tools[serverName]
              if (fresh?.execute === undefined) {
                // plain-error: caught below and rethrown as the tool error
                throw new Error(`the tool '${serverName}' is no longer offered by the server`)
              }
              if (
                (opts.pinDefinitions ?? conn.remote === true) &&
                (await pinned(conn.ctx, tools)).has(serverName)
              ) {
                // plain-error: caught below and rethrown as the tool error
                throw new Error(`the definition of '${serverName}' changed since it was pinned`)
              }
              next = { client: reopened, execute: fresh.execute }
              current = next
            }
          } catch (reopenError) {
            // plain-error: reaches the model as a tool error (framed by the caller)
            throw new Error(
              `MCP server '${name}': the connection was lost and could not be reopened (${errorText(reopenError)}).`,
              { cause: reopenError },
            )
          }
          return await next.execute(...args)
        }
      } finally {
        conn.active--
        if (conn.active === 0 && conn.lingering.size > 0) {
          for (const c of conn.lingering) void c.close().catch(() => undefined)
          conn.lingering.clear()
        }
      }
    })
  }

  /** Wrap the text parts of the tool's model output in an untrusted-content frame. */
  function frameResults(tool: Tool, label: string): Tool {
    const original =
      tool.toModelOutput ??
      // no mapping: frame what the model would see by default (a string as text; JSON unchanged)
      (({ output }: { output: unknown }) =>
        typeof output === 'string'
          ? { type: 'text' as const, value: output }
          : { type: 'json' as const, value: (output ?? null) as never })
    const mapped = original as (options: unknown) => Promise<ModelOutput> | ModelOutput
    const execute = tool.execute
    const framed = withToolFields(tool, {
      toModelOutput: (async (options: unknown) => {
        const out = await mapped(options)
        if (out.type === 'text') {
          return { ...out, value: untrustedContent(out.value, { source: 'mcp', name: label }) }
        }
        if (out.type === 'json') {
          // structured output is as untrusted as text: frame its JSON text
          return {
            type: 'text' as const,
            value: untrustedContent(JSON.stringify(out.value ?? null), {
              source: 'mcp',
              name: label,
            }),
          }
        }
        if (out.type !== 'content') return out
        return {
          ...out,
          value: out.value.map((part) =>
            part.type === 'text'
              ? { ...part, text: untrustedContent(part.text, { source: 'mcp', name: label }) }
              : part,
          ),
        }
      }) as Tool['toModelOutput'],
    })
    // a thrown call error (JSON-RPC error, transport failure) reaches the model as `error-text`
    // without `toModelOutput`; its message is server-provided text too, so frame it here
    if (execute === undefined) return framed
    return withToolExecute(framed, async (...args: Parameters<typeof execute>) => {
      try {
        return await execute(...args)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        // plain-error: the server's message, framed; the loop turns it into a tool error
        throw new Error(untrustedContent(errorText(error), { source: 'mcp', name: label }), {
          cause: error,
        })
      }
    })
  }

  const source = defineToolSource({
    id,
    ...(opts.refresh === undefined ? {} : { refresh: opts.refresh }),
    async open(ctx) {
      const conn = register(ctx)
      if (conn.closed) return // the session closed while opening
      if (pendingClears.has(ctx.session.id)) {
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
            `mcpServerSource('${name}') with connect: 'eager' needs @ai-sdk/mcp; ${INSTALL_HINT}.`,
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
      const { client, tools: all } = await serverTools(conn)
      const pin = opts.pinDefinitions ?? conn.remote === true
      const blocked = pin ? await pinned(ctx, all) : new Set<string>()
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
          details: { source: id, tools: drifted, sessionId: ctx.session.id },
        })
      }
      const deferred = defer === 'auto' ? exposed.length > MCP_AUTO_DEFER_THRESHOLD : defer
      const out: ToolSet = {}
      for (const [serverName, original] of exposed) {
        const risk = riskFor(ctx, serverName, original)
        let tool = reconnecting(conn, client, serverName, original)
        if (risk !== undefined) {
          const metadata = (original as { metadata?: Record<string, unknown> }).metadata
          tool = withToolFields(tool, { metadata: { ...metadata, risk } })
        }
        if (opts.wrapUntrusted !== false) tool = frameResults(tool, `${name}/${serverName}`)
        out[`${prefix}${serverName}`] = deferred
          ? withToolFields(tool, { deferLoading: true })
          : tool
      }
      return out
    },
    async close() {
      // `close()` carries no session: the session's signal aborted before its disposers ran
      // (close, eviction or a failed open), so the abort listener already released it; release
      // any aborted session left and wait for the clients to close.
      for (const conn of [...conns.values()]) if (conn.ctx.signal.aborted) release(conn)
      await Promise.allSettled([...closings])
    },
  })
  internalsOf.set(source, {
    name,
    liveSessions: () => conns.size,
    contexts: (sessionId) =>
      [...conns.values()]
        .filter((c) => !c.closed && !c.ctx.signal.aborted && c.ctx.session.id === sessionId)
        .map((c) => c.ctx),
    shared: () => sharedSessions || agentIds.size > 1,
    pendingClears,
  })
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
 * MCP tool annotations (`readOnlyHint`, `destructiveHint`, …) stay in the tool's metadata as
 * untrusted hints that only tighten the derived risk (`destructiveHint` → `'destructive'`,
 * `openWorldHint` → `'external'`, `toolTraits`); route them with `approval.risk`. Pass `risk` for a
 * trusted server to set the risk yourself.
 *
 * @example
 * ```ts
 * // mcpServerSource comes from the 'eharness/mcp' entry point
 * defineHarnessAgent({
 *   model,
 *   mcp: [
 *     mcpServerSource({
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
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserversource-eharnessmcp
 */
export function mcpServerSource(options: McpServerSourceOptions): ToolSource {
  return createMcpServer(options)
}

/** Internals of the `mcpServerSource()` sources in an agent's root `mcp` / `tools` config. */
function configuredSources(config: { tools?: unknown; mcp?: unknown }): McpSourceInternals[] {
  const candidates: unknown[] = []
  for (const slot of [config.mcp, config.tools]) {
    if (Array.isArray(slot)) candidates.push(...slot)
    else if (slot !== undefined) candidates.push(slot)
  }
  const out: McpSourceInternals[] = []
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const internals = internalsOf.get(candidate as ToolSource)
    if (internals !== undefined && !out.includes(internals)) out.push(internals)
  }
  return out
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
 * @see docs/specs/09-tools-and-mcp.md#3-mcpserversource-eharnessmcp
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
  const config = agent.config as {
    tools?: unknown
    mcp?: unknown
    storage?: { state?: StateAdapter }
  }
  const internals = configuredSources(config).filter((i) => i.name === name)
  if (internals.length !== 1) {
    invalid(
      internals.length === 0
        ? `clearMcpPins: agent '${agent.id}' has no mcpServerSource('${name}') in its \`mcp\` or \`tools\` config (sources contributed by plugins cannot be resolved).`
        : `clearMcpPins: agent '${agent.id}' has more than one mcpServerSource('${name}').`,
    )
  }
  const own = internals[0] as McpSourceInternals
  if (own.shared()) {
    invalid(
      `clearMcpPins: mcpServerSource('${name}') is used by more than one agent; create one mcpServerSource() per agent so its sessions can be told apart.`,
    )
  }
  const contexts = own.contexts(sessionId)
  if (contexts.length > 0) {
    for (const ctx of contexts) ctx.state.set(key, undefined)
    return
  }
  const adapter = opts.stateAdapter ?? config.storage?.state
  if (adapter === undefined) {
    // default in-memory storage: only reachable through the session itself
    own.pendingClears.add(sessionId)
    try {
      await agent.session(sessionId).ready()
    } finally {
      own.pendingClears.delete(sessionId)
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
