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

import { memoryPromptSection, type RememberedDecision } from './decision-memory.ts'
import {
  checkDeliverables,
  type Deliverable,
  deliverablesPromptSection,
  type TokenContext,
} from './deliverables.ts'
import { invalid } from './errors.ts'
import type { RoutineSpec } from './routines.ts'
import { SESSION_CONTEXT_TOOLS } from './session-context.ts'
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
  /**
   * Output tokens one model call of a run may produce (null / absent = sized from the budget, see
   * `programMaxOutputTokens`). Every call reserves its worst case (context + this many output
   * tokens at the model's price) against the budgets before it runs, so a small cap is what lets a
   * small budget work at all.
   */
  maxOutputTokens?: number | null
}

/** A worker program works through the queued tasks of its agent, one session per task (D6). */
export interface WorkerSpec {
  /** Tasks one run takes at most. */
  maxTasks: number
}
export const MAX_TASKS_PER_RUN = 20
export const DEFAULT_TASKS_PER_RUN = 3

export function checkWorker(worker: Partial<WorkerSpec> | null | undefined): void {
  if (worker == null) return
  const n = worker.maxTasks
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_TASKS_PER_RUN)) {
    throw invalid(`worker.maxTasks must be 1-${MAX_TASKS_PER_RUN}`, 'INVALID_PROGRAM')
  }
}

export const normalizeWorker = (
  worker: Partial<WorkerSpec> | null | undefined,
): WorkerSpec | null =>
  worker == null ? null : { maxTasks: worker.maxTasks ?? DEFAULT_TASKS_PER_RUN }

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
  /** Set: each run takes queued tasks of the agent (the work queue); null: one run, the brief. */
  worker: WorkerSpec | null
  /** Files each run must leave in the library; checked at run end (phase H). Empty: none. */
  deliverables: Deliverable[]
  /**
   * Standing agreements: what people agreed with the agent about this program in chat or in the
   * web. Told to every run after the brief. A note never grants anything: authority and gates win.
   */
  notes: string[]
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
  worker?: Partial<WorkerSpec> | null | undefined
  deliverables?: Deliverable[] | undefined
  notes?: string[] | undefined
  status?: ProgramStatus | undefined
}

export const MAX_BRIEF_CHARS = 20_000
export const MAX_LIST_ITEMS = 100
export const MAX_ITEM_CHARS = 500
export const MAX_NOTES = 50
export const MAX_NOTE_CHARS = 1000

/** Trimmed, non-empty, de-duplicated notes. */
export const cleanNotes = (notes: readonly string[] | undefined): string[] => [
  ...new Set((notes ?? []).map((n) => n.trim()).filter((n) => n !== '')),
]

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

export const MIN_OUTPUT_TOKENS = 256
export const MAX_PROGRAM_OUTPUT_TOKENS = 65_536

const usdProblem = (field: string, value: number | null | undefined): void => {
  if (value == null) return
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw invalid(`${field} must be a positive amount in USD or null`, 'INVALID_PROGRAM')
  }
}

/** Shape checks that need neither the clock nor the cron library. */
/**
 * Tools a program grants in its authority and forbids at the same time. Forbidden wins, so the run
 * never even sees such a tool (production: `channel_send` granted by a change, still forbidden from
 * creation, and the daily summary never went out).
 */
