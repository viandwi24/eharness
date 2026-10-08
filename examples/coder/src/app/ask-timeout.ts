/**
 * Timeout for `ask_user_question` dialogs (`askUserQuestionTimeout` setting). The drive wraps
 * its `broker.question(request, signal)` call:
 *
 * ```ts
 * const { result, note } = await withQuestionTimeout(
 *   (signal) => broker.question(request, signal),
 *   seconds,
 *   opts.signal,
 * )
 * ```
 *
 * Aborting the signal passed to the broker dismisses the dialog (the broker resolves `null`), so
 * the UI closes it by itself. `note` is the text to append to the tool result so the model knows
 * the user did not answer instead of treating it as a refusal.
 */
import type { QuestionResult } from '../contracts.ts'

/** Text for the model when the question timed out. */
export const QUESTION_TIMEOUT_NOTE =
  'The user did not answer in time (they may be away). Continue with your best judgement and state the assumption you made; do not ask the same question again right away.'

export interface QuestionTimeoutResult {
  /** The answer, or `null` when dismissed or timed out. */
  result: QuestionResult
  timedOut: boolean
  /** Set when `timedOut`. */
  note?: string
}

/**
 * Run `ask` with a timeout of `seconds` (0, negative or non-finite = never). `signal` aborts the
 * question like the broker does (`null`).
 */
export async function withQuestionTimeout(
  ask: (signal: AbortSignal) => Promise<QuestionResult>,
  seconds: number,
  signal?: AbortSignal,
): Promise<QuestionTimeoutResult> {
  const controller = new AbortController()
  const forward = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener('abort', forward, { once: true })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  if (Number.isFinite(seconds) && seconds > 0) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort('timeout')
    }, seconds * 1000)
  }
  try {
    const result = await ask(controller.signal)
    return timedOut && result === null
      ? { result: null, timedOut: true, note: QUESTION_TIMEOUT_NOTE }
      : { result, timedOut: false }
  } catch {
    return timedOut
      ? { result: null, timedOut: true, note: QUESTION_TIMEOUT_NOTE }
      : { result: null, timedOut: false }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}
