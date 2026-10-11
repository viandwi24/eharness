/**
 * The shared LLM judge engine (ADR-0060), re-exported by `src/index.ts`.
 *
 * @see docs/specs/15-guard-plugin.md
 */
export {
  type JudgeCallRef,
  type JudgeCoordinator,
  judgeCoordinator,
} from './coordinator.ts'
export {
  createJudge,
  DEFAULT_JUDGE_MAX_CALL_CHARS,
  type Judge,
  type JudgeCacheEntry,
  type JudgeCall,
  type JudgeContext,
  type JudgeLimits,
  type JudgeOptions,
  type JudgeOutcome,
  type JudgeParticipant,
  type JudgeResult,
  type JudgeRole,
  type JudgeStore,
  type JudgeTightenAnswer,
  JudgeUnavailableError,
  type JudgeVerdict,
} from './judge.ts'
