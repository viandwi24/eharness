/**
 * Programs (docs/plans/P40-team-autonomous-operations.md, decisions D3 and D4): a standing order
 * the client gives an agent once. The program says what to do (`brief`), what the agent may use
 * while doing it (`authority`, enforced by the permission engine, never only by prompt text),
 * what still needs a decision (`gates`, `escalation`), what is off limits (`forbidden`), what it
 * may spend (`budget`), when it runs (`trigger`) and where the result goes (`report`).
 *
 * Each run is a task session `program:<programId>:<runAt>` that follows Execute, Verify, Report
 * and ends with a structured report. Pure: validation, ids, the rules the engine gets, the text of
 * a run and the outcome of a turn.
 */
import { invalid } from './errors.ts'
import type { RoutineSpec } from './routines.ts'
import type { TaskReport, TaskStatus } from './tasks.ts'

export const PROGRAM_STATUSES = ['active', 'paused'] as const
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number]

/** `digest`: a line in the client's daily digest; `task`: the run on the board; `silent`: nothing. */
export const PROGRAM_REPORTS = ['digest', 'task', 'silent'] as const
export type ProgramReportMode = (typeof PROGRAM_REPORTS)[number]

export interface ProgramAuthority {
  /** Tool names or permission rule specifiers (`web_fetch`, `Bash(git status)`, `WebFetch(domain:x.com)`). */
  tools: string[]
  /** Connector or connection ids: every tool of them may be used. */
  connectors: string[]
  /** Library path globs the run may read (`/library/data/**`). */
  read: string[]
  /** Library path globs the run may write (`/library/reports/**`). */
  write: string[]
}

export interface ProgramBudget {
  /** One run stops at this spend (null = no limit). */
  perRunUsd: number | null
  /** All runs of one UTC day stop at this spend (null = no limit). */
  perDayUsd: number | null
}

export type ProgramTrigger = { kind: 'manual' } | { kind: 'schedule'; spec: RoutineSpec }

export interface Program {
  id: string
  agentId: string
  name: string
  /** What to do and the steps to do it. */
  brief: string
  authority: ProgramAuthority
  /** Actions that still need the client's decision (text; the agent asks with `escalate`). */
  gates: string[]
  /** When to stop and ask instead of pressing on. */
  escalation: string
  /** Rules that are denied in every case; they become deny rules of the engine. */
  forbidden: string[]
  budget: ProgramBudget
  trigger: ProgramTrigger
  report: ProgramReportMode
  status: ProgramStatus
  /** `client` (the web / API) or the id of the agent that proposed it. */
  createdBy: string
  createdAt: number
  updatedAt: number
  /** Bumped by every edit; editors send it back to detect a concurrent edit. */
  version: number
}

export interface ProgramDraft {
  agentId: string
  name: string
  brief: string
  authority?: Partial<ProgramAuthority> | undefined
  gates?: string[] | undefined
  escalation?: string | undefined
  forbidden?: string[] | undefined
  budget?: Partial<ProgramBudget> | undefined
  trigger?: ProgramTrigger | undefined
  report?: ProgramReportMode | undefined
  status?: ProgramStatus | undefined
}

export const MAX_BRIEF_CHARS = 20_000
export const MAX_LIST_ITEMS = 100
export const MAX_ITEM_CHARS = 500

export const EMPTY_AUTHORITY: ProgramAuthority = { tools: [], connectors: [], read: [], write: [] }

/** A permission rule: `Tool`, `Tool(specifier)` or an MCP tool name; no spaces before the `(`. */
const RULE = /^[A-Za-z0-9_.:-]+(\([^\n]*\))?$/

function checkList(
  field: string,
  items: readonly string[] | undefined,
  check?: (item: string) => string | undefined,
): void {
  if (items === undefined) return
  if (items.length > MAX_LIST_ITEMS) {
    throw invalid(`${field} has at most ${MAX_LIST_ITEMS} entries`, 'INVALID_PROGRAM')
  }
  for (const item of items) {
    if (item.trim() === '' || item.length > MAX_ITEM_CHARS) {
      throw invalid(`${field} entries must be 1-${MAX_ITEM_CHARS} characters`, 'INVALID_PROGRAM')
    }
    const problem = check?.(item)
    if (problem !== undefined) throw invalid(`${field}: ${problem}`, 'INVALID_PROGRAM')
  }
}

