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
 * within the budget is returned unchanged. The marker itself is not counted in the budget.
 */
export function truncateMiddle(text: string, maxChars: number): string {
  const budget = Math.max(0, Math.floor(maxChars))
  if (text.length <= budget) return text
  const head = Math.floor(budget * HEAD_SHARE)
  const tail = budget - head
  const removed = text.length - head - tail
  return `${text.slice(0, head)}${TOOL_OUTPUT_TRUNCATED.replace('{n}', String(removed))}${
    tail > 0 ? text.slice(text.length - tail) : ''
  }`
}
