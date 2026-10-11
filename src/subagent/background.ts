/**
 * `reconcileBackgroundChildren` (spec 20 §3.6, ADR-0056): a report for every background child
 * that ended, never started, timed out or waits for a person too long, from any instance, also
 * after a hard crash. Idempotent through the report keys (`session.inject({ key })`).
 */
import { type ChildSessionInfo, errorText, type HarnessSession, isHarnessError } from '../index.ts'
import { parseAgentFrame } from './messaging.ts'
import {
  type BackgroundStatus,
  deliverReport,
  type MessageLike,
  reportKey,
  reportOf,
  specialHead,
  statusOfStop,
  stoppedText,
  textOf,
} from './report.ts'

// biome-ignore lint/suspicious/noExplicitAny: a session of a loosely typed agent
type AnySession = HarnessSession<any, any>

/** Default cap of a report in characters (same as `AGENT_REPORT_MAX_CHARS`). */
const DEFAULT_REPORT_CHARS = 16000

/** Options of {@link reconcileBackgroundChildren}. */
export interface ReconcileBackgroundOptions {
  /** Open the child's session on the agent that runs it (it must be able to `recover()`). */
  openChild: (childSessionId: string, info: ChildSessionInfo) => AnySession
  /** A child without a turn this long after its start is reported as not started. Default 90 000. */
  startGraceMs?: number
  /** A running child older than this is reported as timed out (once). Default: none. */
  timeoutMs?: number
  /** Also abort the child that timed out. Default false. */
  stopOnTimeout?: boolean
  /** A child waiting for a person this long sends one reminder. Default 900 000; 0 = never. */
  waitingReminderMs?: number
  /** Children whose last turn ended longer ago are ignored. Default 86 400 000 (24 h). */
  lookbackMs?: number
  /** Cap of a report (default 16 000 characters). */
  maxReportChars?: number
  /** Names of the tools, used in the texts of the reports. */
  outputToolName?: string
  messageToolName?: string
  /** Clock (tests). */
  now?: () => number
  log?: { warn(message: string, data?: Record<string, unknown>): void }
}

/** What one child needed. */
export interface BackgroundReconcileEntry {
  sessionId: string
  /** `reported`: a report was delivered (or already stored); `running` / `waiting` / `skipped`: nothing to report yet. */
  outcome: 'reported' | 'running' | 'waiting' | 'skipped'
  status?: BackgroundStatus
  /** The turn was interrupted by a dead process and repaired by this call. */
  recovered?: boolean
}

type Stored = MessageLike & {
  metadata?: {
    eharness?: {
      kind?: string
      key?: string
      createdAt?: number
      durationMs?: number
      stop?: string
      turnId?: string
      error?: { message: string }
    }
  }
}

const BG_PREFIX = 'Started background subagent'

