import type {
  LanguageModel,
  ModelMessage,
  streamText,
  ToolChoice,
  ToolSet,
  UIMessageChunk,
} from 'ai'
import type { BudgetConfig, CacheConfig, ModelSettings, ProgressConfig } from '../agent/types.ts'
import type { TurnCompaction } from '../compaction/turn-context.ts'
import type { InputPartData, PendingState, StopReason } from '../messages/types.ts'
import type { ModelCatalog } from '../models/types.ts'
import type { TurnOutput } from '../output/turn.ts'
import type { TurnInfo } from '../plugin/types.ts'
import type { TurnRegistry } from '../registry/turn.ts'
import type { HookRunner } from '../session/hooks.ts'
import type { PendingInput, TurnInputQueue } from '../session/interaction/inbox.ts'
import type { OpenSession, SessionRuntime, TurnState } from '../session/runtime.ts'
import type { TurnError } from '../stream/describe-error.ts'
import type { TurnLedger } from './ledger.ts'
import type { ProgressTracker } from './progress.ts'
import type { applyCache } from './prompt.ts'
import type { UsageTotals } from './usage.ts'

/** Input of {@link runSteps}. */
export interface StepLoopInput {
  rt: SessionRuntime
  registry: TurnRegistry
  info: TurnInfo
  /** The model wire of the turn; responses are appended. */
  wire: ModelMessage[]
  /** Wire index of the current turn's first message (turn reminder position). */
  turnStart: number
  /** Assistant message id of the turn. */
  messageId: string
  activeTools: string[] | undefined
  maxSteps: number
  /** Absolute cap on `turn.beforeEnd` continuations (`Infinity` = none). */
  maxContinues: number
  /** Continuations in a row without progress before further ones are refused. */
  maxIdleContinues: number
  maxOutputTokens: number
  /** Run a tool-less summary step when the step budget runs out. */
  wrapUp: boolean
  /** Stuck detection; `false` disables it (progress is still measured for continuations). */
  progress: ProgressConfig | false | undefined
  /** Model limits and prices (spec 12). */
  models?: ModelCatalog | undefined
  /** USD budgets (spec 12 §4). */
  budget?: BudgetConfig | undefined
  /** USD spent by the session's earlier turns (`state.core.usage.costUsd`). */
  sessionCostBefore?: number
  /** `budget.ledger` of the turn (spec 12 §4.1): reserve before every call, commit after it. */
  ledger?: TurnLedger | undefined
  toolsContext: Record<string, unknown> | undefined
  cache: CacheConfig | false | undefined
  signal: AbortSignal
  /** True when the turn was aborted by `loop.turnTimeoutMs`. */
  timedOut(): boolean
  write(chunk: UIMessageChunk): void
  /** Resolves when `onStepEnd` has run for every `finish-step` written so far. */
  barrier(): Promise<void>
  usage: UsageTotals
  discovered: Set<string>
  /** Heartbeat and cross-process abort poll (spec 05 §9, §9.1); an abort ends the turn below. */
  heartbeat(): Promise<void>
  /** Compaction triggers, guard, calibration and overflow recovery of the turn (spec 06). */
  compaction: TurnCompaction
  /**
   * The turn continues a pending message (`respond()`): step 0 must end with the approval `tool`
   * message — no step reminder, no input delivery, no rewrite that moves it (spec 11 §4 step 5).
   */
  continuation?: boolean
  /** Final tool names the `respond()` answered; reported to `step.prepare` on step 0. */
  continuing?: { approved: string[]; denied: string[] }
  /**
   * Notes of approved calls (spec 11 §3.6): written as `data-eh.input` after the tool outputs of
   * step 0 of the continuation, and shown to the model after the tool result message.
   */
  approvalNotes?: InputPartData[]
  /** `respond(…, { endTurn })`: step 0 runs the approved tools but never calls the model. */
  endAfterContinuation?: boolean
  /** Steers and `next-step` injections waiting for the next step boundary (spec 11 §6). */
  inbox?: TurnInputQueue
  /** Called after an inbox item was written as `data-eh.input` (and appended to the wire). */
  delivered?(item: PendingInput): void
  /** `SendOptions.output` of the turn (spec 05 §3.3); its `state` records the answer checks. */
  output?: TurnOutput
}

