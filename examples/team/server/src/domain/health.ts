/**
 * Agent health: anomaly detection over data the server already keeps (stored tool parts, the model
 * call log, program runs, pending approvals). Pure: the detectors take plain facts and return
 * findings; reading the stores and notifying is `app/health.ts`.
 *
 * A finding has a stable fingerprint (the same problem is the same finding on every scan), so it can
 * be deduplicated, dismissed by an owner and notified once.
 */

export const FINDING_KINDS = [
  'repeated-denial',
  'tool-loop',
  'repeated-error',
  'approval-waiting',
  'token-spike',
  'big-output',
  'program-run',
  'provider-error',
  'tools-changed',
] as const
export type FindingKind = (typeof FINDING_KINDS)[number]

export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

export interface Finding {
  fingerprint: string
  kind: FindingKind
  severity: FindingSeverity
  agentId: string | null
  sessionId: string | null
  programId: string | null
  /** App path that opens the evidence (`/programs/<id>`, `/tasks/<id>`, `/a/<agent>?t=...`). */
  link: string | null
  firstSeen: number
  lastSeen: number
  count: number
  /** One line: what is wrong. */
  explanation: string
  /** What to do about it. */
  fix: string
}

/** Thresholds in one place (the tests and the page read the same numbers). */
export const HEALTH = {
  /** The window every scan looks at. */
  windowMs: 24 * 3_600_000,
  denialCount: 3,
  /** The same input giving the same result this many times in one turn is a loop. */
  loopCount: 3,
  /** `tool_search` calls in one turn, whatever the query. */
  searchLoopCount: 5,
  errorCount: 3,
  approvalWaitMs: 15 * 60_000,
  spikeFactor: 2,
  spikeMinTokens: 50_000,
  /** A single tool output above this many characters. */
  bigOutputChars: 50_000,
  /** A program is suggested a tool after this many runs, or this many denials. */
  suggestRuns: 2,
  suggestDenials: 3,
} as const

// --- facts --------------------------------------------------------------------------------------

/** One tool call of a stored session, as the detectors need it. */
export interface ToolEvent {
  sessionId: string
  /** The assistant message (one turn) that holds the call. */
  messageId: string
  at: number
  agentId: string | null
  /** Set when the session is a run of a program. */
  programId: string | null
  link: string | null
  toolName: string
  /** Fingerprint of the FULL input (stable JSON, sorted keys), for "same input" comparisons. */
  inputKey: string
  /** Fingerprint of the output (`''` when unknown); with `error` it is what "same result" means. */
  outputKey?: string
  denied: boolean
  denialReason: string | null
  /** Error text of a failed call (an `ERROR:` result counts), else null. */
  error: string | null
  outputChars: number
}

/** A model call of the log. */
export interface CallEvent {
  id: string
  sessionId: string | null
  agentId: string | null
  link: string | null
  at: number
  kind: string
  status: string
  inputTokens: number | null
  errorName: string | null
  errorMessage: string | null
}

/** A stored `eh.notice` message with an error code. */
export interface NoticeEvent {
  sessionId: string
  agentId: string | null
  link: string | null
  at: number
  code: string
  message: string
}

export interface PendingApproval {
  id: string
  sessionId: string
  agentId: string
  link: string | null
  toolName: string
  /** When it started waiting (ms). */
  since: number
}

export interface ProgramRunFact {
  programId: string
  programName: string
  agentId: string
  sessionId: string
  taskId: string
  link: string
  at: number
  status: string
  reportStatus: string | null
  summary: string | null
}

/** A chat that keeps tools of a remote MCP server off because the server changed them. */
export interface DriftFact {
  sessionId: string
  agentId: string | null
  link: string | null
  at: number
  /** The connection's name as the owner knows it (falls back to the server slug). */
  connection: string
  /** Tools as the agent calls them. */
  tools: string[]
}

// --- helpers ------------------------------------------------------------------------------------

