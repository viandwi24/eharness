/**
 * Consistency: contradictions and stale state across features (programs, standing orders, routines,
 * decisions, connections, memory files), found with no model call. Pure: `app/consistency.ts`
 * gathers the facts, these functions compare them.
 *
 * Why: an agent (or an owner) that reads two places that disagree acts on the wrong one. A memory
 * file that names tools of a deleted connection, a program that exists twice, a standing order that
 * repeats a program note, a decision nobody answered for a week. Each finding names what is wrong,
 * where, and the exact fix. Everything here is a hint with a stable fingerprint, never an action.
 *
 * Detectors are conservative on purpose: a false alarm teaches people to ignore the page.
 */
import { fingerprintOf, stableJson } from './health.ts'
import { sameInstruction, topicWords } from './order-hygiene.ts'
import { briefWarnings, grantedAndForbidden, type Program } from './programs.ts'
import type { Routine } from './routines.ts'
import type { StandingOrder } from './standing-orders.ts'

export type ConsistencyKind =
  | 'program-duplicate'
  | 'program-needs-tool'
  | 'program-dead-ref'
  | 'order-duplicates-note'
  | 'routine-duplicate'
  | 'decision-stale'
  | 'decision-dead-ref'
  | 'connection-used-but-broken'
  | 'memory-dead-ref'
  | 'memory-duplicate-topic'
  | 'memory-placeholder'
  | 'memory-system-state'

export const CONSISTENCY_KINDS: readonly ConsistencyKind[] = [
  'program-duplicate',
  'program-needs-tool',
  'program-dead-ref',
  'order-duplicates-note',
  'routine-duplicate',
  'decision-stale',
  'decision-dead-ref',
  'connection-used-but-broken',
  'memory-dead-ref',
  'memory-duplicate-topic',
  'memory-placeholder',
  'memory-system-state',
]

export interface ConsistencyFinding {
  kind: ConsistencyKind
  severity: 'high' | 'medium' | 'low'
  agentId: string | null
  /** What it is about, short (a program name, a memory file, a connection). */
  subject: string
  explanation: string
  fix: string
  /** Ids and paths involved (program ids, decision ids, connection ids, memory paths). */
  refs: string[]
  /** Stable: the same problem has the same fingerprint on every scan. */
  fingerprint: string
  /** Memory findings: the file, relative to its scope root, and the first line. */
  memoryPath?: string
  line?: number
}

/** Thresholds in one place (the tests read the same numbers). */
export const CONSISTENCY = {
  decisionStaleMs: 3 * 24 * 3_600_000,
  decisionHighMs: 7 * 24 * 3_600_000,
  /** Two briefs are the same program when they share this many topic words and this Jaccard. */
  briefShared: 8,
  briefSimilarity: 0.7,
  /** Two routine prompts are the same when this similar (Jaccard of topic words), or `sameInstruction`. */
  routineSimilarity: 0.7,
  /** Two memory files are the same topic by content at this Jaccard, when both have enough words. */
  memorySimilarity: 0.6,
  memoryMinWords: 8,
  /** Memory scan caps (the job must stay cheap). */
  memoryMaxFiles: 60,
  memoryMaxChars: 24_000,
  memoryMaxTotalChars: 300_000,
} as const

// --- facts --------------------------------------------------------------------------------------

export interface AgentFact {
  id: string
  name: string
  slug: string
}

export interface DecisionFact {
  id: string
  kind: string
  status: string
  title: string
  agentId: string
  sessionId: string | null
  programId: string | null
  createdAt: number
}

/** A connection as the detectors need it (any scope). */
export interface ConnectionFact {
  id: string
  connectorId: string
  label: string
  status: 'connected' | 'needs-auth' | 'error' | 'disabled'
  statusMessage?: string | undefined
  /** Names a person or an authority calls it by (id, connector id, label, slug, tool prefix). */
  names: string[]
}

