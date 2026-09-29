/**
 * Compaction inside a running turn (internal): the turn wire built from the view with its turn
 * segments, the pre-turn and mid-turn triggers, the guard (sanitize + hard cap), calibration and
 * overflow recovery.
 *
 * @see docs/specs/06-compaction.md#4-triggers
 * @see docs/specs/06-compaction.md#6-guard-always-on-not-configurable-away
 * @see docs/specs/06-compaction.md#7-overflow-recovery
 */
import type { LanguageModel, ModelMessage, Tool, UIMessageChunk } from 'ai'
import { project } from '../messages/project.ts'
import { sanitizeModelMessages } from '../messages/sanitize.ts'
import type { ContextStats, HarnessUIMessage, PendingState } from '../messages/types.ts'
import type { TurnInfo } from '../plugin/types.ts'
import type { TurnRegistry } from '../registry/turn.ts'
import { hookFailed } from '../registry/wrap.ts'
import type { SessionRuntime } from '../session/runtime.ts'
import type { CompactOutcome, SessionCompaction } from './compact.ts'
import { applyHardCap } from './guard.ts'
import { isContextOverflow, reportedTokenCount } from './overflow.ts'
import { toolSetTokens, wireTokens } from './tokens.ts'
import { groupTurns, isBoundaryMessage, partialOf, stepStarts, trimToPartial } from './turns.ts'

/** Factor applied to `maxContextRatio` by the tighter guard of overflow recovery (spec 06 §7). */
export const TIGHTER_GUARD_FACTOR = 0.8

/** A turn wire and the index where the current turn starts. */
export interface BuiltWire {
  wire: ModelMessage[]
  turnStart: number
}

/** The sanitized wire split into its prior segments (summary head + completed turns) and the current turn. */
export interface SanitizedWire {
  /** `[head, turn 1, turn 2, …]` — head is the summary (possibly empty). */
  prior: ModelMessage[][]
  current: ModelMessage[]
  /** `prior` and `current` concatenated. */
  flat: ModelMessage[]
}

/** Result of the hard cap. */
export type CappedWire =
  | {
      messages: ModelMessage[]
      turnStart: number
      /** Uncalibrated estimate of the request (instructions, tools, reminder, messages). */
      raw: number
    }
  | { overflow: string }

/** Outcome of an overflow: retry the step (with a rebuilt wire when compaction ran) or give up. */
export type OverflowDecision = { retry: false } | { retry: true; rebuilt?: BuiltWire }

/** Compaction and guard of one running turn. */
export interface TurnCompaction {
  /** Build the turn wire from the cached view (+ input delivered since the last step barrier). */
  build(delivered?: readonly ModelMessage[]): Promise<BuiltWire>
  /** Pre-turn trigger (spec 06 §4): compacts and rebuilds when over `summarizeAt`. */
  preTurn(built: BuiltWire): Promise<BuiltWire>
  /** Mid-turn trigger before step ≥ 1; returns the rebuilt wire when a compaction ran. */
  midTurn(args: {
    wire: readonly ModelMessage[]
    stepIndex: number
    delivered: readonly ModelMessage[]
  }): Promise<BuiltWire | undefined>
  /** Guard step 1: sanitize, keeping the turn segments. */
  sanitize(wire: readonly ModelMessage[], turnStart: number): SanitizedWire
  /** Guard step 2: the hard cap for the step's model. */
  hardCap(args: {
    wire: SanitizedWire
    /** A `step.prepare` rewrite: treated as the current turn (no droppable turns). */
    rewrite: ModelMessage[] | undefined
    model: LanguageModel
    maxOutputTokens: number | undefined
    tools: Readonly<Record<string, Tool>>
    reminder: string | undefined
  }): Promise<CappedWire>
  /** Calibrate from provider-reported input tokens of the last request. */
  observe(raw: number, inputTokens: number | undefined): void
  /** `data-eh.context` after a step. */
  contextStats(
    model: LanguageModel,
    wire: readonly ModelMessage[],
    maxOutputTokens: number | undefined,
  ): Promise<ContextStats>
  /** True when `error` is a context overflow (built-in patterns or `config.isContextOverflow`). */
  isOverflow(error: unknown): boolean
  /** Handle an overflow of a request whose uncalibrated estimate was `raw` (spec 06 §7). */
  onOverflow(args: {
    error: unknown
    raw: number
    delivered: readonly ModelMessage[]
  }): Promise<OverflowDecision>
}