export async function reconcileBackgroundChildren(
  parent: AnySession,
  options: ReconcileBackgroundOptions,
): Promise<BackgroundReconcileEntry[]> {
  const log = options.log ?? { warn() {} }
  const now = options.now ?? (() => Date.now())
  const startGrace = options.startGraceMs ?? 90_000
  const waitingMs = options.waitingReminderMs ?? 900_000
  const lookback = options.lookbackMs ?? 86_400_000
  const reportMax = Math.max(1, options.maxReportChars ?? DEFAULT_REPORT_CHARS)
  const cutoff = now() - lookback
  const out: BackgroundReconcileEntry[] = []

  const children = (await parent.children()).filter((c) => c.toolCallId !== undefined)
  if (children.length === 0) return out

  // what the parent already knows: report keys, events per child, the result of each agent call
  const keys = new Set<string>()
  const eventAt = new Map<string, number>()
  const callOutput = new Map<string, { state?: string; text: string }>()
  const marked = new Set<string>()
  let before: string | undefined
  for (let page = 0; page < 5; page++) {
    const batch = (await parent.messages({
      limit: 200,
      ...(before === undefined ? {} : { beforeId: before }),
    })) as unknown as Stored[]
    if (batch.length === 0) break
    for (const m of batch) {
      const eh = m.metadata?.eharness
      if (eh?.key !== undefined) keys.add(eh.key)
      if (eh?.kind === 'eh.event') {
        const d = (m.parts[0] as { data?: { name?: string; data?: Record<string, unknown> } }).data
        const sid = d?.data?.sessionId
        if (d?.name === 'subagent' && typeof sid === 'string' && d.data?.status !== 'waiting') {
          eventAt.set(sid, Math.max(eventAt.get(sid) ?? 0, eh.createdAt ?? 0))
        }
      }
      for (const part of m.parts as Array<Record<string, unknown>>) {
        if (part.type === 'data-subagent.run') {
          const d = part.data as { toolCallId?: string; background?: boolean } | undefined
          if (d?.background === true && typeof d.toolCallId === 'string') marked.add(d.toolCallId)
        }
        if (typeof part.toolCallId === 'string' && String(part.type).startsWith('tool-')) {
          callOutput.set(part.toolCallId, {
            state: part.state as string | undefined,
            text:
              typeof part.output === 'string'
                ? part.output
                : typeof part.errorText === 'string'
                  ? part.errorText
                  : '',
          })
        }
      }
    }
    before = batch[0]?.id
    if (batch.length < 200 || (batch[0]?.metadata?.eharness?.createdAt ?? 0) < cutoff) break
  }

  const deliver = async (
    info: ChildSessionInfo,
    status: BackgroundStatus,
    suffix: string,
    turnId: string | undefined,
    head: string,
    wake: boolean,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> => {
    const key = reportKey(info.sessionId, suffix)
    if (keys.has(key)) return true
    const ok = await deliverReport(
      parent,
      {
        text: head,
        data: {
          sessionId: info.sessionId,
          agent: info.agent ?? 'agent',
          status,
          taskId: info.sessionId,
          ...(turnId === undefined ? {} : { turnId }),
          ...(info.name === undefined ? {} : { name: info.name }),
          reconciled: true,
          ...extra,
        },
        key,
        wake,
      },
      log,
    )
    if (ok) keys.add(key)
    return ok
  }

  for (const info of children.slice(-100)) {
    const toolCallId = info.toolCallId as string
    const id = info.sessionId
    try {
      const call = callOutput.get(toolCallId)
      const startedBg = marked.has(toolCallId) || call?.text.startsWith(BG_PREFIX) === true
      const cancelledCall =
        call?.state === 'output-error' &&
        (call.text === 'Cancelled' ||
          call.text.startsWith('Interrupted:') ||
          /cancel/i.test(call.text))
      const child = options.openChild(id, info)
      let stats = await child.stats()
      let recovered = false
      if (stats.activeTurn !== null) {
        let live = false
        try {
          const r = await child.recover()
          if (r.recovered) {
            recovered = true
            stats = await child.stats()
          } else if (r.reason === 'live') live = true
          else {
            out.push({ sessionId: id, outcome: 'skipped' })
            continue
          }
        } catch (error) {
          // a turn of this process runs: it is live
          if (isHarnessError(error) && error.code === 'EH_SESSION_BUSY') live = true
          else throw error
        }
        if (live) {
          // really running: only the timeout applies. It is measured from the start of the run
          // that is running now, not from the child's creation: a child resumed by a message (or a
          // later turn) gets a fresh limit instead of being stopped as soon as it starts.
          const run = stats.activeTurn
          const runStartedAt = run?.startedAt ?? info.createdAt
          if (
            (startedBg || cancelledCall) &&
            options.timeoutMs !== undefined &&
            now() - runStartedAt > options.timeoutMs
          ) {
            const minutes = Math.round(options.timeoutMs / 60000)
            await deliver(
              info,
              'timed_out',
              run === null ? 'timeout' : `timeout:${run.turnId}`,
              run?.turnId,
              specialHead(
                'timed_out',
                `${id}${info.name === undefined ? '' : ` "${info.name}"`}`,
                `(${info.agent ?? 'agent'}${info.description === undefined ? '' : `: ${info.description}`})`,
                { minutes, stopped: options.stopOnTimeout === true },
              ),
              true,
            )
            if (options.stopOnTimeout === true) await child.abort('timed out')
            out.push({ sessionId: id, outcome: 'reported', status: 'timed_out' })
          } else out.push({ sessionId: id, outcome: 'running' })
          continue
        }
      }
      const stored = (await child.messages({ limit: 40 })) as unknown as Stored[]
      const last = stored.findLast(
        (m) => m.role === 'assistant' && m.metadata?.eharness?.kind === undefined,
      )
      const lastUser = stored.findLast(
        (m) => m.role === 'user' && m.metadata?.eharness?.kind === undefined,
      )
      const frame = lastUser === undefined ? undefined : parseAgentFrame(textOf(lastUser, false))
      const resumed = frame?.relation === 'launcher' && frame.to !== undefined
      if (!(startedBg || cancelledCall || resumed)) {
        out.push({ sessionId: id, outcome: 'skipped' })
        continue
      }
      // a crash before the first step ended leaves no assistant message, only the recovery notice
      const notice = stored.findLast(
        (m) =>
          m.metadata?.eharness?.kind === 'eh.notice' &&
          (m.parts[0] as { data?: { code?: string } }).data?.code === 'EH_TURN_INTERRUPTED',
      )
      const crashedNoReply =
        notice !== undefined &&
        (last === undefined || notice.id > last.id) &&
        stats.pending === null
      const what = `(${info.agent ?? 'agent'}${info.description === undefined ? '' : `: ${info.description}`})`
      const who = `${id}${info.name === undefined ? '' : ` "${info.name}"`}`

      if (crashedNoReply && notice !== undefined) {
        const turnId = notice.metadata?.eharness?.turnId ?? notice.id
        const ok = await deliver(
          info,
          'interrupted',
          turnId,
          turnId,
          specialHead('interrupted', who, what, {
            ...(options.messageToolName === undefined
              ? {}
              : { messageTool: options.messageToolName }),
          }),
          true,
        )
        out.push({
          sessionId: id,
          outcome: ok ? 'reported' : 'skipped',
          status: 'interrupted',
          ...(recovered ? { recovered } : {}),
        })
        continue
      }
      // never started
      if (last === undefined) {
        if (now() - info.createdAt > startGrace) {
          await deliver(
            info,
            'not_started',
            'start',
            undefined,
            specialHead('not_started', who, what, {}),
            true,
          )
          out.push({ sessionId: id, outcome: 'reported', status: 'not_started' })
        } else out.push({ sessionId: id, outcome: 'running' })
        continue
      }
      const eh = last.metadata?.eharness
      const endedAt = (eh?.createdAt ?? 0) + (eh?.durationMs ?? 0)

      // waiting for a person
      if (stats.pending !== null) {
        if (waitingMs > 0 && now() - (eh?.createdAt ?? now()) > waitingMs) {
          const minutes = Math.round((now() - (eh?.createdAt ?? now())) / 60000)
          await deliver(
            info,
            'waiting',
            `waiting-long:${eh?.turnId ?? 'x'}`,
            eh?.turnId,
            specialHead('waiting', who, what, { minutes }),
            true,
            { reminder: true },
          )
          out.push({ sessionId: id, outcome: 'waiting', status: 'waiting' })
        } else out.push({ sessionId: id, outcome: 'waiting' })
        continue
      }

      const stop = eh?.stop
      if (stop === undefined || stop === 'tool-pending') {
        out.push({ sessionId: id, outcome: 'skipped' })
        continue
      }
      if (endedAt < cutoff) {
        out.push({ sessionId: id, outcome: 'skipped' })
        continue
      }
      const turnId = eh?.turnId ?? last.id
      const key = reportKey(id, turnId)
      // a report of an older version (no key) after the turn ended counts as delivered
      if (keys.has(key) || (eventAt.get(id) ?? 0) >= (eh?.createdAt ?? 0)) {
        out.push({ sessionId: id, outcome: 'reported', status: statusOfStop(stop) })
        continue
      }
      const status = statusOfStop(stop)
      const text = textOf(last, true)
      let head: string
      if (status === 'interrupted') {
        head = specialHead('interrupted', who, what, {
          ...(options.messageToolName === undefined
            ? {}
            : { messageTool: options.messageToolName }),
        })
      } else {
        const body =
          stop === 'complete' ? text : stoppedText(stop, text || (eh?.error?.message ?? ''))
        head = `${resumed ? 'Resumed subagent' : 'Background subagent'} ${who} ${what} ${
          status === 'completed' ? 'finished' : status === 'stopped' ? 'was stopped' : 'failed'
        }.\n\n${
          reportOf(
            body,
            reportMax,
            options.outputToolName === undefined
              ? undefined
              : `read the full report with ${options.outputToolName}({ id: "${id}" })`,
          ) || '(no report)'
        }`
      }
      const ok = await deliver(info, status, turnId, turnId, head, true)
      out.push({
        sessionId: id,
        outcome: ok ? 'reported' : 'skipped',
        status,
        ...(recovered ? { recovered } : {}),
      })
    } catch (error) {
      log.warn('subagent: reconciling a background child failed', {
        sessionId: id,
        error: errorText(error),
      })
      out.push({ sessionId: id, outcome: 'skipped' })
    }
  }
  return out
}
