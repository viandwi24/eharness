/**
 * Recap (`/recap`) and next-prompt suggestions (`promptSuggestions`): two cheap model calls over
 * the tail of the conversation. Both have a 15 s timeout and never throw.
 *
 * Integration: `createRecap({ storage, sessionId: () => id, model: () => fastOrCurrentModel })`
 * gives `{ recap, suggestNext }` for `CoderController.recap` / `.suggestNext`. Pass a configured
 * fast model in `model` when there is one. Usage of these calls is not charged to a turn.
 */
import { convertToModelMessages, generateText, type LanguageModel } from 'ai'
import type { CoderController } from '../contracts.ts'
import { loadView, type SessionStorage, textOnly } from './session-tools.ts'

export const RECAP_MAX_CHARS = 400
export const SUGGEST_MAX_CHARS = 80
/** Messages of the tail the model sees. */
export const RECAP_MESSAGES = 30
/** Timeout of one call. */
export const RECAP_TIMEOUT_MS = 15_000

/** Dependencies of {@link createRecap}. */
export interface RecapDeps {
  storage: SessionStorage
  sessionId: () => string
  model: () => LanguageModel
  /** Default {@link RECAP_TIMEOUT_MS}. */
  timeoutMs?: number
}

const RECAP_INSTRUCTIONS =
  `Summarize this coding session in ONE line of at most ${RECAP_MAX_CHARS} characters: what the ` +
  'user is working on, what was done so far and what is next. Plain text only, no markdown, no preamble.'

const SUGGEST_INSTRUCTIONS =
  `Predict the next message the user is most likely to send to the coding agent. Reply with that ` +
  `message only: one line, at most ${SUGGEST_MAX_CHARS} characters, no quotes, written as the user ` +
  'would write it. If nothing sensible follows, reply with exactly: none'

/** First line, quotes and markdown decoration removed, cut to `max` characters. */
function clean(text: string, max: number): string {
  let line = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  line = line
    .replace(/^["'`“”]+|["'`“”]+$/g, '')
    .replace(/^[-*>#\s]+/, '')
    .trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** The two functions of {@link createRecap}. */
export function createRecap(deps: RecapDeps): {
  recap: CoderController['recap']
  suggestNext: CoderController['suggestNext']
} {
  const timeoutMs = deps.timeoutMs ?? RECAP_TIMEOUT_MS

  const ask = async (instructions: string): Promise<string | undefined> => {
    const view = (await loadView(deps.storage, deps.sessionId())).slice(-RECAP_MESSAGES)
    const history = textOnly(view, { resultChars: 200 })
    if (history.length === 0) return undefined
    const messages = await convertToModelMessages(history, { ignoreIncompleteToolCalls: true })
    const { text } = await generateText({
      model: deps.model(),
      instructions,
      messages: [...messages, { role: 'user', content: 'Now answer as instructed.' }],
      abortSignal: AbortSignal.timeout(timeoutMs),
      maxRetries: 0,
    })
    return text
  }

  return {
    async recap() {
      try {
        return clean((await ask(RECAP_INSTRUCTIONS)) ?? '', RECAP_MAX_CHARS)
      } catch {
        return ''
      }
    },
    async suggestNext() {
      try {
        const line = clean((await ask(SUGGEST_INSTRUCTIONS)) ?? '', SUGGEST_MAX_CHARS)
        return line === '' || /^none\.?$/i.test(line) ? undefined : line
      } catch {
        return undefined
      }
    },
  }
}
