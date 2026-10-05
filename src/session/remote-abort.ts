/**
 * Cross-process abort through state compare-and-set (internal): the requester side
 * (`session.requestAbort()` when no local turn runs) and the owner side (the bounded poll of a
 * running turn).
 *
 * @see docs/specs/05-session-and-storage.md#91-cross-process-abort
 * @see docs/decisions/0021-cross-process-abort.md
 */
import type {
  AbortRequest,
  AbortRequestResult,
  SessionStateSnapshot,
  StateAdapter,
} from '../agent/session-types.ts'
import { HarnessError, type HarnessWarning, isHarnessError } from '../errors.ts'

/** Default `recovery.staleMs`. */
export const DEFAULT_STALE_MS = 120_000
/** Default `recovery.abortPollMs`. */
export const DEFAULT_ABORT_POLL_MS = 2_000
/** Conflicting request writes retried (re-read) before giving up. */
const REQUEST_RETRIES = 3

/** What {@link requestRemoteAbort} needs. */
export interface RemoteAbortDeps {
  sessionId: string
  adapter: StateAdapter
  /** Instance id of the requester (`ActiveTurn.owner` of its own turns). */
  owner: string
  /** `recovery.staleMs`, or `false` when recovery is disabled. */
  staleMs: number | false
  warn(warning: HarnessWarning, key?: string): void
  /** Called after the request was written (the requester's cached state is stale now). */
  written?(): void
}

function storageError(cause: unknown): HarnessError {
  if (isHarnessError(cause)) return cause
  return new HarnessError('EH_STORAGE', 'State storage failed (abort request).', { cause })
}

function unsupported(deps: RemoteAbortDeps, why: string): AbortRequestResult {
  deps.warn(
    {
      code: 'W_ABORT_UNSUPPORTED',
      message: `Cannot abort a turn running in another instance: ${why}.`,
      details: { sessionId: deps.sessionId },
    },
    'abort-unsupported',
  )
  return { target: 'unsupported' }
}

/**
 * Request the abort of a turn of this session running in another instance (spec 05 §9.1 rule 1):
 * read the state; no live foreign `activeTurn` → `'idle'` (nothing written); otherwise write
 * `core.abortRequest` for that turn with `setIf`, re-reading on conflict (at most 3 retries).
 * A retry that finds another turn active returns `'idle'`: the targeted turn ended, and a late
 * Stop never aborts the next turn (rule 2). Rejects with `EH_STORAGE` when the adapter fails and
 * `EH_SESSION_BUSY` when every retry conflicted.
 */
export async function requestRemoteAbort(
  deps: RemoteAbortDeps,
  reason: string | undefined,
): Promise<AbortRequestResult> {
  if (deps.staleMs === false) return unsupported(deps, 'crash recovery is disabled')
  const staleMs = deps.staleMs
  let target: string | undefined
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    let stored: SessionStateSnapshot | null
    try {
      stored = await deps.adapter.get(deps.sessionId)
    } catch (error) {
      throw storageError(error)
    }
    const active = stored?.core?.activeTurn
    const live =
      stored !== null &&
      active !== undefined &&
      active.owner !== deps.owner &&
      Date.now() - active.heartbeatAt <= staleMs
    if (!live || stored === null || active === undefined) return { target: 'idle' }
    if (target !== undefined && active.turnId !== target) return { target: 'idle' }
    target = active.turnId
    if (stored.core.abortRequest?.turnId === target) return { target: 'remote' } // already asked
    if (deps.adapter.setIf === undefined) {
      return unsupported(deps, 'the StateAdapter has no setIf')
    }
    const request: AbortRequest = { turnId: target, at: Date.now(), by: deps.owner }
    if (reason !== undefined) request.reason = reason
    const rev = typeof stored.rev === 'number' ? stored.rev : 0
    const next: SessionStateSnapshot = {
      ...stored,
      rev: rev + 1,
      core: { ...stored.core, abortRequest: request },
    }
    let ok: boolean
    try {
      ok = await deps.adapter.setIf(deps.sessionId, next, stored.rev ?? null)
    } catch (error) {
      throw storageError(error)
    }
    if (ok) {
      deps.written?.()
      return { target: 'remote' }
    }
  }
  throw new HarnessError(
    'EH_SESSION_BUSY',
    'The abort request could not be written: the session state kept changing.',
    { details: { turnId: target } },
  )
}

/** The owner side: a bounded poll for an abort request of the running turn. */
export interface AbortPoll {
  /** Read the state if `intervalMs` passed since the last read; abort on a matching request. */
  poll(): Promise<void>
}

/**
 * Create the abort poll of turn `turnId` (spec 05 §9.1 rule 3): at most one state read per
 * `intervalMs`, the first one `intervalMs` after the commit point (turns shorter than that read
 * nothing). A request for another turn id is ignored (the next owner write clears it).
 */
export function createAbortPoll(args: {
  turnId: string
  intervalMs: number
  peek(): Promise<SessionStateSnapshot | null>
  abort(request: AbortRequest): void
  /** The turn ended or was aborted: no more reads. */
  done(): boolean
  onError(error: unknown): void
}): AbortPoll {
  let lastAt = Date.now()
  let inFlight = false
  return {
    async poll() {
      if (args.intervalMs <= 0 || inFlight || args.done()) return
      if (Date.now() - lastAt < args.intervalMs) return
      lastAt = Date.now()
      inFlight = true
      try {
        const request = (await args.peek())?.core?.abortRequest
        if (request?.turnId === args.turnId && !args.done()) args.abort(request)
      } catch (error) {
        args.onError(error)
      } finally {
        inFlight = false
      }
    },
  }
}
