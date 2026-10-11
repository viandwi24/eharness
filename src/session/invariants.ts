/**
 * Session invariants (internal): the properties that must hold for every stored session, checked
 * by tests (and by `debug.invariants` at turn end). Spec 05 §15.
 *
 * I1  every stored message is a valid AI SDK `UIMessage` (schema, metadata, kind shape)
 * I2  ids are unique and strictly ascending (stored order = model order)
 * I3  tool call ids are unique; a finished (quiescent) session has exactly one result per call in
 *     the model projection (ADR-0014)
 * I4  pending ids are unique and name non-terminal tool parts of the pending message
 * I5  at most one active turn; no active turn while a turn-less session holds pending state
 * I6  state numbers are sane (`rev`, usage, `inboxDelivered` unique and capped)
 */
import type { SessionStateSnapshot } from '../agent/session-types.ts'
import { project } from '../messages/project.ts'
import { createCoreMessageRegistry, type MessageRegistry } from '../messages/registry.ts'
import { hasToolResult, isToolPart, type ToolPartLike } from '../messages/tool-parts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { checkMessageShape } from '../messages/validate.ts'

/** Options of {@link checkSessionInvariants}. */
export interface InvariantOptions {
  /** Registry for data schemas (default: core registry; unregistered data parts are ignored). */
  registry?: MessageRegistry
  /**
   * No turn is running anywhere: also check I3 (projection) and that no `activeTurn` is stored.
   * Default false (a turn in flight is allowed to be half-written).
   */
  quiescent?: boolean
  /** Skip the per-message schema check (I1). */
  skipSchema?: boolean
}

function toolParts(m: HarnessUIMessage): ToolPartLike[] {
  return (m.parts as Array<{ type: string }>).filter(isToolPart)
}

/** Violated invariants (empty when all hold). Never throws. */
export async function checkSessionInvariants(
  state: SessionStateSnapshot | null,
  messages: readonly HarnessUIMessage[],
  options: InvariantOptions = {},
): Promise<string[]> {
  const problems: string[] = []
  const registry = options.registry ?? createCoreMessageRegistry()
  const core = state?.core ?? {}

  // I2 (a compaction boundary heads a loaded view although it is the newest message)
  const ordered = messages.filter((m) => m.metadata?.eharness?.kind !== 'eh.compaction')
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as HarnessUIMessage
    const m = ordered[i] as HarnessUIMessage
    if (!(prev.id < m.id)) problems.push(`I2: ids not strictly ascending: ${prev.id} then ${m.id}`)
  }
  // I1
  if (options.skipSchema !== true) {
    for (const m of messages) {
      const problem = await checkMessageShape(m, registry)
      if (problem !== undefined) problems.push(`I1: message ${m.id} invalid: ${problem}`)
    }
  }
  // I3 (ids)
  const calls = new Map<string, string>()
  for (const m of messages) {
    for (const part of toolParts(m)) {
      const owner = calls.get(part.toolCallId)
      if (owner !== undefined && owner !== m.id) {
        problems.push(`I3: tool call ${part.toolCallId} appears in messages ${owner} and ${m.id}`)
      }
      calls.set(part.toolCallId, m.id)
    }
    const ids = toolParts(m).map((p) => p.toolCallId)
    if (new Set(ids).size !== ids.length) problems.push(`I3: duplicate tool call id in ${m.id}`)
  }
  // I4
  const pending = core.pending
  if (pending !== undefined && pending !== null) {
    const approvalIds = pending.approvals.map((a) => a.approvalId)
    const toolCallIds = [
      ...pending.approvals.map((a) => a.toolCallId),
      ...pending.clientTools.map((c) => c.toolCallId),
      ...(pending.externals ?? []).map((e) => e.toolCallId),
    ]
    if (new Set(approvalIds).size !== approvalIds.length) problems.push('I4: duplicate approval id')
    if (new Set(toolCallIds).size !== toolCallIds.length)
      problems.push('I4: duplicate pending call')
    const holder = messages.find((m) => m.id === pending.messageId)
    if (holder === undefined) problems.push(`I4: pending message ${pending.messageId} not stored`)
    else {
      const newest = ordered.filter((m) => m.metadata?.eharness?.kind === undefined).at(-1)
      if (newest?.id !== pending.messageId) {
        problems.push(`I5: pending message ${pending.messageId} is not the newest message`)
      }
      for (const id of toolCallIds) {
        const part = toolParts(holder).find((p) => p.toolCallId === id)
        if (part === undefined) problems.push(`I4: pending call ${id} has no tool part`)
        else if (hasToolResult(part)) problems.push(`I4: pending call ${id} already has a result`)
      }
    }
    if (core.activeTurn !== undefined && options.quiescent === true) {
      problems.push('I5: activeTurn stored while the session holds pending state')
    }
  }
  // I5
  if (options.quiescent === true && core.activeTurn !== undefined) {
    problems.push(`I5: activeTurn ${core.activeTurn.turnId} stored but nothing runs`)
  }
  // I6
  const delivered = core.inboxDelivered ?? []
  if (new Set(delivered).size !== delivered.length) problems.push('I6: duplicate inboxDelivered')
  if (delivered.length > 100) problems.push('I6: inboxDelivered exceeds 100')
  if (state !== null && !(Number.isInteger(state.rev) && state.rev >= 0))
    problems.push('I6: bad rev')

  // I3 (projection): exactly one result per call, results follow calls
  if (options.quiescent === true && problems.length === 0) {
    try {
      const view = messages.filter((m) => m.metadata?.eharness?.kind !== 'eh.compaction')
      const wire = await project(view, {
        registry,
        sessionId: 'invariants',
        pending: pending ?? null,
      })
      const open = new Set<string>()
      const answered = new Set<string>()
      for (const msg of wire) {
        if (typeof msg.content === 'string') continue
        for (const part of msg.content) {
          if (part.type === 'tool-call') {
            if (open.has(part.toolCallId) || answered.has(part.toolCallId)) {
              problems.push(`I3: tool call ${part.toolCallId} projected twice`)
            }
            open.add(part.toolCallId)
          } else if (part.type === 'tool-result') {
            if (answered.has(part.toolCallId)) {
              problems.push(`I3: tool call ${part.toolCallId} has two results`)
            }
            if (!open.delete(part.toolCallId) && !answered.has(part.toolCallId)) {
              problems.push(`I3: result ${part.toolCallId} without a call`)
            }
            answered.add(part.toolCallId)
          }
        }
      }
      const pendingCalls = new Set([
        ...(pending?.approvals ?? []).map((a) => a.toolCallId),
        ...(pending?.clientTools ?? []).map((c) => c.toolCallId),
        ...(pending?.externals ?? []).map((e) => e.toolCallId),
      ])
      for (const id of open) {
        if (!pendingCalls.has(id)) problems.push(`I3: tool call ${id} has no result in projection`)
      }
    } catch (error) {
      problems.push(
        `I3: projection failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return problems
}

/** Throw (a plain `Error`, programmer error) listing every violated invariant. */
export async function assertSessionInvariants(
  state: SessionStateSnapshot | null,
  messages: readonly HarnessUIMessage[],
  options: InvariantOptions = {},
): Promise<void> {
  const problems = await checkSessionInvariants(state, messages, options)
  if (problems.length > 0)
    throw new Error(`session invariants violated:\n- ${problems.join('\n- ')}`)
}
