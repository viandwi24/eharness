/**
 * Program use cases (docs/plans/P40-team-autonomous-operations.md, D4). A program with a schedule
 * trigger owns one routine row (`routines.program_id`): the routine service claims the slots,
 * keeps the overlap, recovery and failure rules, and starts the run through the program runner.
 * Every run is a task session, so the run history is the tasks of the program.
 */

import { activeMemory, type RememberedDecision } from '../domain/decision-memory.ts'
import { normalizeDeliverables } from '../domain/deliverables.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import {
  type AuthorityInspection,
  checkProgramFields,
  cleanList,
  type EffectiveGrant,
  normalizeAuthority,
  normalizeWorker,
  type Program,
  type ProgramAuthority,
  type ProgramBudget,
  type ProgramDraft,
  type ProgramTrigger,
  type ProgramWarning,
} from '../domain/programs.ts'
import type { Routine } from '../domain/routines.ts'
import type { Task } from '../domain/tasks.ts'
import { getAgent } from './agents.ts'
import type { Deps, ProgramPatch } from './ports.ts'
import {
  createRoutine,
  deleteRoutine,
  pauseRoutine,
  resumeRoutine,
  updateRoutine,
} from './routines.ts'

/** What the schedule trigger of a program is doing (its routine), for the UI. */
export interface ProgramTriggerState {
  status: Routine['status']
  pausedReason: Routine['pausedReason']
  nextFireAt: number | null
  lastFireAt: number | null
  lastStatus: string | null
  failures: number
}

export type ProgramView = Program & { triggerState: ProgramTriggerState | null }

function routineOf(deps: Deps, programId: string): Routine | undefined {
  return deps.routines.getByProgram(programId)
}

export function programView(deps: Deps, program: Program): ProgramView {
  const r = routineOf(deps, program.id)
  return {
    ...program,
    triggerState:
      r === undefined
        ? null
        : {
            status: r.status,
            pausedReason: r.pausedReason,
            nextFireAt: r.nextFireAt,
            lastFireAt: r.lastFireAt,
            lastStatus: r.lastStatus,
            failures: r.failures,
          },
  }
}

export function getProgram(deps: Deps, id: string): Program {
  const program = deps.programs.get(id)
  if (program === undefined) throw notFound('program', id)
  return program
}

export function listPrograms(deps: Deps, query: { agentId?: string }): ProgramView[] {
  const agentId = query.agentId === undefined ? undefined : getAgent(deps, query.agentId).id
  return deps.programs
    .list(agentId === undefined ? {} : { agentId })
    .map((p) => programView(deps, p))
}

const changed = (deps: Deps, program: Pick<Program, 'id' | 'agentId' | 'name'>, change: string) =>
  deps.events.append({
    type: 'program-changed',
    agentId: program.agentId,
    payload: { programId: program.id, name: program.name, change },
  })

function ensureScheduleRoutine(deps: Deps, program: Program): void {
  if (program.trigger.kind !== 'schedule') return
  deps.schedule.validate(program.trigger.spec)
  const existing = routineOf(deps, program.id)
  if (existing === undefined) {
    createRoutine(deps, {
      agentId: program.agentId,
      name: `Program: ${program.name}`.slice(0, 120),
      prompt: `Run of program ${program.id}`,
      schedule: program.trigger.spec,
      sessionMode: 'task',
      overlap: 'skip',
      programId: program.id,
    })
  }
}

/**
 * Checks an authority against what the agent really has: unambiguous connector names are repaired
 * to real ids, anything else that cannot work is refused with the valid options. Returns the
 * authority to store. Skipped (returned as given) when the agent was never activated.
 */
export function enforceAuthority(
  deps: Deps,
  agentId: string,
  authority: ProgramAuthority,
): ProgramAuthority {
  const inspection = deps.programRunner.inspect(agentId, authority)
  if (inspection === undefined) return authority
  if (inspection.errors.length > 0) {
    throw invalid(
      `The authority names things this agent does not have. ${inspection.errors.join(' ')}`,
      'INVALID_PROGRAM',
    )
  }
  return inspection.authority
}