const ruleProblem = (item: string): string | undefined =>
  RULE.test(item.trim()) ? undefined : `"${item}" is not a tool name or a rule like Tool(specifier)`

const globProblem = (item: string): string | undefined => {
  const glob = item.trim()
  if (!glob.startsWith('/')) return `"${item}" must be a library path glob starting with /`
  if (glob.includes('..')) return `"${item}" must not contain ..`
  return undefined
}

const usdProblem = (field: string, value: number | null | undefined): void => {
  if (value == null) return
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw invalid(`${field} must be a positive amount in USD or null`, 'INVALID_PROGRAM')
  }
}

/** Shape checks that need neither the clock nor the cron library. */
export function checkProgramFields(f: {
  name?: string | undefined
  brief?: string | undefined
  authority?: Partial<ProgramAuthority> | undefined
  gates?: string[] | undefined
  escalation?: string | undefined
  forbidden?: string[] | undefined
  budget?: Partial<ProgramBudget> | undefined
  trigger?: ProgramTrigger | undefined
  report?: string | undefined
  status?: string | undefined
}): void {
  if (f.name !== undefined && (f.name.trim() === '' || f.name.length > 120)) {
    throw invalid('name must be 1-120 characters', 'INVALID_PROGRAM')
  }
  if (f.brief !== undefined && (f.brief.trim() === '' || f.brief.length > MAX_BRIEF_CHARS)) {
    throw invalid(`brief must be 1-${MAX_BRIEF_CHARS} characters`, 'INVALID_PROGRAM')
  }
  if (f.escalation !== undefined && f.escalation.length > MAX_BRIEF_CHARS) {
    throw invalid(`escalation must be at most ${MAX_BRIEF_CHARS} characters`, 'INVALID_PROGRAM')
  }
  if (f.report !== undefined && !(PROGRAM_REPORTS as readonly string[]).includes(f.report)) {
    throw invalid(`report must be one of ${PROGRAM_REPORTS.join(', ')}`, 'INVALID_PROGRAM')
  }
  if (f.status !== undefined && !(PROGRAM_STATUSES as readonly string[]).includes(f.status)) {
    throw invalid(`status must be one of ${PROGRAM_STATUSES.join(', ')}`, 'INVALID_PROGRAM')
  }
  checkList('authority.tools', f.authority?.tools, ruleProblem)
  checkList('authority.connectors', f.authority?.connectors)
  checkList('authority.read', f.authority?.read, globProblem)
  checkList('authority.write', f.authority?.write, globProblem)
  checkList('gates', f.gates)
  checkList('forbidden', f.forbidden, ruleProblem)
  usdProblem('budget.perRunUsd', f.budget?.perRunUsd)
  usdProblem('budget.perDayUsd', f.budget?.perDayUsd)
  if (f.trigger !== undefined && f.trigger.kind !== 'manual' && f.trigger.kind !== 'schedule') {
    throw invalid('trigger.kind must be manual or schedule', 'INVALID_PROGRAM')
  }
}

/** Trimmed, de-duplicated list. */
export const cleanList = (items: readonly string[]): string[] => [
  ...new Set(items.map((i) => i.trim()).filter((i) => i !== '')),
]

export function normalizeAuthority(a: Partial<ProgramAuthority> | undefined): ProgramAuthority {
  return {
    tools: cleanList(a?.tools ?? []),
    connectors: cleanList(a?.connectors ?? []),
    read: cleanList(a?.read ?? []),
    write: cleanList(a?.write ?? []),
  }
}

// --- sessions ----------------------------------------------------------------------------------

/** Session of one run: `program:<programId>:<runAt>`. */
export const programSessionId = (programId: string, runAt: number): string =>
  `program:${programId}:${runAt}`

