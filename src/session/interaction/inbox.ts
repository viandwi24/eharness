/**
 * The input queue of a running turn (internal): steers and `next-step` injections waiting for
 * the next step boundary, in arrival order. (Not the durable `InboxAdapter` port, spec 05 §12.)
 *
 * @see docs/specs/11-interaction.md#61-steer
 * @see docs/specs/11-interaction.md#63-inject-delivery-and-wake
 */
import { convertToModelMessages, type ModelMessage } from 'ai'
import type { SteerDelivery } from '../../agent/session-types.ts'
import { kindOf } from '../../messages/kinds.ts'
import type { MessageRegistry } from '../../messages/registry.ts'
import type { HarnessUIMessage, InputPartData } from '../../messages/types.ts'
import type { NormalizedInput } from '../input.ts'

/** One input ready for delivery at a step boundary. */
export interface PendingInput {
  /** The persistent `data-eh.input` part data written into the running assistant message. */
  data: InputPartData
  /** A steer: the submitted input (for the queued fallback) and the text of the original input. */
  steer?: { input: NormalizedInput; contexts: string[]; text: string }
  /** A `next-step` injection: the saved kind message (updated with `deliveredIn` later). */
  event?: HarnessUIMessage
  /** The injection asked for `wake`: if it is not delivered, a wake turn is queued. */
  wake?: boolean
  /** A steer claimed from the durable inbox: acked once its `data-eh.input` is saved. */
  inboxId?: string
  /** Reports where a steer went (`HarnessRun.delivery`); the first call wins. */
  settle?: (outcome: SteerDelivery) => void
}

/** The input queue of one running turn. */
export interface TurnInputQueue {
  /** False once the turn stopped taking input (its step loop ended). */
  readonly open: boolean
  /** True when something was pushed and not taken yet. */
  readonly waiting: boolean
  /** Add an entry (resolves `undefined` when the input was dropped). False when closed. */
  push(entry: Promise<PendingInput | undefined>): boolean
  /** Take every waiting entry, in order (awaits in-flight `input.submit` hooks). */
  take(): Promise<PendingInput[]>
  /** Put taken items back at the front (the loop stopped before delivering them). */
  unshift(items: readonly PendingInput[]): void
  /** Stop taking input and return everything that was not delivered. */
  close(): Promise<PendingInput[]>
}

/** Create an empty, open input queue. */
export function createTurnInputQueue(): TurnInputQueue {
  let entries: Array<Promise<PendingInput | undefined>> = []
  let open = true
  const take = async (): Promise<PendingInput[]> => {
    const out: PendingInput[] = []
    while (entries.length > 0) {
      const taken = entries
      entries = []
      for (const entry of taken) {
        const item = await entry
        if (item !== undefined) out.push(item)
      }
    }
    return out
  }
  return {
    get open() {
      return open
    },
    get waiting() {
      return entries.length > 0
    },
    push(entry) {
      if (!open) return false
      // a rejected entry (a failing hook runner) must never break the loop
      entries.push(entry.catch(() => undefined))
      return true
    },
    take,
    unshift(items) {
      entries = [...items.map((item) => Promise.resolve(item)), ...entries]
    },
    async close() {
      open = false
      return take()
    },
  }
}

/**
 * The user model message of a `data-eh.input` part: exactly what projection produces when it
 * splits the stored assistant message (spec 03 §6 step 4), so stored order equals model order.
 */
export async function inputWireMessage(data: InputPartData): Promise<ModelMessage[]> {
  const parts: Array<{ type: 'text'; text: string } | NonNullable<InputPartData['files']>[number]> =
    [{ type: 'text', text: data.text }, ...(data.files ?? [])]
  return convertToModelMessages([{ role: 'user', parts }])
}

/**
 * The text a kind message delivers into a running turn: its model projection (spec 03 §5.1)
 * with text parts joined; `undefined` when the kind is not projected or its projection has file
 * parts — such a message is not delivered inline and reaches the model (whole) at the next turn.
 * Throws when the projection throws.
 */
export function kindText(
  message: HarnessUIMessage,
  registry: MessageRegistry,
  sessionId: string,
): string | undefined {
  const kind = kindOf(message)
  if (kind === undefined) return undefined
  const model = registry.kind(kind)?.def.model
  if (model === undefined || model === 'omit') return undefined
  const part = message.parts[0] as { type: string; data?: unknown } | undefined
  if (part?.type !== `data-${kind}`) return undefined
  const result = model(part.data as never, { message, sessionId })
  if (result === null || result === undefined) return undefined
  if (typeof result !== 'string' && result.some((p) => p.type !== 'text')) return undefined
  const text =
    typeof result === 'string'
      ? result
      : result.map((p) => (p as { text: string }).text).join('\n\n')
  return text.length === 0 ? undefined : text
}
