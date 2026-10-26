import { z } from '@hono/zod-openapi'

export const ScriptParam = z.object({
  script: z
    .string()
    .openapi({ param: { name: 'script', in: 'path' }, description: 'Script id or name.' }),
})
export const VersionParam = ScriptParam.extend({
  version: z.coerce
    .number()
    .int()
    .min(1)
    .openapi({ param: { name: 'version', in: 'path' } }),
})
export const RunParam = ScriptParam.extend({
  runId: z.string().openapi({ param: { name: 'runId', in: 'path' } }),
})

const Manifest = z.record(z.string(), z.unknown()).openapi({
  description:
    'Triggers, grants, cooldownSec, maxRunsPerHour and limits (examples/team/docs/scripts.md). Grants are default-deny.',
})

export const ScriptSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    agentId: z.string(),
    status: z.enum(['draft', 'active', 'disabled']),
    latestVersion: z.number().int(),
    activeVersion: z.number().int().nullable(),
    authorKind: z.enum(['person', 'agent']),
    createdBy: z.string(),
    approval: z.object({
      state: z.enum(['none', 'pending', 'approved', 'rejected']),
      version: z.number().int().nullable(),
      by: z.string().nullable(),
      at: z.number().int().nullable(),
      note: z.string().nullable(),
    }),
    routineId: z.string().nullable(),
    lastRunAt: z.number().int().nullable(),
    runCount: z.number().int(),
    errorCount: z.number().int(),
    consecutiveFailures: z.number().int(),
    disabledReason: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('Script')

export const ScriptListSchema = z.object({ scripts: z.array(ScriptSchema) }).openapi('ScriptList')

export const ScriptVersionSchema = z
  .object({
    scriptId: z.string(),
    version: z.number().int(),
    source: z.string(),
    manifest: Manifest,
    hash: z.string(),
    note: z.string(),
    createdBy: z.string(),
    authorKind: z.enum(['person', 'agent']),
    createdAt: z.number().int(),
  })
  .openapi('ScriptVersion')

export const ScriptVersionListSchema = z
  .object({ versions: z.array(ScriptVersionSchema.omit({ source: true })) })
  .openapi('ScriptVersionList')

export const ScriptDetailSchema = z
  .object({
    script: ScriptSchema,
    latest: ScriptVersionSchema,
    /** What a pending request or activating the latest version would widen ([] = nothing). */
    widening: z.array(z.string()),
  })
  .openapi('ScriptDetail')

export const ScriptCreateSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(63)
      .openapi({ description: 'Lowercase letters, digits and -, starting with a letter.' }),
    description: z.string().max(500).optional(),
    agent: z.string().optional().openapi({
      description: 'Agent id or slug the script belongs to (default: the first agent).',
    }),
    source: z.string().min(1).max(200_000),
    manifest: Manifest,
    note: z.string().max(500).optional(),
  })
  .openapi('ScriptCreate')

export const ScriptPatchSchema = z
  .object({
    name: z.string().min(1).max(63).optional(),
    description: z.string().max(500).optional(),
    agent: z.string().optional(),
    source: z.string().min(1).max(200_000).optional(),
    manifest: Manifest.optional(),
    note: z.string().max(500).optional(),
  })
  .openapi('ScriptPatch')

export const ScriptUpdatedSchema = z
  .object({ script: ScriptSchema, version: z.number().int().optional() })
  .openapi('ScriptUpdated')

export const ActivateSchema = z
  .object({ version: z.number().int().min(1).optional(), note: z.string().max(500).optional() })
  .openapi('ScriptActivate')

export const DecisionSchema = z
  .object({ version: z.number().int().min(1).optional(), note: z.string().max(500).optional() })
  .openapi('ScriptDecision')

export const HostCallSchema = z
  .object({
    method: z.string(),
    args: z.unknown(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    ms: z.number(),
    dryRun: z.boolean().optional(),
  })
  .passthrough()
  .openapi('ScriptHostCall')

export const ScriptRunSchema = z
  .object({
    id: z.string(),
    scriptId: z.string(),
    version: z.number().int(),
    trigger: z.enum(['channel', 'schedule', 'table', 'app', 'webhook', 'manual']),
    dryRun: z.boolean(),
    outcome: z.string(),
    reason: z.string().nullable(),
    error: z.string().nullable(),
    event: z.unknown(),
    result: z.unknown(),
    logs: z.array(z.string()),
    calls: z.array(HostCallSchema),
    durationMs: z.number(),
    cpuMs: z.number(),
    startedBy: z.string(),
    startedAt: z.number().int(),
  })
  .openapi('ScriptRun')

export const ScriptRunListSchema = z
  .object({ runs: z.array(ScriptRunSchema) })
  .openapi('ScriptRunList')

export const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().optional().openapi({ description: 'A run id: older runs only.' }),
  dryRun: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: 'Only dry runs (true) or only real runs (false).' }),
})

export const DryRunSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    eventId: z
      .string()
      .optional()
      .openapi({ description: 'A channel event of the Events page (`ch:<id>`).' }),
    text: z
      .string()
      .max(10_000)
      .optional()
      .openapi({ description: 'The message text of a recorded event (the log keeps none).' }),
    event: z
      .unknown()
      .optional()
      .openapi({ description: 'A synthetic event instead of a recorded one.' }),
  })
  .openapi('ScriptDryRun')

export const DryRunResultSchema = z
  .object({
    run: ScriptRunSchema,
    triggers: z
      .array(z.string())
      .openapi({ description: 'Per channel trigger: `match` or why it would not start.' }),
  })
  .openapi('ScriptDryRunResult')

export const RunNowSchema = z.object({ event: z.unknown().optional() }).openapi('ScriptRunNow')

export const ScriptTypesSchema = z
  .object({
    types: z.string().openapi({ description: 'The `scripts.d.ts` scripts are written against.' }),
    methods: z.array(
      z.object({
        name: z.string(),
        args: z.string(),
        returns: z.string(),
        doc: z.string(),
        sideEffect: z.boolean(),
      }),
    ),
    manifestSchema: z.record(z.string(), z.unknown()).openapi({
      description: 'A JSON Schema of the manifest (editor help; the server checks every save).',
    }),
  })
  .openapi('ScriptTypes')

export const ScriptKvSchema = z
  .object({ entries: z.array(z.object({ key: z.string(), value: z.string() })) })
  .openapi('ScriptKv')

export const ScriptDeletedSchema = z.object({ deleted: z.literal(true) }).openapi('ScriptDeleted')

export const ScriptWebhookSchema = z
  .object({
    url: z.string().openapi({
      description: 'POST here to run the script (the token in the path is the secret).',
    }),
    live: z.boolean().openapi({ description: 'The active version has a webhook trigger.' }),
  })
  .openapi('ScriptWebhook')

export const CheckSchema = z
  .object({
    version: z.number().int().min(1).optional(),
    source: z
      .string()
      .max(200_000)
      .optional()
      .openapi({ description: 'A draft to check instead of a saved version.' }),
    manifest: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: 'The draft manifest (default the latest saved).' }),
  })
  .openapi('ScriptCheck')

export const CheckResultSchema = z
  .object({
    ok: z.boolean(),
    errors: z.number().int(),
    warnings: z.number().int(),
    problems: z.array(
      z.object({
        line: z.number().int(),
        column: z.number().int(),
        message: z.string(),
        severity: z.enum(['error', 'warning']),
        code: z.string(),
      }),
    ),
    durationMs: z.number(),
    version: z.number().int().optional(),
  })
  .openapi('ScriptCheckResult')