const shortHash = (text: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** An error text without the parts that differ per run (ids, numbers, quoted values, paths' tails). */
export function normalizeError(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '*')
    .replace(/\b[0-9a-f]{12,}\b/g, '*')
    .replace(/"[^"]{0,200}"/g, '"*"')
    .replace(/'[^']{0,200}'/g, "'*'")
    .replace(/\d+(?:[.:]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/** JSON with object keys sorted, so equal values give equal text. */
export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (v: unknown): unknown => {
    if (typeof v !== 'object' || v === null) return v
    if (seen.has(v)) return '[circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map(walk)
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = walk((v as Record<string, unknown>)[k])
    return out
  }
  try {
    return JSON.stringify(walk(value)) ?? ''
  } catch {
    return ''
  }
}

/** A fingerprint of a whole text (length plus two hashes; never a cut of it). */
export const fingerprintOf = (text: string): string =>
  `${text.length}.${shortHash(text)}.${shortHash(`~${text}`)}`

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

const window = <T extends { at: number }>(items: readonly T[], now: number): T[] =>
  items.filter((e) => e.at >= now - HEALTH.windowMs)

const minMax = (ats: readonly number[]): { first: number; last: number } => ({
  first: Math.min(...ats),
  last: Math.max(...ats),
})

const sameOrNull = <T>(values: readonly T[]): T | null => {
  const first = values[0]
  return first !== undefined && values.every((v) => v === first) ? first : null
}

const groupBy = <T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list === undefined) out.set(k, [item])
    else list.push(item)
  }
  return out
}

const latest = <T extends { at: number }>(items: readonly T[]): T =>
  items.reduce((a, b) => (b.at >= a.at ? b : a))

// --- detectors ----------------------------------------------------------------------------------

/**
 * The same tool denied at least 3 times in one session, or across the runs of one program in 24 h.
 * Runs of a program are grouped by program (a loop in one run and a repeat over runs are one problem).
 */
export function detectRepeatedDenials(events: readonly ToolEvent[], now: number): Finding[] {
  const denied = window(events, now).filter((e) => e.denied)
  const groups = groupBy(denied, (e) =>
    e.programId !== null
      ? `program:${e.programId}:${e.toolName}`
      : `session:${e.sessionId}:${e.toolName}`,
  )
  const out: Finding[] = []
  for (const [key, list] of groups) {
    if (list.length < HEALTH.denialCount) continue
    const last = latest(list)
    const { first, last: lastSeen } = minMax(list.map((e) => e.at))
    const runs = new Set(list.map((e) => e.sessionId)).size
    const program = last.programId !== null
    out.push({
      fingerprint: `denial:${key}`,
      kind: 'repeated-denial',
      severity: program || list.length >= 8 ? 'high' : 'medium',
      agentId: sameOrNull(list.map((e) => e.agentId)),
      sessionId: last.sessionId,
      programId: last.programId,
      link: last.link,
      firstSeen: first,
      lastSeen,
      count: list.length,
      explanation: program
        ? `${last.toolName} was denied ${list.length} times across ${plural(runs, 'run')} of the same program.`
        : `${last.toolName} was denied ${list.length} times in one session.`,
      fix: program
        ? `Add ${last.toolName} to the authority of the program (or ask the agent to use request_authority), or remove the step from the brief. The Decision Center may already hold a suggestion.`
        : `Allow ${last.toolName} for this agent (Tool access), or tell the agent not to use it: it keeps retrying a call nobody can approve.`,
    })
  }
  return out
}

/**
 * The same tool with the same FULL input giving the same result (output or error) at least 3 times
 * in one turn; `tool_search` at least 5 times in one turn whatever the query (the agent looks for a
 * tool that is not there). Same input with changing outputs is polling, not a loop.
 */
