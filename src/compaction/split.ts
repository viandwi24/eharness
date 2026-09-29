/**
 * The compaction split (internal): which messages are summarized (`drop`), which are kept
 * verbatim, `resumeFromId` and `partial` (incl. carry-forward), with auto-shrink.
 *
 * @see docs/specs/06-compaction.md#51-split
 */
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'
import {
  groupTurns,
  partialOf,
  payloadOf,
  sliceSteps,
  stepStarts,
  trimToPartial,
  withoutTokens,
} from './turns.ts'

/** Share of the window the kept completed turns may use before auto-shrink (spec 06 §5.2). */
export const KEEP_SHARE = 0.25

/** Input of {@link planSplit}. */
export interface SplitInput {
  /** The view: `[boundary?] + visible messages`, id order. */
  view: readonly HarnessUIMessage[]
  isBoundary(message: HarnessUIMessage): boolean
  /**
   * - `pre-turn`: the current turn T (from `currentStartId`) is kept, completed turns before it
   *   are split by `keepLast`;
   * - `manual`: like pre-turn; `currentStartId` is the turn of a pending message, if any;
   * - `mid-turn`: T is kept except the steps of `assistantId` before its last completed step.
   */
  mode: 'pre-turn' | 'manual' | 'mid-turn'
  /** First message of the current turn (pre-turn / mid-turn) or of the pending turn (manual). */
  currentStartId: string | undefined
  /** Assistant message of the running turn (pre-turn fallback of `resumeFromId`; mid-turn A). */
  assistantId?: string
  keepLast: number
  /** Kept completed turns above this many (calibrated) tokens are shrunk one turn at a time. */
  maxKeptTokens: number
  /** Calibrated tokens of one message (as projected). */
  tokensOf(message: HarnessUIMessage): Promise<number>
}

/** Result of {@link planSplit}. */
export interface SplitPlan {
  /** Summary of the previous marker (rendered first). */
  previousSummary: string | undefined
  /** Messages to summarize (trimmed where a `partial` applies), id order. */
  drop: HarnessUIMessage[]
  /** Messages kept verbatim (trimmed where the new `partial` applies), id order. */
  keep: HarnessUIMessage[]
  /** Calibrated tokens of `keep`. */
  keptTokens: number
  resumeFromId: string | null
  partial?: CompactionPayload['partial']
  /** Completed turns kept verbatim (after auto-shrink). */
  keptTurns: number
}

/** Plan a compaction (pure apart from `tokensOf`). */
export async function planSplit(input: SplitInput): Promise<SplitPlan> {
  const boundary = input.view.find((m) => input.isBoundary(m))
  const previous = payloadOf(boundary)
  const previousPartial = partialOf(boundary)
  const body = input.view.filter((m) => !input.isBoundary(m))
  const startId = input.currentStartId
  const completed = startId === undefined ? body : body.filter((m) => m.id < startId)
  const current = startId === undefined ? [] : body.filter((m) => m.id >= startId)
  const turns = groupTurns(completed)

  const drop: HarnessUIMessage[] = []
  const keep: HarnessUIMessage[] = []
  let partial: CompactionPayload['partial'] | undefined
  let keptTurns = 0

  if (input.mode === 'mid-turn') {
    const assistantId = input.assistantId
    for (const message of completed) drop.push(trimToPartial(message, previousPartial))
    const carried =
      previousPartial !== undefined && previousPartial.messageId === assistantId
        ? previousPartial.fromStep
        : 0
    for (const message of current) {
      if (message.id !== assistantId) {
        keep.push(trimToPartial(message, previousPartial))
        continue
      }
      const last = stepStarts(message).length - 1
      if (last <= carried) {
        // nothing new to summarize inside A
        keep.push(trimToPartial(message, previousPartial))
        if (previousPartial?.messageId === message.id) partial = previousPartial
        continue
      }
      const dropped = sliceSteps(message, carried, last)
      if (dropped.length > 0) drop.push(withoutTokens({ ...message, parts: dropped }))
      partial = { messageId: message.id, fromStep: last }
      keep.push(trimToPartial(message, partial))
    }
    const keptTokens = await sum(keep, input.tokensOf)
    const first = current[0]
    return {
      previousSummary: previous?.summary,
      drop,
      keep,
      keptTokens,
      resumeFromId: first?.id ?? assistantId ?? null,
      ...(partial === undefined ? {} : { partial }),
      keptTurns: 0,
    }
  }

  // pre-turn / manual: keep the last `keepLast` completed turns, shrinking above maxKeptTokens
  const turnTokens: number[] = []
  for (const turn of turns) {
    turnTokens.push(
      await sum(
        completed.slice(turn.start, turn.end).map((m) => trimToPartial(m, previousPartial)),
        input.tokensOf,
      ),
    )
  }
  let n = Math.max(0, Math.min(Math.floor(input.keepLast), turns.length))
  while (
    n > 0 &&
    turnTokens.slice(turns.length - n).reduce((a, b) => a + b, 0) > input.maxKeptTokens
  )
    n--
  keptTurns = n
  const firstKeptTurn = turns[turns.length - n]
  const keepFrom = firstKeptTurn === undefined ? completed.length : firstKeptTurn.start
  for (const [index, message] of completed.entries()) {
    ;(index < keepFrom ? drop : keep).push(trimToPartial(message, previousPartial))
  }
  for (const message of current) keep.push(trimToPartial(message, previousPartial))
  if (previousPartial !== undefined && keep.some((m) => m.id === previousPartial.messageId)) {
    partial = previousPartial
  }
  const firstKept = keep[0]
  const resumeFromId =
    firstKept?.id ?? (input.mode === 'pre-turn' ? (startId ?? input.assistantId ?? null) : null)
  return {
    previousSummary: previous?.summary,
    drop,
    keep,
    keptTokens: await sum(keep, input.tokensOf),
    resumeFromId,
    ...(partial === undefined ? {} : { partial }),
    keptTurns,
  }
}

async function sum(
  messages: readonly HarnessUIMessage[],
  tokensOf: (message: HarnessUIMessage) => Promise<number>,
): Promise<number> {
  let n = 0
  for (const message of messages) n += await tokensOf(message)
  return n
}