/** `program:<id>:<runAt>` to its parts. */
export function parseProgramSession(
  sessionId: string,
): { programId: string; runAt: number } | undefined {
  const m = /^program:([^:]+):(\d+)$/.exec(sessionId)
  return m === null ? undefined : { programId: m[1] as string, runAt: Number(m[2]) }
}

/** UTC calendar day of an instant: the day scope of the daily budget. */
export const programDay = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** Budget ledger scope of one run. */
export const programRunScope = (sessionId: string): string => `program-run:${sessionId}`
/** Budget ledger scope of one program and day: `program:<id>:<YYYY-MM-DD>`. */
export const programDayScope = (programId: string, at: number): string =>
  `program:${programId}:${programDay(at)}`

// --- authority ---------------------------------------------------------------------------------

/**
 * Tools every program run may use without naming them: core tools that only help the run find and
 * plan its own work. Everything else is closed unless the authority names it.
 */
export const PROGRAM_BASE_TOOLS = [
  'tool_search',
  'load_skill',
  'read_skill_file',
  'search_skills',
  'todo_write',
  // asking the client for a decision or for more authority is never outside the authority
  'escalate',
  'request_authority',
] as const

/** A tool the agent has, with the connector and connections it comes from. */
export interface ToolSourceInfo {
  name: string
  connectorId: string
  connectionIds: readonly string[]
}

export interface ProgramRules {
  /** What approves a call (strict: a call matching none is denied). */
  allow: string[]
  /** What is denied in every case. */
  deny: string[]
}

const globRule = (kind: 'Read' | 'Edit', glob: string): string => `${kind}(${glob.trim()})`

/**
 * The rules of a run, derived from the program (decision D3). `allow`: the authority (tools and
 * rules, every tool of a connector, `Read(glob)` for read, `Edit(glob)` for write) and the base
 * tools. `deny`: `forbidden`. Writing a path also needs reading it (editing reads the file first),
 * so a write glob is readable too.
 */
export function programRules(
  program: Pick<Program, 'authority' | 'forbidden'>,
  tools: readonly ToolSourceInfo[] = [],
): ProgramRules {
  const a = program.authority
  const connectorTools = tools
    .filter(
      (t) =>
        a.connectors.includes(t.connectorId) ||
        t.connectionIds.some((c) => a.connectors.includes(c)),
    )
    .map((t) => t.name)
  return {
    allow: cleanList([
      ...PROGRAM_BASE_TOOLS,
      ...a.tools,
      ...connectorTools,
      ...a.read.map((g) => globRule('Read', g)),
      ...a.write.map((g) => globRule('Read', g)),
      ...a.write.map((g) => globRule('Edit', g)),
    ]),
    deny: cleanList(program.forbidden),
  }
}

/** What the agent reads when the engine refuses a call outside the authority. */
export function outsideAuthorityReason(programName: string, toolName: string): string {
  return (
    `Outside the authority of program "${programName}": ${toolName} (with this input) is not ` +
    'granted to this run, and nobody can approve a single call now. Do not retry the same call. ' +
    'If you need it to finish the brief, call request_authority (name the tool, connector or ' +
    'path and why): your run pauses until the client decides, then continues here. If it is ' +
    'rejected, finish the work that is inside your authority and report what you could not do ' +
    "(status 'needs_decision')."
  )
}

/** The reason of a call a `forbidden` rule denies. */
export function forbiddenReason(programName: string, toolName: string, rule: string): string {
  return (
    `Forbidden by program "${programName}": ${toolName} matches the rule ${rule}. This is never ` +
    'allowed in this program. Choose another way, or report it in your final report.'
  )
}

// --- the run ----------------------------------------------------------------------------------

export const REPORT_STATUSES = ['done', 'partial', 'failed', 'needs_decision'] as const
export const MAX_ATTEMPTS = 3
/**
 * Model steps one program run may take. A run is a standing order, not a chat: a chunked job
 * (read a chunk, write findings, mark it) needs many more steps than a role agent's chat turn.
 */
export const PROGRAM_RUN_MAX_STEPS = 150

const bullets = (items: readonly string[], none: string): string =>
  items.length === 0 ? none : items.map((i) => `- ${i}`).join('\n')

