/** Routine types (scheduler arrives in M7). Pure. */
export type RoutineSchedule =
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'every'; ms: number }

export interface Routine {
  id: string
  agentId: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  lastStatus: string | null
}

/** Deterministic id of one fire (plan §6.6, D3): a fire is idempotent. */
export const fireId = (routineId: string, scheduledAt: number): string =>
  `sched:${routineId}:${scheduledAt}`
