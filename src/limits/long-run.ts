/**
 * `longRun` plugin: a job that runs as a chain of bounded turns (chunks) on the durable inbox. At
 * the end of a chunk the model writes a checkpoint note, the turn ends with the stop reason
 * `plugin:long-run:checkpoint` and a continuation turn is enqueued with an idempotent id. The job
 * stops only when the model finishes, when it is stuck, when a cost or wall-clock budget is spent
 * or when a person stops it. Job state lives in the persisted session state.
 *
 * @see docs/specs/33-limits.md
 */
import { type JSONValue, tool } from 'ai'
import { z } from 'zod/v4'
import {
  definePlugin,
  type EnqueueOptions,
  errorText,
  type HarnessContext,
  HarnessError,
  type HarnessPlugin,
  type HarnessSession,
  LONG_RUN_CHECKPOINT_STOP,
  type SessionStateSnapshot,
  type StateAdapter,
  type TurnResult,
} from '../index.ts'

/** The plugin name; also the namespace of its session state and of its stop reasons. */
export const LONG_RUN_PLUGIN = 'long-run'

/** The key of the job in the plugin's session state (`plugins['long-run'].job`). */
const JOB_KEY = 'job'

/** The state of a long-run job (`plugins['long-run'].job` in the session state). */
export interface LongRunState {
  status: 'running' | 'finished' | 'stopped'
  /** The chunk running now, or the next one to run. Never repeats within a session. */
  chunk: number
  /** Model steps of all finished turns of the job. */
  steps: number
  /** Estimated USD of all finished turns of the job (0 when nothing was priced). */
  costUsd: number
  /** Epoch ms of the first turn of the job. */
  startedAt: number
  /** Epoch ms of the last change. */
  updatedAt: number
  /** The model's last checkpoint note. */
  checkpoint?: string
  /** Why the job stopped: `stuck`, `cost`, `duration`, `aborted`, a caller reason, or a stop of the turn. */
  stopReason?: string
  /** The chunk whose turn started last (set at the start of a turn; used by the resume). */
  activeChunk?: number
}

/** What happened to a job. */
export type LongRunEvent =
  | { type: 'started'; sessionId: string; state: LongRunState }
  | { type: 'checkpoint'; sessionId: string; state: LongRunState }
  | { type: 'resumed'; sessionId: string; state: LongRunState }
  | { type: 'finished'; sessionId: string; state: LongRunState }
  | { type: 'stopped'; sessionId: string; state: LongRunState; reason: string }

/** The part of a session `longRun` needs. A `HarnessSession` fits. */
export type LongRunSession = Pick<HarnessSession, 'enqueue' | 'abort' | 'recover' | 'busy'>

/** An agent (or any source of sessions), or a function returning it (agents are built after plugins). */
export type LongRunSessions =
  | { session(id: string): LongRunSession }
  | (() => { session(id: string): LongRunSession })

/** Input of the `continuePrompt` function. */
export interface LongRunContinueInfo {
  sessionId: string
  chunk: number
  checkpoint: string | undefined
  /** The previous chunk was cut by a server restart (a resume). */
  restarted: boolean
  state: LongRunState
}

/** Options of {@link longRun}. */
export interface LongRunOptions {
  /** Where continuation turns are enqueued: the agent, or a function returning it. */
  sessions: LongRunSessions
  /**
   * The state storage of the agent (`storage.state`). Needed by `longRun().resume()`,
   * `.state()` and a `.stop()` of a session that is not open in this process.
   */
  state?: StateAdapter
  /** Which sessions run as long jobs (called at the first turn of a job). Default: all. */
  match?: (ctx: HarnessContext) => boolean
  /** Steps per turn (chunk), at least 2. Default 80. */
  chunkSteps?: number
  /** Stop the job when its estimated cost reaches this (USD). */
  maxCostUsd?: number | ((ctx: HarnessContext) => number | undefined)
  /** Stop the job this long after it started (ms). */
  maxDurationMs?: number | ((ctx: HarnessContext) => number | undefined)
  /** Replaces the volatile reminder of the last step of a chunk. */
  checkpointPrompt?: string
  /** Replaces the text of the continuation turn. */
  continuePrompt?: string | ((info: LongRunContinueInfo) => string)
  /** Called for every event; a throwing handler is logged. */
  onEvent?: (event: LongRunEvent) => void | Promise<void>
  /** Clock, epoch ms. Default `Date.now`. */
  now?: () => number
}

