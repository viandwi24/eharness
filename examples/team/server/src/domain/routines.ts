/** Routines (plan §6.6, decision D3): types, validation and slot helpers. Pure. */
import { invalid } from './errors.ts'

export type RoutineSpec =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'every'; everyMs: number }
  | { kind: 'at'; at: number }

/** `dm` appends the fire to the agent's DM chat; `task` opens a new session per fire. */
export const SESSION_MODES = ['dm', 'task'] as const
export type SessionMode = (typeof SESSION_MODES)[number]

/** `skip` a fire while the previous one still runs (default), or `queue` it behind. */
export const OVERLAPS = ['skip', 'queue'] as const
export type Overlap = (typeof OVERLAPS)[number]

export const ROUTINE_STATUSES = ['active', 'paused'] as const
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number]

/** Why a routine is paused; `manual` is the only one a person set. */
export type PausedReason =
  | 'manual'
  | 'max-failures'
  | 'max-fires'
  | 'ended'
  | 'completed'
  | 'agent-archived'

export interface Routine {
  id: string
  agentId: string
  name: string
  prompt: string
  schedule: RoutineSpec
  sessionMode: SessionMode
  overlap: Overlap
  /** Missed fires after downtime are skipped (null) or the latest one fires if younger than this. */
  catchUpWindowMs: number | null
  status: RoutineStatus
  pausedReason: PausedReason | null
  nextFireAt: number | null
  lastFireAt: number | null
  lastStatus: string | null
  /** Consecutive failed runs. */
  failures: number
  maxFailures: number
  fireCount: number
  maxFires: number | null
  endAt: number | null
  createdAt: number
  updatedAt: number
}

export const RUN_STATUSES = [
  'claimed',
  'enqueued',
  'needs_action',
  'succeeded',
  'failed',
  'skipped',
] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

export interface RoutineRun {
  id: string
  routineId: string
  /** The slot this run is for (the unique key with `routineId`). */
  scheduledAt: number
  trigger: 'schedule' | 'manual'
  status: RunStatus
  sessionId: string
  inboxId: string | null
  /** Why a run was skipped or failed. */
  reason: string | null
  claimedAt: number
  firedAt: number | null
  finishedAt: number | null
}

export interface RoutineDraft {
  agentId: string
  name: string
  prompt: string
  schedule: RoutineSpec
  sessionMode?: SessionMode | undefined
  overlap?: Overlap | undefined
  catchUpWindowMs?: number | null | undefined
  maxFailures?: number | undefined
  maxFires?: number | null | undefined
  endAt?: number | null | undefined
}

export const DEFAULT_MAX_FAILURES = 3
/** Cost guard: nothing fires more often than this (cron is checked on two consecutive slots). */
export const MIN_EVERY_MS = 10_000
export const MAX_PROMPT_CHARS = 20_000

/** Deterministic id of one fire (plan §6.6, D3): a retried fire is a no-op. */
export const fireId = (routineId: string, scheduledAt: number): string =>
  `sched:${routineId}:${scheduledAt}`

/** Session of a fire: the agent's DM, or one session per fire (`routine:<id>:<scheduledAt>`). */
export const routineSessionId = (
  routine: Pick<Routine, 'id' | 'agentId' | 'sessionMode'>,
  scheduledAt: number,
): string =>
  routine.sessionMode === 'dm' ? `dm:${routine.agentId}` : `routine:${routine.id}:${scheduledAt}`

/** `routine:<id>:<scheduledAt>` -> its parts. */
export function parseRoutineSession(
  sessionId: string,
): { routineId: string; scheduledAt: number } | undefined {
  const m = /^routine:([^:]+):(\d+)$/.exec(sessionId)
  return m === null ? undefined : { routineId: m[1] as string, scheduledAt: Number(m[2]) }
}

/** Shape checks that need no clock or cron library. */
export function checkRoutineFields(f: {
  name?: string
  prompt?: string
  schedule?: RoutineSpec
  sessionMode?: string
  overlap?: string
  catchUpWindowMs?: number | null
  maxFailures?: number
  maxFires?: number | null
  endAt?: number | null
}): void {
  if (f.name !== undefined && (f.name.trim() === '' || f.name.length > 120)) {
    throw invalid('name must be 1-120 characters', 'INVALID_ROUTINE')
  }
  if (f.prompt !== undefined && (f.prompt.trim() === '' || f.prompt.length > MAX_PROMPT_CHARS)) {
    throw invalid(`prompt must be 1-${MAX_PROMPT_CHARS} characters`, 'INVALID_ROUTINE')
  }
  if (
    f.sessionMode !== undefined &&
    !(SESSION_MODES as readonly string[]).includes(f.sessionMode)
  ) {
    throw invalid(`sessionMode must be one of ${SESSION_MODES.join(', ')}`, 'INVALID_ROUTINE')
  }
  if (f.overlap !== undefined && !(OVERLAPS as readonly string[]).includes(f.overlap)) {
    throw invalid(`overlap must be one of ${OVERLAPS.join(', ')}`, 'INVALID_ROUTINE')
  }
  if (
    f.catchUpWindowMs != null &&
    (!Number.isInteger(f.catchUpWindowMs) || f.catchUpWindowMs < 1)
  ) {
    throw invalid('catchUpWindowMs must be a positive integer or null', 'INVALID_ROUTINE')
  }
  if (f.maxFailures !== undefined && (!Number.isInteger(f.maxFailures) || f.maxFailures < 1)) {
    throw invalid('maxFailures must be a positive integer', 'INVALID_ROUTINE')
  }
  if (f.maxFires != null && (!Number.isInteger(f.maxFires) || f.maxFires < 1)) {
    throw invalid('maxFires must be a positive integer or null', 'INVALID_ROUTINE')
  }
  if (f.schedule?.kind === 'every' && f.schedule.everyMs < MIN_EVERY_MS) {
    throw invalid(`everyMs must be at least ${MIN_EVERY_MS}`, 'INVALID_SCHEDULE')
  }
}