/** The text of the turn that starts a run: brief, authority, gates, escalation and the run rule. */
export function programRunPrompt(program: Program): string {
  const a = program.authority
  const tools = [
    ...a.tools,
    ...a.connectors.map((c) => `every tool of connector ${c}`),
    ...a.read.map((g) => `read ${g}`),
    ...a.write.map((g) => `read and write ${g}`),
  ]
  return [
    `Program run: ${program.name}`,
    '',
    'You are running a standing order the client gave you. Nobody is watching this run, so you',
    'finish it yourself inside the authority below. A call outside it is refused, not asked.',
    '',
    '## Brief',
    program.brief.trim(),
    '',
    '## Authority (enforced: anything else is refused)',
    bullets(tools, '- nothing beyond finding and planning your own work'),
    '',
    '## Forbidden (denied in every case)',
    bullets(program.forbidden, '- nothing named beyond the authority'),
    '',
    '## Gates (these still need the client: do not do them before the client agrees; call escalate)',
    bullets(program.gates, '- none named'),
    '',
    '## Escalation (stop and ask instead of pressing on: call escalate)',
    program.escalation.trim() === ''
      ? 'When something looks wrong or unsafe, stop and escalate.'
      : program.escalation.trim(),
    '',
    '## How to run',
    'Work in three steps: Execute, Verify, Report.',
    `1. Execute the brief step by step. Keep what you produce in the library paths you may write.`,
    '2. Verify the result against the brief: read back what you wrote, check numbers and links,',
    '   confirm every step happened. If a check fails, retry once with an adjusted approach.',
    `3. Report. At most ${MAX_ATTEMPTS} attempts in total. If it still fails, stop and report the failure with a`,
    '   diagnosis (what you tried, what happened, what you think is wrong). Never fail silently.',
    '',
    'Asking the client: `escalate` pauses your run until the client answers a question or a gate',
    '(the answer comes back as the tool result, { decision, note }); `request_authority` asks for',
    'a tool, connector or path outside your authority. Use them instead of failing or guessing.',
    'If you still end with something undecided, report needs_decision.',
    '',
    'End the run with the final_answer tool: status (done, partial, failed or needs_decision),',
    'a short summary, outputs (library paths of what you produced) and optional notes.',
  ].join('\n')
}

/** Outcome of one turn of a program run, for the task row and the routine run. */
export function programRunOutcome(
  stop: string,
  report: TaskReport | undefined,
): { status: TaskStatus; summary: string | null; failed: boolean } {
  if (stop === 'complete' && report !== undefined) {
    return {
      status: report.status === 'failed' ? 'failed' : 'done',
      summary: report.summary,
      failed: report.status === 'failed',
    }
  }
  // a later turn (the client steered the run) has no report of its own
  if (stop === 'complete') return { status: 'done', summary: null, failed: false }
  if (stop === 'tool-pending') return { status: 'running', summary: null, failed: false }
  if (stop === 'aborted') return { status: 'stopped', summary: null, failed: false }
  if (stop === 'interrupted') return { status: 'interrupted', summary: null, failed: true }
  const why: Record<string, string> = {
    'cost-cap': 'Stopped: the budget of this run (or program) was used up before it reported.',
    'output-invalid': 'Stopped: the run did not produce a valid final report.',
    'max-steps': 'Stopped: the run used all its steps before it reported.',
    stuck: 'Stopped: the run was repeating itself.',
  }
  return {
    status: 'failed',
    summary: why[stop] ?? `Stopped: ${stop} (no final report).`,
    failed: true,
  }
}

/** A report from untrusted JSON (the stored column), or undefined. */
export function parseReport(value: unknown): TaskReport | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (!(REPORT_STATUSES as readonly unknown[]).includes(v.status)) return undefined
  if (typeof v.summary !== 'string') return undefined
  const outputs = Array.isArray(v.outputs)
    ? v.outputs.filter((o): o is string => typeof o === 'string')
    : []
  return {
    status: v.status as TaskReport['status'],
    summary: v.summary,
    outputs,
    ...(typeof v.notes === 'string' ? { notes: v.notes } : {}),
  }
}
