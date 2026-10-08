/**
 * The session-level compaction engine (internal): token accounting with calibration, the fixed
 * compaction algorithm (split → skip rule → summarize → commit) and manual compaction.
 *
 * @see docs/specs/06-compaction.md
 */
import type { LanguageModel, LanguageModelUsage, UIMessageChunk } from 'ai'
import type { CompactionConfig } from '../agent/types.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import { describeModel } from '../internal/model.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { project } from '../messages/project.ts'
import type { CompactionPayload, ContextStats, HarnessUIMessage } from '../messages/types.ts'
import { hookFailed } from '../registry/wrap.ts'
import type { SessionRuntime } from '../session/runtime.ts'
import { type FlushEnv, runFlushStage } from './flush.ts'
import { resolveSummarizerPrompt } from './prompt.ts'
import { type PruneStats, pruneMessages, resolvePrune } from './prune.ts'
import { KEEP_SHARE, planSplit } from './split.ts'
import { SummarizeError, summarize } from './summarize.ts'
import {
  buildStats,
  type Calibration,
  type ContextLimits,
  type CountTokens,
  contextLimits,
  createCalibration,
  defaultCountTokens,
  messageTokens,
  resolveWindow,
  wireTokens,
  withTokens,
} from './tokens.ts'
import { renderTranscriptEntries } from './transcript.ts'
import { groupTurns, isBoundaryMessage, partialOf, payloadOf, trimToPartial } from './turns.ts'

/** Read through a function: TypeScript narrows `signal.aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Default `compaction.keepLast`. */
export const DEFAULT_KEEP_LAST = 4
/** Default `compaction.maxSummaryTokens`. */
export const DEFAULT_MAX_SUMMARY_TOKENS = 4_000

/** One compaction request. */
export interface CompactRequest {
  mode: 'pre-turn' | 'manual' | 'mid-turn'
  trigger: CompactionPayload['trigger']
  /** First message of the current (or pending) turn. */
  currentStartId?: string | undefined
  /** Assistant message of the running turn. */
  assistantId?: string | undefined
  turnId?: string | undefined
  /** Model whose window applies (turn / step model). */
  model: LanguageModel
  /** Uncalibrated tokens of instructions + tool definitions. */
  fixedTokens: number
  /** Calibrated tokens of the context before compaction (payload `tokens.before`). */
  beforeTokens: number
  /** Turn stream writer (status + transient `data-eh.compaction`); absent for manual. */
  write?: ((chunk: UIMessageChunk) => void) | undefined
  signal?: AbortSignal | undefined
  /**
   * Charged with the usage of every summarizer call, also of a call that then fails (the turn's
   * usage for automatic compaction, `state.core.usage` for manual, spec 06 §5.3), and with the
   * usage of the pre-compaction flush (`source: 'compaction-flush'`, spec 06 §5.2a).
   */
  onUsage?: ((usage: LanguageModelUsage, model: LanguageModel, source: string) => void) | undefined
  /** Overflow recovery (spec 06 §7): the `compaction.before` trigger is `'overflow'`. */
  overflow?: boolean | undefined
  /** The environment of a pre-compaction flush (current wire, turn tools), built on demand. */
  flushEnv?: (() => Promise<FlushEnv>) | undefined
  /** The USD budget that is used up, if any: the compaction is skipped before summarizing. */
  overBudget?: (() => BudgetOverrun | undefined) | undefined
}

/** A used-up USD budget (spec 12 §4). */
export interface BudgetOverrun {
  scope: 'turn' | 'session'
  limitUsd: number
  spentUsd: number
}

/** Outcome of one compaction. */
export type CompactOutcome =
  | { status: 'compacted'; marker: HarnessUIMessage; payload: CompactionPayload }
  | {
      status: 'skipped'
      reason:
        | 'running'
        | 'disabled'
        | 'nothing-to-drop'
        | 'no-gain'
        | 'aborted'
        | 'failed-earlier'
        | 'budget'
    }
  | { status: 'failed'; error: HarnessError }

