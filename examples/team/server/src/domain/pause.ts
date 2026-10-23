/**
 * Pause all: one durable gate for everything automatic. Pure.
 *
 * Pausing never changes the status of a program, routine, reminder or heartbeat: a single record
 * says "the workspace is paused since T", and the places that start work without a person read it.
 * Resuming deletes the record, so what was active is active again and what the owner had paused
 * one by one stays paused.
 */
import { invalid } from './errors.ts'

/** Reason of a slot the schedule recorded as skipped while the workspace was paused. */
export const PAUSED_SKIP_REASON = 'paused'
export const MAX_PAUSE_NOTE_CHARS = 500

export interface WorkspacePause {
  /** When the workspace was paused (ms); null = not paused. */
  pausedAt: number | null
  pausedBy: string | null
  note: string | null
  /** Inbound chat messages are kept but do not wake an agent. */
  holdChannels: boolean
}

export const NOT_PAUSED: WorkspacePause = {
  pausedAt: null,
  pausedBy: null,
  note: null,
  holdChannels: false,
}

export interface PauseRequest {
  note?: string | undefined
  /** Default true. */
  holdChannels?: boolean | undefined
  /** Stop agent turns that run now (default: they finish). */
  stopRunning?: boolean | undefined
}

export const isPaused = (p: WorkspacePause): boolean => p.pausedAt !== null

export function checkPauseRequest(r: PauseRequest): void {
  if (r.note !== undefined && r.note.length > MAX_PAUSE_NOTE_CHARS) {
    throw invalid(`note must be at most ${MAX_PAUSE_NOTE_CHARS} characters`, 'INVALID_PAUSE')
  }
}

/** What a person reads for a skip reason of a run row. */
export const skipReasonText = (reason: string | null): string | null =>
  reason === PAUSED_SKIP_REASON ? 'Skipped: workspace paused' : reason
