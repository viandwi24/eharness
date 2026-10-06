/**
 * External waits (internal): parking at the tool boundary (`start` of an `externalTool()`),
 * helpers over the pending state, and timer arithmetic. The session-level operations
 * (`resolveWait`, `expireWaits`, `pendingWaits`) live in `./resolve.ts`.
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 * @see docs/decisions/0027-external-waits-park-at-the-tool-boundary.md
 */
import type { ModelMessage } from 'ai'
import type { ToolErrorTextFn } from '../../agent/types.ts'
import { HarnessToolError } from '../../errors.ts'
import type {
  PendingClientTool,
  PendingExternal,
  PendingState,
  WaitResult,
} from '../../messages/types.ts'
import type { HarnessContext } from '../../plugin/types.ts'
import type { ExternalToolMeta, WaitStart } from '../../registry/external.ts'

/** The pending state version this build writes (spec 11 §2). */
export const PENDING_VERSION: number = 2

/** `setTimeout` cannot wait longer; longer waits rely on the inbox item or `expireWaits()`. */
export const MAX_TIMER_MS: number = 2 ** 31 - 1

/** Pending state this build understands (0.3 / 0.4 shape without `v`, or version 2). */
export function isKnownPending(pending: PendingState): boolean {
  return pending.v === undefined || pending.v === PENDING_VERSION
}

/** Tool call ids of every pending item (approvals, client tools, external waits). */
export function pendingCallIds(pending: PendingState): Set<string> {
  const ids = new Set<string>()
  for (const a of pending.approvals) ids.add(a.toolCallId)
  for (const c of pending.clientTools) ids.add(c.toolCallId)
  for (const e of pending.externals ?? []) ids.add(e.toolCallId)
  return ids
}

/** Items that still wait: open approvals, client tools and external waits without a result. */
export function unresolvedCount(pending: PendingState): number {
  return (
    pending.approvals.length +
    pending.clientTools.filter((c) => c.result === undefined).length +
    (pending.externals ?? []).filter((e) => e.result === undefined).length
  )
}

/**
 * A pending item that can time out: an external wait, or a call of a request-scoped client tool
 * with a timeout (spec 11 §7.1 rule 5). Both record their timeout result the same way.
 */
export type TimedWait =
  | PendingExternal
  | (PendingClientTool & Required<Pick<PendingClientTool, 'waitId' | 'onTimeout'>>)

/** True for a client tool call that takes part in the wait machinery (it has a `waitId`). */
function isTimedClient(c: PendingClientTool): c is TimedWait & PendingClientTool {
  return c.waitId !== undefined && c.onTimeout !== undefined
}

/** Every external wait and every timed client tool call of the pending state. */
export function timedWaits(pending: PendingState | undefined): TimedWait[] {
  if (pending === undefined) return []
  return [...(pending.externals ?? []), ...pending.clientTools.filter(isTimedClient)]
}

/** The wait (external or timed client call) with this id, if any. */
export function findWait(pending: PendingState, waitId: string): TimedWait | undefined {
  return timedWaits(pending).find((w) => w.waitId === waitId)
}

/** True when `waitId` names a client tool call (answered by the client, never `resolveWait()`). */
export function isClientWait(pending: PendingState, waitId: string): boolean {
  return pending.clientTools.some((c) => c.waitId === waitId)
}

/** The unresolved waits whose timeout is due at `now`, in tool-call order. */
export function dueExternals(pending: PendingState, now: number): TimedWait[] {
  return timedWaits(pending).filter(
    (e) => e.result === undefined && e.timeoutAt !== undefined && e.timeoutAt <= now,
  )
}

/** The earliest `timeoutAt` of an unresolved wait, if any. */
export function nextTimeoutAt(pending: PendingState | undefined): number | undefined {
  let earliest: number | undefined
  for (const e of timedWaits(pending)) {
    if (e.result !== undefined || e.timeoutAt === undefined) continue
    if (earliest === undefined || e.timeoutAt < earliest) earliest = e.timeoutAt
  }
  return earliest
}

