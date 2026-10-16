/**
 * Session context (docs/plans/P52-context-and-orders.md): what an agent may read of its own other
 * sessions and runs, and how a stored message is shown to a model. Pure: no I/O.
 *
 * The privacy gate is one pure function (`decideAccess`) over a scope (who is asking) and a target
 * (the session or run). The tools in `infra/eh/session-context-plugin.ts` build the scope from the
 * channel requester / the session kind and call it for every session they would show.
 */

export const SESSIONS_SEARCH_TOOL = 'sessions_search'
export const SESSION_READ_TOOL = 'session_read'
export const RUNS_LIST_TOOL = 'runs_list'
export const RUN_READ_TOOL = 'run_read'
/** The four read-only tools: allow rules in chats, base tools of programs, allow list of heartbeats. */
export const SESSION_CONTEXT_TOOLS = [
  SESSIONS_SEARCH_TOOL,
  SESSION_READ_TOOL,
  RUNS_LIST_TOOL,
  RUN_READ_TOOL,
] as const

export const CONTEXT_KINDS = [
  'web',
  'channel',
  'program',
  'routine',
  'task',
  'heartbeat',
  'delegated',
] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

/** The kind of a session from its id (`domain/run-profiles.ts` lists the shapes). */
export function contextKindOf(sessionId: string): ContextKind {
  if (sessionId.startsWith('channel:')) return 'channel'
  if (sessionId.startsWith('program:') || sessionId.startsWith('rehearsal:')) return 'program'
  if (sessionId.startsWith('routine:')) return 'routine'
  if (sessionId.startsWith('task:')) return 'task'
  if (sessionId.startsWith('heartbeat:')) return 'heartbeat'
  if (/^dm:[^:]+:/.test(sessionId) || /^chat:[^:]+:[^:]+:/.test(sessionId)) return 'delegated'
  return 'web'
}

/** The agent a session id names (`dm:`, `chat:`, `heartbeat:`); undefined when the id does not say. */
export function agentOfSessionId(sessionId: string): string | undefined {
  const m = /^(?:dm|chat|heartbeat):([^:]+)/.exec(sessionId)
  return m === null ? undefined : (m[1] as string)
}

/** A web chat (a person's own DM thread) is private to the owner side of the team. */
export const isWebDm = (sessionId: string): boolean => contextKindOf(sessionId) === 'web'

// --- the privacy gate -------------------------------------------------------------------------

export type AccessScope =
  /** An owner or admin (or the web app: its user is the owner): any session of the agent. */
  | { kind: 'full'; crossAgent: boolean }
  /** A member or guest in a chat: the current conversation only. */
  | { kind: 'chat'; nodes: readonly string[] }
  /** A program, routine, task or rehearsal: its own lineage and the sessions its brief names. */
  | { kind: 'unattended'; lineage: readonly string[]; refs: readonly string[] }
  /** The heartbeat: its own agent's sessions, web chats only when an order names them. */
  | { kind: 'heartbeat'; refs: readonly string[] }

export interface AccessTarget {
  sessionId: string
  /** The agent that owns the session; undefined = unknown (refused). */
  agentId: string | undefined
  kind: ContextKind
  /** Channel session: the node that owns it and the node it answered in last. */
  nodeIds?: readonly string[]
  /** Run: nodes (chats) its report or a message of its session was posted to. */
  postedNodes?: readonly string[]
}

export type Access = { ok: true } | { ok: false; reason: string }

export const PRIVATE_CHAT_REASON = 'That chat is private to its participants.'
export const OTHER_AGENT_REASON =
  "Only the lead, or an owner asking, can read another agent's sessions and runs."
export const UNATTENDED_REASON =
  'This run may only read its own earlier runs and the sessions its brief names.'
export const HEARTBEAT_REASON =
  'A heartbeat reads sessions of its own agent; a web chat only when one of its standing orders names it.'

const matches = (list: readonly string[], sessionId: string): boolean =>
  list.some((ref) => sessionId === ref || sessionId.startsWith(`${ref}`))

