/**
 * The summarizer call (internal): one `generateText` call, or rolling chunked summarization when
 * the transcript exceeds 60% of the summarizer's context window.
 *
 * @see docs/specs/06-compaction.md#53-summarize
 */
import { generateText, type LanguageModel } from 'ai'
import { summarizerInput } from './prompt.ts'
import type { CountTokens } from './tokens.ts'
import { truncateMiddle } from './truncate.ts'

/** Share of the summarizer window a single transcript chunk may use (spec 06 §5.3). */
export const CHUNK_SHARE = 0.6

/** Input of {@link summarize}. */
export interface SummarizeInput {
  model: LanguageModel
  /** Summarizer instructions. */
  prompt: string
  /** Transcript entries (see `renderTranscriptEntries`). The previous summary is the first one. */
  entries: readonly string[]
  /** `compaction.prompt` context lines. */
  context: readonly string[]
  maxSummaryTokens: number
  /** Summarizer context window (tokens). */
  window: number
  count: CountTokens
  abortSignal?: AbortSignal
}

/**
 * Split entries into chunks of at most `budget` tokens (greedy, order kept). An entry larger than
 * the budget is truncated (head + tail) to fit on its own.
 */
export function chunkEntries(
  entries: readonly string[],
  budget: number,
  count: CountTokens,
): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let used = 0
  for (const original of entries) {
    let entry = original
    let tokens = count(entry)
    if (tokens > budget) {
      // chars per token of this entry, to size the truncation
      const ratio = entry.length / Math.max(1, tokens)
      entry = truncateMiddle(entry, Math.max(1, Math.floor(budget * ratio * 0.9)))
      tokens = count(entry)
    }
    if (current.length > 0 && used + tokens > budget) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(entry)
    used += tokens
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Summarize the transcript. Throws when the model call fails or returns empty text (the caller
 * maps this to `W_COMPACTION_FAILED` / `EH_COMPACTION_FAILED`).
 */
export async function summarize(input: SummarizeInput): Promise<string> {
  const { count } = input
  const whole = input.entries.join('\n\n')
  const budget = Math.max(
    256,
    Math.floor(input.window * CHUNK_SHARE) - input.maxSummaryTokens - count(input.prompt),
  )
  const chunks =
    count(whole) <= Math.floor(input.window * CHUNK_SHARE)
      ? [[...input.entries]]
      : chunkEntries(input.entries, budget, count)
  let summary: string | undefined
  for (const [index, chunk] of chunks.entries()) {
    const entries = summary === undefined ? chunk : [`PREVIOUS SUMMARY:\n${summary}`, ...chunk]
    const last = index === chunks.length - 1
    const result = await generateText({
      model: input.model,
      instructions: input.prompt,
      prompt: summarizerInput(entries.join('\n\n'), last ? input.context : []),
      maxOutputTokens: input.maxSummaryTokens,
      ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    })
    const text = result.text.trim()
    if (text.length === 0) throw new Error('The summarizer returned an empty summary.')
    summary = text
  }
  if (summary === undefined) throw new Error('Nothing to summarize.')
  return summary
}
