/**
 * Shared pieces of background-subagent reports (internal): text helpers, the report event and its
 * idempotent delivery (spec 20 §3.6).
 */

import type { HarnessSession } from '../index.ts'
import { errorText } from '../index.ts'

// biome-ignore lint/suspicious/noExplicitAny: a session of a loosely typed agent
type AnySession = HarnessSession<any, any>

export type PartLike = {
  type: string
  text?: string
  toolName?: string
  input?: unknown
  toolCallId?: string
}
export type MessageLike = { id: string; role: string; parts: PartLike[] }

/** Text of a message, from the last `step-start` when `afterLastStep`. */
export function textOf(message: MessageLike | undefined, afterLastStep: boolean): string {
  if (message === undefined) return ''
  let parts = message.parts
  if (afterLastStep) {
    const i = parts.map((p) => p.type).lastIndexOf('step-start')
    if (i >= 0) parts = parts.slice(i)
  }
  return parts
    .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
    .join('')
    .trim()
}

export function reportOf(text: string, max: number, hint?: string): string {
  return text.length > max
    ? `${text.slice(0, max)}\n… [report cut at ${max} of ${text.length} characters${hint === undefined ? '' : `; ${hint}`}]`
    : text
}

/** Text the parent model reads for a child that did not complete. */
export const stoppedText = (stop: string, text: string): string =>
  `[subagent stopped: ${stop}] ${text}`

/** Status of a `subagent` event (`data.status`). */
export type BackgroundStatus =
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'timed_out'
  | 'not_started'

/** Status of a finished child turn by its stop reason. */
export function statusOfStop(stop: string): BackgroundStatus {
  return stop === 'complete'
    ? 'completed'
    : stop === 'aborted'
      ? 'stopped'
      : stop === 'interrupted'
        ? 'interrupted'
        : 'failed'
}

/** Idempotency key of a report: one per child turn (or per special case). */
export const reportKey = (sessionId: string, suffix: string): string =>
  `subagent-report:${sessionId}:${suffix}`

/** Retry delays of a report delivery (ms): the reconcile is the durable fallback after them. */
const RETRY_DELAYS = [0, 250, 1000]

/**
 * Inject a report event into the parent, with `key` (idempotent) and a few retries. Returns false
 * when every attempt failed (the reconcile delivers it later).
 */
export async function deliverReport(
  parent: Pick<AnySession, 'inject'>,
  event: {
    text: string
    data: Record<string, unknown>
    key: string
    wake: boolean
    /** `'next-step'` (default) also reaches a running parent at its next step; `'next-turn'` only stores it. */
    deliver?: 'next-step' | 'next-turn'
  },
  log: { warn(message: string, data?: Record<string, unknown>): void },
  delays: readonly number[] = RETRY_DELAYS,
): Promise<boolean> {
  let last: unknown
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      await (parent as AnySession).inject(
        'eh.event',
        { name: 'subagent', text: event.text, data: event.data as never },
        { deliver: event.deliver ?? 'next-step', wake: event.wake, key: event.key },
      )
      return true
    } catch (error) {
      last = error
    }
  }
  log.warn('subagent: could not deliver the report of a background agent', {
    error: errorText(last),
    key: event.key,
  })
  return false
}

/** The head line of a report for a status other than `completed` / `failed` / `stopped`. */
export function specialHead(
  status: BackgroundStatus,
  who: string,
  what: string,
  o: { minutes?: number; stopped?: boolean; messageTool?: string },
): string {
  switch (status) {
    case 'interrupted':
      return `Background subagent ${who} ${what} was interrupted: the process running it stopped before it finished. Its work so far is kept in its session.${
        o.messageTool === undefined
          ? ''
          : ` Send it a message with ${o.messageTool} to continue it, or start a new one.`
      }`
    case 'timed_out':
      return `Background subagent ${who} ${what} did not finish within ${o.minutes ?? '?'} minutes (timed out).${
        o.stopped === true ? ' It was stopped; its work so far is kept in its session.' : ''
      }`
    case 'not_started':
      return `Background subagent ${who} ${what} never started: its first turn did not run in time. Start it again.`
    default:
      return `Background subagent ${who} ${what} has been waiting for the user for ${o.minutes ?? '?'} minutes (a permission request or a question). Remind the user; it continues once that is answered.`
  }
}
