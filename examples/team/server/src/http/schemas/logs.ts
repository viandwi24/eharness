import { z } from '@hono/zod-openapi'
import { MODEL_CALL_KINDS, MODEL_CALL_SOURCES, MODEL_CALL_STATUSES } from '../../app/catalog.ts'

export const ModelCallKindSchema = z.enum(MODEL_CALL_KINDS).openapi({
  description:
    "`step` = a turn step of an agent, `compaction` = the history summarizer, `flush` = the pre-compaction memory flush, `search` = the model behind the `web_search` tool, `job` = a background job on an agent's model (memory reorganization), `other` = any other model call (the Auto mode classifier).",
})
export const ModelCallStatusSchema = z.enum(MODEL_CALL_STATUSES).openapi({
  description:
    '`ok`, `error` (the provider call failed) or `aborted` (stopped before it finished).',
})

export const ModelCallSourceSchema = z.enum(MODEL_CALL_SOURCES).openapi({
  description:
    'Where the call came from: `chat`, `task`, `delegated` (work a lead handed to a role agent), `program` (also rehearsals), `routine`, `heartbeat`, `api` (developer API), `compaction`, `flush`, `classifier` (Auto mode), `other`.',
})

const epoch = z.coerce.number().int().min(0)

/** Filters shared by the list, the stats and the detail (so prev / next follow the same view). */
export const LogFilterQuery = z.object({
  from: epoch
    .optional()
    .openapi({ description: 'Calls started at or after this time (epoch ms).' }),
  to: epoch.optional().openapi({ description: 'Calls started at or before this time (epoch ms).' }),
  agentId: z.string().min(1).optional().openapi({ description: 'Only calls of this agent (id).' }),
  sessionId: z.string().min(1).optional().openapi({
    description: 'Only calls of this session (`dm:<agentId>`, a task session, ...).',
  }),
  kind: ModelCallKindSchema.optional(),
  status: ModelCallStatusSchema.optional(),
  source: ModelCallSourceSchema.optional(),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({ description: 'Model id contains this text (case-insensitive).' }),
  q: z.string().min(1).max(200).optional().openapi({
    description: 'Free text: matches the model id, the provider or the name of the agent.',
  }),
})

const SummaryShape = {
  id: z.string().openapi({ description: 'UUIDv7 of the call.' }),
  createdAt: z.number().int().openapi({ description: 'When the row was stored (epoch ms).' }),
  kind: ModelCallKindSchema,
  agentId: z.string().nullable(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  stepIndex: z
    .number()
    .int()
    .nullable()
    .openapi({ description: '`step` calls: 0-based step of the turn.' }),
  messageId: z
    .string()
    .nullable()
    .openapi({ description: '`step` calls: the assistant message the step belongs to.' }),
  taskId: z
    .string()
    .nullable()
    .openapi({ description: 'The task, when the session is a task session.' }),
  provider: z.string(),
  modelId: z.string(),
  status: ModelCallStatusSchema,
  finishReason: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  reasoningTokens: z.number().int().nullable(),
  cachedTokens: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Input tokens read from the prompt cache.' }),
  costUsd: z
    .number()
    .nullable()
    .openapi({ description: 'Null when the model has no price in the catalog.' }),
  costSource: z.enum(['provider', 'estimate']).nullable().openapi({
    description:
      '`provider`: the billed cost the provider reported; `estimate`: computed from catalog prices.',
  }),
  upstreamProvider: z.string().nullable().openapi({
    description: 'The upstream provider that served the call, when the gateway reports it.',
  }),
  startedAt: z.number().int().openapi({ description: 'Start of the provider call (epoch ms).' }),
  firstChunkMs: z
    .number()
    .int()
    .nullable()
    .openapi({ description: 'Time to the first streamed content; null for non-streaming calls.' }),
  durationMs: z.number().int(),
  errorName: z.string().nullable(),
  errorMessage: z.string().nullable(),
  truncated: z.boolean().openapi({
    description:
      'A JSON column was cut at the size cap; it then holds a `_truncated` marker with a preview.',
  }),
}

export const ModelCallSummarySchema = z.object(SummaryShape).openapi('ModelCallSummary', {
  description: 'One call without the large JSON columns.',
})

export const ModelCallListSchema = z
  .object({
    items: z.array(ModelCallSummarySchema),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: 'Pass as `cursor` for the next page; null at the end.' }),
  })
  .openapi('ModelCallList')

