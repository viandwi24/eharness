/**
 * Pending approvals and client tool calls (internal): validation of `respond()` answers against
 * the server-owned pending state, patching of the pending assistant message for a continuation,
 * and the `onNewInput: 'deny'` patch.
 *
 * @see docs/specs/11-interaction.md#4-respond
 * @see docs/specs/11-interaction.md#41-new-input-while-pending
 */
import type { PendingResponse } from '../../agent/session-types.ts'
import { HarnessError } from '../../errors.ts'
import { kindOf } from '../../messages/kinds.ts'
import { DENIED_NEW_INPUT, NOT_EXECUTED_NEW_INPUT } from '../../messages/texts.ts'
import { isToolPart, type ToolPartLike } from '../../messages/tool-parts.ts'
import type { HarnessUIMessage, PendingState } from '../../messages/types.ts'

/**
 * Internal `respond()` option set by `handleChatRequest`: answers that are not pending are
 * ignored instead of rejected (spec 11 §7). `Symbol.for` so that package copies agree.
 */
export const RESPOND_IGNORE_UNKNOWN: unique symbol = Symbol.for('eharness.respond.ignoreUnknown')

/** Why `respond()` answers were rejected (`details.reason` of `EH_INVALID_INPUT`). */
export type RespondRejection = 'unknown-id' | 'incomplete' | 'stale'

/** One validated approval answer. */
export interface ApprovalAnswer {
  approvalId: string
  toolCallId: string
  toolName: string
  approved: boolean
  reason?: string
  remember?: 'once' | 'session'
}

/** One validated client tool answer. */
export type ClientToolAnswer =
  | { toolCallId: string; toolName: string; output: unknown }
  | { toolCallId: string; toolName: string; errorText: string }

/** Validated answers of one `respond()`: every pending item answered exactly once. */
export interface RespondPlan {
  pending: PendingState
  approvals: ApprovalAnswer[]
  toolOutputs: ClientToolAnswer[]
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
  if (!Array.isArray(approvals)) throw invalidShape('`approvals` must be an array.')
  if (!Array.isArray(toolOutputs)) throw invalidShape('`toolOutputs` must be an array.')
  if (pending === undefined) {
    throw reject('unknown-id', 'Nothing is waiting for a response in this session.')
  }

  const byApprovalId = new Map(pending.approvals.map((a) => [a.approvalId, a]))
  const byClientCall = new Map(pending.clientTools.map((c) => [c.toolCallId, c]))
  const answeredApprovals = new Map<string, ApprovalAnswer>()
  const answeredOutputs = new Map<string, ClientToolAnswer>()

  for (const answer of approvals as unknown[]) {
    const a = answer as { id?: unknown; approved?: unknown; reason?: unknown; remember?: unknown }
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
    const out: ApprovalAnswer = {
      approvalId: entry.approvalId,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      approved: a.approved,
    }
    if (typeof a.reason === 'string') out.reason = a.reason
    if (a.remember === 'once' || a.remember === 'session') out.remember = a.remember
    answeredApprovals.set(a.id, out)
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
    if (entry === undefined || answeredOutputs.has(o.toolCallId)) {
      if (ignoreUnknown) continue
      throw reject(
        'unknown-id',
        entry === undefined
          ? `Tool call '${o.toolCallId}' is not waiting for a client output.`
          : `Tool call '${o.toolCallId}' is answered twice.`,
        { id: o.toolCallId },
      )
    }
    answeredOutputs.set(
      o.toolCallId,
      isError
        ? {
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            errorText: o.errorText as string,
          }
        : { toolCallId: entry.toolCallId, toolName: entry.toolName, output: o.output },
    )
  }

  const missing = [
    ...pending.approvals
      .filter((a) => !answeredApprovals.has(a.approvalId))
      .map((a) => a.approvalId),
    ...pending.clientTools
      .filter((c) => !answeredOutputs.has(c.toolCallId))
      .map((c) => c.toolCallId),
  ]
  if (missing.length > 0) {
    throw reject(
      'incomplete',
      `Every pending approval and client tool call must be answered in one respond() (missing: ${missing.join(', ')}).`,
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
  return {
    pending,
    approvals: [...answeredApprovals.values()],
    toolOutputs: [...answeredOutputs.values()],
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
      if (!isToolPart(original)) return original
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
 * through `tool.after` and the output limits); `metadata.eharness.pending = null`.
 */
export function patchForRespond(
  message: HarnessUIMessage,
  approvals: readonly ApprovalAnswer[],
  outputs: readonly ClientToolAnswer[],
): HarnessUIMessage {
  const byCall = new Map(approvals.map((a) => [a.toolCallId, a]))
  const outputByCall = new Map(outputs.map((o) => [o.toolCallId, o]))
  return setPendingNull(
    mapToolParts(structuredClone(message), (part) => {
      const approval = byCall.get(part.toolCallId)
      if (approval !== undefined && part.state === 'approval-requested') {
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
  const clients = new Set(pending.clientTools.map((c) => c.toolCallId))
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
      return undefined
    }),
  )
}
