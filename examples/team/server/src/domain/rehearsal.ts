/**
 * Rehearsal (test run) of a program (docs/plans/P40-team-autonomous-operations.md, phase K). Pure.
 *
 * A rehearsal runs a program on sample data in a safe mode, so the client sees what it would do
 * before activating it:
 *
 *   - its own session `rehearsal:<programId>:<ts>` (never a task, so not in the run history, the
 *     board, the digest or the heartbeat);
 *   - library writes land in a scratch overlay, the real library is never modified;
 *   - tools of external connectors that write or destroy (MCP, OpenAPI, third party) are simulated:
 *     the model reads `SIMULATED: would call <tool> with <input>`, the call is recorded;
 *   - decisions the run would raise (`escalate`, `request_authority`, `propose_plan`) are recorded
 *     as "would ask": nothing enters the real Decision Center and the run does not park;
 *   - a separate small budget cap; nothing counts toward the program's own budget scopes.
 *
 * A saved rehearsal is a test case of the program: its sample inputs plus expectations. Reads see
 * the real library underneath the overlay unless the sample says `reads: 'sample'` (then the run
 * sees only the sample files).
 */
import type { DeliverableResult } from './deliverables.ts'
import { invalid } from './errors.ts'
import type { Program } from './programs.ts'
import type { TaskReport } from './tasks.ts'

// --- session ids --------------------------------------------------------------------------------

export const rehearsalSessionId = (programId: string, ts: number): string =>
  `rehearsal:${programId}:${ts}`

export const isRehearsalSession = (sessionId: string): boolean => sessionId.startsWith('rehearsal:')

export function parseRehearsalSession(
  sessionId: string,
): { programId: string; runAt: number } | undefined {
  const m = /^rehearsal:([^:]+):(\d+)$/.exec(sessionId)
  return m === null ? undefined : { programId: m[1] as string, runAt: Number(m[2]) }
}

// --- limits -------------------------------------------------------------------------------------

/** Default and largest budget of one rehearsal (USD): small on purpose. */
export const REHEARSAL_DEFAULT_BUDGET_USD = 0.5
export const REHEARSAL_MAX_BUDGET_USD = 5
/** Rehearsals running at the same time, over the whole workspace. */
export const MAX_RUNNING_REHEARSALS = 3
/** Rehearsals kept per program (older ones are deleted when a new one starts). */
export const KEEP_REHEARSALS = 50
export const MAX_TEST_CASES = 50
export const MAX_SAMPLE_COPY = 50
export const MAX_SAMPLE_FILES = 20
export const MAX_SAMPLE_FILE_CHARS = 500_000
export const MAX_SAMPLE_TOTAL_CHARS = 2_000_000
/** Copied from the library into the overlay: files and bytes at most. */
export const MAX_COPIED_FILES = 300
export const MAX_COPIED_BYTES = 5_000_000
/** What a stored result keeps of one produced file, and of all of them. */
export const MAX_RESULT_FILE_BYTES = 200_000
export const MAX_RESULT_TOTAL_BYTES = 2_000_000
export const MAX_RESULT_FILES = 100
export const MAX_NAME_CHARS = 120

// --- sample -------------------------------------------------------------------------------------

/** A work-queue item draft for a worker program: what a client would queue. */
export interface SampleTask {
  title: string
  brief: string
  inputs: string[]
}

export interface RehearsalSample {
  /** Library files or directories (`/library/data/`, `/library/data/**`) copied into the overlay. */
  copy: string[]
  /** Files the client attached (pasted or uploaded text): written into the overlay. */
  files: Array<{ path: string; content: string }>
  /** Worker programs: the task the rehearsal works on. */
  task: SampleTask | null
  /** `library`: reads see the real library under the overlay. `sample`: only the sample files. */
  reads: 'library' | 'sample'
}

export const EMPTY_SAMPLE: RehearsalSample = { copy: [], files: [], task: null, reads: 'library' }

const libraryPath = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\n\r\0]/.test(value)) {
    throw invalid(
      `${what}: "${String(value)}" must be a library path starting with /`,
      'INVALID_SAMPLE',
    )
  }
  if (value.split('/').includes('..')) {
    throw invalid(`${what}: "${value}" must not contain ..`, 'INVALID_SAMPLE')
  }
  if (value.length > 500) throw invalid(`${what}: path is too long`, 'INVALID_SAMPLE')
  return value
}