export function grantedAndForbidden(
  authority: Pick<ProgramAuthority, 'tools'>,
  forbidden: readonly string[],
): string[] {
  const no = new Set(forbidden.map((f) => f.trim()))
  return authority.tools.filter((t) => no.has(t))
}

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
  worker?: Partial<WorkerSpec> | null | undefined
  deliverables?: Deliverable[] | undefined
  notes?: string[] | undefined
}): void {
  checkWorker(f.worker)
  if (f.notes !== undefined) {
    if (f.notes.length > MAX_NOTES) {
      throw invalid(`notes: at most ${MAX_NOTES} entries`, 'INVALID_PROGRAM')
    }
    if (f.notes.some((n) => n.length > MAX_NOTE_CHARS)) {
      throw invalid(`notes: each entry at most ${MAX_NOTE_CHARS} characters`, 'INVALID_PROGRAM')
    }
  }
  checkDeliverables(f.deliverables)
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
  const cap = f.budget?.maxOutputTokens
  if (
    cap != null &&
    (!Number.isInteger(cap) || cap < MIN_OUTPUT_TOKENS || cap > MAX_PROGRAM_OUTPUT_TOKENS)
  ) {
    throw invalid(
      `budget.maxOutputTokens must be a whole number of ${MIN_OUTPUT_TOKENS}-${MAX_PROGRAM_OUTPUT_TOKENS} or null`,
      'INVALID_PROGRAM',
    )
  }
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

// --- file tools of a run -----------------------------------------------------------------------

export const FILE_READ_TOOLS = ['read_file', 'list_files', 'grep', 'glob'] as const
export const FILE_WRITE_TOOLS = ['write_file', 'edit_file'] as const
/** Every file tool a program run can be given (deleting is never part of an authority). */
export const PROGRAM_FILE_TOOLS: readonly string[] = [...FILE_READ_TOOLS, ...FILE_WRITE_TOOLS]

const baseName = (rule: string): string => rule.trim().split('(')[0] as string

/**
 * The file tools a program run gets even when the Files capabilities of its agent are off: what the
 * authority grants it. Paths to write give the write tools (and the read tools: editing reads
 * first), paths to read the read tools, and naming a tool (or the `Read` / `Edit` rule kinds) gives
 * that one. The permission gate still limits every call to the granted paths; this only decides
 * which tools exist in the run, so an authority never grants something the model cannot call.
 */
export function runFileTools(authority: ProgramAuthority): string[] {
  const out = new Set<string>()
  if (authority.write.length > 0) for (const t of PROGRAM_FILE_TOOLS) out.add(t)
  if (authority.read.length > 0) for (const t of FILE_READ_TOOLS) out.add(t)
  for (const rule of authority.tools) {
    const name = baseName(rule)
    if (PROGRAM_FILE_TOOLS.includes(name)) out.add(name)
    if (name === 'Read') for (const t of FILE_READ_TOOLS) out.add(t)
    if (name === 'Edit' || name === 'Write') for (const t of PROGRAM_FILE_TOOLS) out.add(t)
  }
  return [...out]
}

// --- model calls: output cap and the budget floor ----------------------------------------------

/** Output tokens of one call of a run when nothing smaller is set (a catalog limit is lower still). */
export const PROGRAM_DEFAULT_OUTPUT_TOKENS = 16_384
/** About the size of the first request of a run (instructions, tools, the brief), for the floor. */
export const TYPICAL_CONTEXT_TOKENS = 20_000
/** The smallest cap the budget sizing picks. */
const SMALLEST_SIZED_OUTPUT_TOKENS = 2_048

/** What the model catalog knows of a model (`ModelInfo` of eharness, structurally): USD per million tokens. */
export interface PricedModel {
  pricing?: { input: number; output: number } | undefined
  maxOutputTokens?: number | undefined
}

/**
 * What a model call reserves before it runs (worst case: the whole output cap is used), in USD;
 * undefined for a model without a price (the ledger reserves 0 for it).
 */
export function callReserveUsd(
  info: PricedModel | undefined,
  outputTokens: number,
  contextTokens = TYPICAL_CONTEXT_TOKENS,
): number | undefined {
  const pricing = info?.pricing
  if (pricing === undefined) return undefined
  return (contextTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}

/**
 * The output cap of one model call of a program run. The budgets reserve the worst case of every
 * call, so a run with a small budget must also have a small cap: unset, the cap is sized so one
 * call reserves at most about half of the smallest budget (never below 2 048 tokens, never above
 * the default or the model's own limit). An explicit `budget.maxOutputTokens` wins.
 */
export function programMaxOutputTokens(
  budget: Pick<ProgramBudget, 'perRunUsd' | 'perDayUsd' | 'maxOutputTokens'>,
  info?: PricedModel,
): number {
  if (budget.maxOutputTokens != null) return budget.maxOutputTokens
  const ceiling = Math.min(PROGRAM_DEFAULT_OUTPUT_TOKENS, info?.maxOutputTokens ?? Infinity)
  const limits = [budget.perRunUsd, budget.perDayUsd].filter((v): v is number => v != null)
  const pricing = info?.pricing
  if (limits.length === 0 || pricing === undefined || pricing.output <= 0) return ceiling
  const room = Math.min(...limits) / 2 - (TYPICAL_CONTEXT_TOKENS * pricing.input) / 1_000_000
  const sized = Math.floor((room * 1_000_000) / pricing.output)
  return Math.max(SMALLEST_SIZED_OUTPUT_TOKENS, Math.min(ceiling, sized))
}

// --- what the authority and the budget cannot do (warnings) -------------------------------------

export interface ProgramWarning {
  code:
    | 'tool-unavailable'
    | 'tool-off'
    | 'channel-not-bound'
    | 'budget-below-minimum'
    | 'brief-needs-tool'
  /** The form field it is about (`authority.tools`, `budget.perRunUsd`, ...). */
  field: string
  message: string
}

/** What the agent of a program can actually use in a run. */
export interface ToolAvailability {
  /** Tool names a run of the agent has (connector tools it may use, plugin tools, base tools). */
  available: ReadonlySet<string>
  /** Names of the channel tools; they exist only for an agent bound to a channel connection. */
  channelTools: readonly string[]
  channelsBound: boolean
  /** Tools the agent has through a connector whose mode for them is Off (still named, never callable). */
  off?: ReadonlySet<string>
}

/** Names that are tool names (snake case), not rule kinds like `Read(...)` or `WebFetch(...)`. */
const isToolName = (name: string): boolean => /^[a-z][a-z0-9_]*$/.test(name)

/**
 * Tools the authority names that the run can never have: the connector is off or the agent is not
 * bound to a channel. Such a call is refused as unavailable, `request_authority` cannot help and
 * a run that insists on it only loops.
 */
export function toolWarnings(
  authority: Pick<ProgramAuthority, 'tools'>,
  tools: ToolAvailability,
): ProgramWarning[] {
  const out: ProgramWarning[] = []
  for (const rule of authority.tools) {
    const name = baseName(rule)
    if (!isToolName(name)) continue
    if (tools.channelTools.includes(name) && !tools.channelsBound) {
      out.push({
        code: 'channel-not-bound',
        field: 'authority.tools',
        message: `${name}: the agent is not bound to any channel connection, so the run can never post or read a channel. Bind the agent to a channel connection first, or remove it from the authority.`,
      })
    } else if (tools.off?.has(name) === true) {
      out.push({
        code: 'tool-off',
        field: 'authority.tools',
        message: `${name}: its connector mode is Off for this agent, so every call is refused although the authority names it. Turn it on (Connectors, the connector of this tool: Ask first or Allowed; the authority then counts as your grant for this program), or remove it.`,
      })
    } else if (!tools.available.has(name)) {
      out.push({
        code: 'tool-unavailable',
        field: 'authority.tools',
        message: `${name}: the agent has no such tool (its connector is off or the name is wrong), so the run can never use it. Turn the connector on for the agent, or remove it.`,
      })
    }
  }
  return out
}

/** A budget smaller than one worst-case call stops every run before its first call. */
export function budgetWarnings(
  budget: Pick<ProgramBudget, 'perRunUsd' | 'perDayUsd' | 'maxOutputTokens'>,
  info: (PricedModel & { id?: string }) | undefined,
): ProgramWarning[] {
  const cap = programMaxOutputTokens(budget, info)
  const reserve = callReserveUsd(info, cap)
  if (reserve === undefined) return []
  const out: ProgramWarning[] = []
  const check = (field: string, label: string, value: number | null | undefined): void => {
    if (value == null || value >= reserve) return
    out.push({
      code: 'budget-below-minimum',
      field,
      message: `${label} $${value} is below the $${reserve.toFixed(4)} one model call reserves${info?.id === undefined ? '' : ` on ${info.id}`} (up to ${cap} output tokens): every run would stop with $0 spent. Raise it to at least $${reserve.toFixed(4)}, or lower the output cap.`,
    })
  }
  check('budget.perRunUsd', 'The per-run budget', budget.perRunUsd)
  check('budget.perDayUsd', 'The per-day budget', budget.perDayUsd)
  return out
}

/**
 * A brief that asks for something the authority does not grant (a heuristic, never a block): saving
 * memory without a memory write tool, running a script or calculation without `run_python`.
 */
export function briefWarnings(
  brief: string,
  authority: Pick<ProgramAuthority, 'tools' | 'connectors'>,
): ProgramWarning[] {
  const out: ProgramWarning[] = []
  const names = authority.tools.map(baseName)
  const granted = (...tools: string[]): boolean => tools.some((t) => names.includes(t))
  const text = brief.toLowerCase()
  if (
    /\b(memori|memory|memories)\b/.test(text) &&
    /\b(update|simpan|save|catat|tulis|write|perbarui|store|record)\b/.test(text) &&
    !granted(
      'memory_create',
      'memory_str_replace',
      'memory_insert',
      'memory_delete',
      'memory_rename',
    )
  ) {
    out.push({
      code: 'brief-needs-tool',
      field: 'authority.tools',
      message:
        'The brief asks to update or save memory, but no memory write tool is granted (memory_view is read-only): the run cannot write it. Add memory_create / memory_str_replace to the tools, or take it out of the brief.',
    })
  }
  if (
    /\b(python|hitung|menghitung|calculate|calculation|kalkulasi|run_python|jalankan kode|run code|python script)\b/.test(
      text,
    ) &&
    !granted('run_python')
  ) {
    out.push({
      code: 'brief-needs-tool',
      field: 'authority.tools',
      message:
        'The brief asks for a calculation or Python code, but run_python is not granted: the run can only compute in its head. Add run_python to the tools, or take it out of the brief.',
    })
  }
  return out
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
  // the clock (`eharness/clock`): read-only, every run needs to know the date
  'datetime',
  // the agent's own memory, read-only: what was agreed in chat may live there (writes stay outside)
  'memory_view',
  // the agent's own place in its chat connections, read-only facts about the setup: which
  // conversations and topics it ingests (`channel_describe`, `list_topics`) and its own rights and
  // status (`channel_status`). They return names and settings, never message content, never a
  // person's accounts, notes or fields, and no file: nothing beyond what the program may read is
  // reachable. `member_lookup` and `people_find` stay out: they return people's data, which only an
  // authority that names them may open. (A name here is harmless for an agent without channels.)
  'channel_describe',
  'channel_status',
  'list_topics',
  // the agent's own other sessions and runs, read-only and scoped in code (`domain/session-context.ts`):
  // a run reads its own earlier runs and the sessions its brief names, nothing else
  ...SESSION_CONTEXT_TOOLS,
  // asking the client for a decision or for more authority is never outside the authority
  'escalate',
  'escalate_wait',
  'request_authority',
] as const

/** Tools of the work queue every worker program may use (`infra/eh/work-queue-plugin.ts`). */
export const WORKER_TOOLS = ['complete_task'] as const

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

export const globRule = (kind: 'Read' | 'Edit', glob: string): string => `${kind}(${glob.trim()})`

/**
 * Read rules of a path glob. A gitignore-style `dir/**` does not match `dir` itself, so listing,
 * globbing, grepping or reading the directory (`list_files`, `glob`, `grep` with a prefix) would be
 * refused although everything below it is granted. A trailing `/**` therefore also grants the
 * directory path (a pattern matching a directory covers what is below it, so nothing widens).
 */
export const readRules = (glob: string): string[] => {
  const g = glob.trim()
  const dir = g.endsWith('/**') ? g.slice(0, -3) : ''
  return dir.length > 1 ? [globRule('Read', g), globRule('Read', dir)] : [globRule('Read', g)]
}

/**
 * The rules of a run, derived from the program (decision D3). `allow`: the authority (tools and
 * rules, every tool of a connector, `Read(glob)` for read, `Edit(glob)` for write) and the base
 * tools. `deny`: `forbidden`. Writing a path also needs reading it (editing reads the file first),
 * so a write glob is readable too.
 */
export function programRules(
  program: Pick<Program, 'authority' | 'forbidden'> & { worker?: WorkerSpec | null },
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
      // a worker program is given its work: reporting a task done is part of it
      ...(program.worker == null ? [] : WORKER_TOOLS),
      ...a.tools,
      ...connectorTools,
      ...a.read.flatMap(readRules),
      ...a.write.flatMap(readRules),
      ...a.write.map((g) => globRule('Edit', g)),
    ]),
    deny: cleanList(program.forbidden),
  }
}