/** A connection one agent has switched on. */
export interface AgentConnectionFact {
  connectionId: string
  label: string
  status: ConnectionFact['status']
  statusMessage?: string | undefined
  /** The owner switched it on for this agent himself (not just inherited from the workspace). */
  explicit: boolean
}

export interface AgentToolsFact {
  /** Tool names the agent is offered through connectors. */
  available: readonly string[]
  /** Connector prefixes of those names (`phone` of `phone_screenshot`). */
  prefixes: readonly string[]
}

export interface MemoryFact {
  /** The agent it belongs to; null for workspace memory. */
  agentId: string | null
  /** Relative to the scope root. */
  path: string
  text: string
  updatedAt: number
}

export interface ConsistencyInput {
  now: number
  agents: readonly AgentFact[]
  programs: readonly Program[]
  /** Problems the tool-availability check found per program id (readable messages). */
  programToolProblems: ReadonlyMap<string, readonly string[]>
  orders: ReadonlyArray<{ agentId: string; order: StandingOrder }>
  routines: readonly Routine[]
  /** Every decision, any status (an id is "known" while it exists). */
  decisions: readonly DecisionFact[]
  /** The session a decision came from still exists. */
  sessionExists: (sessionId: string) => boolean
  connections: readonly ConnectionFact[]
  agentConnections: ReadonlyMap<string, readonly AgentConnectionFact[]>
  tools: ReadonlyMap<string, AgentToolsFact>
  /** Every id the server knows now (programs, decisions, connections, orders, agents, tasks). */
  knownIds: ReadonlySet<string>
  memory: readonly MemoryFact[]
}

// --- helpers ------------------------------------------------------------------------------------

const clip = (text: string, n = 70): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/_/g, '-')

const jaccard = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): { common: number; sim: number } => {
  let common = 0
  for (const w of a) if (b.has(w)) common++
  const union = a.size + b.size - common
  return { common, sim: union === 0 ? 0 : common / union }
}

const agentName = (input: ConsistencyInput, agentId: string): string =>
  input.agents.find((a) => a.id === agentId)?.name ?? agentId

const UUID_G = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** Words that say an id on that line names one of the server's own things. */
const KIND_WORD =
  /\b(programs?|proposals?|decisions?|connections?|orders?|plans?|usulan|keputusan|koneksi|propose_plan)\b/i

export interface DeadId {
  id: string
  line: number
  /** The kind word of the line (`program`, `proposal`, ...). */
  word: string
}

/**
 * Ids in a text that look like references to the server's own things (the line, or the heading
 * above it, says program / proposal / decision / connection / order) and are not known any more.
 * An id without such a word (a device id, a message id) is never judged.
 */
