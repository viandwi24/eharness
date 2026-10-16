/**
 * Pinned tool definitions of remote MCP servers (library `pinDefinitions`, spec 09 §3). A session
 * pins the definitions it first saw and excludes tools the server changed afterwards; the owner
 * accepts the new definitions by clearing the pins. Pure rules over the stored session state.
 */
/** The part of a stored session state these rules read (the library's `SessionStateSnapshot`). */
export interface PinnedState {
  plugins?: Record<string, Record<string, unknown>>
}

/** Key of the pins of server `<name>` in the session state (the library's `mcpPinsKey`). */
const PINS_KEY = /^mcp:([a-z0-9-]{1,32}):pins$/

/** A session whose pinned tool definitions drifted: the library excluded these tools. */
export interface DriftNote {
  /** The MCP server (the connection's slug). */
  server: string
  /** Server tool names (before prefixing) that are off until the pins are cleared. */
  tools: string[]
  at: number
}

/** The servers that have pins in a stored session state. */
export function pinnedServers(state: PinnedState): string[] {
  const out = new Set<string>()
  for (const values of Object.values(state.plugins ?? {})) {
    if (typeof values !== 'object' || values === null) continue
    for (const key of Object.keys(values)) {
      const m = PINS_KEY.exec(key)
      if (m?.[1] !== undefined) out.add(m[1])
    }
  }
  return [...out]
}

/**
 * The state without the pins of `servers` (every server when omitted), and how many pin sets were
 * removed. `undefined` when there was nothing to remove.
 */
export function stripMcpPins<S extends PinnedState>(
  state: S,
  servers?: ReadonlySet<string>,
): { state: S; cleared: number } | undefined {
  let cleared = 0
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const [plugin, values] of Object.entries(state.plugins ?? {})) {
    if (typeof values !== 'object' || values === null) {
      plugins[plugin] = values
      continue
    }
    const rest: typeof values = {}
    for (const [key, value] of Object.entries(values)) {
      const m = PINS_KEY.exec(key)
      if (m?.[1] !== undefined && (servers === undefined || servers.has(m[1]))) cleared++
      else rest[key] = value
    }
    if (Object.keys(rest).length > 0) plugins[plugin] = rest
  }
  return cleared === 0 ? undefined : { state: { ...state, plugins }, cleared }
}
