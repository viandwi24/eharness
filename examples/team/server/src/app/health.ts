/**
 * Agent health: gathers the facts the detectors need from the stores the server already has, runs
 * them (`domain/health.ts`), marks what an owner dismissed, and raises one bell notification per new
 * high-severity finding. The periodic job (`runHealthJob`) also hands the denials of program runs
 * to `app/authority-suggestions.ts`.
 */
import { conflict, notFound } from '../domain/errors.ts'
import {
  type CallEvent,
  type DriftFact,
  detectAll,
  FINDING_KINDS,
  type Finding,
  type FindingKind,
  type FindingSeverity,
  HEALTH,
  type NoticeEvent,
  type PendingApproval,
  type ProgramRunFact,
  type ToolEvent,
} from '../domain/health.ts'
import { parseProgramSession } from '../domain/programs.ts'
import { parseChatSession } from '../domain/threads.ts'
import { willRetryText } from '../domain/turn-retry.ts'
import { postNotice } from './briefings.ts'
import { type ConsistencyFinding, consistencyFindings } from './consistency.ts'
import { hygieneFindings } from './order-care.ts'
import type { Deps } from './ports.ts'

export interface HealthFinding extends Finding {
  agentName: string | null
  programName: string | null
  dismissed: boolean
  dismissedAt: number | null
}

export interface HealthFacts {
  tools: ToolEvent[]
  calls: CallEvent[]
  notices: NoticeEvent[]
  pending: PendingApproval[]
  runs: ProgramRunFact[]
  drifts: DriftFact[]
}

/** Agent, program and link of a session, resolved once per scan. */
function sessionResolver(deps: Deps, callAgents: ReadonlyMap<string, string>) {
  const cache = new Map<
    string,
    { agentId: string | null; programId: string | null; link: string | null }
  >()
  return (sessionId: string) => {
    const hit = cache.get(sessionId)
    if (hit !== undefined) return hit
    let agentId: string | null = null
    let programId: string | null = null
    let link: string | null = null
    const task = deps.tasks.getBySession(sessionId)
    if (task !== undefined) {
      agentId = task.agentId
      link = `/tasks/${task.id}`
    }
    const run = parseProgramSession(sessionId)
    if (run !== undefined) {
      programId = run.programId
      const program = deps.programs.get(run.programId)
      agentId = program?.agentId ?? agentId
      link ??= `/programs/${run.programId}`
    }
    const chat = parseChatSession(sessionId)
    if (chat !== undefined) {
      agentId = chat.agentId
      link = `/a/${chat.agentId}?t=${encodeURIComponent(chat.threadSession)}`
    }
    agentId ??= callAgents.get(sessionId) ?? null
    const out = { agentId, programId, link }
    cache.set(sessionId, out)
    return out
  }
}

/** The facts of the last 24 hours (or `windowMs`). */
export async function gatherFacts(
  deps: Deps,
  now: number,
  windowMs: number = HEALTH.windowMs,
): Promise<HealthFacts> {
  const since = now - windowMs
  const storedCalls = deps.health.calls(since)
  const callAgents = new Map<string, string>()
  for (const c of storedCalls) {
    if (c.sessionId !== null && c.agentId !== null) callAgents.set(c.sessionId, c.agentId)
  }
  const resolve = sessionResolver(deps, callAgents)
  const scanned = deps.health.scanMessages(since)

  const tools = scanned.tools.map((t): ToolEvent => ({ ...t, ...resolve(t.sessionId) }))
  const notices = scanned.notices.map((n): NoticeEvent => {
    const r = resolve(n.sessionId)
    return { ...n, agentId: r.agentId, link: r.link }
  })
  const calls = storedCalls.map(
    (c): CallEvent => ({
      id: c.id,
      sessionId: c.sessionId,
      agentId: c.agentId,
      link: c.sessionId === null ? null : resolve(c.sessionId).link,
      at: c.at,
      kind: c.kind,
      status: c.status,
      inputTokens: c.inputTokens,
      errorName: c.errorName,
      errorMessage: c.errorMessage,
    }),
  )

  let pending: PendingApproval[] = []
  try {
    pending = (await deps.team.approvals()).map(
      (a): PendingApproval => ({
        id: a.id,
        sessionId: a.sessionId,
        agentId: a.agentId,
        link: resolve(a.sessionId).link,
        toolName: a.toolName,
        // an approval waits at the end of its session: the newest message is the one that asked
        since: deps.health.lastMessageAt(a.sessionId) ?? now,
      }),
    )
  } catch {
    // approvals are one source among several: the rest of the scan still runs
  }

  const runs: ProgramRunFact[] = []
  for (const program of deps.programs.list({})) {
    for (const task of deps.tasks.ofProgram(program.id, 50)) {
      const at = task.endedAt ?? task.startedAt
      if (at < since || task.status === 'running') continue
      runs.push({
        programId: program.id,
        programName: program.name,
        agentId: program.agentId,
        sessionId: task.sessionId,
        taskId: task.id,
        link: `/tasks/${task.id}`,
        at,
        status: task.status,
        reportStatus: task.report?.status ?? null,
        summary: task.report?.summary ?? task.summary,
      })
    }
  }
  let drifts: DriftFact[] = []
  try {
    drifts = deps.sessionTools
      .drifts()
      .filter((d) => d.at >= since)
      .map((d) => ({ ...d, link: resolve(d.sessionId).link }))
  } catch {
    // one source among several
  }
  return { tools, calls, notices, pending, runs, drifts }
}