/** Validate and normalise a sample from an API body or a stored row. */
export function normalizeSample(raw: Partial<RehearsalSample> | null | undefined): RehearsalSample {
  if (raw == null) return { ...EMPTY_SAMPLE, copy: [], files: [] }
  const copy = [...new Set((raw.copy ?? []).map((p) => libraryPath(p, 'copy')))]
  if (copy.length > MAX_SAMPLE_COPY) {
    throw invalid(`copy: at most ${MAX_SAMPLE_COPY} paths`, 'INVALID_SAMPLE')
  }
  const files = (raw.files ?? []).map((f) => {
    const path = libraryPath(f?.path, 'files')
    if (typeof f.content !== 'string') {
      throw invalid(`files: "${path}" needs text content`, 'INVALID_SAMPLE')
    }
    if (f.content.length > MAX_SAMPLE_FILE_CHARS) {
      throw invalid(
        `files: "${path}" is over ${MAX_SAMPLE_FILE_CHARS} characters`,
        'INVALID_SAMPLE',
      )
    }
    return { path, content: f.content }
  })
  if (files.length > MAX_SAMPLE_FILES) {
    throw invalid(`files: at most ${MAX_SAMPLE_FILES} files`, 'INVALID_SAMPLE')
  }
  if (files.reduce((n, f) => n + f.content.length, 0) > MAX_SAMPLE_TOTAL_CHARS) {
    throw invalid(`files: over ${MAX_SAMPLE_TOTAL_CHARS} characters in total`, 'INVALID_SAMPLE')
  }
  let task: SampleTask | null = null
  if (raw.task != null) {
    const title = typeof raw.task.title === 'string' ? raw.task.title.trim() : ''
    if (title === '' || title.length > 200) {
      throw invalid('task.title is required (at most 200 characters)', 'INVALID_SAMPLE')
    }
    const brief = typeof raw.task.brief === 'string' ? raw.task.brief : ''
    if (brief.length > 20_000) throw invalid('task.brief is too long', 'INVALID_SAMPLE')
    const inputs = [...new Set((raw.task.inputs ?? []).map((p) => libraryPath(p, 'task.inputs')))]
    task = { title, brief, inputs }
  }
  const reads = raw.reads ?? 'library'
  if (reads !== 'library' && reads !== 'sample') {
    throw invalid('reads must be library or sample', 'INVALID_SAMPLE')
  }
  return { copy, files, task, reads }
}

/** A copy entry as a directory prefix (`/a/b/`, `/a/b/**`) or a single file. */
export function copyTarget(entry: string): { kind: 'dir' | 'file'; path: string } {
  if (entry.endsWith('/**')) return { kind: 'dir', path: entry.slice(0, -2) }
  if (entry.endsWith('/')) return { kind: 'dir', path: entry }
  return { kind: 'file', path: entry }
}

// --- records ------------------------------------------------------------------------------------

/** A call of an external write tool that was not made. */
export interface SimulatedAction {
  tool: string
  input: unknown
  at: number
}

export const WOULD_ASK_KINDS = ['escalation', 'amendment', 'proposal', 'report'] as const
export type WouldAskKind = (typeof WOULD_ASK_KINDS)[number]

/** A decision the run would have raised in the Decision Center. */
export interface WouldAsk {
  kind: WouldAskKind
  title: string
  question: string
  details?: string | undefined
  options?: string[] | undefined
  at: number
}

/** A file the rehearsal produced (new or changed against the sample). */
export interface RehearsalFile {
  path: string
  size: number
  mediaType: string | null
  /** Text of a text file (up to the result caps); null for a binary file or one over the caps. */
  text: string | null
  /** Base64 bytes of a small binary file. */
  base64: string | null
  /** The content is not stored (over the caps). */
  truncated: boolean
}

export const REHEARSAL_STATUSES = ['running', 'done', 'failed'] as const
export type RehearsalStatus = (typeof REHEARSAL_STATUSES)[number]

export interface Rehearsal {
  id: string
  programId: string
  /** The program version the rehearsal ran against. */
  programVersion: number
  /** What the program was when it ran (`programFingerprint`): an edit that matters changes it. */
  programFingerprint: string
  sessionId: string
  /** The test case this run belongs to; null for a manual rehearsal. */
  testId: string | null
  status: RehearsalStatus
  /** How the turn ended (`complete`, `error`, `cost-cap`, ...). */
  stop: string | null
  /** Why a failed rehearsal failed (not the report: a report that says `failed` is `done` here). */
  error: string | null
  sample: RehearsalSample
  budgetUsd: number
  startedAt: number
  endedAt: number | null
  report: TaskReport | null
  /** The deliverable checks against the overlay; null when the program has none. */
  deliverables: DeliverableResult | null
  simulated: SimulatedAction[]
  wouldAsk: WouldAsk[]
  /** Every tool the run called (simulated, refused or real), in order, with repeats. */
  toolsCalled: string[]
  /** Files produced (new or changed against the sample), from the overlay. */
  files: RehearsalFile[]
  /** Library files the run deleted (they exist in the real library). */
  deleted: string[]
  costUsd: number
}