/** The plugin with its controls. */
export type LongRunPlugin = HarnessPlugin<'long-run'> & {
  /**
   * Stop the job of a session: the running turn is aborted, a queued continuation is blocked, and
   * the state becomes `stopped` with `reason` (default `'stopped'`). Returns false when there is
   * no running job. Works in the process that opened the session; for another process use
   * `session.abort()` there, or call this where the session lives.
   */
  stop(sessionId: string, reason?: string): Promise<boolean>
  /** Boot / reconcile: continue a running job whose turn died or whose continuation was lost. Idempotent. */
  resume(sessionId: string): Promise<LongRunResumeResult>
  /** The stored job of a session (needs `options.state`). */
  state(sessionId: string): Promise<LongRunState | undefined>
}

/** Outcome of `resume`. */
export type LongRunResumeResult =
  | { resumed: true; chunk: number; duplicate: boolean }
  | { resumed: false; reason: 'no-job' | 'not-running' | 'live' }

/** Name of the tool the model must call at the last step of a chunk. */
export const LONG_RUN_CHECKPOINT_TOOL = 'long_run_checkpoint'

/** Default reminder of the last step of a chunk. */
export const LONG_RUN_CHECKPOINT_PROMPT: string =
  `This is the last step of this chunk of a long job. Call ${LONG_RUN_CHECKPOINT_TOOL} now with a ` +
  'checkpoint note for yourself: what is done so far (with ids, counts, names), what remains, and ' +
  'the exact next step. You keep only this note and the stored history into the next chunk. If ' +
  'the whole job is already complete, set done to true and then write the final report.'

const RESTART_TEXT =
  'The server restarted while the previous chunk was running. Tool calls that were in flight were ' +
  'interrupted and are not repeated automatically: before you repeat any action that has side ' +
  'effects, check the last tool results in the conversation and the current state of the world.'

/** Default text of a continuation turn. */
export function defaultContinueText(info: LongRunContinueInfo): string {
  const parts = [
    `Continue the long job (chunk ${info.chunk}). Do not redo finished work.`,
    info.checkpoint === undefined || info.checkpoint === ''
      ? 'There is no checkpoint note: read the conversation to see where you stopped.'
      : `Your checkpoint note from the previous chunk:\n\n<checkpoint>\n${info.checkpoint}\n</checkpoint>`,
  ]
  if (info.restarted) parts.push(RESTART_TEXT)
  parts.push('When everything is done, answer with the final report and no tool calls.')
  return parts.join('\n\n')
}

/** Read the stored job of a session from the state storage (`plugins['long-run'].job`). */
export async function longRunState(
  state: StateAdapter,
  sessionId: string,
): Promise<LongRunState | undefined> {
  const snapshot = await state.get(sessionId)
  return jobOf(snapshot)
}

function jobOf(snapshot: SessionStateSnapshot | null): LongRunState | undefined {
  const job = snapshot?.plugins?.[LONG_RUN_PLUGIN]?.[JOB_KEY]
  return job === undefined || job === null ? undefined : (job as unknown as LongRunState)
}

const clone = <T>(value: T): T => structuredClone(value)