/** Session-level compaction and accounting. */
export interface SessionCompaction {
  /** False for `compaction: false` (the guard and overflow recovery still run). */
  readonly enabled: boolean
  readonly calibration: Calibration
  readonly count: CountTokens
  /** Window of a model (warns `W_DEFAULT_CONTEXT_WINDOW` once per model). */
  window(model: LanguageModel): number
  limits(
    model: LanguageModel,
    options?: { maxOutputTokens?: number | undefined; ratioFactor?: number },
  ): ContextLimits
  /** Set `metadata.eharness.tokens` on a message about to be saved. */
  annotate(message: HarnessUIMessage): Promise<HarnessUIMessage>
  /** Uncalibrated tokens of a view (`partial` applied, prune savings subtracted). */
  viewTokens(view: readonly HarnessUIMessage[]): Promise<number>
  /**
   * Uncalibrated tokens of an idle view as the next request would see it (`partial` applied,
   * prune savings subtracted) and what the prune stage replaces (`undefined` when prune is off).
   */
  measureView(
    view: readonly HarnessUIMessage[],
  ): Promise<{ tokens: number; pruned: PruneStats | undefined }>
  /** `lastCompaction` of the newest boundary in the cached view. */
  lastCompaction(): ContextStats['lastCompaction']
  /** Stats from uncalibrated parts. */
  stats(
    model: LanguageModel,
    raw: { instructions: number; tools: number; messages: number },
    options?: {
      maxOutputTokens?: number | undefined
      pruned?: PruneStats | undefined
      /** Calibrated split of `instructions` and `tools` (`ContextStats.instructionBlocks` / `toolSources`). */
      split?: Pick<ContextStats, 'instructionBlocks' | 'toolSources'> | undefined
    },
  ): ContextStats
  /** Run one compaction (never concurrently for the session). */
  compact(request: CompactRequest): Promise<CompactOutcome>
}

