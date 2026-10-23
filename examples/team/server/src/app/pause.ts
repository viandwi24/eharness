/**
 * Pause all use cases (`domain/pause.ts`). The gate is read from the database by the code that
 * starts automatic work (`routine-service.ts`, `work-queue.ts`, the retry and heartbeat services,
 * the channel gateway); nothing here touches the status of a program, routine or reminder.
 */
import { parseSystemKey } from '../domain/heartbeat.ts'
import {
  checkPauseRequest,
  isPaused,
  PAUSED_SKIP_REASON,
  type PauseRequest,
  type WorkspacePause,
} from '../domain/pause.ts'
import type { Deps } from './ports.ts'
import { dispatchQueue } from './work-queue.ts'

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The longest note a pause takes (the route schema reads it from here). */
export { MAX_PAUSE_NOTE_CHARS } from '../domain/pause.ts'

/** What would fire right now if the workspace ran: what a pause holds. */
export interface PauseHeld {
  programs: number
  routines: number
  reminders: number
  heartbeat: boolean
  digest: boolean
  queuedTasks: number
  runningTurns: number
}

export interface PauseView extends WorkspacePause {
  paused: boolean
  held: PauseHeld
  /** Runs recorded as skipped while paused, since the pause began (0 when not paused). */
  skippedWhilePaused: number
}

/** The gate, as a cheap single-row read (every tick and decision asks). */
export const workspacePaused = (deps: Pick<Deps, 'pause'>): boolean => isPaused(deps.pause.get())

export function heldCounts(deps: Deps): PauseHeld {
  const systemKeys = deps.routines.activeSystemKeys().flatMap((k) => parseSystemKey(k) ?? [])
  return {
    programs: deps.programs.list({}).filter((p) => p.status === 'active').length,
    routines: deps.routines.list({}).filter((r) => r.status === 'active').length,
    reminders: systemKeys.filter((k) => k.kind === 'reminder').length,
    heartbeat: systemKeys.some((k) => k.kind === 'heartbeat'),
    digest: systemKeys.some((k) => k.kind === 'digest'),
    queuedTasks: deps.tasks.list({ status: 'queued', limit: 500 }).length,
    runningTurns: deps.tasks.list({ status: 'running', limit: 500 }).length,
  }
}

export function pauseView(deps: Deps): PauseView {
  const state = deps.pause.get()
  return {
    ...state,
    paused: isPaused(state),
    held: heldCounts(deps),
    skippedWhilePaused:
      state.pausedAt === null ? 0 : deps.routines.countSkipped(PAUSED_SKIP_REASON, state.pausedAt),
  }
}

const changed = (deps: Deps, change: 'paused' | 'resumed', extra: Record<string, unknown>): void =>
  deps.events.append({ type: 'settings-changed', payload: { keys: ['pause'], change, ...extra } })

/**
 * Pause everything automatic. Idempotent: pausing again updates the note and the channel hold and
 * keeps the original `pausedAt`. `stopRunning` aborts the runs of the task board the way the Stop
 * button does (their open tool calls get the `Interrupted:` results).
 */
export async function pauseWorkspace(
  deps: Deps,
  request: PauseRequest,
  by = 'owner',
): Promise<PauseView> {
  checkPauseRequest(request)
  const current = deps.pause.get()
  const now = deps.clock.now()
  const note = request.note?.trim() ?? ''
  deps.pause.set(
    {
      pausedAt: current.pausedAt ?? now,
      pausedBy: current.pausedAt === null ? by : current.pausedBy,
      note: note === '' ? null : note,
      holdChannels: request.holdChannels ?? true,
    },
    now,
  )
  changed(deps, 'paused', {
    holdChannels: request.holdChannels ?? true,
    stopRunning: request.stopRunning === true,
  })
  if (request.stopRunning === true && deps.interruptRun !== undefined) {
    for (const task of deps.tasks.list({ status: 'running', limit: 500 })) {
      try {
        await deps.interruptRun(task, 'paused')
      } catch (error) {
        console.warn(`team: could not stop ${task.id} for the pause: ${reason(error)}`)
      }
    }
  }
  return pauseView(deps)
}

/**
 * Resume: the gate opens, queued tasks start now and the routines tick runs, so held work does
 * not wait for the next timer. Slots skipped while paused stay skipped.
 */
export function resumeWorkspace(deps: Deps): PauseView {
  const was = deps.pause.get()
  deps.pause.clear(deps.clock.now())
  if (was.pausedAt !== null) {
    changed(deps, 'resumed', {
      pausedAt: was.pausedAt,
      skipped: deps.routines.countSkipped(PAUSED_SKIP_REASON, was.pausedAt),
    })
  }
  try {
    dispatchQueue(deps)
  } catch (error) {
    console.warn(`team: dispatch after resume failed: ${reason(error)}`)
  }
  void deps.routineEngine?.tick?.()
  return pauseView(deps)
}
