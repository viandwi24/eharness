/**
 * The Decision Center (docs/plans/P40-team-autonomous-operations.md, decision D5). Pure.
 *
 * A decision is something only the client can settle. Three kinds:
 *
 *  - `proposal`: an agent (the manager, or any agent in a DM chat) proposes a one-off plan or a
 *    standing program, with the authority and budget it needs. Approving creates the program (and
 *    runs it once for a one-off), with exactly the authority of the proposal; the client may edit
 *    it first. The proposing session is not parked.
 *  - `escalation`: a running session hit a gate or an escalation rule. The agent called
 *    `escalate`: its turn parked on an external wait, and the decision resumes the same session
 *    with `{ decision, note }` as the tool output (`waitId` names the wait).
 *  - `amendment`: a program run needs more authority (`request_authority`). Approving widens the
 *    program's authority, and resumes the run like an escalation; rejecting resumes it with the
 *    refusal.
 *
 * Tool approvals are not decisions: they stay inline in the chat of the session (decision D2).
 */
import { type Deliverable, normalizeDeliverables } from './deliverables.ts'
import { invalid } from './errors.ts'
import {
  checkProgramFields,
  cleanList,
  MAX_BRIEF_CHARS,
  normalizeAuthority,
  type ProgramAuthority,
  type ProgramBudget,
  type ProgramDraft,
  type ProgramReportMode,
  type ProgramTrigger,
} from './programs.ts'
import type { TaskReport } from './tasks.ts'

export const DECISION_KINDS = ['proposal', 'escalation', 'amendment'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

export const DECISION_STATUSES = ['open', 'approved', 'rejected', 'expired'] as const
export type DecisionStatus = (typeof DECISION_STATUSES)[number]

/** The program a proposal would create. `agentId` is the agent that will run it. */
export interface ProposedProgram {
  agentId: string
  name: string
  brief: string
  authority: ProgramAuthority
  gates: string[]
  escalation: string
  forbidden: string[]
  budget: ProgramBudget
  trigger: ProgramTrigger
  report: ProgramReportMode
  /** Files the run must leave (phase H); absent in proposals stored before it. */
  deliverables?: Deliverable[]
}

export interface ProposalPayload {
  program: ProposedProgram
  /**
   * true: a one-off plan: the program is created with a manual trigger and run once at once.
   * false: a standing program, created as proposed (a schedule starts on approval).
   */
  runOnce: boolean
}

export interface EscalationPayload {
  question: string
  /** Answers the client picks from; empty: approve or reject. */
  options: string[]
  /** `agent`: the agent called `escalate`; `report`: its final report said `needs_decision`. */
  source: 'agent' | 'report'
}

export interface AmendmentPayload {
  /** The authority to add to the program (what the run asked for; the client may narrow it). */
  authority: ProgramAuthority
  why: string
}

type Base = {
  id: string
  status: DecisionStatus
  title: string
  /** Markdown: goal, plan steps, why, evidence links. */
  body: string
  /** The agent that asks (the owner of the source session). */
  agentId: string
  /** The session it came from (a link in the UI); null for a decision not tied to one. */
  sessionId: string | null
  /** The program it is about (amendment, escalation of a run) or created (approved proposal). */
  programId: string | null
  /** The external wait the session is parked on (escalation, amendment). */
  waitId: string | null
  decidedBy: string | null
  decidedAt: number | null
  decisionNote: string | null
  /** What the decision made happen: the choice, the program it created, the run it started. */
  outcome: DecisionOutcome | null
  createdAt: number
}

export type Decision =
  | (Base & { kind: 'proposal'; payload: ProposalPayload })
  | (Base & { kind: 'escalation'; payload: EscalationPayload })
  | (Base & { kind: 'amendment'; payload: AmendmentPayload })

export interface DecisionOutcome {
  /** `approved`, `rejected`, or the option the client picked. */
  decision: string
  programId?: string | undefined
  /** Session of the one-off run an approved proposal started. */
  runSessionId?: string | undefined
}

export const MAX_TITLE_CHARS = 200
export const MAX_NOTE_CHARS = 4000
export const MAX_OPTIONS = 6
export const MAX_OPTION_CHARS = 80

export const isOpen = (d: Pick<Decision, 'status'>): boolean => d.status === 'open'

/** What the agent reads as the output of `escalate` and `request_authority`. */
export interface DecisionAnswer {
  /** `approved`, `rejected`, or the option the client picked. */
  decision: string
  note: string
}

// --- validation ---------------------------------------------------------------------------------

export function checkTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ')
  if (t === '' || t.length > MAX_TITLE_CHARS) {
    throw invalid(`title must be 1-${MAX_TITLE_CHARS} characters`, 'INVALID_DECISION')
  }
  return t
}

