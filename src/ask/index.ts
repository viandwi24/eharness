/**
 * `eharness/ask`: the `ask()` plugin — a multiple-choice question tool that works in an
 * autonomous server (non-interactive fallback), a single-process CLI and a split web/server app
 * (client tool answered through `respond({ toolOutputs })`).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @see docs/specs/21-ask-plugin.md
 */
export {
  type Answer,
  ASK_TOOL,
  type AskOptions,
  answerOutput,
  ask,
  type PendingQuestion,
  pendingQuestions,
  type Question,
  type QuestionOption,
  type QuestionResult,
} from './plugin.ts'