/** Create the compaction context of one turn. */
export function createTurnCompaction(args: {
  engine: SessionCompaction
  rt: SessionRuntime
  turnId: string
  assistantId: string
  /** First message of the current turn (spec 06 §5.1). */
  currentStartId: string
  info: TurnInfo
  registry: TurnRegistry
  write(chunk: UIMessageChunk): void
  signal: AbortSignal
  pending?: PendingState | null
  continuing?: string
}): TurnCompaction {
  const { engine, rt, registry, info } = args
  const messages = rt.agent.messages
  const config = rt.agent.config
  const select = config.compaction === false ? undefined : config.compaction?.select
  const isBoundary = (m: HarnessUIMessage) => isBoundaryMessage(m, messages)
  const instructionsText = [registry.block1, registry.block2, registry.turnReminder]
    .filter((t): t is string => t !== undefined)
    .join('\n\n')
  const instructionsRaw = instructionsText.length === 0 ? 0 : engine.count(instructionsText)
  let fixedRaw: number | undefined
  /** Lengths of the prior segments of the last built wire: `[head, turn 1, …]`. */
  let segments: number[] = []
  let midTurnStep = -1
  let overflowCompacted = false
  let tightened = false
  let truncationWarned = false
  /** A failed automatic compaction is not retried in the same turn (the guard takes over). */
  let failed = false

  const projectOptions = {
    registry: messages,
    sessionId: rt.id,
    tools: registry.tools,
    model: info.model,
    pending: args.pending ?? null,
    ...(args.continuing === undefined ? {} : { continuing: args.continuing }),
  }

  async function fixed(): Promise<number> {
    fixedRaw ??= instructionsRaw + (await toolSetTokens(registry.tools, engine.count))
    return fixedRaw
  }

  function selected(view: HarnessUIMessage[]): HarnessUIMessage[] {
    if (select === undefined) return view
    try {
      const out = select(view, rt.contextOf('app'))
      return Array.isArray(out) ? out : view
    } catch (error) {
      hookFailed(rt, 'compaction.select', 'app', error)
      return view
    }
  }

  async function build(delivered: readonly ModelMessage[] = []): Promise<BuiltWire> {
    // injected during the turn (id > A) belong to the next turn (spec 03 §5.4)
    const view = selected((rt.view ?? []).filter((m) => isBoundary(m) || m.id <= args.assistantId))
    let boundary: HarnessUIMessage | undefined
    for (const m of view)
      if (isBoundary(m) && (boundary === undefined || m.id > boundary.id)) boundary = m
    const partial = partialOf(boundary)
    const body = view.filter((m) => !isBoundary(m)).map((m) => trimToPartial(m, partial))
    const prior = body.filter((m) => m.id < args.currentStartId)
    const current = body.filter((m) => m.id >= args.currentStartId)
    const head = boundary === undefined ? [] : await project([boundary], projectOptions)
    const turns: ModelMessage[][] = []
    for (const range of groupTurns(prior)) {
      turns.push(await project(prior.slice(range.start, range.end), projectOptions))
    }
    const currentWire = await project(current, projectOptions)
    segments = [head.length, ...turns.map((t) => t.length)]
    const turnStart = segments.reduce((a, b) => a + b, 0)
    return { wire: [...head, ...turns.flat(), ...currentWire, ...delivered], turnStart }
  }

  function hasCompletedStep(): boolean {
    const message = rt.view?.find((m) => m.id === args.assistantId)
    return message !== undefined && stepStarts(message).length > 0
  }

  async function compactNow(
    trigger: 'turn' | 'auto',
    beforeTokens: number,
    forceMode?: 'pre-turn' | 'mid-turn',
  ): Promise<CompactOutcome> {
    const mode = forceMode ?? (hasCompletedStep() ? 'mid-turn' : 'pre-turn')
    if (failed) return { status: 'skipped', reason: 'failed-earlier' }
    const outcome = await engine.compact({
      mode,
      trigger,
      currentStartId: args.currentStartId,
      assistantId: args.assistantId,
      turnId: args.turnId,
      model: info.model,
      fixedTokens: await fixed(),
      beforeTokens,
      write: args.write,
      signal: args.signal,
    })
    if (outcome.status === 'failed') failed = true
    return outcome
  }

  return {
    build,
    async preTurn(built) {
      if (!engine.enabled) return built
      const tokens = engine.calibration.apply(
        (await fixed()) + wireTokens(built.wire, engine.count),
      )
      if (tokens <= engine.limits(info.model).summarizeAt) return built
      const outcome = await compactNow('turn', tokens, 'pre-turn')
      return outcome.status === 'compacted' ? build() : built
    },
    async midTurn({ wire, stepIndex, delivered }) {
      if (!engine.enabled || stepIndex < 1 || midTurnStep === stepIndex) return undefined
      midTurnStep = stepIndex
      const tokens = engine.calibration.apply((await fixed()) + wireTokens(wire, engine.count))
      if (tokens <= engine.limits(info.model).summarizeAt) return undefined
      const outcome = await compactNow('auto', tokens)
      return outcome.status === 'compacted' ? build(delivered) : undefined
    },
    sanitize(wire, turnStart) {
      const total = segments.reduce((a, b) => a + b, 0)
      if (total !== turnStart || turnStart > wire.length) {
        const current = sanitizeModelMessages(wire)
        return { prior: [], current, flat: current }
      }
      const prior: ModelMessage[][] = []
      let at = 0
      for (const length of segments) {
        prior.push(wire.slice(at, at + length))
        at += length
      }
      const current = sanitizeModelMessages(wire.slice(turnStart))
      return { prior, current, flat: [...prior.flat(), ...current] }
    },
    async hardCap({ wire, rewrite, model, maxOutputTokens, tools, reminder }) {
      const limits = engine.limits(model, {
        maxOutputTokens,
        ...(tightened ? { ratioFactor: TIGHTER_GUARD_FACTOR } : {}),
      })
      const fixedPart =
        instructionsRaw +
        (await toolSetTokens(tools, engine.count)) +
        (reminder === undefined ? 0 : engine.count(reminder) + 8)
      const measure = (list: readonly ModelMessage[]) =>
        engine.calibration.apply(wireTokens(list, engine.count))
      const result = applyHardCap({
        head: rewrite === undefined ? (wire.prior[0] ?? []) : [],
        turns: rewrite === undefined ? wire.prior.slice(1) : [],
        current: rewrite === undefined ? wire.current : rewrite,
        fixedTokens: engine.calibration.apply(fixedPart),
        limit: limits.hardLimit,
        measure,
      })
      if ((result.droppedTurns > 0 || result.truncatedOutputs > 0) && !truncationWarned) {
        truncationWarned = true
        rt.warn(
          {
            code: 'W_CONTEXT_TRUNCATED',
            message: `The context did not fit (limit ${limits.hardLimit} tokens): dropped ${result.droppedTurns} older turn(s) and truncated ${result.truncatedOutputs} tool output(s) in the request.`,
            details: {
              droppedTurns: result.droppedTurns,
              truncatedOutputs: result.truncatedOutputs,
              limit: limits.hardLimit,
            },
          },
          args.turnId,
        )
      }
      if (result.over) {
        return {
          overflow: `The context (~${result.tokens} tokens) exceeds the hard limit of ${limits.hardLimit} tokens.`,
        }
      }
      return {
        messages: result.messages,
        turnStart: result.turnStart,
        raw: fixedPart + wireTokens(result.messages, engine.count),
      }
    },
    observe(raw, inputTokens) {
      engine.calibration.observe(raw, inputTokens)
    },
    async contextStats(model, wire, maxOutputTokens) {
      return engine.stats(
        model,
        {
          instructions: instructionsRaw,
          tools: (await fixed()) - instructionsRaw,
          messages: wireTokens(wire, engine.count),
        },
        { maxOutputTokens },
      )
    },
    isOverflow: (error) => isContextOverflow(error, config.isContextOverflow),
    async onOverflow({ error, raw, delivered }) {
      engine.calibration.overflow(raw, reportedTokenCount(error))
      if (!overflowCompacted) {
        overflowCompacted = true
        if (engine.enabled) {
          rt.warn(
            {
              code: 'W_OVERFLOW_RETRY',
              message:
                'The provider rejected the context as too long; compacting and retrying the step.',
            },
            `${args.turnId}:compact`,
          )
          const outcome = await compactNow('auto', engine.calibration.apply(raw))
          if (outcome.status === 'compacted')
            return { retry: true, rebuilt: await build(delivered) }
        }
      }
      if (!tightened) {
        tightened = true
        rt.warn(
          {
            code: 'W_OVERFLOW_RETRY',
            message:
              'The provider rejected the context as too long; retrying the step with a tighter guard.',
          },
          `${args.turnId}:guard`,
        )
        return { retry: true }
      }
      return { retry: false }
    },
  }
}