export function deadIdsIn(text: string, known: ReadonlySet<string>): DeadId[] {
  const lines = text.split('\n')
  const out: DeadId[] = []
  const seen = new Set<string>()
  let heading = ''
  lines.forEach((raw, i) => {
    if (/^\s*#{1,6}\s/.test(raw)) heading = raw
    for (const m of raw.matchAll(UUID_G)) {
      const id = m[0].toLowerCase()
      if (known.has(id) || seen.has(id)) continue
      const word = KIND_WORD.exec(raw)?.[1] ?? KIND_WORD.exec(heading)?.[1]
      if (word === undefined) continue
      seen.add(id)
      out.push({ id, line: i + 1, word: word.toLowerCase() })
    }
  })
  return out
}

const finding = (
  f: Omit<ConsistencyFinding, 'fingerprint'> & { key: string },
): ConsistencyFinding => {
  const { key, ...rest } = f
  return { ...rest, fingerprint: `consistency:${f.kind}:${f.agentId ?? '-'}:${key}` }
}

// --- programs -----------------------------------------------------------------------------------

function programDuplicates(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const byAgent = new Map<string, Program[]>()
  for (const p of input.programs) byAgent.set(p.agentId, [...(byAgent.get(p.agentId) ?? []), p])
  for (const [agentId, list] of byAgent) {
    const words = new Map(list.map((p) => [p.id, topicWords(p.brief)] as const))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i] as Program
        const b = list[j] as Program
        const sameName = norm(a.name) === norm(b.name) && a.name.trim() !== ''
        const { common, sim } = jaccard(
          words.get(a.id) as Set<string>,
          words.get(b.id) as Set<string>,
        )
        const sameBrief = common >= CONSISTENCY.briefShared && sim >= CONSISTENCY.briefSimilarity
        if (!sameName && !sameBrief) continue
        const ids = [a.id, b.id].sort()
        out.push(
          finding({
            kind: 'program-duplicate',
            severity: 'medium',
            agentId,
            subject: a.name,
            explanation: sameName
              ? `${agentName(input, agentId)} has two programs named "${clip(a.name)}" (${a.id} and ${b.id}): both would run, and notes and memory point at one of them.`
              : `The programs "${clip(a.name)}" (${a.id}) and "${clip(b.name)}" (${b.id}) of ${agentName(input, agentId)} have almost the same brief.`,
            fix: 'Keep the one with the runs and notes you want, move the useful notes to it, and delete the other on the Programs page. Then fix any memory file that names the deleted id.',
            refs: ids,
            key: ids.join('+'),
          }),
        )
      }
    }
  }
  return out
}

function programNeeds(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  for (const p of input.programs) {
    const brief = briefWarnings(p.brief, p.authority)
    for (const w of brief) {
      out.push(
        finding({
          kind: 'program-needs-tool',
          severity: 'low',
          agentId: p.agentId,
          subject: p.name,
          explanation: `The brief of "${clip(p.name)}" asks for something its authority does not grant. ${w.message}`,
          fix: 'Edit the program: add the missing tool to the authority, or take the step out of the brief.',
          refs: [p.id],
          key: `${p.id}:brief:${fingerprintOf(w.message)}`,
        }),
      )
    }
    const both = grantedAndForbidden(p.authority, p.forbidden)
    if (both.length > 0) {
      out.push(
        finding({
          kind: 'program-needs-tool',
          severity: p.status === 'active' ? 'high' : 'medium',
          agentId: p.agentId,
          subject: p.name,
          explanation: `The program "${clip(p.name)}" grants and forbids the same tools: ${both.join(', ')}. Forbidden wins, so its runs never get them.`,
          fix: `Edit the program: take ${both.join(', ')} out of Forbidden (or out of the authority if it must not be used).`,
          refs: [p.id],
          key: `${p.id}:forbidden:${both.join(',')}`,
        }),
      )
    }
    const problems = input.programToolProblems.get(p.id) ?? []
    if (problems.length > 0) {
      const scheduled = p.status === 'active' && p.trigger.kind === 'schedule'
      out.push(
        finding({
          kind: 'program-needs-tool',
          severity: scheduled ? 'high' : 'medium',
          agentId: p.agentId,
          subject: p.name,
          explanation: `The program "${clip(p.name)}" needs tools or connectors the agent does not have now: ${problems.map((m) => clip(m, 140)).join(' | ')}`,
          fix: 'Edit the program authority: remove the names that are gone, or turn the connector on for the agent (Connectors tab).',
          refs: [p.id],
          key: `${p.id}:tools:${fingerprintOf(problems.join('\n'))}`,
        }),
      )
    }
  }
  return out
}

function programDeadRefs(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  for (const p of input.programs) {
    const texts = [
      { where: 'brief', text: p.brief },
      { where: 'notes', text: p.notes.join('\n') },
      { where: 'escalation', text: p.escalation },
    ]
    for (const { where, text } of texts) {
      for (const d of deadIdsIn(text, input.knownIds)) {
        out.push(
          finding({
            kind: 'program-dead-ref',
            severity: 'medium',
            agentId: p.agentId,
            subject: p.name,
            explanation: `The ${where} of "${clip(p.name)}" mentions a ${d.word} id (${d.id}) that no longer exists.`,
            fix: `Edit the program: remove or replace ${d.id} in the ${where}.`,
            refs: [p.id, d.id],
            key: `${p.id}:${d.id}`,
          }),
        )
      }
    }
  }
  return out
}