export function checkBody(body: string | undefined): string {
  const b = (body ?? '').trim()
  if (b.length > MAX_BRIEF_CHARS) {
    throw invalid(`body must be at most ${MAX_BRIEF_CHARS} characters`, 'INVALID_DECISION')
  }
  return b
}

export function checkNote(note: string | undefined): string {
  const n = (note ?? '').trim()
  if (n.length > MAX_NOTE_CHARS) {
    throw invalid(`note must be at most ${MAX_NOTE_CHARS} characters`, 'INVALID_DECISION')
  }
  return n
}

/** Options of an escalation, trimmed and de-duplicated; `rejected` and `approved` are the buttons, not options. */
export function cleanOptions(options: readonly string[] | undefined): string[] {
  const out = cleanList(options ?? [])
  if (out.length > MAX_OPTIONS) {
    throw invalid(`at most ${MAX_OPTIONS} options`, 'INVALID_DECISION')
  }
  for (const o of out) {
    if (o.length > MAX_OPTION_CHARS) {
      throw invalid(`options are at most ${MAX_OPTION_CHARS} characters`, 'INVALID_DECISION')
    }
  }
  return out
}

/** A proposed program from untrusted JSON (the agent, or the client editing before approval). */
export interface ProposedProgramInput {
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
  deliverables?: Deliverable[] | undefined
}

/** Checks (`INVALID_PROGRAM` / `INVALID_DECISION`) and normalizes a proposed program. */
export function normalizeProposedProgram(input: ProposedProgramInput): ProposedProgram {
  const draft: ProgramDraft = { ...input }
  checkProgramFields(draft)
  return {
    agentId: input.agentId,
    name: input.name.trim(),
    brief: input.brief.trim(),
    authority: normalizeAuthority(input.authority),
    gates: cleanList(input.gates ?? []),
    escalation: (input.escalation ?? '').trim(),
    forbidden: cleanList(input.forbidden ?? []),
    budget: {
      perRunUsd: input.budget?.perRunUsd ?? null,
      perDayUsd: input.budget?.perDayUsd ?? null,
    },
    trigger: input.trigger ?? { kind: 'manual' },
    report: input.report ?? 'task',
    deliverables: normalizeDeliverables(input.deliverables),
  }
}

/** What a one-off proposal creates: the same program with a manual trigger. */
export function programOfProposal(p: ProposalPayload): ProposedProgram {
  return p.runOnce ? { ...p.program, trigger: { kind: 'manual' } } : p.program
}

export const isEmptyAuthority = (a: ProgramAuthority): boolean =>
  a.tools.length + a.connectors.length + a.read.length + a.write.length === 0

/** `base` widened by `extra` (union per field; order kept). */
export function mergeAuthority(base: ProgramAuthority, extra: ProgramAuthority): ProgramAuthority {
  return {
    tools: cleanList([...base.tools, ...extra.tools]),
    connectors: cleanList([...base.connectors, ...extra.connectors]),
    read: cleanList([...base.read, ...extra.read]),
    write: cleanList([...base.write, ...extra.write]),
  }
}

/** The lines of an authority as a person reads them (the UI and the markdown body use the same). */
export function authorityLines(a: ProgramAuthority): string[] {
  return [
    ...a.tools.map((t) => `use ${t}`),
    ...a.connectors.map((c) => `every tool of connector ${c}`),
    ...a.read.map((g) => `read ${g}`),
    ...a.write.map((g) => `read and write ${g}`),
  ]
}