export function detectToolLoops(events: readonly ToolEvent[], now: number): Finding[] {
  const recent = window(events, now).filter((e) => !e.denied)
  const groups = groupBy(recent, (e) =>
    e.toolName === 'tool_search'
      ? `${e.sessionId}|${e.messageId}|tool_search|`
      : `${e.sessionId}|${e.messageId}|${e.toolName}|${e.inputKey}|${
          e.error !== null ? `E${fingerprintOf(normalizeError(e.error))}` : `O${e.outputKey ?? ''}`
        }`,
  )
  // one finding per session and tool: the turns that loop are added up
  const perSession = new Map<string, ToolEvent[]>()
  for (const list of groups.values()) {
    const head = list[0] as ToolEvent
    const min = head.toolName === 'tool_search' ? HEALTH.searchLoopCount : HEALTH.loopCount
    if (list.length < min) continue
    const key = `${head.sessionId}|${head.toolName}`
    perSession.set(key, [...(perSession.get(key) ?? []), ...list])
  }
  const out: Finding[] = []
  for (const [key, list] of perSession) {
    const head = list[0] as ToolEvent
    const { first, last } = minMax(list.map((e) => e.at))
    const search = head.toolName === 'tool_search'
    out.push({
      fingerprint: `loop:${key}`,
      kind: 'tool-loop',
      severity: list.length >= 15 ? 'high' : 'medium',
      agentId: head.agentId,
      sessionId: head.sessionId,
      programId: head.programId,
      link: head.link,
      firstSeen: first,
      lastSeen: last,
      count: list.length,
      explanation: search
        ? `The agent called tool_search ${list.length} times in one turn: it looks for a tool it does not have.`
        : `${head.toolName} was called ${list.length} times with the same input and gave the same result each time, in one turn.`,
      fix: search
        ? 'Check that the tool exists and is enabled for this agent (Connectors, Tool access); tell the agent in its instructions what to do when a tool is unavailable.'
        : `Open the session: the agent repeats ${head.toolName} with the same input and gets the same result. Steer it, fix the tool, or add a note to its instructions.`,
    })
  }
  return out
}

/** The same normalized error text at least 3 times in 24 h (a sandbox that fails on every run). */
export function detectRepeatedErrors(events: readonly ToolEvent[], now: number): Finding[] {
  const failed = window(events, now).filter((e) => e.error !== null && !e.denied)
  const groups = groupBy(failed, (e) => `${e.toolName}|${normalizeError(e.error as string)}`)
  const out: Finding[] = []
  for (const [key, list] of groups) {
    if (list.length < HEALTH.errorCount) continue
    const last = latest(list)
    const { first, last: lastSeen } = minMax(list.map((e) => e.at))
    const sessions = new Set(list.map((e) => e.sessionId)).size
    const text = (last.error as string).replace(/\s+/g, ' ').trim().slice(0, 140)
    out.push({
      fingerprint: `error:${last.toolName}:${shortHash(key)}`,
      kind: 'repeated-error',
      severity: list.length >= 10 ? 'high' : 'medium',
      agentId: sameOrNull(list.map((e) => e.agentId)),
      sessionId: last.sessionId,
      programId: sameOrNull(list.map((e) => e.programId)),
      link: last.link,
      firstSeen: first,
      lastSeen,
      count: list.length,
      explanation: `${last.toolName} failed ${list.length} times in ${plural(sessions, 'session')} with the same error: ${text}`,
      fix: `The cause is probably the tool or its environment, not the agent: check ${last.toolName} (sandbox, connector, credentials) and run it once by hand.`,
    })
  }
  return out
}