// --- orders, routines ---------------------------------------------------------------------------

function orderVsNotes(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  for (const { agentId, order } of input.orders) {
    if (!order.active || order.done !== undefined) continue
    for (const p of input.programs) {
      if (p.agentId !== agentId) continue
      p.notes.forEach((note) => {
        if (!sameInstruction(order.text, note)) return
        out.push(
          finding({
            kind: 'order-duplicates-note',
            severity: 'medium',
            agentId,
            subject: p.name,
            explanation: `The standing order "${clip(order.text)}" (${order.id}) and a note of the program "${clip(p.name)}" say the same thing: it would be done twice.`,
            fix: 'Keep it in one place: remove the program note if the heartbeat should do it, or remove the standing order if the program runs should.',
            refs: [order.id, p.id],
            key: `${order.id}:${p.id}:${fingerprintOf(note)}`,
          }),
        )
      })
    }
  }
  return out
}

const scheduleKey = (r: Routine): string => stableJson(r.schedule)

function routineDuplicates(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const live = input.routines.filter((r) => r.programId === null && r.status === 'active')
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i] as Routine
      const b = live[j] as Routine
      if (a.agentId !== b.agentId || scheduleKey(a) !== scheduleKey(b)) continue
      const same =
        norm(a.prompt) === norm(b.prompt) ||
        sameInstruction(a.prompt, b.prompt) ||
        jaccard(topicWords(a.prompt), topicWords(b.prompt)).sim >= CONSISTENCY.routineSimilarity
      if (!same) continue
      const ids = [a.id, b.id].sort()
      out.push(
        finding({
          kind: 'routine-duplicate',
          severity: 'medium',
          agentId: a.agentId,
          subject: a.name,
          explanation: `The routines "${clip(a.name)}" and "${clip(b.name)}" of ${agentName(input, a.agentId)} fire on the same schedule with nearly the same prompt: every fire happens twice.`,
          fix: 'Delete or pause one of the routines on the Routines page.',
          refs: ids,
          key: ids.join('+'),
        }),
      )
    }
  }
  return out
}

// --- decisions ----------------------------------------------------------------------------------

const days = (ms: number): number => Math.floor(ms / 86_400_000)

function decisionFindings(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const programIds = new Set(input.programs.map((p) => p.id))
  const agentIds = new Set(input.agents.map((a) => a.id))
  for (const d of input.decisions) {
    if (d.status !== 'open') continue
    const age = input.now - d.createdAt
    if (age >= CONSISTENCY.decisionStaleMs) {
      out.push(
        finding({
          kind: 'decision-stale',
          severity: age >= CONSISTENCY.decisionHighMs ? 'high' : 'medium',
          agentId: d.agentId,
          subject: d.title,
          explanation: `The decision "${clip(d.title)}" has waited ${days(age)} days for an answer: the session or program behind it is stuck.`,
          fix: 'Answer it in the Decision Center, or reject it if it no longer matters.',
          refs: [d.id],
          key: d.id,
        }),
      )
    }
    const gone: string[] = []
    if (!agentIds.has(d.agentId)) gone.push('the agent that asked')
    if (d.programId !== null && !programIds.has(d.programId))
      gone.push(`the program (${d.programId})`)
    if (d.sessionId !== null && !input.sessionExists(d.sessionId)) {
      gone.push(`the session (${d.sessionId})`)
    }
    if (gone.length > 0) {
      out.push(
        finding({
          kind: 'decision-dead-ref',
          severity: 'medium',
          agentId: agentIds.has(d.agentId) ? d.agentId : null,
          subject: d.title,
          explanation: `The open decision "${clip(d.title)}" is about something that no longer exists: ${gone.join(', ')}. Nothing can act on an answer.`,
          fix: 'Reject the decision in the Decision Center (nothing is lost).',
          refs: [d.id],
          key: d.id,
        }),
      )
    }
  }
  return out
}

