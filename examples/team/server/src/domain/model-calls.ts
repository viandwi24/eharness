/** Model call log (the "Logs" page): one row per provider call. Pure types and rules. */

export const MODEL_CALL_KINDS = ['step', 'compaction', 'flush', 'other'] as const
export type ModelCallKind = (typeof MODEL_CALL_KINDS)[number]

export const MODEL_CALL_STATUSES = ['ok', 'error', 'aborted'] as const
export type ModelCallStatus = (typeof MODEL_CALL_STATUSES)[number]

/** Summary row: everything but the big JSON columns (what the table needs). */
export interface ModelCallSummary {
  id: string
  /** When the row was stored (ms). Retention counts from it. */
  createdAt: number
  kind: ModelCallKind
  agentId: string | null
  sessionId: string | null
  turnId: string | null
  stepIndex: number | null
  messageId: string | null
  /** The task of the session, when the session is a task session. */
  taskId: string | null
  provider: string
  modelId: string
  status: ModelCallStatus
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  cachedTokens: number | null
  costUsd: number | null
  /** Start of the provider call (ms). */
  startedAt: number
  firstChunkMs: number | null
  durationMs: number
  errorName: string | null
  errorMessage: string | null
  /** At least one JSON column was cut at the size cap. */
  truncated: boolean
}

/** A JSON column as stored: the value, or a marker object when it was cut. */
export type JsonValue = unknown

export interface ModelCallDetail extends ModelCallSummary {
  requestOptions: JsonValue
  requestBody: JsonValue
  response: JsonValue
  output: JsonValue
  providerMetadata: JsonValue
  usageRaw: JsonValue
  /** The row above this one in the list (newer), under the same filters. */
  prevId: string | null
  /** The row below this one in the list (older), under the same filters. */
  nextId: string | null
}

/** What the writer inserts: a summary without bookkeeping, plus the JSON columns. */
export interface NewModelCall extends Omit<ModelCallSummary, 'truncated'> {
  requestOptions: JsonValue
  requestBody: JsonValue
  response: JsonValue
  output: JsonValue
  providerMetadata: JsonValue
  usageRaw: JsonValue
}

export interface ModelCallFilter {
  /** Start of the call >= from (epoch ms). */
  from?: number
  /** Start of the call <= to (epoch ms). */
  to?: number
  agentId?: string
  sessionId?: string
  kind?: ModelCallKind
  status?: ModelCallStatus
  /** Model id contains this text (case-insensitive). */
  model?: string
  /** Free text over model id, provider and agent name. */
  q?: string
}

export interface ModelCallListQuery extends ModelCallFilter {
  cursor?: string
  limit: number
}

export interface ModelCallPage {
  items: ModelCallSummary[]
  nextCursor: string | null
}

export interface ModelCallBucket {
  /** Start of the bucket (epoch ms). */
  start: number
  count: number
  errors: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface ModelCallStats {
  from: number
  to: number
  bucketMs: number
  buckets: ModelCallBucket[]
  totals: Omit<ModelCallBucket, 'start'> & { aborted: number }
  /** Distinct model ids in the range (for a filter), most called first. */
  models: string[]
}

/** Default size cap of one JSON column (bytes of its JSON text). */
export const DEFAULT_JSON_CAP = 512 * 1024
export const DEFAULT_MAX_ROWS = 5000
export const DEFAULT_RETENTION_DAYS = 7
export const MAX_BUCKETS = 200

/**
 * JSON text of `value` for a column, cut at `cap` characters. A cut value is replaced by a marker
 * object holding the head of the text, so the column is always valid JSON.
 */
export function capJson(value: unknown, cap: number): { text: string | null; truncated: boolean } {
  if (value === undefined) return { text: null, truncated: false }
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    return {
      text: JSON.stringify({ _truncated: true, error: 'not serializable' }),
      truncated: true,
    }
  }
  if (text.length <= cap) return { text, truncated: false }
  const marker = { _truncated: true, bytes: text.length, preview: '' }
  const room = Math.max(0, cap - JSON.stringify(marker).length - 16)
  marker.preview = text.slice(0, room)
  return { text: JSON.stringify(marker), truncated: true }
}

/** A nice bucket width (ms) so a range has at most `max` buckets and none is under a second. */
export function bucketWidth(rangeMs: number, max = 60): number {
  const steps = [
    1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000, 1_800_000, 3_600_000, 10_800_000,
    21_600_000, 43_200_000, 86_400_000,
  ]
  const want = rangeMs / max
  return steps.find((s) => s >= want) ?? Math.ceil(want)
}
