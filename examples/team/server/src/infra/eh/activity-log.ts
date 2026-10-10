/**
 * `activityLog` plugin: the `model.call` hook (ADR-0047) persists one `model_calls` row per
 * provider call and appends a lightweight `model-call` event to the feed so the Logs page can
 * live-update. Calls the engine makes without a session (the Auto mode classifier) arrive through
 * `ActivityLog.observer`.
 *
 * Retention is a count and an age: a cheap prune runs after every `pruneEvery` writes and at most
 * once a minute, on whichever instance writes. Nothing here may break a turn: every failure is
 * logged and swallowed.
 */
import {
  definePlugin,
  type HarnessContext,
  type HarnessPlugin,
  type ModelCallEvent,
  type ModelCallRecord,
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
  tasks: {
    getBySession(sessionId: string): { id: string } | undefined
    appendEvent(event: NewEvent, now: number): number
  }
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf(slug: string): { id: string } | undefined
  /** Keep at most this many rows. Default 5000. */
  maxRows?: number
  /** Keep rows for this many days. Default 7. */
  retentionDays?: number
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

export interface ActivityLog {
  /** The plugin to register on every agent. */
  plugin(): HarnessPlugin<'activity-log'>
  /** Store a call; never throws. */
  record(call: ModelCallRecord, info: CallContext & Partial<ModelCallEvent>): void
  /** A `modelClassifier({ onModelCall })` for a session (kind `other`). */
  observer(info: CallContext): (record: ModelCallRecord) => void
  /** Run the retention now (also done periodically); returns the rows deleted. */
  prune(): number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function createActivityLog(options: ActivityLogOptions): ActivityLog {
  const now = options.now ?? (() => Date.now())
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
  const retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS
  const pruneEvery = options.pruneEvery ?? 50
  const pruneMinMs = options.pruneMinMs ?? 60_000
  const warn = (message: string): void => options.log?.warn(`activityLog ${message}`)
  let writes = 0
  let lastPrune = 0

  const prune = (): number => {
    lastPrune = now()
    try {
      return options.store.prune({ maxRows, olderThan: lastPrune - retentionMs })
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
      options.tasks.appendEvent(
        {
          type: 'model-call',
          agentId: row.agentId,
          sessionId,
          payload: { id: row.id, kind: row.kind, status: row.status, model: row.modelId },
        },
        at,
      )
      writes += 1
      if (writes % pruneEvery === 0 && at - lastPrune >= pruneMinMs) prune()
    } catch (error) {
      warn(`write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    record,
    prune,
    observer: (info) => (call) => record(call, info),
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