/** Findings of the current facts, dismissed ones marked. */
export function findingsOf(
  deps: Deps,
  facts: HealthFacts,
  now: number,
  extra: readonly Finding[] = [],
): HealthFinding[] {
  const dismissed = deps.health.dismissed()
  const agents = new Map(deps.agents.list({ includeArchived: true }).map((a) => [a.id, a.name]))
  return [...detectAll({ now, ...facts }), ...extra].map((f) => {
    const at = dismissed.get(f.fingerprint)
    return {
      ...f,
      agentName: f.agentId === null ? null : (agents.get(f.agentId) ?? null),
      programName: f.programId === null ? null : (deps.programs.get(f.programId)?.name ?? null),
      dismissed: at !== undefined,
      dismissedAt: at ?? null,
    }
  })
}

const PROGRAM_KINDS = new Set(['program-duplicate', 'program-needs-tool', 'program-dead-ref'])

/** Consistency findings as findings of the Health page (kind `consistency`). */
export function consistencyAsFindings(
  deps: Deps,
  list: readonly ConsistencyFinding[],
  now: number,
): Finding[] {
  return list.map((c): Finding => {
    const programId = PROGRAM_KINDS.has(c.kind) ? (c.refs[0] ?? null) : null
    let link: string | null = null
    if (programId !== null) link = `/programs/${programId}`
    else if (c.kind.startsWith('decision-')) link = '/decisions'
    else if (c.kind === 'order-duplicates-note') {
      const slug = c.agentId === null ? undefined : deps.agents.get(c.agentId)?.slug
      link = slug === undefined ? null : `/a/${slug}?tab=heartbeat`
    } else if (c.kind === 'routine-duplicate') link = '/routines'
    else if (c.kind === 'connection-used-but-broken') link = '/connectors'
    return {
      fingerprint: c.fingerprint,
      kind: 'consistency',
      severity: c.severity,
      agentId: c.agentId,
      sessionId: null,
      programId,
      link,
      firstSeen: now,
      lastSeen: now,
      count: 1,
      explanation: c.explanation,
      fix: c.fix,
      consistency: {
        kind: c.kind,
        memoryPath: c.memoryPath ?? null,
        line: c.line ?? null,
        refs: c.refs,
      },
    }
  })
}

/**
 * The consistency scan is a read of many stores: the Health page (polled every minute) reuses the
 * last result for a few minutes; the 10-minute job always rescans and refreshes it.
 */
const CONSISTENCY_TTL_MS = 5 * 60_000
const consistencyCache = new WeakMap<object, { at: number; findings: Finding[] }>()

async function consistencyOf(deps: Deps, now: number, fresh: boolean): Promise<Finding[]> {
  const hit = consistencyCache.get(deps)
  if (!fresh && hit !== undefined && now - hit.at < CONSISTENCY_TTL_MS) return hit.findings
  try {
    const findings = consistencyAsFindings(deps, await consistencyFindings(deps, { now }), now)
    consistencyCache.set(deps, { at: now, findings })
    return findings
  } catch (error) {
    console.warn(`team: consistency scan failed: ${String(error)}`)
    return hit?.findings ?? []
  }
}

export interface HealthQuery {
  agentId?: string | undefined
  severity?: FindingSeverity | undefined
  kind?: FindingKind | undefined
  includeDismissed?: boolean | undefined
}

/** The Health page: findings of the last 24 hours, newest problems first within a severity. */
/**
 * A failure that waits for its automatic retry says when, and is not high (no bell yet: the owner
 * need not act; the retry service rings once if the last attempt fails).
 */