/** What the agent reads when the engine refuses a call outside the authority. */
export function outsideAuthorityReason(
  programName: string,
  toolName: string,
  readable: readonly string[] = [],
): string {
  // a search or listing without a path covers the whole tree, which only a grant of the whole tree
  // allows; the rules never widen, so the reason names the roots that can be searched instead
  const where =
    readable.length === 0
      ? ''
      : ` If this was a search or listing: pass a path (prefix) inside what this run may read (${readable.join(', ')}); a call without a path covers everything and is refused.`
  return (
    `Outside the authority of program "${programName}": ${toolName} (with this input) is not ` +
    `granted to this run, and nobody can approve a single call now.${where} Do not retry the same call. ` +
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
export function programRunPrompt(
  program: Program,
  run?: TokenContext,
  remembered: readonly RememberedDecision[] = [],
  now = Date.now(),
): string {
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
    ...((program.notes ?? []).length === 0
      ? []
      : [
          '## Standing agreements from the client',
          'Agreed with the client in chat or in the web. Follow them in this run. They never grant',
          'authority or lift a gate: the authority, forbidden and gates below win over any note.',
          bullets(program.notes, ''),
          '',
        ]),
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
    ...(run === undefined ? [] : deliverablesPromptSection(program.deliverables ?? [], run)),
    ...memoryPromptSection(remembered, now),
    '## How to run',
    'Work in three steps: Execute, Verify, Report.',
    `1. Execute the brief step by step. Keep what you produce in the library paths you may write.`,
    '2. Verify the result against the brief: read back what you wrote, check numbers and links,',
    '   confirm every step happened. If a check fails, retry once with an adjusted approach.',
    ...((program.deliverables ?? []).length === 0
      ? []
      : [
          '   The server also checks the deliverables above when you end; fix them before you report.',
        ]),
    `3. Report. At most ${MAX_ATTEMPTS} attempts in total. If it still fails, stop and report the failure with a`,
    '   diagnosis (what you tried, what happened, what you think is wrong). Never fail silently.',
    '',
    'Asking the client: `escalate` sends a question or a gate to the client and returns at once;',
    'do not act on it, finish the rest of your job and end the run. When the client answers, this',
    'run continues as a new message with the answer. Use `escalate_wait` (pauses the run until the',
    'answer comes back as { decision, note, answeredBy }) only when nothing else can be done.',
    '`request_authority` asks for a tool, connector or path outside your authority. Use them instead',
    'of failing or guessing. When you mention who decided, attribute it exactly as `answeredBy` says.',
    'A question you already escalated is with the client: do not report needs_decision for it.',
    'If you still end with something undecided that you did not escalate, report needs_decision.',
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
    'cost-cap':
      'Stopped: the budget of this run (or program) was used up before it reported. ' +
      'A model call reserves its worst-case cost before it runs, so a very small budget can ' +
      'stop a run before its first call: raise the budget.',
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

// --- effective grant: what an authority really gives (validation + display) ---------------------

export type GrantKind = 'read' | 'write' | 'destructive' | 'external' | 'unknown'

/** A connection the agent has, as the authority can name it. */
export interface AuthorityConnectionInfo {
  connectionId: string
  connectorId: string
  slug: string
  toolPrefix: string
  label: string
}

/** A tool the agent has through a connector. */
export interface AuthorityToolInfo {
  name: string
  connectorId: string
  connectionIds: readonly string[]
  kind: GrantKind
  /** Mode Off: every call is refused. */
  off: boolean
  /** Write / destructive tool of a third-party connector: a gate, never granted by a connector grant. */
  pinned: boolean
}

export interface AuthoritySources {
  connections: readonly AuthorityConnectionInfo[]
  tools: readonly AuthorityToolInfo[]
  /** Every connector definition id of the workspace (known, maybe not enabled for this agent). */
  definitionIds: readonly string[]
  availability: ToolAvailability
}

export interface GrantedTool {
  name: string
  kind: GrantKind
  status: 'granted' | 'gate' | 'off' | 'unavailable'
}

export interface GrantedConnector {
  requested: string
  /** The resolved connector or connection id; null when it matches nothing. */
  id: string | null
  label: string
  tools: GrantedTool[]
}

export interface EffectiveGrant {
  connectors: GrantedConnector[]
  /** Tools the authority names itself. */
  tools: GrantedTool[]
  read: string[]
  write: string[]
}

export interface AuthorityInspection {
  /** The authority with unambiguous connector names repaired to real ids. */
  authority: ProgramAuthority
  repaired: Array<{ from: string; to: string }>
  /** Readable problems; saving is refused while any exist. */
  errors: string[]
  grant: EffectiveGrant
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/_/g, '-')

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] as number
      row[j] = Math.min(tmp + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length] as number
}

/** Tool names of the agent that look like a mistyped `name`. */
export function similarTools(name: string, names: Iterable<string>): string[] {
  const n = norm(name)
  const out: string[] = []
  for (const candidate of names) {
    const c = norm(candidate)
    if (c === n || c.endsWith(`-${n}`) || n.endsWith(`-${c}`) || levenshtein(c, n) <= 2) {
      out.push(candidate)
    }
  }
  return out.slice(0, 5)
}

function grantTool(t: AuthorityToolInfo, viaConnector: boolean): GrantedTool {
  if (t.off) return { name: t.name, kind: t.kind, status: 'off' }
  if (viaConnector && t.pinned) return { name: t.name, kind: t.kind, status: 'gate' }
  return { name: t.name, kind: t.kind, status: 'granted' }
}

/**
 * Checks an authority against what the agent really has. A connector name that is the slug, tool
 * prefix or label of exactly one connection is repaired to that connection's id; one that matches
 * nothing (or several) is an error that lists the valid ids. A tool name the agent does not have
 * is an error only when a tool of the agent looks like it (a typo); otherwise it stays a warning
 * (`toolWarnings`), because the connector may simply be off for now.
 */
export function inspectAuthority(
  authority: ProgramAuthority,
  sources: AuthoritySources,
): AuthorityInspection {
  const errors: string[] = []
  const repaired: Array<{ from: string; to: string }> = []
  const valid = sources.connections.map((c) => `${c.connectionId} (${c.label})`)
  const validIds = [...new Set(sources.connections.flatMap((c) => [c.connectorId, c.connectionId]))]
  const connectors: string[] = []
  const grantConnectors: GrantedConnector[] = []

  for (const requested of authority.connectors) {
    const exactConnector = sources.connections.filter((c) => c.connectorId === requested)
    const exactConnection = sources.connections.find((c) => c.connectionId === requested)
    let id: string | null = null
    let label = requested
    if (exactConnection !== undefined || exactConnector.length > 0) {
      id = requested
      label = exactConnection?.label ?? exactConnector[0]?.label ?? requested
    } else {
      const n = norm(requested)
      const matches = sources.connections.filter((c) =>
        [c.slug, c.toolPrefix, c.label, c.connectionId, c.connectorId].some((x) => norm(x) === n),
      )
      if (matches.length === 1) {
        const m = matches[0] as AuthorityConnectionInfo
        id = m.connectionId
        label = m.label
        repaired.push({ from: requested, to: id })
      } else if (matches.length > 1) {
        errors.push(
          `authority.connectors: "${requested}" matches several connections (${matches.map((m) => `${m.connectionId} (${m.label})`).join(', ')}). Name one connection id.`,
        )
      } else if (sources.definitionIds.includes(requested)) {
        errors.push(
          `authority.connectors: "${requested}" is a connector this agent does not have enabled. Turn it on for the agent first. Enabled: ${valid.join(', ') || 'none'}.`,
        )
      } else {
        errors.push(
          `authority.connectors: "${requested}" is not a connector or connection id of this agent. Valid: ${valid.join(', ') || 'none (no custom or third-party connector is enabled)'}${validIds.length > 0 ? `; or a connector id: ${validIds.filter((v) => !sources.connections.some((c) => c.connectionId === v)).join(', ')}` : ''}.`,
        )
      }
    }
    if (id !== null) connectors.push(id)
    grantConnectors.push({
      requested,
      id,
      label,
      tools:
        id === null
          ? []
          : sources.tools
              .filter((t) => t.connectorId === id || t.connectionIds.includes(id as string))
              .map((t) => grantTool(t, true)),
    })
  }

  const byName = new Map(sources.tools.map((t) => [t.name, t]))
  const grantTools: GrantedTool[] = []
  for (const rule of authority.tools) {
    const name = baseName(rule)
    if (!isToolName(name)) continue
    const info = byName.get(name)
    if (info !== undefined) {
      grantTools.push(grantTool(info, false))
    } else if (sources.availability.available.has(name)) {
      grantTools.push({ name, kind: 'unknown', status: 'granted' })
    } else {
      grantTools.push({ name, kind: 'unknown', status: 'unavailable' })
      if (sources.availability.channelTools.includes(name)) continue
      const near = similarTools(name, sources.availability.available)
      if (near.length > 0) {
        errors.push(
          `authority.tools: the agent has no tool "${name}". Did you mean: ${near.join(', ')}?`,
        )
      }
    }
  }

  return {
    authority: { ...authority, connectors: cleanList(connectors) },
    repaired,
    errors,
    grant: {
      connectors: grantConnectors,
      tools: grantTools,
      read: authority.read,
      write: authority.write,
    },
  }
}