/**
 * May `caller` read `target`? `callerAgent` is the agent whose turn it is; `callerIsLead` allows
 * the `agent` argument in a full scope.
 */
export function decideAccess(
  scope: AccessScope,
  caller: { agentId: string; isLead: boolean },
  target: AccessTarget,
  options: { ownerAsking?: boolean } = {},
): Access {
  const own = target.agentId === caller.agentId
  switch (scope.kind) {
    case 'full':
      if (own) return { ok: true }
      if (
        target.agentId !== undefined &&
        scope.crossAgent &&
        (caller.isLead || options.ownerAsking)
      )
        return { ok: true }
      return { ok: false, reason: OTHER_AGENT_REASON }
    case 'chat': {
      if (!own) return { ok: false, reason: OTHER_AGENT_REASON }
      if (target.kind === 'channel') {
        const nodes = target.nodeIds ?? []
        return nodes.some((n) => scope.nodes.includes(n))
          ? { ok: true }
          : { ok: false, reason: PRIVATE_CHAT_REASON }
      }
      // a run whose report went to this very chat
      if ((target.postedNodes ?? []).some((n) => scope.nodes.includes(n))) return { ok: true }
      return { ok: false, reason: PRIVATE_CHAT_REASON }
    }
    case 'unattended':
      if (!own) return { ok: false, reason: UNATTENDED_REASON }
      return matches(scope.lineage, target.sessionId) || scope.refs.includes(target.sessionId)
        ? { ok: true }
        : { ok: false, reason: UNATTENDED_REASON }
    case 'heartbeat':
      return canReadForHeartbeat(caller.agentId, target, scope.refs)
        ? { ok: true }
        : { ok: false, reason: HEARTBEAT_REASON }
  }
}

/**
 * The heartbeat is the agent's own supervisor: it may read every session of its agent, except web
 * chats (a person's private DM) unless one of its standing orders references the session
 * (`refs`: session ids; the heartbeat module passes the ids its orders carry).
 */
export function canReadForHeartbeat(
  agentId: string,
  target: Pick<AccessTarget, 'sessionId' | 'agentId' | 'kind'>,
  refs: readonly string[] = [],
): boolean {
  if (target.agentId !== agentId) return false
  if (target.kind === 'web' && !refs.includes(target.sessionId)) return false
  return true
}

/** Session ids (and task ids) a brief or an order text names: what a run may read besides its lineage. */
export function sessionRefsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(
    /\b(?:dm|chat|channel|program|routine|task|heartbeat)(?::[A-Za-z0-9_.#-]+)+/g,
  )) {
    out.add(m[0].replace(/[.,;:]+$/, ''))
  }
  return [...out]
}

// --- platform message ids ----------------------------------------------------------------------

/** "pesan 12345", "message 12345", "msg #12345", "#12345" or "12345": the platform message id. */
export function parsePlatformMessageId(text: string): string | undefined {
  const m = /^\s*(?:(?:pesan|message|msg|mesej|id)\s*)?#?\s*(\d{1,20})\s*$/i.exec(text)
  return m === null ? undefined : (m[1] as string)
}

/** Does this text carry the header of the chat message `id` (`message <id>` or `#<id>`)? */
export function carriesPlatformId(text: string, id: string): boolean {
  const safe = id.replace(/[^0-9]/g, '')
  if (safe === '') return false
  return new RegExp(`(?<!reply to )(?:#|\\bmessage )${safe}(?![0-9])`).test(text)
}

// --- showing messages --------------------------------------------------------------------------

export interface StoredPart {
  type: string
  text?: string
  state?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
  mediaType?: string
  filename?: string
  url?: string
  data?: unknown
}

export interface StoredMessage {
  id: string
  role: string
  parts: StoredPart[]
  metadata?: { eharness?: { kind?: string } } | undefined
  createdAt: number
}

