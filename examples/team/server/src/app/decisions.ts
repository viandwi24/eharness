/**
 * Decision Center use cases (docs/plans/P40-team-autonomous-operations.md, D5). Agents create
 * decisions through the `decisions` plugin (`infra/eh/decisions-plugin.ts`); the client lists,
 * approves (a proposal may be edited first) and rejects them through the API.
 *
 * Deciding is a compare-and-set on `open` (the first answer wins), then the effect: a proposal
 * creates its program (and starts a one-off run), an amendment widens the program, an escalation
 * or amendment resumes the parked session with `{ decision, note }`. When the effect fails the
 * decision is opened again, so nothing is half decided.
 */
import {
  amendmentBody,
  authorityLines,
  checkBody,
  checkNote,
  checkTitle,
  cleanOptions,
  type Decision,
  type DecisionAnswer,
  type DecisionKind,
  type DecisionOutcome,
  type DecisionStatus,
  isEmptyAuthority,
  mergeAuthority,
  normalizeAmendmentAuthority,
  normalizeProposedProgram,
  type ProposalPayload,
  type ProposedProgramInput,
  programOfProposal,
  reportBody,
} from '../domain/decisions.ts'
import { type DeliverableCheck, deliverableLine } from '../domain/deliverables.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  normalizeAuthority,
  type Program,
  type ProgramAuthority,
  parseProgramSession,
} from '../domain/programs.ts'
import type { Task, TaskReport } from '../domain/tasks.ts'
import { getAgent } from './agents.ts'
import type { Deps } from './ports.ts'
import { createProgram, getProgram, runProgramNow, updateProgram } from './programs.ts'

export const CLIENT = 'client'

export function getDecision(deps: Deps, id: string): Decision {
  const d = deps.decisions.get(id)
  if (d === undefined) throw notFound('decision', id)
  return d
}

export interface DecisionQuery {
  status?: DecisionStatus | undefined
  kind?: DecisionKind | undefined
  /** Agent id or slug. */
  agentId?: string | undefined
  limit?: number | undefined
}

export function listDecisions(deps: Deps, query: DecisionQuery): Decision[] {
  const agentId = query.agentId === undefined ? undefined : getAgent(deps, query.agentId).id
  return deps.decisions.list({
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.kind === undefined ? {} : { kind: query.kind }),
    ...(agentId === undefined ? {} : { agentId }),
    limit: query.limit ?? 100,
  })
}

export const openDecisionCount = (deps: Deps): number => deps.decisions.countOpen()

const changed = (deps: Deps, d: Decision, change: 'created' | 'decided'): void =>
  deps.events.append({
    type: 'decision-changed',
    agentId: d.agentId,
    sessionId: d.sessionId,
    payload: {
      decisionId: d.id,
      kind: d.kind,
      status: d.status,
      title: d.title,
      change,
      open: deps.decisions.countOpen(),
    },
  })

// --- creation (the agents, through the plugin) --------------------------------------------------

export interface ProposeInput {
  /** The agent asking (the owner of the session). */
  agentId: string
  sessionId: string | null
  title: string
  body?: string | undefined
  /** The agent that will run the program (id or slug); default: the asker. */
  runner?: string | undefined
  program: Omit<ProposedProgramInput, 'agentId'>
  runOnce: boolean
}

/** Markdown of a proposal whose agent gave no body: the brief and what it asks for. */
function proposalBody(program: ProposalPayload['program'], runOnce: boolean): string {
  const lines = authorityLines(program.authority)
  return [
    runOnce ? 'A one-off plan.' : 'A standing program.',
    '',
    '## Plan',
    program.brief,
    '',
    '## Authority it asks for',
    ...(lines.length === 0
      ? ['- nothing beyond finding and planning its own work']
      : lines.map((l) => `- ${l}`)),
    ...((program.deliverables ?? []).length === 0
      ? []
      : [
          '',
          '## Deliverables it must leave',
          ...(program.deliverables ?? []).map((d) => `- ${deliverableLine(d)}`),
        ]),
  ].join('\n')
}

