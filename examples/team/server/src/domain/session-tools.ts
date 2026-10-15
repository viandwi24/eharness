/**
 * What tools a session really has: the tools the agent is configured with (connectors) against
 * what its last model call carried (`tools` of the request = loaded, the "Deferred tools:" block
 * of the instructions = loadable with `tool_search`). Pure rules; the use case reads the stores.
 */

export type ToolMode = 'allow' | 'ask' | 'off'

/** A tool the agent's current activation offers. */
export interface ConfiguredTool {
  name: string
  mode: ToolMode
  /** Switched off for this chat only (composer tools menu). */
  chatOff: boolean
}

export interface ConfiguredGroup {
  connectionId: string | null
  connectorId: string
  /** Connector name ("Phone"). */
  name: string
  /** Connection label ("work account"). */
  label: string
  tools: ConfiguredTool[]
}

export interface LastCallTools {
  /** Id of the call on the Logs page. */
  id: string
  /** Start of the call (epoch ms). */
  at: number
  /** Tool names sent with schemas. */
  loaded: string[]
  /** Tool names the instructions list as loadable with `tool_search`. */
  deferred: string[]
}

const DEFERRED_HEADER = 'Deferred tools:'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The body was cut at the storage cap (`capJson` stores a marker with a preview). */
export const isTruncatedBody = (body: unknown): boolean =>
  isRecord(body) && body._truncated === true

function collectStrings(value: unknown, into: string[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === 'string') {
    if (value.includes(DEFERRED_HEADER)) into.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, into, depth + 1)
  } else if (isRecord(value)) {
    for (const v of Object.values(value)) collectStrings(v, into, depth + 1)
  }
}

/** Names listed in the "Deferred tools:" blocks of a request body (`- name: description` lines). */
export function deferredNamesOf(body: unknown): string[] {
  const texts: string[] = []
  collectStrings(body, texts)
  const names = new Set<string>()
  for (const text of texts) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!(lines[i] ?? '').includes(DEFERRED_HEADER)) continue
      for (let j = i + 1; j < lines.length; j++) {
        const m = /^- ([^\s:]+)(?::.*)?$/.exec(lines[j] ?? '')
        if (m?.[1] === undefined) break
        names.add(m[1])
      }
    }
  }
  return [...names]
}

/**
 * Tools of a provider request body: Anthropic (`{ name, defer_loading? }`), OpenAI chat
 * (`{ function: { name } }`) and OpenAI responses (`{ type: 'function', name }`).
 * `undefined` when the body has no `tools` array (nothing to compare with).
 */
export function toolsOfRequestBody(
  body: unknown,
): { loaded: string[]; deferred: string[] } | undefined {
  if (!isRecord(body) || !Array.isArray(body.tools)) return undefined
  const loaded: string[] = []
  const deferred = deferredNamesOf(body)
  for (const tool of body.tools) {
    if (!isRecord(tool)) continue
    const fn = isRecord(tool.function) ? tool.function : undefined
    const name = typeof tool.name === 'string' ? tool.name : fn?.name
    if (typeof name !== 'string') continue
    if (tool.defer_loading === true) {
      if (!deferred.includes(name)) deferred.push(name)
    } else if (!loaded.includes(name)) loaded.push(name)
  }
  return { loaded, deferred: deferred.filter((n) => !loaded.includes(n)) }
}

/**
 * Configured tools the model should have (allowed or asked, not off in the agent and not switched
 * off in this chat) that the last call neither loaded nor deferred: the red flag. `extra` is the
 * reverse: sent but not configured (plugin tools such as `tool_search`).
 */
export function compareTools(
  groups: readonly ConfiguredGroup[],
  call: Pick<LastCallTools, 'loaded' | 'deferred'>,
): { missing: string[]; extra: string[] } {
  const seen = new Set([...call.loaded, ...call.deferred])
  const known = new Set<string>()
  const missing: string[] = []
  for (const group of groups) {
    for (const tool of group.tools) {
      known.add(tool.name)
      if (tool.mode === 'off' || tool.chatOff) continue
      if (!seen.has(tool.name) && !missing.includes(tool.name)) missing.push(tool.name)
    }
  }
  const extra = [...seen].filter((n) => !known.has(n))
  return { missing, extra }
}