export const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 1))}… (+${text.length - max + 1} chars)`

const oneLine = (text: string, max: number): string => clip(text.replace(/\s+/g, ' ').trim(), max)

/** The kind of a stored kind message (`eh.compaction`, `eh.input`, ...); undefined for ordinary ones. */
export const kindOfMessage = (m: Pick<StoredMessage, 'metadata'>): string | undefined =>
  m.metadata?.eharness?.kind

/** The text parts of a message, joined: what search matches over. */
export const messageText = (m: Pick<StoredMessage, 'parts'>): string =>
  m.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim()

/** The summary a compaction message holds, or undefined. */
export function compactionSummaryOf(m: StoredMessage): string | undefined {
  if (kindOfMessage(m) !== 'eh.compaction') return undefined
  const part = m.parts.find((p) => p.type === 'data-eh.compaction')
  const data = part?.data as { summary?: unknown } | undefined
  return typeof data?.summary === 'string' ? data.summary : undefined
}

const toolNameOf = (p: StoredPart): string =>
  p.type === 'dynamic-tool' ? (p.toolName ?? 'tool') : p.type.replace(/^tool-/, '')

function resultText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** One compact line for a part that is not text: a tool call (name, state, short result) or a file. */
export function compactPart(p: StoredPart): string | undefined {
  if (p.type === 'text' || p.type === 'reasoning' || p.type === 'step-start') return undefined
  if (p.type.startsWith('tool-') || p.type === 'dynamic-tool') {
    const state = p.state ?? 'unknown'
    const detail =
      state === 'output-error'
        ? ` error: ${oneLine(p.errorText ?? '', 160)}`
        : state === 'output-available'
          ? ` -> ${oneLine(resultText(p.output), 160)}`
          : state === 'output-denied'
            ? ' denied'
            : ''
    return `[tool ${toolNameOf(p)} ${state}${detail}]`
  }
  if (p.type === 'file') {
    return `[file ${p.filename ?? 'unnamed'} ${p.mediaType ?? ''} ${p.url !== undefined && !p.url.startsWith('data:') ? p.url : ''}]`.replace(
      /\s+\]$/,
      ']',
    )
  }
  return undefined
}

/** One message as lines of text: header (id, time, role) and the text and compact parts. */
export function renderMessage(
  m: StoredMessage,
  options: { zone: string; maxChars: number; mark?: boolean },
): string {
  const kind = kindOfMessage(m)
  const head = `${options.mark === true ? '>> ' : ''}[${m.id} ${stamp(m.createdAt, options.zone)} ${m.role}${kind === undefined ? '' : ` ${kind}`}]`
  if (kind === 'eh.compaction') {
    return `${head} (the conversation before this point was summarized; see the summary above)`
  }
  const text = messageText(m)
  const extras = m.parts.map(compactPart).filter((x): x is string => x !== undefined)
  const body = [text === '' ? undefined : clip(text, options.maxChars), ...extras]
    .filter((x) => x !== undefined)
    .join('\n')
  return `${head} ${body === '' ? '(no text)' : body}`
}

/** `2026-10-12 12:57` in a zone (an unknown zone falls back to UTC). */
export function stamp(at: number, zone: string): string {
  const format = (tz: string): string | undefined => {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(new Date(at))
          .map((p) => [p.type, p.value]),
      )
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
    } catch {
      return undefined
    }
  }
  return format(zone) ?? (format('UTC') as string)
}

/** A snippet of `text` around the first hit of any term (case-insensitive). */
export function snippetAround(text: string, terms: readonly string[], width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return clip(flat, width)
  const start = Math.max(0, at - Math.floor(width / 3))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Every term must occur in the text (case-insensitive). */
export const hasAllTerms = (text: string, terms: readonly string[]): boolean => {
  const lower = text.toLowerCase()
  return terms.every((t) => lower.includes(t.toLowerCase()))
}

/** The search terms of a query: words (quoted phrases stay whole), at most 8. */
export function queryTerms(query: string): string[] {
  const terms: string[] = []
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? '').trim()
    if (t !== '') terms.push(t)
  }
  return terms.slice(0, 8)
}
