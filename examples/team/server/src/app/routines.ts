/** Routine use cases: the schedule rows; firing is `infra/eh/routine-service.ts`. */
import { conflict, notFound } from '../domain/errors.ts'
import {
  checkRoutineFields,
  DEFAULT_MAX_FAILURES,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  type RoutineSpec,
} from '../domain/routines.ts'
import { getAgent } from './agents.ts'
import type { Deps, RoutinePatch } from './ports.ts'

export function getRoutine(deps: Deps, id: string): Routine {
  const routine = deps.routines.get(id)
  if (routine === undefined) throw notFound('routine', id)
  return routine
}

export function listRoutines(deps: Deps, query: { agentId?: string }): Routine[] {
  const agentId = query.agentId === undefined ? undefined : getAgent(deps, query.agentId).id
  return deps.routines.list(agentId === undefined ? {} : { agentId })
}

function firstSlot(deps: Deps, spec: RoutineSpec, now: number): number {
  const slot = deps.schedule.next(spec, now)
  if (slot === null) {
    throw conflict('the schedule has no slot after now', 'SCHEDULE_EXHAUSTED')
  }
  return slot
}

export function createRoutine(deps: Deps, draft: RoutineDraft): Routine {
  const agent = getAgent(deps, draft.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  checkRoutineFields(draft)
  deps.schedule.validate(draft.schedule)
  const now = deps.clock.now()
  const routine = deps.routines.insert({
    id:
      draft.id !== undefined && draft.id !== '' && deps.routines.get(draft.id) === undefined
        ? draft.id
        : deps.ids.next(),
    agentId: agent.id,
    name: draft.name.trim(),
    prompt: draft.prompt,
    schedule: draft.schedule,
    sessionMode: draft.sessionMode ?? 'task',
    overlap: draft.overlap ?? 'skip',
    catchUpWindowMs: draft.catchUpWindowMs ?? null,
    maxFailures: draft.maxFailures ?? DEFAULT_MAX_FAILURES,
    maxFires: draft.maxFires ?? null,
    endAt: draft.endAt ?? null,
    programId: draft.programId ?? null,
    nextFireAt: firstSlot(deps, draft.schedule, now),
    now,
  })
  deps.events.append({
    type: 'routine-changed',
    agentId: routine.agentId,
    payload: { routineId: routine.id, name: routine.name, change: 'created' },
  })
  return routine
}

export type RoutineUpdate = Partial<Omit<RoutineDraft, 'agentId'>> & { version?: number }

export function updateRoutine(deps: Deps, id: string, update: RoutineUpdate): Routine {
  const current = getRoutine(deps, id)
  if (update.version !== undefined && update.version !== current.version) {
    throw conflict('the routine was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  checkRoutineFields(update)
  const patch: RoutinePatch = {
    ...(update.name === undefined ? {} : { name: update.name.trim() }),
    ...(update.prompt === undefined ? {} : { prompt: update.prompt }),
    ...(update.sessionMode === undefined ? {} : { sessionMode: update.sessionMode }),
    ...(update.overlap === undefined ? {} : { overlap: update.overlap }),
    ...(update.catchUpWindowMs === undefined ? {} : { catchUpWindowMs: update.catchUpWindowMs }),
    ...(update.maxFailures === undefined ? {} : { maxFailures: update.maxFailures }),
    ...(update.maxFires === undefined ? {} : { maxFires: update.maxFires }),
    ...(update.endAt === undefined ? {} : { endAt: update.endAt }),
  }
  const now = deps.clock.now()
  if (update.schedule !== undefined) {
    deps.schedule.validate(update.schedule)
    patch.schedule = update.schedule
    // an active routine gets its next slot from the new schedule; a paused one on resume
    if (current.status === 'active') patch.nextFireAt = firstSlot(deps, update.schedule, now)
  }
  const next = deps.routines.update(id, patch, now) as Routine
  deps.events.append({
    type: 'routine-changed',
    agentId: next.agentId,
    payload: { routineId: next.id, name: next.name, change: 'updated' },
  })
  return next
}

export function deleteRoutine(deps: Deps, id: string): Routine {
  const routine = getRoutine(deps, id)
  deps.routines.delete(id)
  deps.events.append({
    type: 'routine-changed',
    agentId: routine.agentId,
    payload: { routineId: id, name: routine.name, change: 'deleted' },
  })
  return routine
}

export function pauseRoutine(deps: Deps, id: string): Routine {
  const routine = getRoutine(deps, id)
  if (routine.status === 'paused') return routine
  const next = deps.routines.update(
    id,
    { status: 'paused', pausedReason: 'manual' },
    deps.clock.now(),
  ) as Routine
  deps.events.append({
    type: 'routine-changed',
    agentId: next.agentId,
    payload: { routineId: id, name: next.name, change: 'paused', reason: 'manual' },
  })
  return next
}

/** Resume recomputes the next slot from now: nothing missed while paused ever fires. */
export function resumeRoutine(deps: Deps, id: string): Routine {
  const routine = getRoutine(deps, id)
  if (routine.status === 'active') return routine
  const agent = getAgent(deps, routine.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  const now = deps.clock.now()
  if (routine.endAt !== null && routine.endAt <= now) {
    throw conflict('the routine has ended; change endAt first', 'ROUTINE_ENDED')
  }
  if (routine.maxFires !== null && routine.fireCount >= routine.maxFires) {
    throw conflict('the routine reached maxFires; raise it first', 'ROUTINE_EXHAUSTED')
  }
  const nextFireAt = firstSlot(deps, routine.schedule, now)
  const next = deps.routines.update(
    id,
    { status: 'active', pausedReason: null, failures: 0, nextFireAt },
    now,
  ) as Routine
  deps.events.append({
    type: 'routine-changed',
    agentId: next.agentId,
    payload: { routineId: id, name: next.name, change: 'resumed' },
  })
  return next
}

export async function runRoutineNow(deps: Deps, id: string): Promise<RoutineRun> {
  const routine = getRoutine(deps, id)
  const agent = getAgent(deps, routine.agentId)
  if (agent.archivedAt !== null) throw conflict('the agent is archived', 'AGENT_ARCHIVED')
  return deps.routineEngine.runNow(routine)
}

export function routineRuns(deps: Deps, id: string, limit = 50): RoutineRun[] {
  getRoutine(deps, id)
  return deps.routines.runs(id, limit)
}

/** What waits in the session that keeps this routine from firing ("an input is still queued"). */
export async function routineQueue(deps: Deps, id: string) {
  return deps.routineEngine.queue(getRoutine(deps, id))
}

/** Clears that queue; the next fire runs. Returns how many inputs were removed. */
export async function clearRoutineQueue(deps: Deps, id: string): Promise<number> {
  const routine = getRoutine(deps, id)
  const removed = await deps.routineEngine.clearQueue(routine)
  deps.events.append({
    type: 'routine-changed',
    agentId: routine.agentId,
    payload: { routineId: id, name: routine.name, change: 'queue cleared', removed },
  })
  return removed
}