/** `propose_plan`: stores the proposal. Nothing starts and the proposing session is not parked. */
export function createProposal(deps: Deps, input: ProposeInput): Decision {
  const asker = getAgent(deps, input.agentId)
  const runner = getAgent(deps, input.runner ?? asker.id)
  if (runner.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const program = normalizeProposedProgram({ ...input.program, agentId: runner.id })
  if (program.trigger.kind === 'schedule') deps.schedule.validate(program.trigger.spec)
  const payload: ProposalPayload = { program, runOnce: input.runOnce }
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'proposal',
    title: checkTitle(input.title),
    body: checkBody(input.body) || proposalBody(program, input.runOnce),
    agentId: asker.id,
    sessionId: input.sessionId,
    programId: null,
    payload,
    waitId: null,
    createdAt: deps.clock.now(),
  })
  changed(deps, d, 'created')
  return d
}

export interface EscalateInput {
  agentId: string
  sessionId: string
  /** The external wait the session is parked on; one decision per wait (a retried `start` is idempotent). */
  waitId: string
  title: string
  question: string
  details?: string | undefined
  options?: string[] | undefined
}

/** `escalate`: the decision of a parked session. */
export function createEscalation(deps: Deps, input: EscalateInput): Decision {
  const existing = deps.decisions.getByWait(input.waitId)
  if (existing !== undefined) return existing
  const question = input.question.trim()
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'escalation',
    title: checkTitle(input.title),
    body: checkBody([`**${question}**`, input.details?.trim() ?? ''].filter(Boolean).join('\n\n')),
    agentId: input.agentId,
    sessionId: input.sessionId,
    programId: parseProgramSession(input.sessionId)?.programId ?? null,
    payload: { question, options: cleanOptions(input.options), source: 'agent' },
    waitId: input.waitId,
    createdAt: deps.clock.now(),
  })
  changed(deps, d, 'created')
  return d
}

export interface AmendInput {
  agentId: string
  sessionId: string
  waitId: string
  authority: Partial<ProgramAuthority>
  why: string
}

/** `request_authority`: the extra authority a run asks for. */
export function createAmendment(deps: Deps, input: AmendInput): Decision {
  const existing = deps.decisions.getByWait(input.waitId)
  if (existing !== undefined) return existing
  const programId = parseProgramSession(input.sessionId)?.programId ?? null
  const program = programId === null ? undefined : deps.programs.get(programId)
  let authority: ProgramAuthority
  try {
    authority = normalizeAmendmentAuthority(input.authority)
  } catch {
    // the session is parked already: show what was asked, the client edits or rejects it
    authority = normalizeAuthority(input.authority)
  }
  const payload = { authority, why: input.why.trim() }
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'amendment',
    title: checkTitle(`More authority for ${program?.name ?? 'a run'}`),
    body: amendmentBody(program?.name ?? 'a program', payload),
    agentId: input.agentId,
    sessionId: input.sessionId,
    programId,
    payload,
    waitId: input.waitId,
    createdAt: deps.clock.now(),
  })
  changed(deps, d, 'created')
  return d
}

/**
 * A run ended with `needs_decision` without escalating: the report becomes an escalation, so the
 * client sees it in the Decision Center. Not tied to a wait: the answer is sent to the session as
 * a new message. One open decision per session.
 */
export function createReportEscalation(
  deps: Deps,
  input: { agentId: string; sessionId: string; report: TaskReport },
): Decision | undefined {
  if (deps.decisions.list({ sessionId: input.sessionId, status: 'open', limit: 1 }).length > 0) {
    return undefined
  }
  const programId = parseProgramSession(input.sessionId)?.programId ?? null
  const program = programId === null ? undefined : deps.programs.get(programId)
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'escalation',
    title: checkTitle(`${program?.name ?? 'A run'} needs a decision`),
    body: checkBody(reportBody(input.report)),
    agentId: input.agentId,
    sessionId: input.sessionId,
    programId,
    payload: { question: input.report.summary, options: [], source: 'report' },
    waitId: null,
    createdAt: deps.clock.now(),
  })
  changed(deps, d, 'created')
  return d
}