/** The result a timed-out wait takes: its `onTimeout`, marked `by: 'timeout'`. */
export function timeoutResult(entry: Pick<TimedWait, 'onTimeout'>): WaitResult {
  return 'output' in entry.onTimeout
    ? { output: structuredClone(entry.onTimeout.output), by: 'timeout' }
    : { errorText: entry.onTimeout.errorText, by: 'timeout' }
}

/** Environment of {@link parkExternals}. */
export interface ParkEnv {
  /** `externalTool()` definitions of the turn, by tool name. */
  externals: ReadonlyMap<string, { owner: string; meta: ExternalToolMeta }>
  contextOf(owner: string): HarnessContext
  signal: AbortSignal
  /** `config.toolErrorText`: the text a thrown error becomes (spec 10 §1.1). */
  toolErrorText?: ToolErrorTextFn | undefined
  now?: () => number
}

/** A call whose `start` threw: answered with this error result instead of parking. */
export interface FailedStart {
  toolCallId: string
  toolName: string
  errorText: string
}

/** The text a throwing `start` becomes: like a thrown `execute` error (spec 10 §1.1). */
function errorTextOf(
  error: unknown,
  entry: PendingExternal,
  map: ToolErrorTextFn | undefined,
): string {
  const options = { toolName: entry.toolName, toolCallId: entry.toolCallId }
  if (map === undefined) return String(new HarnessToolError(error, options))
  try {
    const mapped: unknown = map(error, options)
    return typeof mapped === 'string' ? mapped : 'Error: the tool failed.'
  } catch {
    return 'Error: the tool failed.'
  }
}

function inputsOf(response: readonly ModelMessage[]): Map<string, unknown> {
  const inputs = new Map<string, unknown>()
  for (const message of response) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call' && part.providerExecuted !== true) {
        inputs.set(part.toolCallId, part.input)
      }
    }
  }
  return inputs
}

/**
 * Run `start` of every external call of `pending`, once, in tool-call order (spec 11 §4.2 rule 1),
 * and complete the entries (`correlationId`, `payload`, `timeoutAt`, `onTimeout`). A throwing
 * `start` removes the entry and is reported in the result: the caller answers that call with an
 * error result. Mutates `pending`.
 */
export async function parkExternals(
  pending: PendingState,
  response: readonly ModelMessage[],
  env: ParkEnv,
): Promise<FailedStart[]> {
  const entries = pending.externals ?? []
  if (entries.length === 0) return []
  const inputs = inputsOf(response)
  const now = env.now ?? Date.now
  const kept: PendingExternal[] = []
  const failed: FailedStart[] = []
  for (const entry of entries) {
    const def = env.externals.get(entry.toolName)
    let started: WaitStart | undefined
    if (def?.meta.start !== undefined) {
      try {
        const out = await def.meta.start(inputs.get(entry.toolCallId), {
          waitId: entry.waitId,
          toolCallId: entry.toolCallId,
          ctx: env.contextOf(def.owner),
          abortSignal: env.signal,
        })
        started = out ?? undefined
      } catch (error) {
        failed.push({
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          errorText: errorTextOf(error, entry, env.toolErrorText),
        })
        continue
      }
    }
    const timeoutMs = started?.timeoutMs ?? def?.meta.timeoutMs
    const timeoutAt =
      started?.timeoutAt ?? (timeoutMs === undefined ? undefined : now() + timeoutMs)
    const onTimeout = started?.onTimeout ?? def?.meta.onTimeout
    const next: PendingExternal = { ...entry }
    if (started?.correlationId !== undefined) next.correlationId = started.correlationId
    if (started?.payload !== undefined) next.payload = structuredClone(started.payload)
    if (timeoutAt !== undefined && Number.isFinite(timeoutAt)) next.timeoutAt = timeoutAt
    if (onTimeout !== undefined) next.onTimeout = structuredClone(onTimeout)
    kept.push(next)
  }
  if (kept.length > 0) pending.externals = kept
  else delete pending.externals
  return failed
}