/** Outcome of the step loop. */
export interface LoopResult {
  stop: StopReason
  error?: TurnError
  pending?: PendingState
  steps: number
  /** Model of the last step. */
  model: LanguageModel
  /** Reason of the terminal `abort` chunk (aborted / timeout). */
  abortReason?: string
}

/**
 * The state of one step loop run: what `runSteps` used to keep in closure variables. The step
 * functions (`beginStep`, `buildStep`, `streamStep`, `recordStep`, `decideNext`) take it as their
 * first argument.
 */
export interface StepsCtx {
  input: StepLoopInput
  rt: SessionRuntime
  registry: TurnRegistry
  info: TurnInfo
  wire: ModelMessage[]
  compaction: TurnCompaction
  open: OpenSession
  hooks: HookRunner
  hookTimeoutMs: number
  contextOf: SessionRuntime['contextOf']
  budget: number
  continues: number
  /** Continuations in a row after which no new successful tool result appeared. */
  idleContinues: number
  /** `progress.novel` when the last continuation was granted. */
  novelAtContinue?: number | undefined
  progress: ProgressTracker
  maxNudges: number
  nudges: number
  /** Reminder of the next step after a nudge. */
  nudge?: string | undefined
  /** The next step is the wrap-up step (tools off) after the step budget ran out. */
  wrapping: boolean
  wrapped: boolean
  budgetWarned: Set<string>
  stepIndex: number
  model: LanguageModel
  /** Input waiting for the next step boundary (`step.end` context, `turn.beforeEnd` continue). */
  waiting: Array<{ source: `plugin:${string}`; text: string }>
  lastPrefix?: string | undefined
  cacheBustWarned: boolean
  /** Wire index of the current turn's first message (moves when a compaction rebuilds the wire). */
  turnStart: number
  /** Wire length after the last step barrier: later messages are not in the cached view yet. */
  sinceBarrier: number
  /** Steers / injections taken from the inbox and not delivered yet. */
  external: PendingInput[]
  inbox: TurnInputQueue | undefined
  output: TurnOutput | undefined
  /** The next step must call the output tool (a tool-mode retry, spec 05 §3.3 rule 4). */
  forceOutputTool: boolean
}

/** The model call of one step, as `buildStep` prepared it. */
export interface StepRequest {
  stepModel: LanguageModel
  settings: ModelSettings
  activeTools: string[] | undefined
  toolChoice: ToolChoice<ToolSet> | undefined
  /** The hard-capped wire (`compaction.hardCap`). */
  capped: Awaited<ReturnType<TurnCompaction['hardCap']>> extends infer R
    ? Exclude<R, { overflow: string }>
    : never
  /** The prompt after the cache markers. */
  cached: ReturnType<typeof applyCache>
}

/** What the model call of one step produced (`streamStep`). */
export interface StepRun {
  result: ReturnType<typeof streamText>
  /** The step's response messages; `undefined` when the call failed before streaming. */
  response: ModelMessage[] | undefined
  turnState: TurnState | undefined
  sawError: boolean
  errorText: string | undefined
  stepAborted: boolean
  stepStarted: boolean
  /** An error chunk before the step's first `start-step`, held back for overflow recovery. */
  held: UIMessageChunk | undefined
  rawError: unknown
  /** `respond(…, { endTurn })`: the step ran the approved tools against a model that makes no call. */
  endStep: boolean
  /** Notes of approved calls that follow the tool result message on the wire. */
  noteWire: ModelMessage[]
  writeNotes(): void
}
