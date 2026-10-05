/**
 * Head + tail truncation shared by the guard, the compaction transcript and tool output limits
 * (internal).
 *
 * @see docs/specs/09-tools-and-mcp.md#4-tool-output-limits
 */
import { TOOL_OUTPUT_TRUNCATED } from '../messages/texts.ts'

/** Share of the budget kept from the start of the text; the rest is kept from the end. */
const HEAD_SHARE = 0.7

/**
 * Truncate `text` to about `maxChars` characters: the first 70% and the last 30% of the budget are
 * kept around the `TOOL_OUTPUT_TRUNCATED` marker (`{n}` = number of removed characters). Text
 * within the budget is returned unchanged. The marker itself is not counted in the budget. Cut
 * points never split a UTF-16 surrogate pair (an emoji is kept whole or removed whole).
 */
export function truncateMiddle(text: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars))
  if (text.length <= budget) return text
  let head = Math.floor(budget * HEAD_SHARE)
  let tailStart = text.length - (budget - head)
  // never cut a surrogate pair: move the cut points off its middle (the budget may shrink by one)
  if (head > 0 && isLow(text.charCodeAt(head)) && isHigh(text.charCodeAt(head - 1))) head--
  if (
    tailStart < text.length &&
    isLow(text.charCodeAt(tailStart)) &&
    isHigh(text.charCodeAt(tailStart - 1))
  ) {
    tailStart++
  }
  const removed = tailStart - head
  return `${text.slice(0, head)}${TOOL_OUTPUT_TRUNCATED.replace('{n}', String(removed))}${text.slice(tailStart)}`
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
