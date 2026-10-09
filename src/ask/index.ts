/**
 * `eharness/ask`: the `askUser()` plugin — a multiple-choice question tool that works in an
 * autonomous server (non-interactive fallback), a single-process CLI and a split web/server app
 * (client tool answered through `respond({ toolOutputs })`).
 *
 * @see docs/specs/21-ask-plugin.md
 */
export {
  type Answer,
  ASK_DESCRIPTION,
  ASK_TOOL,
  type AskUserOptions,
  answerOutput,
  askUser,
  formatAnswers,
  type PendingQuestion,
  parseQuestions,
  pendingQuestions,
  type Question,
  type QuestionOption,
  type QuestionResult,
} from './plugin.ts'
