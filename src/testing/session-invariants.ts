/**
 * `assertStoredSessionInvariants`: the session invariants (spec 05 §15) checked on what is in the
 * storage (a state snapshot and the stored messages), for tests of an adapter or an application.
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 */
import type { HarnessUIMessage, SessionStateSnapshot } from '../index.ts'
import { assertValidUIMessage } from './schema-checked-messages.ts'

/** Options of {@link assertStoredSessionInvariants}. */
export interface StoredSessionInvariantOptions {
  /** No turn runs anywhere: no `activeTurn` may be stored and no tool call may lack a result. */
  quiescent?: boolean
}

type ToolPart = { type: string; toolCallId: string; state: string; preliminary?: boolean }

function toolParts(message: HarnessUIMessage): ToolPart[] {
  return (message.parts as Array<{ type: string }>).filter(
    (p): p is ToolPart => p.type.startsWith('tool-') || p.type === 'dynamic-tool',
  )
}

const hasResult = (p: ToolPart): boolean =>
  (p.state === 'output-available' && p.preliminary !== true) ||
  p.state === 'output-error' ||
  p.state === 'output-denied'

/**
 * Throw (listing every violation) when the stored session breaks an invariant:
 *
 * - every message is a valid AI SDK `UIMessage` (data parts are not checked here);
 * - message ids are unique and ascending (stored order = model order);
 * - tool call ids are unique across the session;
 * - pending ids (approval ids, tool call ids) are unique, name tool parts of the pending message
 *   that have no result yet, and the pending message is stored;
 * - quiescent: no `activeTurn`, and every tool call without a result is a pending one;
 * - `inboxDelivered` is unique and at most 100 long.
 */
export async function assertStoredSessionInvariants(
  state: SessionStateSnapshot | null,
  messages: readonly HarnessUIMessage[],
  options: StoredSessionInvariantOptions = {},
): Promise<void> {
  const problems: string[] = []
  const core = state?.core ?? {}
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1] as HarnessUIMessage
    const m = messages[i] as HarnessUIMessage
    if (!(prev.id < m.id)) problems.push(`ids not strictly ascending: ${prev.id}, ${m.id}`)
  }
  for (const m of messages) {
    try {
      await assertValidUIMessage(m)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
  }
  const owner = new Map<string, string>()
  for (const m of messages) {
    for (const p of toolParts(m)) {
      const other = owner.get(p.toolCallId)
      if (other !== undefined && other !== m.id) {
        problems.push(`tool call ${p.toolCallId} is in messages ${other} and ${m.id}`)
      }
      owner.set(p.toolCallId, m.id)
    }
  }
  const pending = core.pending
  const pendingCalls = new Set<string>()
  if (pending !== undefined && pending !== null) {
    const ids = [
      ...pending.approvals.map((a) => a.toolCallId),
      ...pending.clientTools.map((c) => c.toolCallId),
      ...(pending.externals ?? []).map((e) => e.toolCallId),
    ]
    for (const id of ids) pendingCalls.add(id)
    if (pendingCalls.size !== ids.length) problems.push('pending state lists a call twice')
    const approvalIds = pending.approvals.map((a) => a.approvalId)
    if (new Set(approvalIds).size !== approvalIds.length) problems.push('duplicate approval id')
    const holder = messages.find((m) => m.id === pending.messageId)
    if (holder === undefined) problems.push(`pending message ${pending.messageId} is not stored`)
    else {
      for (const id of ids) {
        const part = toolParts(holder).find((p) => p.toolCallId === id)
        if (part === undefined) problems.push(`pending call ${id} has no tool part`)
        else if (hasResult(part)) problems.push(`pending call ${id} already has a result`)
      }
    }
  }
  if (options.quiescent === true) {
    if (core.activeTurn !== undefined) problems.push(`activeTurn ${core.activeTurn.turnId} stored`)
    for (const m of messages) {
      for (const p of toolParts(m)) {
        if (!hasResult(p) && !pendingCalls.has(p.toolCallId)) {
          problems.push(`tool call ${p.toolCallId} of message ${m.id} has no result (${p.state})`)
        }
      }
    }
  }
  const delivered = core.inboxDelivered ?? []
  if (new Set(delivered).size !== delivered.length) problems.push('inboxDelivered has duplicates')
  if (delivered.length > 100) problems.push('inboxDelivered is longer than 100')
  if (problems.length > 0)
    throw new Error(`session invariants violated:\n- ${problems.join('\n- ')}`)
}