// --- connections --------------------------------------------------------------------------------

const BROKEN: Record<ConnectionFact['status'], string | undefined> = {
  connected: undefined,
  'needs-auth': 'needs to sign in again',
  error: 'is in error',
  disabled: 'is disabled',
}

const matchesRef = (c: ConnectionFact, ref: string): boolean => {
  const r = norm(ref)
  return r !== '' && [c.id, c.connectorId, c.label, ...c.names].some((n) => norm(n) === r)
}

function connectionFindings(input: ConsistencyInput): ConsistencyFinding[] {
  type Use = {
    agentId: string
    connection: ConnectionFact
    uses: string[]
    severity: 'medium' | 'low'
  }
  const uses = new Map<string, Use>()
  const add = (
    agentId: string,
    c: ConnectionFact,
    why: string,
    severity: 'medium' | 'low',
  ): void => {
    const key = `${agentId}:${c.id}`
    const u = uses.get(key) ?? { agentId, connection: c, uses: [], severity: 'low' as const }
    if (!u.uses.includes(why)) u.uses.push(why)
    if (severity === 'medium') u.severity = 'medium'
    uses.set(key, u)
  }
  const agentIds = new Set(input.agents.map((a) => a.id))
  for (const p of input.programs) {
    if (!agentIds.has(p.agentId)) continue
    for (const ref of p.authority.connectors) {
      const hit = input.connections.filter((c) => matchesRef(c, ref))
      if (hit.length === 0 || hit.some((c) => c.status === 'connected')) continue
      for (const c of hit) add(p.agentId, c, `the program "${clip(p.name, 40)}"`, 'medium')
    }
  }
  const missing: ConsistencyFinding[] = []
  for (const { agentId, order } of input.orders) {
    if (!order.active || order.done !== undefined) continue
    for (const need of order.needs) {
      const m = /^phone\/(.+)$/.exec(need)
      if (m === null) continue
      const slug = m[1] as string
      const hit = input.connections.filter((c) => matchesRef(c, slug))
      if (hit.length === 0) {
        missing.push(
          finding({
            kind: 'connection-used-but-broken',
            severity: 'medium',
            agentId,
            subject: need,
            explanation: `The standing order "${clip(order.text)}" (${order.id}) needs "${need}", but no connection called "${slug}" exists any more: the beat cannot use it.`,
            fix: 'Give the order again with a connection that exists, or remove the order.',
            refs: [order.id],
            key: `order:${order.id}:${need}`,
          }),
        )
      } else if (!hit.some((c) => c.status === 'connected')) {
        for (const c of hit) add(agentId, c, `the standing order ${order.id}`, 'medium')
      }
    }
  }
  for (const [agentId, list] of input.agentConnections) {
    if (!agentIds.has(agentId)) continue
    for (const a of list) {
      if (a.status === 'connected' || !a.explicit) continue
      const c = input.connections.find((x) => x.id === a.connectionId)
      add(
        agentId,
        c ?? {
          id: a.connectionId,
          connectorId: '',
          label: a.label,
          status: a.status,
          statusMessage: a.statusMessage,
          names: [],
        },
        'it is switched on for the agent',
        'low',
      )
    }
  }
  const out = [...missing]
  for (const u of uses.values()) {
    const state = BROKEN[u.connection.status]
    if (state === undefined) continue
    const msg =
      u.connection.statusMessage === undefined ? '' : ` (${clip(u.connection.statusMessage, 100)})`
    out.push(
      finding({
        kind: 'connection-used-but-broken',
        severity: u.severity,
        agentId: u.agentId,
        subject: u.connection.label,
        explanation: `The connection "${clip(u.connection.label)}" ${state}${msg}, but ${agentName(input, u.agentId)} still relies on it: ${u.uses.join(', ')}.`,
        fix:
          u.connection.status === 'disabled'
            ? 'Enable the connection (Connectors page), or take it out of the programs and orders that use it.'
            : 'Open the connection on the Connectors page and reconnect or test it, or take it out of the programs and orders that use it.',
        refs: [u.connection.id],
        key: `${u.connection.id}`,
      }),
    )
  }
  return out
}

