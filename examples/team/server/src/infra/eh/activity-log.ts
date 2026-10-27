/**
 * `activityLog` plugin: the `model.call` hook (ADR-0047) persists one `model_calls` row per
 * provider call and appends a lightweight `model-call` event to the feed so the Logs page can
 * live-update. Calls the engine makes without a session (the Auto mode classifier) arrive through
 * `ActivityLog.observer`; model calls the server makes itself (web search, memory reorganization)
 * go through `ActivityLog.watch`, and the Developer API books its calls with `record`. Every call
 * to a model shows up on the Logs page.
 *
 * Retention is a count and an age: a cheap prune runs after every `pruneEvery` writes and at most
 * once a minute, on whichever instance writes. Nothing here may break a turn: every failure is
 * logged and swallowed.
 */
import type { LanguageModel } from 'ai'
import {
  definePlugin,
  errorText,
  type HarnessContext,
  type HarnessPlugin,
  type ModelCallEvent,
  type ModelCallRecord,
  type ModelCatalog,
  observeModel,
  settledCostOf,
} from 'eharness'
import type { NewEvent } from '../../domain/events.ts'
import {
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_DAYS,
  type ModelCallKind,
  type NewModelCall,
} from '../../domain/model-calls.ts'
import type { ModelCallWriter } from '../db/model-calls-repo.ts'

export interface ActivityLogOptions {
  store: ModelCallWriter
  tasks: { getBySession(sessionId: string): { id: string } | undefined }
  events: { append(event: NewEvent): void }
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf(slug: string): { id: string } | undefined
  /** Prices of models, for the cost of calls no hook priced (`watch`, `observer`). */
  catalog?: () => ModelCatalog | undefined
  /** Keep at most this many rows. Default 5000. */
  maxRows?: number | (() => number)
  /** Keep the full request/response for this many hours; older rows keep metadata. Default 24. */
  bodyHours?: number | (() => number)
  /** Keep rows for this many days. Default 7. */
  retentionDays?: number | (() => number)
  /** Prune after this many writes (and at most once a `pruneMinMs`). Default 50. */
  pruneEvery?: number
  pruneMinMs?: number
  now?: () => number
  log?: { warn(message: string): void }
}

export interface CallContext {
  sessionId?: string | undefined
  agentId?: string | undefined
}

/** Context of a stored call: the hook event's fields, with the team's own kinds (`search`, `job`). */
export type RecordInfo = CallContext &
  Omit<Partial<ModelCallEvent>, 'kind' | 'sessionId'> & { kind?: ModelCallKind }

export interface ActivityLog {
  /** The plugin to register on every agent. */
  plugin(): HarnessPlugin<'activity-log'>
  /** Store a call; never throws. */
  record(call: ModelCallRecord, info: RecordInfo): void
  /** A `modelClassifier({ onModelCall })` for a session (kind `other`). */
  observer(info: CallContext): (record: ModelCallRecord) => void
  /** `model`, logging each call it makes (priced from the catalog when the provider reports no cost). */
  watch(model: LanguageModel, info: CallContext & { kind: ModelCallKind }): LanguageModel
  /** Run the retention now (also done periodically); returns the rows deleted. */
  prune(): number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function createActivityLog(options: ActivityLogOptions): ActivityLog {
  const now = options.now ?? (() => Date.now())
  const settingOf = (v: number | (() => number) | undefined, fallback: number): number =>
    typeof v === 'function' ? v() : (v ?? fallback)
  const pruneEvery = options.pruneEvery ?? 50
  const pruneMinMs = options.pruneMinMs ?? 60_000
  const warn = (message: string): void => options.log?.warn(`activityLog ${message}`)
  let writes = 0
  let lastPrune = 0

  const prune = (): number => {
    lastPrune = now()
    try {
      return options.store.prune({
        maxRows: settingOf(options.maxRows, DEFAULT_MAX_ROWS),
        olderThan: lastPrune - settingOf(options.retentionDays, DEFAULT_RETENTION_DAYS) * DAY_MS,
        bodiesOlderThan: lastPrune - settingOf(options.bodyHours, 24) * 3_600_000,
      })
    } catch (error) {
      warn(`prune failed: ${String(error)}`)
      return 0
    }
  }

  const record: ActivityLog['record'] = (call, info) => {
    try {
      const sessionId = info.sessionId ?? null
      const at = now()
      const started = Date.parse(call.startedAt)
      const usage = call.usage
      const row: NewModelCall = {
        id: call.id,
        createdAt: at,
        kind: (info.kind ?? 'other') as ModelCallKind,
        agentId: info.agentId ?? null,
        sessionId,
        turnId: info.turnId ?? null,
        stepIndex: info.stepIndex ?? null,
        messageId: info.messageId ?? null,
        taskId: sessionId === null ? null : (options.tasks.getBySession(sessionId)?.id ?? null),
        provider: call.model.provider,
        modelId: call.model.modelId,
        status: call.status,
        finishReason: call.finishReason ?? null,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
        cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
        costUsd: info.costUsd ?? null,
        costSource: info.costUsd === undefined ? null : (info.costSource ?? null),
        upstreamProvider: call.upstreamProvider ?? null,
        startedAt: Number.isFinite(started) ? started : at,
        firstChunkMs: call.firstChunkMs ?? null,
        durationMs: call.durationMs,
        errorName: call.error?.name ?? null,
        errorMessage: call.error?.message ?? null,
        requestOptions: call.request.options,
        requestBody: call.request.body,
        response: call.response,
        output: call.output,
        providerMetadata: call.providerMetadata,
        usageRaw: usage.raw,
      }
      options.store.insert(row, at)
      options.events.append({
        type: 'model-call',
        agentId: row.agentId,
        sessionId,
        payload: { id: row.id, kind: row.kind, status: row.status, model: row.modelId },
        at,
      })
      writes += 1
      if (writes % pruneEvery === 0 && at - lastPrune >= pruneMinMs) prune()
    } catch (error) {
      warn(`write failed: ${errorText(error)}`)
    }
  }

  /** The settled cost of a call no hook priced; undefined when neither provider nor catalog knows. */
  const priced = (
    model: LanguageModel,
    call: ModelCallRecord,
  ): { costUsd?: number; costSource?: 'provider' | 'estimate' } => {
    try {
      const settled = settledCostOf(options.catalog?.(), model, call.usage, call.providerMetadata)
      return settled === undefined ? {} : { costUsd: settled.costUsd, costSource: settled.source }
    } catch {
      return {}
    }
  }

  return {
    record,
    prune,
    observer: (info) => (call) =>
      record(call, { ...info, ...priced(`${call.model.provider}/${call.model.modelId}`, call) }),
    watch: (model, info) =>
      observeModel(model, (call) => record(call, { ...info, ...priced(model, call) })),
    plugin: () =>
      definePlugin({
        name: 'activity-log',
        setup: () => ({
          hooks: {
            'model.call': (ctx: HarnessContext, e: ModelCallEvent): void => {
              const agent = options.agentOf(ctx.agent.id)
              record(e, { ...e, agentId: agent?.id ?? ctx.agent.id })
            },
          },
        }),
      }),
  }
}
