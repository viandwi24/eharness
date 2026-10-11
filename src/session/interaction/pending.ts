/**
 * Pending approvals and client tool calls (internal): validation of `respond()` answers against
 * the server-owned pending state, patching of the pending assistant message for a continuation,
 * and the `onNewInput: 'deny'` patch.
 *
 * @see docs/specs/11-interaction.md#4-respond
 * @see docs/specs/11-interaction.md#41-new-input-while-pending
 */
import { isToolUIPart } from 'ai'
import type { ApprovalActor, PendingResponse } from '../../agent/session-types.ts'
import { HarnessError } from '../../errors.ts'
import { kindOf } from '../../messages/kinds.ts'
import {
  DENIED_NEW_INPUT,
  NOT_EXECUTED_NEW_INPUT,
  WAIT_CANCELLED_NEW_INPUT,
} from '../../messages/texts.ts'
import { hasToolResult, isToolPart, type ToolPartLike } from '../../messages/tool-parts.ts'
import type { HarnessUIMessage, PendingState, WaitResult } from '../../messages/types.ts'
import { isKnownPending } from './waits.ts'

/**
 * Internal `respond()` option set by `handleChatRequest`: answers that are not pending are
 * ignored instead of rejected (spec 11 §7). `Symbol.for` so that package copies agree.
 */
export const RESPOND_IGNORE_UNKNOWN: unique symbol = Symbol.for('eharness.respond.ignoreUnknown')

/** Why `respond()` answers were rejected (`details.reason` of `EH_INVALID_INPUT`). */
export type RespondRejection = 'unknown-id' | 'incomplete' | 'stale' | 'wrong-kind' | 'conflict'

/** One validated approval answer. */
export interface ApprovalAnswer {
  approvalId: string
  toolCallId: string
  toolName: string
  approved: boolean
  reason?: string
  remember?: 'once' | 'session'
  actor?: ApprovalActor
  /** The human's note (spec 11 §3.6): delivered to the model for an approved call. */
  note?: string
}

/** Longest `note` of an approval answer (characters). */
export const MAX_NOTE_CHARS: number = 4_000

/** Largest stored `input` of a pending client tool call (UTF-8 bytes of its JSON). */
export const MAX_PENDING_INPUT_BYTES: number = 16 * 1024

/**
 * The pending entry of a client tool call, with its `input` unless the JSON is larger than 16 KB
 * (then `inputTruncated: true`; spec 11 §2). An input that is not JSON-serialisable is left out.
 */
export function clientToolEntry(
  toolCallId: string,
  toolName: string,
  input: unknown,
): PendingState['clientTools'][number] {
  const entry: PendingState['clientTools'][number] = { toolCallId, toolName }
  if (input === undefined) return entry
  try {
    const json = JSON.stringify(input)
    if (json === undefined) return entry
    if (new TextEncoder().encode(json).length > MAX_PENDING_INPUT_BYTES) {
      entry.inputTruncated = true
    } else {
      entry.input = JSON.parse(json)
    }
  } catch {
    entry.inputTruncated = true
  }
  return entry
}

/**
 * One validated client tool answer. `finished` marks a recorded external result that already
 * passed `tool.after` and the output limits (`resolveWait()`).
 */
export type ClientToolAnswer =
  | { toolCallId: string; toolName: string; output: unknown; finished?: true }
  | { toolCallId: string; toolName: string; errorText: string; finished?: true }

/** One external wait of the plan: recorded by `resolveWait()` / a timeout, or answered here. */
export interface ExternalAnswer {
  waitId: string
  toolCallId: string
  toolName: string
  result: WaitResult
  /** The result was recorded before this `respond()` (its event was emitted then). */
  recorded: boolean
}

/**
 * Validated answers of one `respond()`. When `complete`, every pending item is answered exactly
 * once (this call's answers plus the ones recorded earlier, ADR-0044). Otherwise the call is a
 * partial answer: `record` holds the new answers to store in the pending state, `remaining` the
 * ids of the items still unanswered.
 */
export interface RespondPlan {
  pending: PendingState
  complete: boolean
  approvals: ApprovalAnswer[]
  /** Client outputs, then the external results (as outputs, in pending order). */
  toolOutputs: ClientToolAnswer[]
  /** The external waits of the plan (events, audit). */
  externals: ExternalAnswer[]
  /** Answers of this call that are not recorded yet (always empty when `complete`). */
  record: { approvals: ApprovalAnswer[]; toolOutputs: ClientToolAnswer[] }
  /** Ids (approval id / tool call id / wait id) still unanswered (empty when `complete`). */
  remaining: string[]
}

