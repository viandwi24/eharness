/**
 * External waits (internal): parking at the tool boundary (defaults of an `externalTool()`),
 * helpers over the pending state, and timer arithmetic. The session-level operations
 * (`resolveWait`, `expireWaits`, `pendingWaits`) live in `./resolve.ts`.
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 * @see docs/decisions/0027-external-waits-park-at-the-tool-boundary.md
 */
import type { PendingExternal, PendingState, WaitResult } from '../../messages/types.ts'
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
    pending.clientTools.length +
    (pending.externals ?? []).filter((e) => e.result === undefined).length
  )
}

/** The unresolved externals whose timeout is due at `now`, in tool-call order. */
export function dueExternals(pending: PendingState, now: number): PendingExternal[] {
  return (pending.externals ?? []).filter(
    (e) => e.result === undefined && e.timeoutAt !== undefined && e.timeoutAt <= now,
  )
}

/** The earliest `timeoutAt` of an unresolved external wait, if any. */
export function nextTimeoutAt(pending: PendingState | undefined): number | undefined {
  let earliest: number | undefined
  for (const e of pending?.externals ?? []) {
    if (e.result !== undefined || e.timeoutAt === undefined) continue
    if (earliest === undefined || e.timeoutAt < earliest) earliest = e.timeoutAt
  }
  return earliest
}

/** The result a timed-out wait takes: its `onTimeout`, marked `by: 'timeout'`. */
export function timeoutResult(entry: PendingExternal): WaitResult {
  return 'output' in entry.onTimeout
    ? { output: structuredClone(entry.onTimeout.output), by: 'timeout' }
    : { errorText: entry.onTimeout.errorText, by: 'timeout' }
}

/** Environment of {@link armExternals}. */
export interface ParkEnv {
  /** `externalTool()` definitions of the turn, by tool name. */
  externals: ReadonlyMap<string, { owner: string; meta: ExternalToolMeta }>
  now?: () => number
}

/**
 * Complete the external entries of a pending state that is about to be committed: `timeoutAt` and
 * `onTimeout` from the tool's defaults, and `started: false` for tools with a `start` (it runs
 * after the commit, spec 11 §4.2 rule 1) with `parkedAt`. Synchronous: no user code runs before the commit.
 * Mutates `pending`.
 */
export function armExternals(pending: PendingState, env: ParkEnv): void {
  const now = env.now ?? Date.now
  for (const entry of pending.externals ?? []) {
    const def = env.externals.get(entry.toolName)
    const timeoutMs = def?.meta.timeoutMs
    if (timeoutMs !== undefined && Number.isFinite(now() + timeoutMs)) {
      entry.timeoutAt = now() + timeoutMs
    }
    if (def?.meta.onTimeout !== undefined) entry.onTimeout = structuredClone(def.meta.onTimeout)
    if (def?.meta.start !== undefined) {
      entry.started = false
      entry.parkedAt = now()
    }
  }
}

/**
 * Apply what `start` returned to a dispatched wait: correlation id, payload, timeout overrides.
 * Mutates `entry`.
 */
export function applyStart(entry: PendingExternal, out: WaitStart, now: () => number): void {
  if (out.correlationId !== undefined) entry.correlationId = out.correlationId
  if (out.payload !== undefined) entry.payload = structuredClone(out.payload)
  const timeoutAt =
    out.timeoutAt ?? (out.timeoutMs === undefined ? undefined : now() + out.timeoutMs)
  if (timeoutAt !== undefined && Number.isFinite(timeoutAt)) entry.timeoutAt = timeoutAt
  if (out.onTimeout !== undefined) entry.onTimeout = structuredClone(out.onTimeout)
}
