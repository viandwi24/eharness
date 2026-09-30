/**
 * Context overflow detection (internal): is a provider error a "context too long" rejection, and
 * did the provider report the actual token count?
 *
 * @see docs/specs/06-compaction.md#7-overflow-recovery
 */
import { errorChain, statusOf, textsOf } from '../internal/provider-errors.ts'

/** Built-in patterns of provider "context too long" messages (case-insensitive). */
export const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /too many tokens/i,
  /exceed\w*.{0,40}context (?:window|length)/i,
  /context (?:window|length).{0,40}(?:exceed|too long|too large)/i,
  /input is too long/i,
  /input too long/i,
  /request_too_large/i,
  /exceeds? the (?:maximum|max)(?: allowed)? (?:number of )?(?:input )?tokens/i,
  /input token count.*exceeds/i,
  /reduce the length of the (?:messages|prompt|input)/i,
]

/**
 * True when `error` is a context overflow: some error of its chain (`.cause`, AI SDK `RetryError`
 * `lastError`/`errors`) has HTTP status 400 or 413 and a message or provider payload matching
 * {@link OVERFLOW_PATTERNS}, or `custom(error)` returns true. See `internal/provider-errors.ts`
 * for the recognised error shapes.
 */
export function isContextOverflow(error: unknown, custom?: (error: unknown) => boolean): boolean {
  for (const item of errorChain(error)) {
    const status = statusOf(item)
    if (status !== 400 && status !== 413) continue
    if (textsOf(item).some((text) => OVERFLOW_PATTERNS.some((p) => p.test(text)))) return true
  }
  if (custom !== undefined) {
    try {
      return custom(error) === true
    } catch {
      return false
    }
  }
  return false
}

const COUNT_PATTERNS: readonly RegExp[] = [
  /(\d[\d,]*)\s*tokens?\s*>\s*\d[\d,]*/i, // anthropic: "prompt is too long: 215000 tokens > 200000 maximum"
  /resulted in (\d[\d,]*) tokens/i, // openai: "However, your messages resulted in 130000 tokens"
  /requested (\d[\d,]*) tokens/i, // openai: "you requested 130000 tokens"
  /input token count \(?(\d[\d,]*)\)?/i, // gemini: "The input token count (1200000) exceeds …"
  /prompt (?:has|contains) (\d[\d,]*) tokens/i,
]

/** The actual prompt token count reported by the provider in an overflow error, if any. */
export function reportedTokenCount(error: unknown): number | undefined {
  for (const item of errorChain(error)) {
    for (const text of textsOf(item)) {
      for (const pattern of COUNT_PATTERNS) {
        const match = pattern.exec(text)
        const value = match?.[1] === undefined ? Number.NaN : Number(match[1].replace(/,/g, ''))
        if (Number.isFinite(value) && value > 0) return value
      }
    }
  }
  return undefined
}