/** Create the compaction engine of one session. */
export function createSessionCompaction(deps: {
  rt: SessionRuntime
  /** Save messages (hooks + cache), throws `EH_STORAGE`. */
  persist(messages: HarnessUIMessage[]): Promise<HarnessUIMessage[]>
}): SessionCompaction {
  const { rt } = deps
  const config = rt.agent.config
  const registry = rt.agent.messages
  const settings: CompactionConfig = config.compaction === false ? {} : (config.compaction ?? {})
  const enabled = config.compaction !== false
  const custom = settings.countTokens
  const count: CountTokens =
    custom === undefined
      ? defaultCountTokens
      : (text) => {
          try {
            const n = custom(text)
            return Number.isFinite(n) && n >= 0 ? n : defaultCountTokens(text)
          } catch {
            return defaultCountTokens(text)
          }
        }
  const calibration = createCalibration()
  const isBoundary = (m: HarnessUIMessage) => isBoundaryMessage(m, registry)
  let running = false
  const prune = resolvePrune(config.compaction)
  /** Prune saving per message object (spec 06 §5.0 accounting); a changed message is a new object. */
  const savings = new WeakMap<HarnessUIMessage, { tokens: number } & PruneStats>()

  async function savingOf(message: HarnessUIMessage): Promise<{ tokens: number } & PruneStats> {
    const cached = savings.get(message)
    if (cached !== undefined) return cached
    let entry = { tokens: 0, outputs: 0, chars: 0 }
    if (prune !== undefined) {
      try {
        const projected = await project([message], { registry, sessionId: rt.id })
        const pruned = pruneMessages(projected, prune)
        if (pruned.stats.outputs > 0) {
          const tokens = wireTokens(projected, count) - wireTokens(pruned.messages, count)
          entry = { tokens: Math.max(0, tokens), ...pruned.stats }
        }
      } catch {
        // estimate without the saving
      }
    }
    savings.set(message, entry)
    return entry
  }

  /** Ids of the messages of completed turns the prune stage prunes (all but the newest `keepTurns`). */
  function prunedIds(completed: readonly HarnessUIMessage[]): ReadonlySet<string> {
    const out = new Set<string>()
    if (prune === undefined) return out
    const turns = groupTurns(completed)
    for (const range of turns.slice(0, Math.max(0, turns.length - prune.keepTurns))) {
      for (const message of completed.slice(range.start, range.end)) out.add(message.id)
    }
    return out
  }

  async function measureView(
    view: readonly HarnessUIMessage[],
  ): Promise<{ tokens: number; pruned: PruneStats | undefined }> {
    const partial = partialOf(view.find(isBoundary))
    const ids = prunedIds(view.filter((m) => !isBoundary(m)))
    const pruned: PruneStats = { outputs: 0, chars: 0 }
    let tokens = 0
    for (const message of view) {
      const trimmed = trimToPartial(message, partial)
      tokens += await messageTokens(trimmed, registry, count)
      if (!ids.has(message.id)) continue
      const saving = await savingOf(trimmed)
      tokens -= saving.tokens
      pruned.outputs += saving.outputs
      pruned.chars += saving.chars
    }
    return { tokens, pruned: prune === undefined ? undefined : pruned }
  }

  const warnedWindows = new Set<string>()
  const window = (model: LanguageModel) =>
    resolveWindow(config, model, (warning, key) => {
      if (warnedWindows.has(key ?? '')) return
      warnedWindows.add(key ?? '')
      rt.warn(warning, key)
    })
  const limits: SessionCompaction['limits'] = (model, options = {}) =>
    contextLimits(config, window(model), {
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options.ratioFactor === undefined ? {} : { ratioFactor: options.ratioFactor }),
    })

  const lastCompaction = (): ContextStats['lastCompaction'] => {
    const marker = rt.view?.find(isBoundary)
    const payload = payloadOf(marker)
    if (marker === undefined || payload === undefined) return undefined
    return {
      markerId: marker.id,
      before: payload.tokens?.before ?? 0,
      after: payload.tokens?.after ?? 0,
      at: marker.metadata?.eharness?.createdAt ?? 0,
    }
  }

  async function run(request: CompactRequest): Promise<CompactOutcome> {
    const view = rt.view ?? []
    const limit = limits(request.model)
    // kept completed turns are measured as the next wire sees them: pruned (spec 06 §5.0)
    const startId = request.currentStartId
    const completed = view.filter(
      (m) => !isBoundary(m) && (startId === undefined || m.id < startId),
    )
    const pruneIds = request.mode === 'mid-turn' ? new Set<string>() : prunedIds(completed)
    const plan = await planSplit({
      view,
      isBoundary,
      mode: request.mode,
      currentStartId: request.currentStartId,
      ...(request.assistantId === undefined ? {} : { assistantId: request.assistantId }),
      keepLast: settings.keepLast ?? DEFAULT_KEEP_LAST,
      maxKeptTokens: Math.floor(limit.window * KEEP_SHARE),
      tokensOf: async (m) =>
        calibration.apply(
          (await messageTokens(m, registry, count)) -
            (pruneIds.has(m.id) ? (await savingOf(m)).tokens : 0),
        ),
    })
    const dropped = renderTranscriptEntries({
      messages: plan.drop,
      registry,
      sessionId: rt.id,
    })
    // skip rule (no churn): nothing to summarize besides the previous summary …
    if (dropped.length === 0) return { status: 'skipped', reason: 'nothing-to-drop' }
    // … or the result would not be below summarizeAt
    const maxSummaryTokens = settings.maxSummaryTokens ?? DEFAULT_MAX_SUMMARY_TOKENS
    const fixed = calibration.apply(request.fixedTokens)
    if (calibration.apply(maxSummaryTokens) + plan.keptTokens + fixed >= limit.summarizeAt) {
      return { status: 'skipped', reason: 'no-gain' }
    }
    // a used-up budget: no summarizer call (the guard keeps the request within the window)
    const overBudget = (): boolean => {
      const overrun = request.overBudget?.()
      if (overrun === undefined) return false
      rt.warn(
        {
          code: 'W_BUDGET',
          message: `The ${overrun.scope} budget of $${overrun.limitUsd} is used up ($${overrun.spentUsd.toFixed(4)}); compaction is skipped.`,
          details: { ...overrun, exceeded: true, compaction: true },
        },
        `${request.turnId ?? 'manual'}:compaction-budget`,
      )
      return true
    }
    if (overBudget()) return { status: 'skipped', reason: 'budget' }

    request.write?.({ type: 'data-eh.status', data: { state: 'compacting' }, transient: true })

    // pre-compaction flush (spec 06 §5.2a): summarizing will happen; hooks may save facts first
    const flushed = await runFlushStage({
      rt,
      event: {
        messages: plan.drop,
        tokens: request.beforeTokens,
        trigger: request.overflow === true ? 'overflow' : request.trigger,
      },
      turnId: request.turnId,
      defaultModel: settings.model,
      turnModel: request.model,
      tokensOf: (text) => calibration.apply(count(text) + 4),
      window,
      env: request.flushEnv,
      write: request.write,
      signal: request.signal,
      onUsage: request.onUsage,
      persist: deps.persist,
    })
    if (flushed === 'aborted' || isAborted(request.signal)) {
      return { status: 'skipped', reason: 'aborted' }
    }
    // the flush may have used up the budget: no summarizer call then
    if ((flushed === 'flushed' || flushed === 'failed') && overBudget()) {
      return { status: 'skipped', reason: 'budget' }
    }
    const entries = renderTranscriptEntries({
      previousSummary: plan.previousSummary,
      messages: plan.drop,
      registry,
      sessionId: rt.id,
    })
    const { prompt, context } = await resolveSummarizerPrompt({
      hooks: rt.open?.hooks,
      contextOf: rt.contextOf,
      configured: settings.prompt,
      onError: (owner, error) => hookFailed(rt, 'compaction.prompt', owner, error),
      messages: plan.drop,
    })
    const summarizer = settings.model ?? config.model
    let summary: string
    try {
      const result = await summarize({
        model: summarizer,
        prompt,
        entries,
        context,
        maxSummaryTokens,
        window: settings.contextWindow ?? window(summarizer),
        count,
        ...(request.signal === undefined ? {} : { abortSignal: request.signal }),
        onUsage: (usage) => request.onUsage?.(usage, summarizer, 'compaction'),
      })
      summary = result.summary
    } catch (error) {
      if (isAborted(request.signal)) return { status: 'skipped', reason: 'aborted' }
      const reason = error instanceof SummarizeError ? error.reason : undefined
      return {
        status: 'failed',
        error: new HarnessError(
          'EH_COMPACTION_FAILED',
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error, ...(reason === undefined ? {} : { details: { reason } }) },
        ),
      }
    }
    if (isAborted(request.signal)) return { status: 'skipped', reason: 'aborted' }

    const summaryTokens = calibration.apply(
      await messageTokens(
        createKindMessage('eh.compaction', {
          summary,
          resumeFromId: null,
          tokens: { before: 0, after: 0 },
          trigger: request.trigger,
        }),
        registry,
        count,
      ),
    )
    const payload: CompactionPayload = {
      summary,
      resumeFromId: plan.resumeFromId,
      ...(plan.partial === undefined ? {} : { partial: plan.partial }),
      tokens: { before: request.beforeTokens, after: summaryTokens + plan.keptTokens + fixed },
      trigger: request.trigger,
      model: describeModel(summarizer),
    }
    const marker = createKindMessage('eh.compaction', payload, {
      id: rt.nextId(),
      createdAt: Date.now(),
      parentId: (rt.view ?? view).at(-1)?.id ?? null,
      ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    })

    // commit: save(marker) → state pointer → cache
    let saved: HarnessUIMessage
    try {
      saved = (await deps.persist([marker]))[0] ?? marker
    } catch (error) {
      return {
        status: 'failed',
        error: isHarnessError(error)
          ? error
          : new HarnessError('EH_STORAGE', 'Message storage failed (save).', { cause: error }),
      }
    }
    const core = rt.state.core()
    core.compaction = { markerId: saved.id, resumeFromId: plan.resumeFromId }
    rt.state.markDirty()
    try {
      await rt.state.write()
    } catch (error) {
      // the loader heals the pointer from the newer marker (spec 06 §5.4)
      rt.log.warn('eharness: state write after compaction failed', { error })
    }
    const start = plan.resumeFromId ?? saved.id
    rt.view = [saved, ...(rt.view ?? []).filter((m) => !isBoundary(m) && m.id >= start)]

    // the saved payload: message.beforeSave may have transformed the marker
    const savedPayload = payloadOf(saved) ?? payload
    const chunk = {
      type: 'data-eh.compaction',
      data: savedPayload,
      transient: true,
    } as UIMessageChunk
    if (request.write !== undefined) request.write(chunk)
    else rt.events.emit({ type: 'data', chunk: chunk as never })
    rt.events.emit({ type: 'message', message: structuredClone(saved) as never })
    for (const hook of rt.open?.hooks.list('compaction.after') ?? []) {
      try {
        await hook.fn(rt.contextOf(hook.owner), { marker: structuredClone(saved) })
      } catch (error) {
        hookFailed(rt, 'compaction.after', hook.owner, error)
      }
    }
    return { status: 'compacted', marker: saved, payload: savedPayload }
  }

  return {
    enabled,
    calibration,
    count,
    window,
    limits,
    annotate: (message) => withTokens(message, registry, count),
    async viewTokens(view) {
      return (await measureView(view)).tokens
    },
    measureView,
    lastCompaction,
    stats(model, raw, options = {}) {
      return buildStats(
        calibration,
        limits(model, options),
        raw,
        lastCompaction(),
        options.pruned,
        options.split,
      )
    },
    async compact(request) {
      if (!enabled) return { status: 'skipped', reason: 'disabled' }
      if (running) return { status: 'skipped', reason: 'running' }
      running = true
      try {
        const outcome = await run(request)
        if (outcome.status === 'failed' && request.mode !== 'manual') {
          rt.warn(
            {
              code: 'W_COMPACTION_FAILED',
              message: `${outcome.error.message} Continuing with the guard.`,
              details: { trigger: request.trigger, ...(outcome.error.details ?? {}) },
            },
            request.turnId ?? 'compaction',
          )
        }
        return outcome
      } finally {
        running = false
      }
    },
  }
}