/** A tool approval or question that nobody answered for more than 15 minutes. */
export function detectWaitingApprovals(
  pending: readonly PendingApproval[],
  now: number,
): Finding[] {
  const out: Finding[] = []
  for (const a of pending) {
    const waited = now - a.since
    if (waited < HEALTH.approvalWaitMs) continue
    const minutes = Math.floor(waited / 60_000)
    out.push({
      fingerprint: `approval:${a.id}`,
      kind: 'approval-waiting',
      severity: waited >= 2 * 3_600_000 ? 'high' : 'medium',
      agentId: a.agentId,
      sessionId: a.sessionId,
      programId: null,
      link: a.link,
      firstSeen: a.since,
      lastSeen: now,
      count: 1,
      explanation: `${a.toolName} has waited ${minutes >= 120 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`} for an answer.`,
      fix: 'Answer it in the chat of the session (Approve or Deny), or stop the session. Rules in Tool access can answer this tool without asking.',
    })
  }
  return out
}

/**
 * A model call whose input is more than twice the previous step of the same session and above
 * 50k tokens; a single tool output above the character limit.
 */
export function detectTokenSpikes(
  calls: readonly CallEvent[],
  events: readonly ToolEvent[],
  now: number,
): Finding[] {
  const out: Finding[] = []
  const steps = window(calls, now).filter(
    (c) => c.kind === 'step' && c.status === 'ok' && c.sessionId !== null && c.inputTokens !== null,
  )
  for (const [sessionId, list] of groupBy(steps, (c) => c.sessionId as string)) {
    const ordered = [...list].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    const spikes: CallEvent[] = []
    for (let i = 1; i < ordered.length; i++) {
      const prev = (ordered[i - 1] as CallEvent).inputTokens as number
      const cur = ordered[i] as CallEvent
      const tokens = cur.inputTokens as number
      if (tokens > HEALTH.spikeMinTokens && prev > 0 && tokens > HEALTH.spikeFactor * prev) {
        spikes.push(cur)
      }
    }
    if (spikes.length === 0) continue
    const worst = spikes.reduce((a, b) =>
      (b.inputTokens as number) > (a.inputTokens as number) ? b : a,
    )
    const { first, last } = minMax(spikes.map((c) => c.at))
    out.push({
      fingerprint: `spike:${sessionId}`,
      kind: 'token-spike',
      severity: (worst.inputTokens as number) >= 150_000 ? 'high' : 'medium',
      agentId: worst.agentId,
      sessionId,
      programId: null,
      link: worst.link,
      firstSeen: first,
      lastSeen: last,
      count: spikes.length,
      explanation: `The context of one step jumped to ${Math.round((worst.inputTokens as number) / 1000)}k tokens, more than double the step before.`,
      fix: 'Look for a large tool result just before it (a file, a page or a screenshot read into the context). Ask the agent to write big data to a file and read parts of it.',
    })
  }
  const big = window(events, now).filter((e) => e.outputChars > HEALTH.bigOutputChars)
  for (const [, list] of groupBy(big, (e) => `${e.sessionId}|${e.toolName}`)) {
    const worst = list.reduce((a, b) => (b.outputChars > a.outputChars ? b : a))
    const { first, last } = minMax(list.map((e) => e.at))
    out.push({
      fingerprint: `bigout:${worst.sessionId}:${worst.toolName}`,
      kind: 'big-output',
      severity: worst.outputChars >= 150_000 ? 'high' : 'medium',
      agentId: worst.agentId,
      sessionId: worst.sessionId,
      programId: worst.programId,
      link: worst.link,
      firstSeen: first,
      lastSeen: last,
      count: list.length,
      explanation: `${worst.toolName} returned ${Math.round(worst.outputChars / 1000)}k characters in one result, which fills the context.`,
      fix: `Make ${worst.toolName} return a file path or a summary instead of the data itself, or ask for a smaller slice.`,
    })
  }
  return out
}

/** A program run that ended failed, interrupted, or with a partial/failed report. */
export function detectProgramRuns(runs: readonly ProgramRunFact[], now: number): Finding[] {
  const out: Finding[] = []
  for (const r of window(runs, now)) {
    const failed =
      r.status === 'failed' || r.status === 'interrupted' || r.reportStatus === 'failed'
    const partial = r.reportStatus === 'partial'
    if (!failed && !partial) continue
    const summary = (r.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    out.push({
      fingerprint: `run:${r.sessionId}`,
      kind: 'program-run',
      severity: failed ? 'high' : 'medium',
      agentId: r.agentId,
      sessionId: r.sessionId,
      programId: r.programId,
      link: r.link,
      firstSeen: r.at,
      lastSeen: r.at,
      count: 1,
      explanation: `A run of "${r.programName}" ended ${failed ? 'failed' : 'partial'}${summary === '' ? '.' : `: ${summary}`}`,
      fix: failed
        ? 'Open the run and read its report: the usual causes are a budget that is too small, a missing authority or a tool that fails.'
        : 'Open the run: it did only part of the brief. Check what it could not do (authority, budget, a failing tool) and fix that, then run again.',
    })
  }
  return out
}

/** Model call errors and error notices (`EH_PROVIDER*`), grouped by agent and message. */
export function detectProviderErrors(
  calls: readonly CallEvent[],
  notices: readonly NoticeEvent[],
  now: number,
): Finding[] {
  const failed = window(calls, now).filter((c) => c.status === 'error')
  type Row = {
    at: number
    agentId: string | null
    sessionId: string | null
    link: string | null
    text: string
  }
  const rows: Row[] = failed.map((c) => ({
    at: c.at,
    agentId: c.agentId,
    sessionId: c.sessionId,
    link: c.link,
    text: `${c.errorName ?? 'Error'}: ${c.errorMessage ?? ''}`,
  }))
  for (const n of window(notices, now)) {
    if (!n.code.startsWith('EH_PROVIDER')) continue
    // the call that failed is in the log already: the notice is the same incident
    if (failed.some((c) => c.sessionId === n.sessionId && Math.abs(c.at - n.at) <= 60_000)) continue
    rows.push({
      at: n.at,
      agentId: n.agentId,
      sessionId: n.sessionId,
      link: n.link,
      text: `${n.code}: ${n.message}`,
    })
  }
  const out: Finding[] = []
  for (const [key, list] of groupBy(rows, (r) => `${r.agentId ?? '-'}|${normalizeError(r.text)}`)) {
    const last = latest(list)
    const { first, last: lastSeen } = minMax(list.map((r) => r.at))
    const text = last.text.replace(/\s+/g, ' ').trim().slice(0, 160)
    out.push({
      fingerprint: `provider:${shortHash(key)}`,
      kind: 'provider-error',
      severity: list.length >= 3 ? 'high' : 'medium',
      agentId: last.agentId,
      sessionId: last.sessionId,
      programId: null,
      link: last.link,
      firstSeen: first,
      lastSeen,
      count: list.length,
      explanation: `The model provider failed ${plural(list.length, 'time')}: ${text}`,
      fix: 'Check the provider profile (key, quota, model id) in Settings, then send the message again: a failed turn can leave a chat or group without an answer.',
    })
  }
  return out
}

/** Tools a chat keeps off because their server changed them: one finding per agent and connection. */
export function detectToolsChanged(drifts: readonly DriftFact[], now: number): Finding[] {
  const out: Finding[] = []
  for (const [key, list] of groupBy(
    window(drifts, now),
    (d) => `${d.agentId ?? '-'}|${d.connection}`,
  )) {
    const last = latest(list)
    const tools = [...new Set(list.flatMap((d) => d.tools))]
    const chats = new Set(list.map((d) => d.sessionId)).size
    const { first, last: lastSeen } = minMax(list.map((d) => d.at))
    const shown = tools.slice(0, 6).join(', ')
    out.push({
      fingerprint: `tools-changed:${shortHash(key)}`,
      kind: 'tools-changed',
      severity: 'medium',
      agentId: last.agentId,
      sessionId: last.sessionId,
      programId: null,
      link: last.link,
      firstSeen: first,
      lastSeen,
      count: chats,
      explanation: `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} of ${last.connection} changed on the server after ${chats === 1 ? 'a chat' : `${chats} chats`} first saw them and stay off for safety: ${shown}${tools.length > 6 ? ` and ${tools.length - 6} more` : ''}.`,
      fix: "Open the chat's Tools panel and choose Accept & reload, or Reload tools in all chats.",
    })
  }
  return out
}

export interface ScanInput {
  now: number
  tools: readonly ToolEvent[]
  calls: readonly CallEvent[]
  notices: readonly NoticeEvent[]
  pending: readonly PendingApproval[]
  runs: readonly ProgramRunFact[]
  /** Chats that keep tools off because their server changed them (optional: older callers). */
  drifts?: readonly DriftFact[]
}

const RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 }

/** Every detector over the facts; high severity first, then the newest. */
export function detectAll(input: ScanInput): Finding[] {
  const { now } = input
  return [
    ...detectRepeatedDenials(input.tools, now),
    ...detectToolLoops(input.tools, now),
    ...detectRepeatedErrors(input.tools, now),
    ...detectWaitingApprovals(input.pending, now),
    ...detectTokenSpikes(input.calls, input.tools, now),
    ...detectProgramRuns(input.runs, now),
    ...detectProviderErrors(input.calls, input.notices, now),
    ...detectToolsChanged(input.drifts ?? [], now),
  ].sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.lastSeen - a.lastSeen)
}

// --- reading stored parts -----------------------------------------------------------------------

const DENIED_TEXT = /^(Outside the authority of program|Forbidden by program)/

const textOf = (v: unknown): string | null => {
  if (typeof v === 'string') return v
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    if (typeof o.error === 'string') return o.error
    if (o.ok === false && typeof o.message === 'string') return o.message
    if (typeof o.exitCode === 'number' && o.exitCode !== 0 && typeof o.stderr === 'string') {
      return o.stderr
    }
  }
  return null
}

/** Output without base64 payloads (a screenshot is compared by its other fields). */
function stripMedia(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 20_000 ? value.slice(0, 20_000) : value
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(stripMedia)
  const o = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o))
    out[k] = k === 'data' && typeof o[k] === 'string' ? '[data]' : stripMedia(o[k])
  return out
}

const ERROR_TEXT = /^\s*(error|failed|exception|traceback)\b/i

/** What a stored tool part says about the call; undefined when it is not a finished call. */
export function readToolPart(part: Record<string, unknown>):
  | {
      toolName: string
      inputKey: string
      outputKey: string
      denied: boolean
      denialReason: string | null
      error: string | null
      outputChars: number
    }
  | undefined {
  const type = typeof part.type === 'string' ? part.type : ''
  const toolName =
    type === 'dynamic-tool'
      ? typeof part.toolName === 'string'
        ? part.toolName
        : ''
      : type.startsWith('tool-')
        ? type.slice(5)
        : ''
  if (toolName === '') return undefined
  const state = part.state
  const inputKey = fingerprintOf(stableJson(part.input ?? {}))
  if (state === 'output-denied') {
    const reason = (part.approval as { reason?: unknown } | undefined)?.reason
    return {
      toolName,
      inputKey,
      outputKey: '',
      denied: true,
      denialReason: typeof reason === 'string' ? reason : '',
      error: null,
      outputChars: 0,
    }
  }
  if (state === 'output-error') {
    const text = typeof part.errorText === 'string' ? part.errorText : ''
    const denied = DENIED_TEXT.test(text)
    return {
      toolName,
      inputKey,
      outputKey: '',
      denied,
      denialReason: denied ? text : null,
      error: denied ? null : text,
      outputChars: text.length,
    }
  }
  if (state === 'output-available') {
    const output = part.output
    let chars = 0
    if (typeof output === 'string') chars = output.length
    else {
      try {
        chars = (JSON.stringify(output) ?? '').length
      } catch {
        chars = 0
      }
    }
    const text = textOf(output)
    const denied = text !== null && DENIED_TEXT.test(text)
    return {
      toolName,
      inputKey,
      outputKey: fingerprintOf(
        typeof output === 'string' ? output : stableJson(stripMedia(output)),
      ),
      denied,
      denialReason: denied ? text : null,
      error: !denied && text !== null && ERROR_TEXT.test(text) ? text.slice(0, 600) : null,
      outputChars: chars,
    }
  }
  return undefined
}

// --- authority suggestions (plan B) -------------------------------------------------------------

/** A tool that program runs were denied, with the evidence. */
export interface DeniedToolCandidate {
  programId: string
  tool: string
  runs: number
  denials: number
  sessions: string[]
  firstSeen: number
  lastSeen: number
}

/**
 * Tools denied as "outside the authority of the program" in at least 2 runs or 3 denials in the
 * window. `forbidden` rules of a program, file tools (their grant is paths) and tools the program
 * has already are never candidates. Whether a tool is safe to grant is the caller's check.
 */
export function deniedToolCandidates(
  events: readonly ToolEvent[],
  programs: ReadonlyMap<string, { forbidden: readonly string[]; tools: readonly string[] }>,
  now: number,
  fileTools: readonly string[],
): DeniedToolCandidate[] {
  const denied = window(events, now).filter(
    (e) =>
      e.denied &&
      e.programId !== null &&
      (e.denialReason ?? '').startsWith('Outside the authority of program'),
  )
  const out: DeniedToolCandidate[] = []
  for (const [, list] of groupBy(denied, (e) => `${e.programId}|${e.toolName}`)) {
    const head = list[0] as ToolEvent
    const program = programs.get(head.programId as string)
    if (program === undefined) continue
    const base = (rule: string): string => rule.split('(')[0]?.trim() ?? rule
    if (program.forbidden.some((r) => base(r) === head.toolName || r.trim() === head.toolName))
      continue
    if (program.tools.some((r) => base(r) === head.toolName)) continue
    if (fileTools.includes(head.toolName)) continue
    const sessions = [...new Set(list.map((e) => e.sessionId))]
    if (sessions.length < HEALTH.suggestRuns && list.length < HEALTH.suggestDenials) continue
    const { first, last } = minMax(list.map((e) => e.at))
    out.push({
      programId: head.programId as string,
      tool: head.toolName,
      runs: sessions.length,
      denials: list.length,
      sessions,
      firstSeen: first,
      lastSeen: last,
    })
  }
  return out
}

const NEVER =
  /(delete|remove|destroy|drop|purge|wipe|kick|ban|revoke|send|post|publish|pay|transfer|refund|bash|shell|exec|run_|deploy|reset|kill|stop|disable|archive|ban)/i
const SAFE_READ =
  /^(list|get|describe|read|search|find|show|view|lookup|fetch|count)_|_(list|get|describe|read|search|view|lookup|info|status)$|^(grep|glob|web_search|channel_describe|list_topics)$/i
/** Writes to the agent's own memory: low risk, the agent edits notes about its work. */
const OWN_WRITE = new Set(['memory_str_replace', 'memory_insert', 'memory_create', 'memory_note'])

/**
 * Whether a denied tool may be suggested for a program. `kind` is what the tool inventory says when
 * it knows the tool (`read`, `write`, `destructive`, `external`, `unknown`). Unsure: no.
 */
export function safeToSuggest(tool: string, kind: string | undefined, pinned = false): boolean {
  if (pinned) return false
  if (kind === 'destructive' || kind === 'external') return false
  if (NEVER.test(tool)) return false
  if (kind === 'read') return true
  if (kind === 'write') return OWN_WRITE.has(tool)
  return SAFE_READ.test(tool) || OWN_WRITE.has(tool)
}
