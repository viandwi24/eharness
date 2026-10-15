/**
 * Automatic retry of turns that failed with a transient error and that nobody watches
 * (`domain/turn-retry.ts` has the policy). The turn hooks call `observe` when a turn ends and
 * `turnStarted` when one starts; a timer (`tick`) starts the due retries.
 *
 * Why a small table (`turn_retries`) and not the routines scheduler or the durable inbox: a retry
 * is not a prompt to enqueue (the inbox item is consumed by the turn that already ran) and not a
 * schedule slot (the routines table fires prompts at times, per routine). It is the continuation of
 * one session, so the row is keyed by session; it survives a restart and any instance can take it.
 *
 * The retry CONTINUES the session from its stored state (`session.send(undefined)`, with the report
 * spec of a program run): the tool calls and results the failed turn already stored stay, so
 * nothing that was done is done twice (`regenerate` would drop them).
 *
 * Eligible sessions: program runs (also the hand-back turn of a decision), routine runs, assigned
 * tasks and channel conversations. Not retried: a person's chat (they see the error and answer),
 * heartbeat beats (the next beat is the retry), delegated children (their parent was told at once
 * and decides) and rehearsals.
 *
 * A retry is cancelled when another turn starts first (a new message, a manual run), when the
 * session is busy or gone, or when the agent is archived. Many concurrent failures do not stampede
 * the provider: the delays have jitter.
 */
import type { HarnessSession } from 'eharness'
import { errorText } from 'eharness'
import { postNotice } from '../../app/briefings.ts'
import type { AgentRepo, Deps, TaskStore } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { conflict, notFound } from '../../domain/errors.ts'
import {
  classifyFailure,
  gaveUpText,
  MAX_RETRY_ATTEMPTS,
  maxAttemptsOf,
  type PendingRetry,
  retryDelayMs,
} from '../../domain/turn-retry.ts'
import { type RetryRow, type TurnRetryStore, toPending } from '../db/turn-retries-repo.ts'
import type { AgentFactory } from './agent-factory.ts'
import { continuationOptions } from './decision-service.ts'

/** What a turn end tells the service. */
export interface TurnEndFacts {
  sessionId: string
  turnId: string
  stop: string
  error?: { code: string; message: string } | undefined
}

/** What `observe` decided for a failed turn. */
export type RetryPlan =
  | { state: 'retrying'; attempt: number; max: number; nextAt: number; errorMessage: string }
  | { state: 'exhausted'; max: number; errorMessage: string }

/** The hooks the plugins call (late-bound: the service is built after the factory). */
export interface TurnRetryHooks {
  observe(facts: TurnEndFacts): RetryPlan | undefined
  turnStarted(sessionId: string, turnId: string): void
}

export interface TurnRetryService extends TurnRetryHooks {
  pending(sessionId: string): PendingRetry | undefined
  /** Every waiting retry, by session id (tasks, runs and the Health page read this). */
  waiting(): Map<string, PendingRetry>
  /** A retry of this session that ended without success (the last attempt failed), if any. */
  gaveUp(sessionId: string): boolean
  /** Cancel a pending retry (a new message or a manual run goes first). */
  cancel(sessionId: string): boolean
  /**
   * Continue a session now: the Retry button. Cancels the waiting retry; the next failure starts a
   * fresh series of attempts. Throws a conflict when the session is busy.
   */
  retryNow(sessionId: string): Promise<{ started: true }>
  /** Start the retries that are due. Returns how many were started. */
  tick(now?: number): Promise<number>
  start(): void
  stop(): Promise<void>
  /** Continuations started by this process that have not ended (tests wait for them). */
  idle(): Promise<void>
}

export interface TurnRetryDeps {
  store: TurnRetryStore
  agents: AgentRepo
  tasks: Pick<TaskStore, 'getBySession'>
  /** The agent that runs a session (`createSessionResolver`). */
  resolve: (sessionId: string) => { def: AgentDef } | undefined
  /** Late-bound app deps: the final failure rings the bell. */
  app?: () => Deps | undefined
  /**
   * A waiting retry was dropped without a turn (the agent was archived, the session is gone or
   * busy): the task and the run that showed it as retrying must not stay so. Never throws.
   */
  onAbandon?: (sessionId: string, why: string) => void
  /** Called after a retry turn ended (the deliverable re-check of a resumed run). */
  afterRun?: (sessionId: string) => Promise<void>
  /** Timer interval; 0 = no timer (tests call `tick`). Default 5 000. */
  tickMs?: number
  /** Lease of a started retry; a `running` row older than this and whose session is idle is retried again. */
  leaseMs?: number
  /**
   * Retry a failure the library could not name ("Unexpected error": a network reset, or a bug) a
   * couple of times. Default true; tests of plain failures turn it off.
   */
  retryUnknown?: boolean
  /** How long a busy session (a turn that is still closing) is waited for before the retry is dropped (ms). Default 3 000. */
  busyRetryMs?: number
  now?: () => number
  random?: () => number
  /** Delay before an attempt (ms); default the policy of `domain/turn-retry.ts` with jitter. Tests shorten it. */
  delayMs?: (attempt: number) => number
  log?: { warn(message: string): void }
}