export const MAX_RECORDED_ACTIONS = 200

// --- simulation ---------------------------------------------------------------------------------

/** Connectors whose tools run for real in a rehearsal (their writes go to the overlay or are reads). */
export const REHEARSAL_INTERNAL_CONNECTORS: readonly string[] = [
  'files',
  'memory',
  'planning',
  'web',
  'ask',
  'bigdata',
]

/** Tool risk (spec 11 §3.2) of the calls a rehearsal simulates. */
export function isSimulatedCall(call: {
  connectorId: string | undefined
  risk: string | undefined
  /** The kind of the connector capability of the tool (`read`, `write`, `destructive`), when known. */
  kind?: string | undefined
}): boolean {
  // not from a connector: the app's own tools (decisions, work queue) handle a rehearsal themselves
  if (call.connectorId === undefined) return false
  if (REHEARSAL_INTERNAL_CONNECTORS.includes(call.connectorId)) return false
  // reads run for real (a rehearsal on live data is still a read); a tool with a risk that says
  // write, external or destructive is simulated, an MCP read-only hint never lowers it (D7)
  if (call.risk === 'read') return false
  if (call.risk === undefined && call.kind === 'read') return false
  // an unknown risk and kind of an external tool is treated as a write: never call what we cannot classify
  return true
}

const PREVIEW_CHARS = 600