export const ModelCallDetailSchema = z
  .object({
    ...SummaryShape,
    requestOptions: z.unknown().openapi({
      description: 'Provider-agnostic call options: prompt, tools, tool choice, settings.',
    }),
    requestBody: z.unknown().openapi({
      description: 'The body the provider received, when it reports it; null otherwise.',
    }),
    response: z.unknown().openapi({
      description:
        '`{ id, modelId, timestamp, headers, body }` (credential-like headers are removed).',
    }),
    output: z.unknown().openapi({ description: '`{ text, reasoning, toolCalls }`.' }),
    providerMetadata: z.unknown(),
    usageRaw: z.unknown().openapi({ description: 'The usage object as the provider reported it.' }),
    prevId: z
      .string()
      .nullable()
      .openapi({ description: 'The row above in the list (newer) under the same filters.' }),
    nextId: z
      .string()
      .nullable()
      .openapi({ description: 'The row below in the list (older) under the same filters.' }),
  })
  .openapi('ModelCallDetail', { description: 'One call with every JSON column.' })

const TotalsShape = {
  count: z.number().int(),
  errors: z.number().int().openapi({ description: 'Calls with status `error`.' }),
  aborted: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedTokens: z
    .number()
    .int()
    .openapi({ description: 'Input tokens read from the prompt cache.' }),
  reasoningTokens: z.number().int(),
  costUsd: z.number(),
}

const TotalsSchema = z.object({
  ...TotalsShape,
  p50Ms: z.number().nullable().openapi({
    description: 'Median duration of the calls that were not aborted; null when there are none.',
  }),
  p95Ms: z.number().nullable().openapi({ description: '95th percentile of the same durations.' }),
})

const BreakdownRow = z.object({
  key: z.string().nullable().openapi({ description: 'Model id, or agent id (null: no agent).' }),
  calls: z.number().int(),
  errors: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  avgDurationMs: z.number(),
})

export const ModelCallStatsSchema = z
  .object({
    from: z.number().int(),
    to: z.number().int(),
    bucketMs: z.number().int().openapi({ description: 'Width of a bucket.' }),
    buckets: z
      .array(
        z.object({
          start: z.number().int(),
          count: z.number().int(),
          errors: z.number().int(),
          aborted: z.number().int(),
          inputTokens: z.number().int(),
          outputTokens: z.number().int(),
          cachedTokens: z.number().int(),
          reasoningTokens: z.number().int(),
          costUsd: z.number(),
          costBySource: z
            .record(z.string(), z.number())
            .openapi({ description: 'Cost per source; only sources with a cost in the bucket.' }),
          costByAgent: z.record(z.string(), z.number()).openapi({
            description: 'Cost per agent id (`none`: no agent); only agents with a cost.',
          }),
        }),
      )
      .openapi({ description: 'Every bucket of the range in order, empty ones included.' }),
    totals: TotalsSchema,
    previous: TotalsSchema.openapi({
      description: 'Totals of the equal range right before `from`, under the same filters.',
    }),
    byModel: z.array(BreakdownRow).openapi({ description: 'Per model, most expensive first.' }),
    byAgent: z.array(BreakdownRow).openapi({ description: 'Per agent, most expensive first.' }),
    models: z.array(z.string()).openapi({
      description:
        'Distinct model ids in the range (ignoring the `model` filter), most called first.',
    }),
  })
  .openapi('ModelCallStats')

export const LogIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Id of the call.' }),
})