// --- memory -------------------------------------------------------------------------------------

const PLACEHOLDER: ReadonlyArray<RegExp> = [
  /<\s*isi\b[^>\n]*>?/i,
  /\(\s*isi\s+setelah[^)\n]*\)?/i,
  /<\s*fill\b[^>\n]*>?/i,
  /<\s*id\s*>/i,
  /<\s*(?:todo|tbd|placeholder)\b[^>\n]*>?/i,
  /\[\s*isi\b[^\]\n]*\]?/i,
  /\bTODO\b\s*[:(-]/,
  /\bTBD\b/,
]

/** Lines that state volatile state the server knows live. */
const SYSTEM_STATE: ReadonlyArray<RegExp> = [
  /\bstatus\b[^.\n]{0,40}\b(?:not connected|disconnected|connected|needs-auth)\b/i,
  /\b(?:NOT CONNECTED|NOT connected|DISCONNECTED|CONNECTED)\b/,
  /\bdevice[ _-]?id\b\s*[:=]\s*\S+/i,
  /\bstatus\s+(?:per|as of|pada)\s+\S*\d/i,
  /\btopics?\b[^.\n]{0,20}["'“”]?\bempty\b/i,
]

/** A platform capability that changed: amending a program is possible (`propose_plan` with `program`). */
const STALE_CLAIM: ReadonlyArray<RegExp> = [
  /\b(?:not|cannot|can't|never|tidak)\b[^.\n]{0,30}\b(?:support|supports|supported|bisa|dapat|mendukung)\b[^.\n]{0,30}\b(?:amend|amending|amendment|editing|edit|mengubah|ubah)\b[^.\n]{0,20}\bprograms?\b/i,
]

/** First lines per file are enough to name the problem; the rest is counted. */
function lineMatches(
  text: string,
  patterns: readonly RegExp[],
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  let fenced = false
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    if (patterns.some((re) => re.test(raw))) out.push({ line: i + 1, text: raw.trim() })
  })
  return out
}

const memoryRef = (m: MemoryFact): string =>
  m.agentId === null ? `workspace memory ${m.path}` : `memory file ${m.path}`

const OWN_PLACE = (m: MemoryFact): string => (m.agentId === null ? 'workspace memory' : 'memory')

function memoryPlaceholders(m: MemoryFact): ConsistencyFinding[] {
  const hits = lineMatches(m.text, PLACEHOLDER)
  if (hits.length === 0) return []
  const first = hits[0] as { line: number; text: string }
  return [
    finding({
      kind: 'memory-placeholder',
      severity: 'medium',
      agentId: m.agentId,
      subject: m.path,
      explanation: `The ${memoryRef(m)} line ${first.line} still holds a placeholder ("${clip(first.text, 90)}")${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}: an agent would take it as a real value.`,
      fix: `Open ${m.path} in the ${OWN_PLACE(m)} tab and fill in the real value on line ${first.line}, or delete the line.`,
      refs: [m.path],
      key: `${m.path}:${fingerprintOf(hits.map((h) => h.text).join('\n'))}`,
      memoryPath: m.path,
      line: first.line,
    }),
  ]
}