function withRetries(deps: Deps, findings: HealthFinding[]): HealthFinding[] {
  const waiting = deps.turnRetry?.waiting() ?? new Map()
  if (waiting.size === 0) return findings
  return findings.map((f) => {
    const retry = f.sessionId === null ? undefined : waiting.get(f.sessionId)
    return retry === undefined
      ? f
      : {
          ...f,
          explanation: `${f.explanation} (${willRetryText(retry)})`,
          severity: f.severity === 'high' ? 'medium' : f.severity,
        }
  })
}

export async function listHealth(
  deps: Deps,
  query: HealthQuery = {},
): Promise<{ findings: HealthFinding[]; open: number; scannedAt: number }> {
  const now = deps.clock.now()
  const all = withRetries(
    deps,
    findingsOf(deps, await gatherFacts(deps, now), now, [
      ...(await hygieneFindings(deps, now)),
      ...(await consistencyOf(deps, now, false)),
    ]),
  )
  const agentId =
    query.agentId === undefined
      ? undefined
      : (deps.agents.get(query.agentId) ?? deps.agents.getBySlug(query.agentId))?.id
  const findings = all.filter(
    (f) =>
      (query.includeDismissed === true || !f.dismissed) &&
      (query.agentId === undefined || f.agentId === (agentId ?? query.agentId)) &&
      (query.severity === undefined || f.severity === query.severity) &&
      (query.kind === undefined || f.kind === query.kind),
  )
  return { findings, open: all.filter((f) => !f.dismissed).length, scannedAt: now }
}

/** An owner dismisses a finding: it stays out of the list and is never notified. */
export function dismissFinding(deps: Deps, fingerprint: string): void {
  if (fingerprint.trim() === '' || fingerprint.length > 300) throw notFound('finding', fingerprint)
  deps.health.dismiss(fingerprint, deps.clock.now())
}

export function restoreFinding(deps: Deps, fingerprint: string): void {
  if (!deps.health.restore(fingerprint)) {
    throw conflict('the finding is not dismissed', 'NOT_DISMISSED')
  }
}

export const isFindingKind = (v: string): v is FindingKind =>
  (FINDING_KINDS as readonly string[]).includes(v)

/** New high-severity findings raise one bell notice each (the key is the fingerprint: once). */
export function notifyFindings(
  deps: Deps,
  findings: readonly HealthFinding[],
  now: number,
): number {
  let n = 0
  for (const f of findings) {
    if (f.severity !== 'high' || f.dismissed) continue
    const posted = postNotice(deps, {
      key: `health:${f.fingerprint}`,
      title: `Health: ${f.explanation}`.slice(0, 160),
      body: f.fix,
      link: '/health',
      agentId: f.agentId,
      at: now,
    })
    if (posted) n++
  }
  return n
}

export interface HealthJobReport {
  findings: number
  notified: number
}

/**
 * Every 10 minutes: scan the recent window and raise the bell for new high findings. Never throws.
 * `suggest` (the authority suggestions of programs) gets the same facts.
 */
export async function runHealthJob(
  deps: Deps,
  hooks: { suggest?: (deps: Deps, tools: ToolEvent[], now: number) => Promise<unknown> } = {},
): Promise<HealthJobReport> {
  const now = deps.clock.now()
  try {
    const facts = await gatherFacts(deps, now)
    const findings = withRetries(
      deps,
      findingsOf(deps, facts, now, [
        ...(await hygieneFindings(deps, now)),
        ...(await consistencyOf(deps, now, true)),
      ]),
    )
    const notified = notifyFindings(deps, findings, now)
    if (hooks.suggest !== undefined) {
      try {
        await hooks.suggest(deps, facts.tools, now)
      } catch (error) {
        console.warn(`team: authority suggestions failed: ${String(error)}`)
      }
    }
    return { findings: findings.filter((f) => !f.dismissed).length, notified }
  } catch (error) {
    console.warn(`team: health scan failed: ${String(error)}`)
    return { findings: 0, notified: 0 }
  }
}

/**
 * For the daily digest: the open findings of the last day as plain facts (no notification, no
 * writes). The heartbeat digest can list `explanation` and `fix` of the high ones.
 */
export async function healthSummary(deps: Deps): Promise<{ high: HealthFinding[]; open: number }> {
  const { findings } = await listHealth(deps)
  return { high: findings.filter((f) => f.severity === 'high'), open: findings.length }
}