export function createProgram(
  deps: Deps,
  draft: ProgramDraft & { createdBy?: string | undefined },
): ProgramView {
  const agent = getAgent(deps, draft.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  checkProgramFields(draft)
  const trigger: ProgramTrigger = draft.trigger ?? { kind: 'manual' }
  if (trigger.kind === 'schedule') deps.schedule.validate(trigger.spec)
  const now = deps.clock.now()
  const program = deps.programs.insert({
    id: deps.ids.next(),
    agentId: agent.id,
    name: draft.name.trim(),
    brief: draft.brief.trim(),
    authority: enforceAuthority(deps, agent.id, normalizeAuthority(draft.authority)),
    gates: cleanList(draft.gates ?? []),
    escalation: (draft.escalation ?? '').trim(),
    forbidden: cleanList(draft.forbidden ?? []),
    budget: {
      perRunUsd: draft.budget?.perRunUsd ?? null,
      perDayUsd: draft.budget?.perDayUsd ?? null,
      maxOutputTokens: draft.budget?.maxOutputTokens ?? null,
    },
    trigger,
    report: draft.report ?? 'task',
    worker: normalizeWorker(draft.worker),
    deliverables: normalizeDeliverables(draft.deliverables),
    status: draft.status ?? 'active',
    createdBy: draft.createdBy ?? 'client',
    now,
  })
  ensureScheduleRoutine(deps, program)
  const routine = routineOf(deps, program.id)
  if (program.status === 'paused' && routine !== undefined) pauseRoutine(deps, routine.id)
  changed(deps, program, 'created')
  return programView(deps, program)
}

export type ProgramUpdate = Partial<Omit<ProgramDraft, 'agentId'>> & {
  version?: number | undefined
}

export function updateProgram(deps: Deps, id: string, update: ProgramUpdate): ProgramView {
  const current = getProgram(deps, id)
  if (update.version !== undefined && update.version !== current.version) {
    throw conflict('the program was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  checkProgramFields(update)
  if (update.trigger?.kind === 'schedule') deps.schedule.validate(update.trigger.spec)
  const patch: ProgramPatch = {
    ...(update.name === undefined ? {} : { name: update.name.trim() }),
    ...(update.brief === undefined ? {} : { brief: update.brief.trim() }),
    ...(update.authority === undefined
      ? {}
      : {
          authority: enforceAuthority(
            deps,
            current.agentId,
            normalizeAuthority({ ...current.authority, ...update.authority }),
          ),
        }),
    ...(update.gates === undefined ? {} : { gates: cleanList(update.gates) }),
    ...(update.escalation === undefined ? {} : { escalation: update.escalation.trim() }),
    ...(update.forbidden === undefined ? {} : { forbidden: cleanList(update.forbidden) }),
    ...(update.budget === undefined ? {} : { budget: { ...current.budget, ...update.budget } }),
    ...(update.trigger === undefined ? {} : { trigger: update.trigger }),
    ...(update.report === undefined ? {} : { report: update.report }),
    ...(update.worker === undefined ? {} : { worker: normalizeWorker(update.worker) }),
    ...(update.deliverables === undefined
      ? {}
      : { deliverables: normalizeDeliverables(update.deliverables) }),
  }
  if (update.status !== undefined && update.status !== current.status) {
    throw invalid('use pause and resume to change the status', 'INVALID_PROGRAM')
  }
  const next = deps.programs.update(id, patch, deps.clock.now()) as Program

  // the schedule trigger follows: a new schedule, a first one, or none any more
  const routine = routineOf(deps, id)
  if (next.trigger.kind === 'schedule') {
    if (routine === undefined) {
      ensureScheduleRoutine(deps, next)
      const created = routineOf(deps, id)
      if (next.status === 'paused' && created !== undefined) pauseRoutine(deps, created.id)
    } else if (update.trigger !== undefined) {
      updateRoutine(deps, routine.id, { schedule: next.trigger.spec })
    }
  } else if (routine !== undefined) {
    deleteRoutine(deps, routine.id)
  }
  const after = routineOf(deps, id)
  if (after !== undefined && update.name !== undefined) {
    updateRoutine(deps, after.id, { name: `Program: ${next.name}`.slice(0, 120) })
  }
  changed(deps, next, 'updated')
  return programView(deps, next)
}

export function deleteProgram(deps: Deps, id: string): Program {
  const program = getProgram(deps, id)
  const routine = routineOf(deps, id)
  if (routine !== undefined) deleteRoutine(deps, routine.id)
  deps.programs.delete(id)
  // its rehearsals and test cases go with it
  deps.rehearsals.deleteByProgram(id)
  deps.programTests.deleteByProgram(id)
  deps.programMemory.deleteByProgram(id)
  changed(deps, program, 'deleted')
  return program
}

/** Pausing stops the schedule trigger; a run in progress finishes. */
export function pauseProgram(deps: Deps, id: string): ProgramView {
  const program = getProgram(deps, id)
  const routine = routineOf(deps, id)
  if (routine !== undefined && routine.status === 'active') pauseRoutine(deps, routine.id)
  const next =
    program.status === 'paused'
      ? program
      : (deps.programs.update(id, { status: 'paused' }, deps.clock.now()) as Program)
  changed(deps, next, 'paused')
  return programView(deps, next)
}

/** Resuming recomputes the next slot from now (nothing missed while paused fires). */
export function resumeProgram(deps: Deps, id: string): ProgramView {
  const program = getProgram(deps, id)
  const agent = getAgent(deps, program.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const routine = routineOf(deps, id)
  if (routine !== undefined && routine.status !== 'active') resumeRoutine(deps, routine.id)
  const next =
    program.status === 'active'
      ? program
      : (deps.programs.update(id, { status: 'active' }, deps.clock.now()) as Program)
  changed(deps, next, 'resumed')
  return programView(deps, next)
}

/** The runs of a program, newest first: its task sessions. */
export function programRuns(deps: Deps, id: string, limit = 50): Task[] {
  getProgram(deps, id)
  return deps.tasks.ofProgram(id, limit)
}

/**
 * Run now (a manual run; the schedule is untouched). One run at a time: while a run of this
 * program is going or waits, a second one is refused (`409 PROGRAM_BUSY`).
 */
export async function runProgramNow(
  deps: Deps,
  id: string,
): Promise<{ sessionId: string | null; taskId: string | null; started: boolean; idle: boolean }> {
  const program = getProgram(deps, id)
  const agent = getAgent(deps, program.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const active = deps.tasks
    .ofProgram(id, 20)
    .find((t) => t.status === 'running' || t.status === 'needs_action')
  if (active !== undefined) {
    throw conflict('a run of this program is still going', 'PROGRAM_BUSY', {
      sessionId: active.sessionId,
    })
  }
  const started = await deps.programRunner.start(program, { runAt: deps.clock.now() })
  if (started.idle === true) return { sessionId: null, taskId: null, started: false, idle: true }
  return {
    sessionId: started.sessionId,
    taskId: deps.tasks.getBySession(started.sessionId)?.id ?? null,
    started: started.started,
    idle: false,
  }
}

/**
 * What a program (or a draft of one) cannot do: tools its authority names that the agent never has
 * and a budget below the cost of one model call. Warnings, never errors: the editor shows them
 * while the client types, and a save still works.
 */
export async function checkProgramDraft(
  deps: Deps,
  draft: {
    agentId: string
    authority?: Partial<ProgramAuthority> | undefined
    budget?: Partial<ProgramBudget> | undefined
  },
): Promise<ProgramWarning[]> {
  const agent = getAgent(deps, draft.agentId)
  return deps.programRunner.check({
    agentId: agent.id,
    authority: normalizeAuthority(draft.authority),
    budget: {
      perRunUsd: draft.budget?.perRunUsd ?? null,
      perDayUsd: draft.budget?.perDayUsd ?? null,
      maxOutputTokens: draft.budget?.maxOutputTokens ?? null,
    },
  })
}

/** The effective grant of an authority (resolved tools per connector), for the editor and cards. */
export async function authorityGrant(
  deps: Deps,
  agentId: string,
  authority: Partial<ProgramAuthority> | undefined,
  options: { activate?: boolean } = {},
): Promise<AuthorityInspection | null> {
  const agent = getAgent(deps, agentId)
  // a read (a program view) must not open connector connections: it uses what is activated already
  if (options.activate !== false) await deps.programRunner.prepare(agent.id)
  return deps.programRunner.inspect(agent.id, normalizeAuthority(authority)) ?? null
}

/** A saved program with its warnings and effective grant (`POST` / `PATCH` / `GET` answers). */
export async function programWithWarnings(
  deps: Deps,
  view: ProgramView,
): Promise<ProgramView & { warnings: ProgramWarning[]; grant: EffectiveGrant | null }> {
  const inspection = await authorityGrant(deps, view.agentId, view.authority)
  return {
    ...view,
    warnings: await checkProgramDraft(deps, view),
    grant: inspection?.grant ?? null,
  }
}

/**
 * Boot repair: connector names of stored programs that map to exactly one real connection
 * (`tracker-demo` for the connection whose tool prefix it is) are rewritten to its id. Anything
 * ambiguous or unknown is left alone. Idempotent; never throws.
 */
export async function repairProgramAuthorities(deps: Deps): Promise<number> {
  let n = 0
  for (const program of deps.programs.list({})) {
    try {
      if (program.authority.connectors.length === 0) continue
      // no activation here: boot runs this after the connectors are prepared; an agent that is not
      // activated (inspect returns undefined) is repaired on a later boot
      const inspection = deps.programRunner.inspect(program.agentId, program.authority)
      if (inspection === undefined || inspection.repaired.length === 0) continue
      deps.programs.update(program.id, { authority: inspection.authority }, deps.clock.now())
      changed(deps, program, 'authority repaired')
      n++
    } catch {
      // a repair is best effort
    }
  }
  return n
}

/** What the client already settled for this program (not expired): the program page lists it. */
export function programMemory(deps: Deps, id: string): RememberedDecision[] {
  getProgram(deps, id)
  return activeMemory(deps.programMemory.list(id), deps.clock.now())
}

export function forgetProgramMemory(deps: Deps, id: string, memoryId: string): void {
  getProgram(deps, id)
  if (!deps.programMemory.forget(id, memoryId, deps.clock.now())) {
    throw notFound('remembered decision', memoryId)
  }
}