function memorySystemState(m: MemoryFact): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const state = lineMatches(m.text, SYSTEM_STATE)
  if (state.length > 0) {
    const first = state[0] as { line: number; text: string }
    out.push(
      finding({
        kind: 'memory-system-state',
        severity: 'low',
        agentId: m.agentId,
        subject: m.path,
        explanation: `The ${memoryRef(m)} line ${first.line} states system state the server knows live ("${clip(first.text, 90)}")${state.length > 1 ? ` (${state.length} lines)` : ''}: it goes stale and then misleads.`,
        fix: `Remove ${state.length > 1 ? 'those lines' : `line ${first.line}`} from ${m.path}; check live with channel_status / phone_list_devices instead.`,
        refs: [m.path],
        key: `${m.path}:state:${fingerprintOf(state.map((h) => h.text).join('\n'))}`,
        memoryPath: m.path,
        line: first.line,
      }),
    )
  }
  const claims = lineMatches(m.text, STALE_CLAIM)
  if (claims.length > 0) {
    const first = claims[0] as { line: number; text: string }
    out.push(
      finding({
        kind: 'memory-system-state',
        severity: 'medium',
        agentId: m.agentId,
        subject: m.path,
        explanation: `The ${memoryRef(m)} line ${first.line} says programs cannot be amended ("${clip(first.text, 90)}"), but an agent can: propose_plan with the "program" field proposes a change to an existing program.`,
        fix: `Delete line ${first.line} of ${m.path}, or rewrite it: amend a program with propose_plan and its "program" id.`,
        refs: [m.path],
        key: `${m.path}:claim:${fingerprintOf(first.text)}`,
        memoryPath: m.path,
        line: first.line,
      }),
    )
  }
  return out
}

const TOOL_TOKEN = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*)_([a-z][a-z0-9_]*|\*)(?![a-z0-9_*-])/g

function memoryDeadRefs(m: MemoryFact, input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  for (const d of deadIdsIn(m.text, input.knownIds)) {
    out.push(
      finding({
        kind: 'memory-dead-ref',
        severity: 'medium',
        agentId: m.agentId,
        subject: m.path,
        explanation: `The ${memoryRef(m)} line ${d.line} names a ${d.word} id (${d.id}) that no longer exists (deleted or never created).`,
        fix: `Remove or replace ${d.id} on line ${d.line} of ${m.path}; list the real ones with the programs / decisions tools.`,
        refs: [m.path, d.id],
        key: `${m.path}:${d.id}`,
        memoryPath: m.path,
        line: d.line,
      }),
    )
  }
  if (m.agentId === null) return out
  const tools = input.tools.get(m.agentId)
  if (tools === undefined) return out
  const available = new Set(tools.available)
  const prefixes = new Set(tools.prefixes)
  const reported = new Set<string>()
  m.text.split('\n').forEach((raw, i) => {
    for (const t of raw.matchAll(TOOL_TOKEN)) {
      const prefix = t[1] as string
      const name = t[2] as string
      const token = t[0]
      if (reported.has(token) || available.has(token)) continue
      const wildcard = name === '*'
      // a numbered slug (`phone-2`) is how a second connection of one kind is named; a name
      // under a prefix the agent has now, that it is not offered, is a tool that went away
      const numbered = /^[a-z][a-z0-9]*-\d+$/.test(prefix) && !prefixes.has(prefix)
      const former = prefixes.has(prefix) && !wildcard && name.length >= 3
      if (!numbered && !former) continue
      reported.add(token)
      out.push(
        finding({
          kind: 'memory-dead-ref',
          severity: 'medium',
          agentId: m.agentId,
          subject: m.path,
          explanation: `The ${memoryRef(m)} line ${i + 1} names the tool ${token}, which the agent is not offered any more${numbered ? ` (no connection with the prefix "${prefix}" exists now)` : ''}.`,
          fix: `Edit line ${i + 1} of ${m.path}: replace ${token} with a tool the agent has now (${
            [...prefixes]
              .slice(0, 4)
              .map((p) => `${p}_*`)
              .join(', ') || 'see the Connectors tab'
          }), or delete the line.`,
          refs: [m.path],
          key: `${m.path}:tool:${token}`,
          memoryPath: m.path,
          line: i + 1,
        }),
      )
    }
  })
  return out
}

