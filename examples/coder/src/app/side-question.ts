/**
 * Side question (`/btw`): answer a question from the current context without storing anything.
 *
 * The stored view of the session (compaction summary plus the messages after it) is reduced to
 * text (tool calls become `[name(args)] → result` lines, so no tool definitions are needed),
 * converted with AI SDK `convertToModelMessages` and streamed with `streamText` without tools.
 * Nothing is written to the session, its state or its usage: the tokens of a side question are
 * not charged to any turn (they do not show up in `/cost`).
 *
 * Integration: `sideQuestion: createSideQuestion({ storage, sessionId: () => id, model: () =>
 * resolveModel(modelState.model) })` implements `CoderController.sideQuestion`.
 */
import { convertToModelMessages, type LanguageModel, streamText } from 'ai'
import type { CoderController } from '../contracts.ts'
import { loadView, type SessionStorage, textOnly } from './session-tools.ts'

/** Instructions of the side-question call. */
export const SIDE_QUESTION_INSTRUCTIONS =
  'Answer the side question briefly from the conversation so far; do not call tools. ' +
  'The side question and your answer are not part of the conversation.'

/** Dependencies of {@link createSideQuestion}. */
export interface SideQuestionDeps {
  storage: SessionStorage
  sessionId: () => string
  /** The session's current model (re-evaluated per call). */
  model: () => LanguageModel
  /** Characters of each tool result kept in the context. Default 500. */
  resultChars?: number
}

/** Returns the implementation of {@link CoderController.sideQuestion}. */
export function createSideQuestion(deps: SideQuestionDeps): CoderController['sideQuestion'] {
  return async (question, onDelta, signal) => {
    const view = await loadView(deps.storage, deps.sessionId())
    const history = await convertToModelMessages(
      textOnly(view, deps.resultChars !== undefined ? { resultChars: deps.resultChars } : {}),
      { ignoreIncompleteToolCalls: true },
    )
    const result = streamText({
      model: deps.model(),
      instructions: SIDE_QUESTION_INSTRUCTIONS,
      messages: [
        ...history,
        { role: 'user', content: `Side question (answer briefly, no tools): ${question}` },
      ],
      ...(signal ? { abortSignal: signal } : {}),
    })
    let text = ''
    for await (const delta of result.textStream) {
      text += delta
      onDelta(text)
    }
    return text
  }
}
