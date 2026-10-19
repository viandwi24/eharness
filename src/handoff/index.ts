/**
 * `eharness/handoff`: an agent hands a question or decision to a person, the turn parks on an
 * external wait, and an answer from anywhere (web app, chat reply, another instance) resumes it.
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/32-handoff.md
 */
export { memoryHandoffStore } from './memory.ts'
export {
  cancelHandoff,
  expireHandoffs,
  formatHandoffAnswer,
  HANDOFF_CANCELLED_TEXT,
  HANDOFF_EXPIRED_TEXT,
  HANDOFF_TOOL,
  type HandoffAnswerInput,
  type HandoffOptions,
  type HandoffRedeliverSessions,
  type HandoffResolution,
  type HandoffResumeOptions,
  type HandoffSessions,
  handoff,
  redeliverHandoff,
  resolveHandoff,
  type StartHandoffArgs,
  startHandoff,
} from './plugin.ts'
export type {
  HandoffAnswer,
  HandoffAnswerExtras,
  HandoffInput,
  HandoffKind,
  HandoffListQuery,
  HandoffListResult,
  HandoffOption,
  HandoffRequest,
  HandoffStatus,
  HandoffStore,
  HandoffTransition,
} from './types.ts'
