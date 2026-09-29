/**
 * The guard's hard cap (internal): drop the oldest completed turns, then truncate the largest
 * tool outputs of the current turn in the wire copy, until the request fits.
 *
 * @see docs/specs/06-compaction.md#6-guard-always-on-not-configurable-away
 */
import type { ModelMessage } from 'ai'
import { truncateMiddle } from './truncate.ts'

/** Tool outputs at or below this size are never truncated by the guard. */
export const MIN_TRUNCATED_OUTPUT_CHARS = 1_000

/** Input of {@link applyHardCap}. */
export interface HardCapInput {
  /** Summary head (boundary projection); never dropped. */
  head: readonly ModelMessage[]
  /** Completed turns, oldest first (droppable). */
  turns: ReadonlyArray<readonly ModelMessage[]>
  /** The current turn (never dropped; its tool outputs may be truncated). */
  current: readonly ModelMessage[]
  /** Calibrated tokens of everything besides the messages (instructions, tools, reminders). */
  fixedTokens: number
  /** Absolute limit (calibrated tokens). */
  limit: number
  /** Calibrated tokens of a list of messages. */
  measure(messages: readonly ModelMessage[]): number
}

/** Result of {@link applyHardCap}. */
export interface HardCapResult {
  /** The request messages: head + remaining turns + current (possibly truncated). */
  messages: ModelMessage[]
  /** Index of the current turn's first message in `messages`. */
  turnStart: number
  /** Number of completed turns dropped. */
  droppedTurns: number
  /** Number of tool outputs truncated. */
  truncatedOutputs: number
  /** Calibrated tokens of the result, fixed part included. */
  tokens: number
  /** True when the result is still over the limit. */
  over: boolean
}

type ToolResultLike = { type: 'tool-result'; output: unknown; [key: string]: unknown }

function outputChars(output: unknown): number {
  const o = output as { type?: unknown; value?: unknown }
  if (o?.type === 'text' || o?.type === 'error-text') return String(o.value ?? '').length
  if (o?.type === 'json' || o?.type === 'error-json') return (JSON.stringify(o.value) ?? '').length
  if (o?.type === 'content' && Array.isArray(o.value)) {
    return (o.value as Array<{ type?: string; text?: unknown }>).reduce(
      (sum, item) => sum + (item.type === 'text' ? String(item.text ?? '').length : 0),
      0,
    )
  }
  return 0
}

function truncateOutput(output: unknown, maxChars: number): unknown {
  const o = output as { type?: unknown; value?: unknown }
  if (o.type === 'text' || o.type === 'error-text') {
    return { ...o, value: truncateMiddle(String(o.value ?? ''), maxChars) }
  }
  if (o.type === 'json' || o.type === 'error-json') {
    const value = o.value as { truncated?: unknown; preview?: unknown; originalChars?: unknown }
    if (value?.truncated === true && typeof value.preview === 'string') {
      return { ...o, value: { ...value, preview: truncateMiddle(value.preview, maxChars) } }
    }
    const text = JSON.stringify(o.value) ?? ''
    return {
      ...o,
      value: {
        truncated: true,
        preview: truncateMiddle(text, maxChars),
        originalChars: text.length,
      },
    }
  }
  if (o.type === 'content' && Array.isArray(o.value)) {
    const total = outputChars(o)
    return {
      ...o,
      value: (o.value as Array<{ type?: string; text?: unknown }>).map((item) =>
        item.type === 'text'
          ? {
              ...item,
              text: truncateMiddle(
                String(item.text ?? ''),
                Math.floor((String(item.text ?? '').length / Math.max(1, total)) * maxChars),
              ),
            }
          : item,
      ),
    }
  }
  return output
}

/** Locations of the tool results of a message list. */
function toolResults(
  messages: readonly ModelMessage[],
): Array<{ m: number; p: number; chars: number }> {
  const out: Array<{ m: number; p: number; chars: number }> = []
  for (const [m, message] of messages.entries()) {
    if (typeof message.content === 'string') continue
    for (const [p, part] of (message.content as Array<{ type: string }>).entries()) {
      if (part.type !== 'tool-result') continue
      out.push({ m, p, chars: outputChars((part as ToolResultLike).output) })
    }
  }
  return out
}

/**
 * Fit a request under `limit` (spec 06 §6 step 2): drop the oldest whole completed turns; when
 * only the current turn remains, halve the largest tool output of the current turn (head + tail,
 * never below {@link MIN_TRUNCATED_OUTPUT_CHARS}) until it fits or nothing is left to truncate.
 * The input arrays are never mutated.
 */
export function applyHardCap(input: HardCapInput): HardCapResult {
  const { measure, fixedTokens, limit } = input
  const head = [...input.head]
  let turns = input.turns.map((t) => [...t])
  let current = [...input.current]
  const total = () =>
    fixedTokens + measure(head) + turns.reduce((s, t) => s + measure(t), 0) + measure(current)
  let tokens = total()
  let droppedTurns = 0
  while (tokens > limit && turns.length > 0) {
    turns = turns.slice(1)
    droppedTurns++
    tokens = total()
  }
  let truncatedOutputs = 0
  const touched = new Set<string>()
  const exhausted = new Set<string>()
  while (tokens > limit) {
    const candidates = toolResults(current).filter(
      (r) => r.chars > MIN_TRUNCATED_OUTPUT_CHARS && !exhausted.has(`${r.m}:${r.p}`),
    )
    if (candidates.length === 0) break
    candidates.sort((a, b) => b.chars - a.chars || a.m - b.m || a.p - b.p)
    const target = candidates[0] as { m: number; p: number; chars: number }
    const key = `${target.m}:${target.p}`
    const max = Math.max(MIN_TRUNCATED_OUTPUT_CHARS, Math.floor(target.chars / 2))
    const message = current[target.m] as ModelMessage
    const content = message.content as Array<{ type: string }>
    const part = content[target.p] as ToolResultLike
    const output = truncateOutput(part.output, max)
    if (outputChars(output) >= target.chars) {
      exhausted.add(key)
      continue
    }
    current = current.map((m, index) =>
      index === target.m
        ? ({
            ...m,
            content: content.map((p, i) => (i === target.p ? { ...part, output } : p)),
          } as ModelMessage)
        : m,
    )
    if (!touched.has(key)) {
      touched.add(key)
      truncatedOutputs++
    }
    tokens = total()
  }
  const flatTurns = turns.flat()
  return {
    messages: [...head, ...flatTurns, ...current],
    turnStart: head.length + flatTurns.length,
    droppedTurns,
    truncatedOutputs,
    tokens,
    over: tokens > limit,
  }
}
