/**
 * Turn grouping, current-turn rules and step helpers (internal), shared by compaction and the
 * guard.
 *
 * @see docs/specs/06-compaction.md#51-split
 */
import { kindOf } from '../messages/kinds.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'

/** A half-open range `[start, end)` of indices into a message list. */
export interface TurnRange {
  start: number
  end: number
}

/** True for a boundary kind message (compaction marker). */
export function isBoundaryMessage(message: HarnessUIMessage, registry: MessageRegistry): boolean {
  const kind = kindOf(message)
  return kind !== undefined && registry.kind(kind)?.def.boundary === true
}

/** True for a message that starts a turn: `role: 'user'` and not a kind message. */
export function startsTurn(message: HarnessUIMessage): boolean {
  return message.role === 'user' && kindOf(message) === undefined
}

/**
 * Group messages (no boundary) into turns: a turn starts at every non-kind user message; kind
 * messages before the first such message belong to the first turn. `data-eh.input` parts live
 * inside assistant messages and never start a turn; rewinds are kind messages.
 */
export function groupTurns(messages: readonly HarnessUIMessage[]): TurnRange[] {
  if (messages.length === 0) return []
  const starts: number[] = []
  for (const [index, message] of messages.entries()) if (startsTurn(message)) starts.push(index)
  if (starts.length === 0) return [{ start: 0, end: messages.length }]
  starts[0] = 0
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? messages.length }))
}

/** How the current turn of an operation is found (spec 06 §5.1). */
export type CurrentTurnRule =
  /** `send()` with input, `edit()`: the new user message. */
  | { kind: 'input'; userMessageId: string }
  /** `send()` without input (wake, queued no-input): injected kinds, else the new assistant message. */
  | { kind: 'no-input'; assistantId: string }
  /** `respond()`: the turn of the continued assistant message. */
  | { kind: 'respond'; messageId: string }
  /** `regenerate()`: the turn of the re-answered user message (the old answer is hidden). */
  | { kind: 'regenerate'; assistantId: string }

/**
 * Id of the first message of the current turn in `view` (`[boundary?] + visible`, id order). For
 * a no-input turn without injected kinds this is the (not yet stored) assistant message id.
 */
export function currentTurnStartId(
  view: readonly HarnessUIMessage[],
  rule: CurrentTurnRule,
  registry: MessageRegistry,
): string {
  const body = view.filter((m) => !isBoundaryMessage(m, registry))
  switch (rule.kind) {
    case 'input':
      return rule.userMessageId
    case 'respond': {
      const index = body.findIndex((m) => m.id === rule.messageId)
      const before = index < 0 ? body : body.slice(0, index)
      for (let i = before.length - 1; i >= 0; i--) {
        const message = before[i] as HarnessUIMessage
        if (startsTurn(message)) return message.id
      }
      return (before[0] ?? body[index])?.id ?? rule.messageId
    }
    case 'regenerate': {
      for (let i = body.length - 1; i >= 0; i--) {
        const message = body[i] as HarnessUIMessage
        if (startsTurn(message)) return message.id
      }
      return noInputStart(body, rule.assistantId)
    }
    case 'no-input':
      return noInputStart(body, rule.assistantId)
  }
}

/** First kind message after the last non-kind message, else the assistant message id. */
function noInputStart(body: readonly HarnessUIMessage[], assistantId: string): string {
  let last = -1
  for (const [index, message] of body.entries()) {
    if (message.id === assistantId) continue
    if (kindOf(message) === undefined) last = index
  }
  return body[last + 1]?.id ?? assistantId
}

/** Indices of the `step-start` parts of a message. */
export function stepStarts(message: HarnessUIMessage): number[] {
  const out: number[] = []
  for (const [index, part] of message.parts.entries())
    if (part.type === 'step-start') out.push(index)
  return out
}

/**
 * Parts of `message` from its `from`-th step (inclusive) to its `to`-th step (exclusive); `to`
 * undefined = to the end. Parts before the first `step-start` belong to no step and are kept only
 * when `from` is 0.
 */
export function sliceSteps(
  message: HarnessUIMessage,
  from: number,
  to?: number,
): HarnessUIMessage['parts'] {
  const starts = stepStarts(message)
  const begin = from <= 0 ? 0 : (starts[from] ?? message.parts.length)
  const end = to === undefined ? message.parts.length : (starts[to] ?? message.parts.length)
  return message.parts.slice(begin, Math.max(begin, end))
}

/** The `partial` of a boundary marker, if valid. */
export function partialOf(
  boundary: HarnessUIMessage | undefined,
): CompactionPayload['partial'] | undefined {
  const data = (boundary?.parts[0] as { data?: unknown } | undefined)?.data
  const candidate = (data as { partial?: unknown } | undefined)?.partial
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const { messageId, fromStep } = candidate as { messageId?: unknown; fromStep?: unknown }
  if (typeof messageId !== 'string' || typeof fromStep !== 'number') return undefined
  return { messageId, fromStep }
}

/** The payload of a boundary marker. */
export function payloadOf(boundary: HarnessUIMessage | undefined): CompactionPayload | undefined {
  return (boundary?.parts[0] as { data?: CompactionPayload } | undefined)?.data
}

/**
 * Apply a `partial` to one message: drop its parts before the `fromStep`-th `step-start` (all
 * parts when it has fewer steps). The cached token estimate is removed from a trimmed copy.
 */
export function trimToPartial(
  message: HarnessUIMessage,
  partial: CompactionPayload['partial'] | undefined,
): HarnessUIMessage {
  if (partial === undefined || message.id !== partial.messageId) return message
  const starts = stepStarts(message)
  const begin = starts[partial.fromStep] ?? message.parts.length
  return withoutTokens({ ...message, parts: message.parts.slice(begin) })
}

/** A copy without `metadata.eharness.tokens` (for trimmed messages). */
export function withoutTokens(message: HarnessUIMessage): HarnessUIMessage {
  const eharness = message.metadata?.eharness
  if (eharness?.tokens === undefined) return message
  const { tokens: _tokens, ...rest } = eharness
  return { ...message, metadata: { ...message.metadata, eharness: rest } }
}