/** Store the new answers of a partial plan in its pending state (mutates `plan.pending`). */
export function applyRecord(plan: RespondPlan): void {
  for (const a of plan.record.approvals) {
    const entry = plan.pending.approvals.find((e) => e.approvalId === a.approvalId)
    if (entry === undefined) continue
    entry.answer = {
      approved: a.approved,
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      ...(a.remember !== undefined ? { remember: a.remember } : {}),
      ...(a.actor !== undefined ? { actor: structuredClone(a.actor) } : {}),
      ...(a.note !== undefined ? { note: a.note } : {}),
    }
  }
  for (const o of plan.record.toolOutputs) {
    const entry = plan.pending.clientTools.find((e) => e.toolCallId === o.toolCallId)
    if (entry === undefined) continue
    entry.answer = structuredClone(
      'errorText' in o ? { errorText: o.errorText } : { output: o.output },
    ) as never
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function reject(reason: RespondRejection, message: string, extra: Record<string, unknown> = {}) {
  return new HarnessError('EH_INVALID_INPUT', message, { details: { reason, ...extra } })
}

function invalidShape(message: string): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', `Invalid respond() answer: ${message}`)
}

/**
 * Validate `respond()` answers against the pending state and the cached view (spec 11 §4 step 1).
 *
 * - every id must belong to the pending set (else `'unknown-id'`; with `ignoreUnknown`, answers
 *   that are not pending are skipped instead — `handleChatRequest`);
 * - every pending approval and client tool must be answered (`'incomplete'`);
 * - the pending message must still be the newest non-kind message of the view (`'stale'`).
 *
 * Throws `EH_INVALID_INPUT`. Pure: nothing is consumed here.
 */
export function planRespond(args: {
  pending: PendingState | undefined
  response: PendingResponse
  view: readonly HarnessUIMessage[]
  ignoreUnknown?: boolean
}): RespondPlan {
  const { pending, response } = args
  const ignoreUnknown = args.ignoreUnknown === true
  if (typeof response !== 'object' || response === null) throw invalidShape('expected an object.')
  const approvals = response.approvals ?? []
  const toolOutputs = response.toolOutputs ?? []
  const externalAnswers = response.externals ?? []
  if (!Array.isArray(externalAnswers)) throw invalidShape('`externals` must be an array.')
  if (!Array.isArray(approvals)) throw invalidShape('`approvals` must be an array.')
  if (!Array.isArray(toolOutputs)) throw invalidShape('`toolOutputs` must be an array.')
  if (pending === undefined) {
    throw reject('unknown-id', 'Nothing is waiting for a response in this session.')
  }
  if (!isKnownPending(pending)) {
    throw reject(
      'stale',
      `The pending state has an unknown version (${String(pending.v)}); it authorizes nothing.`,
      { version: pending.v },
    )
  }

  const byApprovalId = new Map(pending.approvals.map((a) => [a.approvalId, a]))
  const byClientCall = new Map(pending.clientTools.map((c) => [c.toolCallId, c]))
  const externals = pending.externals ?? []
  const externalByCall = new Map(externals.map((e) => [e.toolCallId, e]))
  const externalById = new Map(externals.map((e) => [e.waitId, e]))
  const answeredApprovals = new Map<string, ApprovalAnswer>()
  const answeredOutputs = new Map<string, ClientToolAnswer>()
  /** Answers of this call that are valid (new or a repeat of a recorded one). */
  let accepted = 0
  const recordApprovals: ApprovalAnswer[] = []
  const recordOutputs: ClientToolAnswer[] = []

  for (const answer of approvals as unknown[]) {
    const a = answer as {
      id?: unknown
      approved?: unknown
      reason?: unknown
      remember?: unknown
      actor?: unknown
      note?: unknown
    }
    if (typeof a !== 'object' || a === null || typeof a.id !== 'string') {
      throw invalidShape('every approval needs a string `id`.')
    }
    if (typeof a.approved !== 'boolean') throw invalidShape('`approved` must be a boolean.')
    if (a.reason !== undefined && typeof a.reason !== 'string') {
      throw invalidShape('`reason` must be a string.')
    }
    if (a.remember !== undefined && a.remember !== 'once' && a.remember !== 'session') {
      throw invalidShape("`remember` must be 'once' or 'session'.")
    }
    if (a.note !== undefined && (typeof a.note !== 'string' || a.note.length > MAX_NOTE_CHARS)) {
      throw invalidShape(`\`note\` must be a string of at most ${MAX_NOTE_CHARS} characters.`)
    }
    if (
      a.actor !== undefined &&
      (a.actor === null ||
        typeof a.actor !== 'object' ||
        typeof (a.actor as { id?: unknown }).id !== 'string')
    ) {
      throw invalidShape('`actor` must be an object with a string `id`.')
    }
    const entry = byApprovalId.get(a.id)
    if (entry === undefined || answeredApprovals.has(a.id)) {
      if (ignoreUnknown) continue
      throw reject(
        'unknown-id',
        entry === undefined
          ? `Approval '${a.id}' is not pending.`
          : `Approval '${a.id}' is answered twice.`,
        { id: a.id },
      )
    }
    const approved = entry.granted === true ? true : a.approved
    const out: ApprovalAnswer = {
      approvalId: entry.approvalId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      // a granted approval (deferred behind parked calls) stays granted
      approved,
    }
    const note = typeof a.note === 'string' && a.note.trim().length > 0 ? a.note : undefined
    if (approved) {
      if (typeof a.reason === 'string') out.reason = a.reason
      if (note !== undefined) out.note = note
    } else if (typeof a.reason === 'string' || note !== undefined) {
      // a note on a denial reaches the model through the reason (spec 11 §3.6)
      out.reason = [a.reason, note].filter((t): t is string => typeof t === 'string').join('\n\n')
    }
    if (a.remember === 'once' || a.remember === 'session') out.remember = a.remember
    if (a.actor !== undefined) out.actor = structuredClone(a.actor) as ApprovalActor
    accepted++
    if (entry.answer !== undefined && entry.granted !== true) {
      // recorded by an earlier partial respond(): the same decision again is a no-op
      const recorded = entry.answer
      if (
        recorded.approved !== out.approved ||
        recorded.reason !== out.reason ||
        recorded.note !== out.note
      ) {
        throw reject('conflict', `Approval '${a.id}' was answered differently before.`, {
          id: a.id,
        })
      }
      answeredApprovals.set(a.id, recordedApproval(entry))
      continue
    }
    answeredApprovals.set(a.id, out)
    if (entry.granted !== true) recordApprovals.push(out)
  }

  // approvals granted before their batch parked (spec 11 §3.5) need no second answer; approvals
  // recorded by an earlier partial respond() (ADR-0044) are used as recorded
  for (const entry of pending.approvals) {
    if (answeredApprovals.has(entry.approvalId)) continue
    if (entry.answer !== undefined && entry.granted !== true) {
      answeredApprovals.set(entry.approvalId, recordedApproval(entry))
      continue
    }
    if (entry.granted !== true) continue
    answeredApprovals.set(entry.approvalId, {
      approvalId: entry.approvalId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      approved: true,
    })
  }

  for (const answer of toolOutputs as unknown[]) {
    const o = answer as { toolCallId?: unknown; errorText?: unknown; output?: unknown }
    if (typeof o !== 'object' || o === null || typeof o.toolCallId !== 'string') {
      throw invalidShape('every tool output needs a string `toolCallId`.')
    }
    const isError = 'errorText' in o
    if (isError && typeof o.errorText !== 'string') {
      throw invalidShape('`errorText` must be a string.')
    }
    if (!isError && !('output' in o))
      throw invalidShape('a tool output needs `output` or `errorText`.')
    const entry = byClientCall.get(o.toolCallId)
    if (entry === undefined && externalByCall.has(o.toolCallId)) {
      // only the server resolves an external wait (spec 11 §4.2 rule 5)
      if (ignoreUnknown) continue
      throw reject(
        'wrong-kind',
        `Tool call '${o.toolCallId}' is an external wait; resolve it with resolveWait() or respond({ externals }).`,
        { id: o.toolCallId },
      )
    }
    // a call whose timeout result was recorded (the client was too late) is answered already
    if (entry === undefined || entry.result !== undefined || answeredOutputs.has(o.toolCallId)) {
      if (ignoreUnknown) continue
      throw reject(
        'unknown-id',
        entry === undefined
          ? `Tool call '${o.toolCallId}' is not waiting for a client output.`
          : entry.result !== undefined
            ? `Tool call '${o.toolCallId}' already timed out; its result is recorded.`
            : `Tool call '${o.toolCallId}' is answered twice.`,
        { id: o.toolCallId },
      )
    }
    const given: ClientToolAnswer = isError
      ? { toolCallId: entry.toolCallId, toolName: entry.toolName, errorText: o.errorText as string }
      : { toolCallId: entry.toolCallId, toolName: entry.toolName, output: o.output }
    accepted++
    if (entry.answer !== undefined) {
      if (!sameJson(entry.answer, isError ? { errorText: o.errorText } : { output: o.output })) {
        throw reject('conflict', `Tool call '${o.toolCallId}' was answered differently before.`, {
          id: o.toolCallId,
        })
      }
    } else recordOutputs.push(given)
    answeredOutputs.set(o.toolCallId, given)
  }
  for (const entry of pending.clientTools) {
    if (entry.answer === undefined || answeredOutputs.has(entry.toolCallId)) continue
    answeredOutputs.set(entry.toolCallId, {
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      ...entry.answer,
    } as ClientToolAnswer)
  }

  const answeredExternals = new Map<string, WaitResult>()
  for (const answer of externalAnswers as unknown[]) {
    const x = answer as { waitId?: unknown; errorText?: unknown; output?: unknown }
    if (typeof x !== 'object' || x === null || typeof x.waitId !== 'string') {
      throw invalidShape('every external answer needs a string `waitId`.')
    }
    const isError = 'errorText' in x
    if (isError && typeof x.errorText !== 'string')
      throw invalidShape('`errorText` must be a string.')
    if (!isError && !('output' in x)) {
      throw invalidShape('an external answer needs `output` or `errorText`.')
    }
    const entry = externalById.get(x.waitId)
    // a wait whose result was recorded must not be answered again
    if (entry === undefined || entry.result !== undefined || answeredExternals.has(x.waitId)) {
      if (ignoreUnknown) continue
      throw reject(
        'unknown-id',
        entry === undefined
          ? `Wait '${x.waitId}' is not pending.`
          : `Wait '${x.waitId}' is already resolved or answered twice.`,
        { id: x.waitId },
      )
    }
    answeredExternals.set(
      x.waitId,
      isError
        ? { errorText: x.errorText as string, by: 'result' }
        : { output: x.output as never, by: 'result' },
    )
  }

  const missing = [
    ...externals
      .filter((e) => e.result === undefined && !answeredExternals.has(e.waitId))
      .map((e) => e.waitId),
    ...pending.approvals
      .filter((a) => !answeredApprovals.has(a.approvalId))
      .map((a) => a.approvalId),
    ...pending.clientTools
      .filter((c) => c.result === undefined && !answeredOutputs.has(c.toolCallId))
      .map((c) => c.toolCallId),
  ]
  // a call that answers nothing (or answers external waits, which are not recorded partially)
  // while items are open is rejected; any other partial answer is recorded (ADR-0044)
  if (missing.length > 0 && (accepted === 0 || answeredExternals.size > 0)) {
    throw reject(
      'incomplete',
      `Pending approvals, client tool calls or waits are still unanswered (missing: ${missing.join(', ')}).`,
      { missing },
    )
  }

  let newest: HarnessUIMessage | undefined
  for (const message of args.view) if (kindOf(message) === undefined) newest = message
  if (newest?.id !== pending.messageId) {
    throw reject(
      'stale',
      'The pending message is no longer the newest message of the session; the answers are stale.',
      { messageId: pending.messageId },
    )
  }
  const complete = missing.length === 0
  const externalPlan: ExternalAnswer[] = externals.map((e) => ({
    waitId: e.waitId,
    toolCallId: e.toolCallId,
    toolName: e.toolName,
    result: (e.result ?? answeredExternals.get(e.waitId)) as WaitResult,
    recorded: e.result !== undefined,
  }))
  const externalOutputs: ClientToolAnswer[] = externalPlan.map((e) => {
    const base = { toolCallId: e.toolCallId, toolName: e.toolName }
    return 'errorText' in e.result
      ? {
          ...base,
          errorText: e.result.errorText,
          ...(e.recorded ? { finished: true as const } : {}),
        }
      : { ...base, output: e.result.output, ...(e.recorded ? { finished: true as const } : {}) }
  })
  // client calls that timed out: their recorded result is used as recorded
  const timedOutClients: ClientToolAnswer[] = pending.clientTools.flatMap((c) => {
    if (c.result === undefined) return []
    const base = { toolCallId: c.toolCallId, toolName: c.toolName, finished: true as const }
    return [
      'errorText' in c.result
        ? { ...base, errorText: c.result.errorText }
        : { ...base, output: c.result.output },
    ]
  })
  return {
    pending,
    complete,
    approvals: [...answeredApprovals.values()],
    toolOutputs: [...answeredOutputs.values(), ...timedOutClients, ...externalOutputs],
    externals: complete ? externalPlan : [],
    record: complete
      ? { approvals: [], toolOutputs: [] }
      : { approvals: recordApprovals, toolOutputs: recordOutputs },
    remaining: missing,
  }
}

/** The answer of an approval that a partial `respond()` recorded. */
function recordedApproval(entry: PendingState['approvals'][number]): ApprovalAnswer {
  const a = entry.answer as NonNullable<typeof entry.answer>
  return {
    approvalId: entry.approvalId,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    approved: a.approved,
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    ...(a.remember !== undefined ? { remember: a.remember } : {}),
    ...(a.actor !== undefined ? { actor: structuredClone(a.actor) as ApprovalActor } : {}),
    ...(a.note !== undefined ? { note: a.note } : {}),
  }
}

function setPendingNull(message: HarnessUIMessage): HarnessUIMessage {
  const eharness = message.metadata?.eharness
  if (eharness === undefined) return message
  return { ...message, metadata: { ...message.metadata, eharness: { ...eharness, pending: null } } }
}

function mapToolParts(
  message: HarnessUIMessage,
  patch: (part: ToolPartLike) => Record<string, unknown> | undefined,
): HarnessUIMessage {
  return {
    ...message,
    parts: message.parts.map((original) => {
      if (!isToolUIPart(original)) return original
      const next = patch(original as unknown as ToolPartLike)
      return (next ?? original) as unknown as HarnessUIMessage['parts'][number]
    }),
  }
}

/** Keys a tool part keeps when its state changes to a result. */
function base(part: ToolPartLike): Record<string, unknown> {
  const { state: _s, output: _o, errorText: _e, preliminary: _p, ...rest } = part
  return rest
}

/**
 * Patch the pending message for a continuation (spec 11 §4 step 3): approval parts →
 * `approval-responded` with the approval object **merged** (`signature` and `inputSchemaInput`
 * survive); client tool parts → `output-available` / `output-error` (outputs already passed
 * through `tool.after` and the output limits); `metadata.eharness.pending = null`. The message
 * `parked` names approved calls of client tools (no `execute`): their parts go back to
 * `input-available` instead (the client answers them). The message
 * is running again: its `stop` is removed until the continuation ends (so crash recovery sees an
 * unfinished message, spec 05 §9).
 */
export function patchForRespond(
  message: HarnessUIMessage,
  approvals: readonly ApprovalAnswer[],
  outputs: readonly ClientToolAnswer[],
  parked: ReadonlySet<string> = new Set(),
): HarnessUIMessage {
  const byCall = new Map(approvals.map((a) => [a.toolCallId, a]))
  const outputByCall = new Map(outputs.map((o) => [o.toolCallId, o]))
  const patched = setPendingNull(
    mapToolParts(structuredClone(message), (part) => {
      const approval = byCall.get(part.toolCallId)
      if (approval !== undefined && part.state === 'approval-requested') {
        if (parked.has(part.toolCallId)) {
          // approved call of a tool without `execute`: the client runs it (spec 11 §5)
          const { approval: _approval, ...rest } = base(part)
          return { ...rest, state: 'input-available' }
        }
        const merged: Record<string, unknown> = {
          ...(part.approval ?? { id: approval.approvalId }),
          approved: approval.approved,
        }
        if (approval.reason !== undefined) merged.reason = approval.reason
        return { ...base(part), state: 'approval-responded', approval: merged }
      }
      const output = outputByCall.get(part.toolCallId)
      if (output !== undefined && part.state === 'input-available') {
        return 'errorText' in output
          ? { ...base(part), state: 'output-error', errorText: output.errorText }
          : { ...base(part), state: 'output-available', output: output.output }
      }
      return undefined
    }),
  )
  const eharness = patched.metadata?.eharness
  if (eharness?.stop === undefined) return patched
  const { stop: _stop, ...running } = eharness
  return { ...patched, metadata: { ...patched.metadata, eharness: running } }
}

/**
 * The `onNewInput: 'deny'` patch (spec 11 §4.1): pending approval parts → `output-denied` with
 * `approval: { ...approval, approved: false, reason: DENIED_NEW_INPUT }`, pending client tool parts
 * → `output-error` (`NOT_EXECUTED_NEW_INPUT`), `metadata.eharness.pending = null`.
 */
export function patchForNewInput(
  message: HarnessUIMessage,
  pending: PendingState,
): HarnessUIMessage {
  const approvals = new Set(pending.approvals.map((a) => a.toolCallId))
  const clients = new Set(
    pending.clientTools.filter((c) => c.result === undefined).map((c) => c.toolCallId),
  )
  const timedOut = new Map(
    pending.clientTools.flatMap((c) => (c.result === undefined ? [] : [[c.toolCallId, c.result]])),
  )
  // a wait whose result was recorded keeps it; an open one is cancelled (spec 11 §4.2 rule 7)
  const externals = new Map((pending.externals ?? []).map((e) => [e.toolCallId, e]))
  return setPendingNull(
    mapToolParts(structuredClone(message), (part) => {
      if (approvals.has(part.toolCallId) && part.state === 'approval-requested') {
        return {
          ...base(part),
          state: 'output-denied',
          approval: {
            ...(part.approval ?? {}),
            approved: false,
            reason: DENIED_NEW_INPUT,
          },
        }
      }
      if (clients.has(part.toolCallId) && part.state === 'input-available') {
        return { ...base(part), state: 'output-error', errorText: NOT_EXECUTED_NEW_INPUT }
      }
      const recorded = timedOut.get(part.toolCallId)
      if (recorded !== undefined && part.state === 'input-available') {
        return 'errorText' in recorded
          ? { ...base(part), state: 'output-error', errorText: recorded.errorText }
          : { ...base(part), state: 'output-available', output: recorded.output }
      }
      const wait = externals.get(part.toolCallId)
      if (wait !== undefined && part.state === 'input-available') {
        const result = wait.result
        if (result === undefined) {
          return { ...base(part), state: 'output-error', errorText: WAIT_CANCELLED_NEW_INPUT }
        }
        return 'errorText' in result
          ? { ...base(part), state: 'output-error', errorText: result.errorText }
          : { ...base(part), state: 'output-available', output: result.output }
      }
      return undefined
    }),
  )
}

/**
 * True when `view` is consistent with the stored `pending`: its newest non-kind message is the
 * pending message and every pending call is an open tool part of it. A cache that fails this is
 * stale (another instance answered, or continued the same message with new calls: the message
 * keeps its id, so `lastId` cannot see it) and must be reloaded.
 */
export function viewHoldsPending(
  view: readonly HarnessUIMessage[],
  pending: PendingState,
): boolean {
  let newest: HarnessUIMessage | undefined
  for (const message of view) if (kindOf(message) === undefined) newest = message
  if (newest?.id !== pending.messageId) return false
  const open = new Set<string>()
  for (const part of newest.parts as Array<{ type: string }>) {
    if (isToolPart(part) && !hasToolResult(part)) open.add(part.toolCallId)
  }
  const calls = [
    ...pending.approvals.map((a) => a.toolCallId),
    ...pending.clientTools.map((c) => c.toolCallId),
    ...(pending.externals ?? []).map((e) => e.toolCallId),
  ]
  return calls.every((id) => open.has(id))
}

/** Identity of a pending state (message and calls): equal signatures mean the same wait. */
export function pendingSignature(pending: PendingState | undefined): string {
  if (pending === undefined) return ''
  return JSON.stringify([
    pending.messageId,
    pending.approvals.map((a) => a.approvalId).sort(),
    pending.clientTools.map((c) => c.toolCallId).sort(),
    (pending.externals ?? []).map((e) => e.waitId).sort(),
  ])
}