/**
 * A run's deliverables still failed after the fix-up turn: an escalation, so the client sees which
 * files are wrong. Not tied to a wait (the run ended): the answer is sent to the session as a new
 * message. One open decision per session.
 */
export function createDeliverablesEscalation(
  deps: Deps,
  input: { program: Program; task: Task; checks: readonly DeliverableCheck[] },
): Decision | undefined {
  const { program, task } = input
  if (deps.decisions.list({ sessionId: task.sessionId, status: 'open', limit: 1 }).length > 0) {
    return undefined
  }
  const bad = input.checks.filter((c) => !c.ok)
  const d = deps.decisions.insert({
    id: deps.ids.next(),
    kind: 'escalation',
    title: checkTitle(`${program.name}: deliverables not met`),
    body: checkBody(
      [
        'The run ended, but these deliverables still fail after one fix-up turn. The run is marked partial.',
        '',
        '## What fails',
        ...bad.flatMap((c) => [`- \`${c.path}\``, ...c.problems.map((p) => `  - ${p}`)]),
      ].join('\n'),
    ),
    agentId: task.agentId,
    sessionId: task.sessionId,
    programId: program.id,
    payload: {
      question: `${bad.length} deliverable${bad.length === 1 ? '' : 's'} of "${program.name}" still fail. Approve to let the agent try again, or reject to leave it partial.`,
      options: [],
      source: 'report',
    },
    waitId: null,
    createdAt: deps.clock.now(),
  })
  changed(deps, d, 'created')
  return d
}

// --- deciding (the client) ----------------------------------------------------------------------

export interface ApproveInput {
  note?: string | undefined
  /** Escalation with options: the option picked. */
  choice?: string | undefined
  /** Proposal: what the client changed; absent fields stay as proposed. */
  edit?:
    | {
        program?: Partial<Omit<ProposedProgramInput, 'agentId'>> & { agentId?: string | undefined }
        runOnce?: boolean | undefined
      }
    | undefined
  /** Amendment: the authority to grant when it is narrower than asked. */
  authority?: Partial<ProgramAuthority> | undefined
}

function mustBeOpen(d: Decision): void {
  if (d.status !== 'open') {
    throw conflict(`the decision is already ${d.status}`, 'DECISION_CLOSED', { status: d.status })
  }
}

/** Decide (compare-and-set); a lost race is a conflict. */
function claim(
  deps: Deps,
  d: Decision,
  status: 'approved' | 'rejected',
  note: string,
  extra: { outcome?: DecisionOutcome; payload?: Decision['payload'] } = {},
): Decision {
  const next = deps.decisions.decide(d.id, {
    status,
    decidedBy: CLIENT,
    decidedAt: deps.clock.now(),
    note,
    ...(extra.outcome === undefined ? {} : { outcome: extra.outcome }),
    ...(extra.payload === undefined ? {} : { payload: extra.payload }),
  })
  if (next === undefined) {
    const now = getDecision(deps, d.id)
    throw conflict(`the decision is already ${now.status}`, 'DECISION_CLOSED', {
      status: now.status,
    })
  }
  return next
}

/** The answer reaches the session; a session that no longer waits makes the decision `expired`. */
async function deliver(deps: Deps, d: Decision, answer: DecisionAnswer): Promise<Decision> {
  if (d.sessionId === null) return d
  try {
    const result = await deps.decisionResolver.resume(d, answer)
    if (result !== 'gone') return d
  } catch (error) {
    deps.decisions.reopen(d.id)
    throw error
  }
  // stopped, timed out or deleted meanwhile: record that the answer reached nobody
  deps.decisions.reopen(d.id)
  const expired = deps.decisions.decide(d.id, {
    status: 'expired',
    decidedBy: CLIENT,
    decidedAt: deps.clock.now(),
    note: 'The run no longer waits for this decision.',
  })
  changed(deps, expired ?? d, 'decided')
  throw conflict('the run no longer waits for this decision', 'DECISION_EXPIRED')
}