const NAME_NOISE = new Set([
  'program',
  'programs',
  'rules',
  'rule',
  'notes',
  'note',
  'draft',
  'old',
  'new',
  'backup',
  'final',
  'copy',
  'update',
  'updated',
  'summary',
  'md',
])

/** A file's name as a topic: no extension, dates or suffixes like `-program` / `-rules`. */
export function topicOfName(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(/\.[a-z0-9]+$/i, '')
  const tokens = base
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\b\d{6,8}\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== '' && !NAME_NOISE.has(t) && !/^v\d+$/.test(t) && !/^\d+$/.test(t))
  return tokens.sort().join('-')
}

const dirOf = (path: string): string => path.split('/').slice(0, -1).join('/')

function memoryDuplicates(files: readonly MemoryFact[]): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const words = new Map(files.map((f) => [f.path, topicWords(f.text)] as const))
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = files[i] as MemoryFact
      const b = files[j] as MemoryFact
      const ta = topicOfName(a.path)
      const sameName = ta !== '' && ta === topicOfName(b.path) && dirOf(a.path) === dirOf(b.path)
      const wa = words.get(a.path) as Set<string>
      const wb = words.get(b.path) as Set<string>
      const { sim } = jaccard(wa, wb)
      const sameContent =
        wa.size >= CONSISTENCY.memoryMinWords &&
        wb.size >= CONSISTENCY.memoryMinWords &&
        sim >= CONSISTENCY.memorySimilarity
      if (!sameName && !sameContent) continue
      // the stale one is the file nobody touched for longer
      const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a]
      const paths = [a.path, b.path].sort()
      out.push(
        finding({
          kind: 'memory-duplicate-topic',
          severity: 'medium',
          agentId: a.agentId,
          subject: older.path,
          explanation: `${a.agentId === null ? 'Workspace memory' : 'Memory'} has two files on one topic: ${a.path} and ${b.path} (${sameName ? 'almost the same name' : `${Math.round(sim * 100)}% the same words`}). An agent reads both and cannot tell which is current.`,
          fix: `Merge what is still true of ${older.path} into ${newer.path} (the newer one), then delete ${older.path}.`,
          refs: paths,
          key: paths.join('+'),
          memoryPath: older.path,
        }),
      )
    }
  }
  return out
}

function memoryFindings(input: ConsistencyInput): ConsistencyFinding[] {
  const out: ConsistencyFinding[] = []
  const groups = new Map<string, MemoryFact[]>()
  for (const m of input.memory) {
    groups.set(m.agentId ?? '', [...(groups.get(m.agentId ?? '') ?? []), m])
    out.push(...memoryPlaceholders(m), ...memorySystemState(m), ...memoryDeadRefs(m, input))
  }
  for (const files of groups.values()) out.push(...memoryDuplicates(files))
  return out
}

// --- all ----------------------------------------------------------------------------------------

const RANK = { high: 0, medium: 1, low: 2 } as const

/** Every finding of the facts: one per fingerprint, high severity first. */
export function detectConsistency(input: ConsistencyInput): ConsistencyFinding[] {
  const all = [
    ...programDuplicates(input),
    ...programNeeds(input),
    ...programDeadRefs(input),
    ...orderVsNotes(input),
    ...routineDuplicates(input),
    ...decisionFindings(input),
    ...connectionFindings(input),
    ...memoryFindings(input),
  ]
  const seen = new Set<string>()
  const out: ConsistencyFinding[] = []
  for (const f of all) {
    if (seen.has(f.fingerprint)) continue
    seen.add(f.fingerprint)
    out.push(f)
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}