/** Checks an amendment's authority (rules and globs), with the same rules as a program's. */
export function normalizeAmendmentAuthority(
  a: Partial<ProgramAuthority> | undefined,
): ProgramAuthority {
  checkProgramFields({ authority: a })
  const out = normalizeAuthority(a)
  if (isEmptyAuthority(out)) {
    throw invalid('an amendment must name at least one tool, connector or path', 'INVALID_DECISION')
  }
  return out
}

// --- text ---------------------------------------------------------------------------------------

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n')

/** Markdown body of a decision made from a final report that said `needs_decision`. */
export function reportBody(report: TaskReport): string {
  return [
    '## What the run says',
    report.summary,
    ...(report.notes === undefined || report.notes === '' ? [] : ['', '## Notes', report.notes]),
    ...(report.outputs.length === 0 ? [] : ['', '## Produced so far', bullets(report.outputs)]),
  ].join('\n')
}

/** Markdown body of an amendment: why. What it grants is a list of its own (`authorityLines`). */
export function amendmentBody(programName: string, a: AmendmentPayload): string {
  return [
    `The run of **${programName}** needs more authority than it was given.`,
    '',
    '## Why',
    a.why,
  ].join('\n')
}

/** The follow-up message of a decision about a session that is not parked (a report-made escalation). */
export function followUpText(decision: Pick<Decision, 'title'>, answer: DecisionAnswer): string {
  return [
    `The client decided on "${decision.title}": ${answer.decision}.`,
    ...(answer.note === '' ? [] : [`Note from the client: ${answer.note}`]),
    answer.decision === 'rejected'
      ? 'Do not do what was asked. Finish what is inside your authority and report.'
      : 'Continue the work with this decision and end with your final report.',
    // without this a run whose blocker stays (a deliverable it cannot write) reports
    // needs_decision again and opens the same decision after every answer
    "The client has decided: do not report 'needs_decision' about this again. Use 'done' or " +
      "'partial' and say what is missing.",
  ].join('\n')
}

/** Description of the tools, written once (the tool texts and the prompts share the wording). */
export const ESCALATE_DESCRIPTION =
  'Stop and ask the client for a decision, then wait for it. Use it when a gate or an escalation ' +
  'rule of your brief applies, when something looks wrong or unsafe, or when a choice is not ' +
  'yours to make. State the question and what you found (markdown, with library paths as ' +
  'evidence). Give `options` when there are clear alternatives (2-6 short labels), otherwise the ' +
  'client approves or rejects. Your run is paused until the client answers, then continues in ' +
  'this same conversation: the tool result is { decision, note } where decision is "approved", ' +
  '"rejected" or the option picked. Do not ask for tool permissions with this: use ' +
  '`request_authority` for that. Do not call it for things inside your authority.'

export const REQUEST_AUTHORITY_DESCRIPTION =
  'Ask the client to widen the authority of this program when your work needs a tool, connector ' +
  'or library path it was not granted (a call was refused as outside the authority). Name exactly ' +
  'what you need (`tools`, `connectors`, `read`, `write` globs) and why. Your run is paused until ' +
  'the client answers, then continues in this same conversation: the tool result is ' +
  '{ decision, note } where decision is "approved" (the authority is added, retry your call) or ' +
  '"rejected" (do not retry; finish what is inside your authority and report what you could not do).'

export const PROPOSE_PLAN_DESCRIPTION =
  'Propose a plan to the client for approval: a one-off piece of work (`runOnce: true`) or a ' +
  'standing program (`runOnce: false`, optionally with a schedule). The plan is a program: name, ' +
  'brief (what to do, step by step), the authority it needs (tools, connectors, library paths), ' +
  'what still needs a decision (gates), forbidden actions and a budget. `body` is the pitch for ' +
  'the client in markdown: the goal, the steps, why, and links to the evidence (library paths). ' +
  '`agent` (required) is the slug of the agent that will run it. An open proposal that says the ' +
  'same thing is not created twice: you are told which one exists. This does not start anything and does ' +
  'not pause you: the client approves, edits or rejects it in the Decision Center. Ask for the ' +
  'least authority that does the job.'