export async function approveDecision(
  deps: Deps,
  id: string,
  input: ApproveInput = {},
): Promise<Decision> {
  const d = getDecision(deps, id)
  mustBeOpen(d)
  const note = checkNote(input.note)

  if (d.kind === 'proposal') return approveProposal(deps, d, note, input.edit)

  if (d.kind === 'escalation') {
    const options = d.payload.options
    if (options.length > 0 && input.choice === undefined) {
      throw invalid(`pick one of: ${options.join(', ')}`, 'INVALID_DECISION')
    }
    if (input.choice !== undefined && !options.includes(input.choice)) {
      throw invalid(
        options.length === 0
          ? 'this question has no options: approve or reject it'
          : `pick one of: ${options.join(', ')}`,
        'INVALID_DECISION',
      )
    }
    const decision = input.choice ?? 'approved'
    const next = claim(deps, d, 'approved', note, { outcome: { decision } })
    await deliver(deps, next, { decision, note })
    changed(deps, next, 'decided')
    return next
  }

  // amendment: widen the program first, so the resumed run can use it at once
  if (d.programId === null || deps.programs.get(d.programId) === undefined) {
    throw conflict('the program of this run was deleted: reject the request', 'PROGRAM_DELETED')
  }
  const granted =
    input.authority === undefined
      ? d.payload.authority
      : normalizeAmendmentAuthority(input.authority)
  const program = getProgram(deps, d.programId)
  if (isEmptyAuthority(granted)) throw invalid('nothing to grant', 'INVALID_DECISION')
  const next = claim(deps, d, 'approved', note, {
    outcome: { decision: 'approved', programId: program.id },
    payload: { ...d.payload, authority: granted },
  })
  try {
    updateProgram(deps, program.id, { authority: mergeAuthority(program.authority, granted) })
  } catch (error) {
    deps.decisions.reopen(d.id)
    throw error
  }
  await deliver(deps, next, { decision: 'approved', note })
  changed(deps, next, 'decided')
  return next
}

async function approveProposal(
  deps: Deps,
  d: Extract<Decision, { kind: 'proposal' }>,
  note: string,
  edit: ApproveInput['edit'],
): Promise<Decision> {
  const base = d.payload
  const merged: ProposedProgramInput = { ...base.program, ...edit?.program }
  const runOnce = edit?.runOnce ?? base.runOnce
  // validate everything before the decision is claimed
  const runner = getAgent(deps, merged.agentId)
  if (runner.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const program = normalizeProposedProgram({ ...merged, agentId: runner.id })
  if (program.trigger.kind === 'schedule') deps.schedule.validate(program.trigger.spec)
  const payload: ProposalPayload = { program, runOnce }

  let next = claim(deps, d, 'approved', note, { payload, outcome: { decision: 'approved' } })
  const draft = programOfProposal(payload)
  let created: ReturnType<typeof createProgram>
  try {
    created = createProgram(deps, { ...draft, createdBy: d.agentId })
  } catch (error) {
    deps.decisions.reopen(d.id)
    throw error
  }
  next =
    deps.decisions.setOutcome(d.id, { decision: 'approved', programId: created.id }, created.id) ??
    next
  if (runOnce) {
    try {
      const run = await runProgramNow(deps, created.id)
      next =
        deps.decisions.setOutcome(
          d.id,
          {
            decision: 'approved',
            programId: created.id,
            ...(run.sessionId === null ? {} : { runSessionId: run.sessionId }),
          },
          created.id,
        ) ?? next
    } catch {
      // the program exists; "Run now" on the Programs page starts it
    }
  }
  changed(deps, next, 'decided')
  return next
}

export async function rejectDecision(
  deps: Deps,
  id: string,
  input: { note?: string | undefined } = {},
): Promise<Decision> {
  const d = getDecision(deps, id)
  mustBeOpen(d)
  const note = checkNote(input.note)
  const next = claim(deps, d, 'rejected', note, { outcome: { decision: 'rejected' } })
  if (d.kind !== 'proposal') await deliver(deps, next, { decision: 'rejected', note })
  changed(deps, next, 'decided')
  return next
}