export function previewInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input) ?? String(input)
  } catch {
    text = String(input)
  }
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS)}... (${text.length} chars)`
    : text
}

/** What the model reads instead of the result of a simulated call. */
export const simulatedText = (tool: string, input: unknown): string =>
  `SIMULATED: would call ${tool} with ${previewInput(input)}. This is a rehearsal: the call was not made and nothing outside the rehearsal changed. Treat it as done, carry on, and say in your report that it was simulated.`

export const SIMULATED_ESCALATION_TEXT =
  'SIMULATED: this decision is recorded as "would ask" and was not sent to the client. This is a rehearsal: carry on as if the client approved the safest option, and say in your report what you would have asked.'

/** The block added to the run prompt of a rehearsal. */
export const REHEARSAL_NOTE = [
  '## This is a rehearsal (test run)',
  'You are running on sample data so the client can see what you would do before the program is',
  'activated. Work exactly as in a real run. The differences: files you write go to a scratch area',
  'and the real library is untouched; calls to external systems that would change something are',
  'simulated (the tool result says SIMULATED); a decision you would raise is only recorded.',
  'Do not skip steps because of this, and say in your report what was simulated.',
].join('\n')

export function simulatedTaskText(kind: 'create' | 'update', detail: string): string {
  return `SIMULATED: would ${kind === 'create' ? 'queue a task' : 'change a task'} (${detail}). This is a rehearsal: the real board was not touched.`
}

// --- test cases ---------------------------------------------------------------------------------

export interface TestExpect {
  /** Every deliverable of the program must pass (vacuous when the program has none). */
  deliverablesPass: boolean
  /** Tool names the run must not call; a trailing `*` is a prefix (`github_*`). */
  mustNotCall: string[]
  /** The report must say this; null = any status. */
  reportStatus: TaskReport['status'] | null
}

export const DEFAULT_EXPECT: TestExpect = {
  deliverablesPass: true,
  mustNotCall: [],
  reportStatus: null,
}

const REPORT_STATUS_VALUES = ['done', 'partial', 'failed', 'needs_decision'] as const

export function normalizeExpect(raw: Partial<TestExpect> | null | undefined): TestExpect {
  const mustNotCall = [
    ...new Set((raw?.mustNotCall ?? []).map((t) => String(t).trim()).filter(Boolean)),
  ]
  if (mustNotCall.length > 50) throw invalid('mustNotCall: at most 50 tools', 'INVALID_TEST')
  for (const tool of mustNotCall) {
    if (!/^[A-Za-z0-9_.:*-]{1,100}$/.test(tool)) {
      throw invalid(`mustNotCall: "${tool}" is not a tool name`, 'INVALID_TEST')
    }
  }
  const status = raw?.reportStatus ?? null
  if (status !== null && !(REPORT_STATUS_VALUES as readonly string[]).includes(status)) {
    throw invalid(
      `reportStatus must be one of ${REPORT_STATUS_VALUES.join(', ')} or null`,
      'INVALID_TEST',
    )
  }
  return {
    deliverablesPass: raw?.deliverablesPass ?? DEFAULT_EXPECT.deliverablesPass,
    mustNotCall,
    reportStatus: status,
  }
}

export function checkTestName(name: unknown): string {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '' || text.length > MAX_NAME_CHARS) {
    throw invalid(`name is required (at most ${MAX_NAME_CHARS} characters)`, 'INVALID_TEST')
  }
  return text
}

export const TEST_RESULT_STATUSES = ['running', 'pass', 'fail', 'error'] as const
export type TestResultStatus = (typeof TEST_RESULT_STATUSES)[number]

export interface TestResult {
  status: TestResultStatus
  /** The rehearsal of this result; null while it waits its turn. */
  rehearsalId: string | null
  /** The program as it was when this ran (`programFingerprint`): an edit that matters makes it stale. */
  programFingerprint: string
  /** What was wrong, one line each (`fail`), or the reason a run could not finish (`error`). */
  failures: string[]
  at: number
}

export interface TestCase {
  id: string
  programId: string
  name: string
  sample: RehearsalSample
  expect: TestExpect
  lastResult: TestResult | null
  createdAt: number
  updatedAt: number
}

const matchesTool = (pattern: string, tool: string): boolean =>
  pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern

/** The expectations of a test case against a finished rehearsal: what is wrong (empty = pass). */
export function evaluateExpect(
  expect: TestExpect,
  run: Pick<Rehearsal, 'status' | 'error' | 'report' | 'deliverables' | 'toolsCalled'>,
  hasDeliverables: boolean,
): { status: 'pass' | 'fail' | 'error'; failures: string[] } {
  if (run.status !== 'done') {
    return {
      status: 'error',
      failures: [`the rehearsal did not finish: ${run.error ?? 'unknown error'}`],
    }
  }
  const failures: string[] = []
  if (expect.deliverablesPass && hasDeliverables) {
    if (run.deliverables === null) failures.push('the deliverables were not checked')
    else if (run.deliverables.status !== 'pass') {
      for (const c of run.deliverables.checks.filter((c) => !c.ok)) {
        failures.push(`deliverable ${c.path}: ${c.problems.join('; ')}`)
      }
    }
  }
  for (const pattern of expect.mustNotCall) {
    const hit = run.toolsCalled.find((t) => matchesTool(pattern, t))
    if (hit !== undefined) failures.push(`called ${hit}, which the test forbids`)
  }
  if (expect.reportStatus !== null && run.report?.status !== expect.reportStatus) {
    failures.push(
      `the report status is ${run.report?.status ?? 'missing'}, expected ${expect.reportStatus}`,
    )
  }
  return { status: failures.length === 0 ? 'pass' : 'fail', failures }
}

/**
 * What makes a program behave differently: its agent, name (the `{slug}` token), brief, authority,
 * gates, escalation, forbidden list, worker setting and deliverables. Pausing, resuming, the
 * schedule, the report mode and the budget do not change what a run does, so they do not make a
 * test result stale. A short stable hash (FNV-1a) of that, as hex.
 */
export function programFingerprint(
  p: Pick<
    Program,
    | 'agentId'
    | 'name'
    | 'brief'
    | 'authority'
    | 'gates'
    | 'escalation'
    | 'forbidden'
    | 'worker'
    | 'deliverables'
  >,
): string {
  const text = JSON.stringify([
    p.agentId,
    p.name,
    p.brief,
    p.authority,
    p.gates,
    p.escalation,
    p.forbidden,
    p.worker,
    p.deliverables,
  ])
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A result for a program that changed since: it cannot be trusted any more. */
export const isStale = (r: TestResult | null, fingerprint: string): boolean =>
  r !== null && r.status !== 'running' && r.programFingerprint !== fingerprint

export interface TestSummary {
  total: number
  passing: number
  /** Last result is a fail or an error at the program's current version. */
  failing: number
  /** Not run since the last edit of the program (or never): the result cannot be trusted. */
  stale: number
  running: number
}

export function summarizeTests(cases: readonly TestCase[], fingerprint: string): TestSummary {
  const out: TestSummary = { total: cases.length, passing: 0, failing: 0, stale: 0, running: 0 }
  for (const c of cases) {
    const r = c.lastResult
    if (r === null) out.stale++
    else if (r.status === 'running') out.running++
    else if (r.programFingerprint !== fingerprint) out.stale++
    else if (r.status === 'pass') out.passing++
    else out.failing++
  }
  return out
}

/** A stored result from untrusted JSON, or null. */
export function parseTestResult(value: unknown): TestResult | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!(TEST_RESULT_STATUSES as readonly unknown[]).includes(v.status)) return null
  return {
    status: v.status as TestResultStatus,
    rehearsalId: typeof v.rehearsalId === 'string' ? v.rehearsalId : null,
    programFingerprint: typeof v.programFingerprint === 'string' ? v.programFingerprint : '',
    failures: Array.isArray(v.failures)
      ? v.failures.filter((f): f is string => typeof f === 'string')
      : [],
    at: typeof v.at === 'number' ? v.at : 0,
  }
}
