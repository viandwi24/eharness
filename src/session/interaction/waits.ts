/**
 * External waits (internal): parking at the tool boundary (defaults of an `externalTool()`),
 * helpers over the pending state, and timer arithmetic. The session-level operations
 * (`resolveWait`, `expireWaits`, `pendingWaits`) live in `./resolve.ts`.
 *
 * @see docs/specs/11-interaction.md#42-external-waits
 * @see docs/decisions/0027-external-waits-park-at-the-tool-boundary.md
 */
import { asSchema, type Tool } from 'ai'
import { HarnessError } from '../../errors.ts'
import type {
  PendingClientTool,
  PendingExternal,
  PendingState,
  WaitResult,
} from '../../messages/types.ts'
import type { ExternalToolMeta, WaitStart } from '../../registry/external.ts'
import { listSourceTools } from '../../registry/tools.ts'
import type { OpenSession, SessionRuntime } from '../runtime.ts'
import type { RespondPlan } from './pending.ts'

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

/** Find the tool of a wait: static tools, the source cache, then a fresh source listing. */
export async function findWaitTool(
  rt: SessionRuntime,
  open: OpenSession,
  name: string,
): Promise<Tool | undefined> {
  const fixed = open.tools.find((t) => t.name === name)
  if (fixed !== undefined) return fixed.tool
  for (const list of open.sourceCache.values()) {
    const hit = list.find((t) => t.name === name)
    if (hit !== undefined) return hit.tool
  }
  try {
    const listed = await listSourceTools({
      sources: open.toolSources,
      cache: open.sourceCache,
      taken: new Set(open.tools.map((t) => t.name)),
      contextOf: rt.contextOf,
      warn: rt.warn,
    })
    return listed.find((t) => t.name === name)?.tool
  } catch {
    return undefined
  }
}

/**
 * Validate an external result against the tool's `outputSchema` (spec 11 §4.2 rule 3). Returns the
 * validated value; throws `EH_INVALID_INPUT` (`details.reason: 'invalid-result'`).
 */
export async function validateWaitOutput(
  tool: Tool | undefined,
  entry: { waitId: string; toolName: string },
  output: unknown,
): Promise<unknown> {
  if (tool?.outputSchema === undefined) return output
  const validate = asSchema(tool.outputSchema as never).validate
  if (validate === undefined) return output
  const checked = await validate(output)
  if (checked.success) return checked.value
  throw new HarnessError(
    'EH_INVALID_INPUT',
    `The result of wait '${entry.waitId}' does not match the output schema of tool '${entry.toolName}': ${checked.error.message}`,
    {
      details: { reason: 'invalid-result', waitId: entry.waitId, tool: entry.toolName },
      cause: checked.error,
    },
  )
}

/**
 * Validate the external results a `respond({ externals })` brings against the outputSchema of
 * their tools, before anything is consumed (spec 11 §4.2 rule 3). Results recorded earlier were
 * validated when they were recorded. Replaces the outputs with the validated values. Throws
 * `EH_INVALID_INPUT` (`'invalid-result'`).
 */
export async function validateExternalAnswers(
  rt: SessionRuntime,
  open: OpenSession,
  plan: RespondPlan,
): Promise<void> {
  for (const e of plan.externals) {
    if (e.recorded || 'errorText' in e.result) continue
    const tool = await findWaitTool(rt, open, e.toolName)
    const output = await validateWaitOutput(tool, e, e.result.output)
    e.result = { ...e.result, output: output as never }
    const answer = plan.toolOutputs.find((o) => o.toolCallId === e.toolCallId)
    if (answer !== undefined && 'output' in answer) answer.output = output
  }
}