const ELIGIBLE = /^(program|routine|task|channel):/

/** Whether a turn of this session is retried when it fails transiently. */
export const isRetryableSession = (sessionId: string): boolean =>
  ELIGIBLE.test(sessionId) && !sessionId.includes(':worker:') && !sessionId.includes(':agent:')

export function createTurnRetryService(
  factory: AgentFactory,
  deps: TurnRetryDeps,
): TurnRetryService {
  const { store } = deps
  const clock = deps.now ?? (() => Date.now())
  const random = deps.random ?? Math.random
  const log = deps.log ?? { warn() {} }
  const tickMs = deps.tickMs ?? 5000
  const leaseMs = deps.leaseMs ?? 600_000
  const busyRetryMs = deps.busyRetryMs ?? 3000
  const inflight = new Set<Promise<unknown>>()
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  const planOf = (row: RetryRow): RetryPlan =>
    row.state === 'failed'
      ? { state: 'exhausted', max: row.maxAttempts, errorMessage: row.errorMessage }
      : {
          state: 'retrying',
          attempt: row.attempt,
          max: row.maxAttempts,
          nextAt: row.nextAt,
          errorMessage: row.errorMessage,
        }

  /** One bell notice (deduplicated by key) when the last attempt did not help. */
  function noticeGaveUp(row: RetryRow, now: number): void {
    const app = deps.app?.()
    if (app === undefined) return
    const task = deps.tasks.getBySession(row.sessionId)
    const what =
      task?.title ?? (row.sessionId.startsWith('channel:') ? 'A chat reply' : row.sessionId)
    try {
      postNotice(app, {
        key: `turn-retry-failed:${row.sessionId}:${row.turnId}`,
        title: `${what} failed after ${row.maxAttempts} automatic retries`.slice(0, 160),
        body: `${gaveUpText(row.maxAttempts, row.errorMessage)} Open it and press Retry to continue it from where it stopped.`,
        link: task === undefined ? '/channels' : `/tasks/${task.id}`,
        agentId: row.agentId,
        at: now,
      })
    } catch (error) {
      log.warn(`turn retry notice of ${row.sessionId} not posted: ${errorText(error)}`)
    }
  }

  function observe(f: TurnEndFacts): RetryPlan | undefined {
    if (!isRetryableSession(f.sessionId)) return undefined
    const now = clock()
    const row = store.get(f.sessionId)
    // the same turn is reported by several hooks (task index, run outcome, channel): one count
    if (row !== undefined && row.turnId === f.turnId) return planOf(row)
    const classified = classifyFailure(f)
    const kind = classified === 'unknown' && deps.retryUnknown === false ? undefined : classified
    if (kind === undefined) {
      // a retry that worked, or a turn that ended for another reason: nothing is waiting any more
      if (row !== undefined) store.delete(f.sessionId)
      return undefined
    }
    const error = f.error as { code: string; message: string }
    const def = deps.resolve(f.sessionId)?.def
    const agentId = def?.id ?? row?.agentId ?? ''
    if (agentId === '' || def?.archivedAt != null || stopped) return undefined
    const max = maxAttemptsOf(kind)
    // a retry turn that failed again continues the series; any other failing turn starts one
    const made = row?.state === 'running' ? row.attempt : 0
    const next = made + 1
    if (next > max) {
      const failed = store.put(
        {
          sessionId: f.sessionId,
          agentId,
          turnId: f.turnId,
          attempt: made,
          maxAttempts: max,
          nextAt: now,
          errorCode: error.code,
          errorMessage: error.message,
          state: 'failed',
        },
        now,
      )
      noticeGaveUp(failed, now)
      return planOf(failed)
    }
    return planOf(
      store.put(
        {
          sessionId: f.sessionId,
          agentId,
          turnId: f.turnId,
          attempt: next,
          maxAttempts: max,
          nextAt: now + (deps.delayMs?.(next) ?? retryDelayMs(next, random)),
          errorCode: error.code,
          errorMessage: error.message,
          state: 'pending',
        },
        now,
      ),
    )
  }

  function turnStarted(sessionId: string, _turnId: string): void {
    const row = store.get(sessionId)
    // the retry's own turn finds its row `running`; any other turn goes first and cancels it
    if (row !== undefined && row.state !== 'running') store.delete(sessionId)
  }

  function abandon(sessionId: string, why: string): void {
    store.delete(sessionId)
    try {
      deps.onAbandon?.(sessionId, why)
    } catch (error) {
      log.warn(`turn retry abandon of ${sessionId} failed: ${errorText(error)}`)
    }
  }

  /** Continue the session; the turn hooks do the rest. Resolves when the turn has ended. */
  async function start(row: { sessionId: string }): Promise<void> {
    const resolved = deps.resolve(row.sessionId)
    const def = resolved?.def
    if (def === undefined || def.archivedAt !== null) {
      abandon(row.sessionId, 'the agent is gone or archived')
      return
    }
    let session: HarnessSession
    try {
      await factory.prepare(def)
      session = factory.openSession(def, row.sessionId) as HarnessSession
    } catch (error) {
      log.warn(`turn retry of ${row.sessionId} could not open the session: ${errorText(error)}`)
      abandon(row.sessionId, `the session could not be opened (${errorText(error)})`)
      return
    }
    let run: {
      result: Promise<{ turnId: string; stop: string; error?: { code: string; message: string } }>
    }
    // the failed turn may still be closing (its end hooks run just before the session is idle): a
    // busy session is tried again shortly, then the retry is dropped (something else works on it)
    const end = Date.now() + busyRetryMs
    for (;;) {
      try {
        run = session.send(undefined, continuationOptions(factory, def, row.sessionId) as never)
        break
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'EH_SESSION_BUSY' && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 40))
          continue
        }
        log.warn(`turn retry of ${row.sessionId} was refused: ${errorText(error)}`)
        abandon(row.sessionId, 'the session was busy (something else is working on it)')
        return
      }
    }
    const result = await run.result
    // a turn that failed before its hooks ran (a lock outage) is counted here: same turn id, one count
    if (result.stop === 'error') {
      observe({
        sessionId: row.sessionId,
        turnId: result.turnId,
        stop: result.stop,
        error: result.error,
      })
    }
    await deps.afterRun?.(row.sessionId).catch((error: unknown) => {
      log.warn(`turn retry follow-up of ${row.sessionId} failed: ${errorText(error)}`)
    })
  }

  const track = (p: Promise<void>): void => {
    const watched = p.catch((error: unknown) => log.warn(`turn retry failed: ${errorText(error)}`))
    inflight.add(watched)
    void watched.finally(() => inflight.delete(watched))
  }

  const service: TurnRetryService = {
    observe,
    turnStarted,
    pending: (sessionId) => {
      const row = store.get(sessionId)
      return row === undefined ? undefined : toPending(row)
    },
    waiting() {
      const out = new Map<string, PendingRetry>()
      for (const row of store.waiting()) {
        const p = toPending(row)
        if (p !== undefined) out.set(row.sessionId, p)
      }
      return out
    },
    gaveUp: (sessionId) => store.get(sessionId)?.state === 'failed',
    cancel: (sessionId) => store.delete(sessionId),

    async retryNow(sessionId) {
      const resolved = deps.resolve(sessionId)
      if (resolved === undefined) throw notFound('session', sessionId)
      if (resolved.def.archivedAt !== null)
        throw conflict('the agent is archived', 'AGENT_ARCHIVED')
      const row = store.get(sessionId)
      if (row?.state === 'running') {
        throw conflict('a retry of this session is running right now', 'RETRY_RUNNING')
      }
      if ((await factory.peek(sessionId).busy()) !== null) {
        throw conflict('the session is working right now', 'SESSION_BUSY')
      }
      // our own turn must find a `running` row (so it is not taken for a new message), and a
      // failure of it starts a fresh series
      const now = clock()
      store.put(
        {
          sessionId,
          agentId: resolved.def.id,
          turnId: row?.turnId ?? 'manual',
          attempt: 0,
          maxAttempts: row?.maxAttempts ?? MAX_RETRY_ATTEMPTS,
          nextAt: now,
          errorCode: row?.errorCode ?? 'EH_RUN_FAILED',
          errorMessage: row?.errorMessage ?? 'manual retry',
          state: 'running',
        },
        now,
      )
      track(start({ sessionId }))
      return { started: true }
    },

    async tick(now = clock()) {
      if (stopped) return 0
      // a retry whose instance died before its turn started: its lease ran out and nothing runs
      for (const row of store.waiting()) {
        if (row.state !== 'running' || row.claimedUntil === null || row.claimedUntil > now) continue
        if (
          (await factory
            .peek(row.sessionId)
            .busy()
            .catch(() => 'busy')) !== null
        )
          continue
        store.put({ ...row, state: 'pending', nextAt: now }, now)
      }
      const due = store.claimDue(now, leaseMs, 20)
      for (const row of due) track(start(row))
      return due.length
    },

    start() {
      if (tickMs <= 0 || timer !== undefined) return
      timer = setInterval(() => {
        void service
          .tick()
          .catch((error) => log.warn(`turn retry tick failed: ${errorText(error)}`))
      }, tickMs)
      timer.unref()
    },

    async stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      await Promise.allSettled([...inflight])
    },

    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight])
    },
  }
  return service
}