/** Create the `longRun` plugin (spec 33 §3). */
export function longRun(options: LongRunOptions): LongRunPlugin {
  const chunkSteps = Math.max(2, Math.floor(options.chunkSteps ?? 80))
  const now = options.now ?? Date.now
  const sessionsOf = (): { session(id: string): LongRunSession } =>
    typeof options.sessions === 'function' ? options.sessions() : options.sessions
  const checkpointPrompt = options.checkpointPrompt ?? LONG_RUN_CHECKPOINT_PROMPT
  const continueText = (info: LongRunContinueInfo): string =>
    typeof options.continuePrompt === 'function'
      ? options.continuePrompt(info)
      : (options.continuePrompt ?? defaultContinueText(info))
  /** Stop requests of this process (session id → reason), applied at the next hook. */
  const stopRequests = new Map<string, string>()
  /** Sessions open in this process (to write their state on a stop). */
  const open = new Map<string, HarnessContext>()

  const emit = async (event: LongRunEvent, log: HarnessContext['log']): Promise<void> => {
    try {
      await options.onEvent?.(event)
    } catch (error) {
      log.warn(`long-run: onEvent failed: ${errorText(error)}`)
    }
  }
  const resolve = <T>(
    value: T | ((ctx: HarnessContext) => T | undefined) | undefined,
    ctx: HarnessContext,
  ): T | undefined =>
    typeof value === 'function' ? (value as (c: HarnessContext) => T)(ctx) : value

  const enqueueContinuation = async (
    sessionId: string,
    job: LongRunState,
    restarted: boolean,
    id: string,
  ): Promise<{ duplicate: boolean }> => {
    const text = continueText({
      sessionId,
      chunk: job.chunk,
      checkpoint: job.checkpoint,
      restarted,
      state: clone(job),
    })
    const enqueueOptions: EnqueueOptions = {
      id,
      metadata: { longRun: { chunk: job.chunk, restarted } },
    }
    const result = (await sessionsOf().session(sessionId).enqueue(text, enqueueOptions)) as {
      duplicate?: boolean
    }
    return { duplicate: result.duplicate === true }
  }

  const plugin = definePlugin({
    name: LONG_RUN_PLUGIN,
    session: (ctx) => {
      const sessionId = ctx.session.id
      open.set(sessionId, ctx)
      /** The running turn belongs to a job. */
      let active = false
      let note: string | undefined
      /** Events of `turn.prepare`, emitted at `turn.start`. */
      let emits: LongRunEvent[] = []
      const read = (): LongRunState | undefined => {
        const job = ctx.state.get<JSONValue>(JOB_KEY)
        return job === undefined ? undefined : (job as unknown as LongRunState)
      }
      const write = (job: LongRunState): void => {
        ctx.state.set(JOB_KEY, job as unknown as JSONValue)
      }
      const finish = async (
        job: LongRunState,
        status: 'finished' | 'stopped',
        reason?: string,
      ): Promise<void> => {
        const next: LongRunState = {
          ...job,
          status,
          updatedAt: now(),
          ...(reason === undefined ? {} : { stopReason: reason }),
        }
        write(next)
        await emit(
          status === 'finished'
            ? { type: 'finished', sessionId, state: clone(next) }
            : { type: 'stopped', sessionId, state: clone(next), reason: reason ?? 'stopped' },
          ctx.log,
        )
      }

      return {
        tools: {
          [LONG_RUN_CHECKPOINT_TOOL]: tool({
            description:
              'End of a chunk of a long job: store a checkpoint note and continue in a fresh turn. Only call it when asked to.',
            inputSchema: z.object({
              note: z.string().min(1).describe('What is done, what remains, the exact next step'),
              done: z.boolean().optional().describe('True when the whole job is complete'),
            }),
            execute: async ({ done }) =>
              done === true
                ? 'The job is complete. Write the final report now.'
                : 'Checkpoint saved. This turn ends; the job continues in the next one.',
          }),
        },
        dispose: () => {
          if (open.get(sessionId) === ctx) open.delete(sessionId)
        },
        hooks: {
          'input.submit': (_c, e) => {
            const app = (e.message.metadata as { app?: { longRun?: unknown } } | undefined)?.app
            if (app?.longRun === undefined) return undefined
            const job = read()
            if (job?.status === 'running' && !stopRequests.has(sessionId)) return undefined
            return { block: { reason: 'The long-run job is not running.' } }
          },
          // the job state of a turn is set in `turn.prepare`: it is written at the commit point
          // of the turn, so a crash during the turn leaves a stored job to resume
          'turn.prepare': (c) => {
            active = false
            note = undefined
            emits = []
            const key = c.turn?.source?.key
            const fromLongRun = typeof key === 'string' && key.startsWith('longrun:')
            let job = read()
            const t = now()
            if (job?.status === 'running' && !stopRequests.has(sessionId)) {
              active = true
            } else if (!fromLongRun && (options.match?.(c) ?? true)) {
              stopRequests.delete(sessionId)
              job = {
                status: 'running',
                chunk: job === undefined ? 0 : job.chunk + 1,
                steps: 0,
                costUsd: 0,
                startedAt: t,
                updatedAt: t,
              }
              active = true
              emits.push({ type: 'started', sessionId, state: clone(job) })
            }
            if (!active || job === undefined) return undefined
            job = { ...job, activeChunk: job.chunk, updatedAt: t }
            write(job)
            if (typeof key === 'string' && key.includes(':resume:')) {
              emits.push({ type: 'resumed', sessionId, state: clone(job) })
            }
            return undefined
          },
          'turn.start': async (c) => {
            for (const event of emits) await emit(event, c.log)
            emits = []
          },
          'turn.beforeEnd': (_c, e) => {
            if (!active || e.stop !== 'max-steps' || e.idleContinues > 0) return undefined
            const room = chunkSteps - (e.stepIndex + 1)
            return room > 0 ? { extendSteps: room } : undefined
          },
          'step.prepare': (_c, e) => {
            if (!active || e.stepIndex !== chunkSteps - 1) return undefined
            return {
              reminder: checkpointPrompt,
              toolChoice: { type: 'tool' as const, toolName: LONG_RUN_CHECKPOINT_TOOL },
            }
          },
          'step.end': (c, e) => {
            if (!active) return undefined
            const job = read()
            if (job === undefined) return undefined
            if (stopRequests.has(sessionId)) return { stop: 'stopped' }
            const total = job.costUsd + (e.costUsd ?? 0)
            const maxCost = resolve(options.maxCostUsd, c)
            if (maxCost !== undefined && total >= maxCost) return { stop: 'cost' }
            const maxMs = resolve(options.maxDurationMs, c)
            if (maxMs !== undefined && now() - job.startedAt >= maxMs) return { stop: 'duration' }
            const checkpoint = e.toolCalls.find((t) => t.toolName === LONG_RUN_CHECKPOINT_TOOL)
            if (checkpoint !== undefined) {
              const input = checkpoint.input as { note?: unknown; done?: unknown } | undefined
              // the model says the job is done: the turn goes on and its final answer is the report
              if (input?.done === true) return undefined
              note = typeof input?.note === 'string' ? input.note.trim() : ''
              return { stop: 'checkpoint' }
            }
            return undefined
          },
          'turn.end': async (c, e: TurnResult) => {
            if (!active) return
            active = false
            const before = read()
            if (before === undefined) return
            const requested = stopRequests.get(sessionId)
            const job: LongRunState = {
              ...before,
              steps: before.steps + e.steps,
              costUsd: before.costUsd + (e.usage.costUsd ?? 0),
              updatedAt: now(),
            }
            if (e.stop === 'tool-pending') {
              write(job) // waits for a person; the job continues with the answer
              active = true
              return
            }
            if (e.stop === 'blocked') return
            if (requested !== undefined) {
              stopRequests.delete(sessionId)
              await finish(job, 'stopped', requested)
              return
            }
            if (e.stop === LONG_RUN_CHECKPOINT_STOP) {
              const next: LongRunState = {
                ...job,
                chunk: job.chunk + 1,
                ...(note === undefined || note === '' ? {} : { checkpoint: note }),
              }
              write(next)
              await emit({ type: 'checkpoint', sessionId, state: clone(next) }, c.log)
              try {
                await enqueueContinuation(
                  sessionId,
                  next,
                  false,
                  `longrun:${sessionId}:${next.chunk}`,
                )
              } catch (error) {
                // the job stays running: resume() enqueues it again
                c.log.error(`long-run: could not enqueue the continuation: ${errorText(error)}`)
              }
              return
            }
            if (e.stop === 'complete') {
              await finish(job, 'finished')
              return
            }
            const reason = e.stop.startsWith('plugin:long-run:')
              ? e.stop.slice('plugin:long-run:'.length)
              : e.stop
            await finish(job, 'stopped', reason)
          },
        },
      }
    },
  })

  const readStored = async (sessionId: string): Promise<LongRunState | undefined> => {
    const live = open.get(sessionId)
    if (live !== undefined) {
      const job = live.state.get<JSONValue>(JOB_KEY)
      if (job !== undefined) return job as unknown as LongRunState
    }
    if (options.state === undefined) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        'longRun: this call needs the `state` option (the agent state storage)',
        { details: { plugin: 'long-run', option: 'state' } },
      )
    }
    return longRunState(options.state, sessionId)
  }

  const controls = {
    async state(sessionId: string): Promise<LongRunState | undefined> {
      return readStored(sessionId)
    },

    async stop(sessionId: string, reason = 'stopped'): Promise<boolean> {
      const job = await readStored(sessionId)
      if (job?.status !== 'running') return false
      stopRequests.set(sessionId, reason)
      const live = open.get(sessionId)
      const target = sessionsOf().session(sessionId)
      const aborted = await target.abort(reason)
      if (aborted.target === 'idle') {
        // between chunks: nothing runs, so the state changes here and the queued continuation is blocked
        const stopped: LongRunState = {
          ...job,
          status: 'stopped',
          stopReason: reason,
          updatedAt: now(),
        }
        if (live !== undefined) live.state.set(JOB_KEY, stopped as unknown as JSONValue)
        if (options.state !== undefined) await writeStored(options.state, sessionId, stopped)
        stopRequests.delete(sessionId)
        await emit(
          { type: 'stopped', sessionId, state: clone(stopped), reason },
          live?.log ?? { debug() {}, info() {}, warn() {}, error() {} },
        )
      }
      return true
    },

    async resume(sessionId: string): Promise<LongRunResumeResult> {
      const job = await readStored(sessionId)
      if (job === undefined) return { resumed: false, reason: 'no-job' }
      if (job.status !== 'running') return { resumed: false, reason: 'not-running' }
      const session = sessionsOf().session(sessionId)
      const recovered = await session.recover()
      if (!recovered.recovered && recovered.reason === 'live')
        return { resumed: false, reason: 'live' }
      if ((await session.busy()) !== null) return { resumed: false, reason: 'live' }
      // the turn of this chunk started and died: a new item (one per last write of the job);
      // otherwise the continuation of this chunk is queued or about to be: same id, no duplicate
      const restarted = job.activeChunk === job.chunk
      const id = restarted
        ? `longrun:${sessionId}:${job.chunk}:resume:${job.updatedAt}`
        : `longrun:${sessionId}:${job.chunk}`
      const { duplicate } = await enqueueContinuation(sessionId, job, restarted, id)
      return { resumed: true, chunk: job.chunk, duplicate }
    },
  }

  // the plugin object is frozen: a derived object keeps its `~def` through the prototype
  return Object.assign(Object.create(plugin) as LongRunPlugin, controls)
}

/** Compare-and-set write of `plugins['long-run'].job` into a stored snapshot (idle sessions only). */
async function writeStored(
  state: StateAdapter,
  sessionId: string,
  job: LongRunState,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const snapshot = await state.get(sessionId)
    if (snapshot === null) return
    const next: SessionStateSnapshot = {
      ...snapshot,
      rev: snapshot.rev + 1,
      plugins: {
        ...snapshot.plugins,
        [LONG_RUN_PLUGIN]: {
          ...snapshot.plugins?.[LONG_RUN_PLUGIN],
          [JOB_KEY]: job as unknown as JSONValue,
        },
      },
    }
    if (state.setIf === undefined) {
      await state.set(sessionId, next)
      return
    }
    if (await state.setIf(sessionId, next, snapshot.rev)) return
  }
}
