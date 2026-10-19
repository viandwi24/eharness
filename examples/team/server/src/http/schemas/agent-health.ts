import { z } from '@hono/zod-openapi'

// the http layer does not import the domain: `test/health.test.ts` checks these lists against it
export const FINDING_KINDS = [
  'repeated-denial',
  'tool-loop',
  'repeated-error',
  'approval-waiting',
  'token-spike',
  'big-output',
  'program-run',
  'provider-error',
  'tools-changed',
  'order-hygiene',
  'consistency',
] as const
export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const

export const FindingSchema = z
  .object({
    fingerprint: z.string().openapi({
      description: 'Stable id of the problem: the same problem is the same finding on every scan.',
    }),
    kind: z.enum(FINDING_KINDS),
    severity: z.enum(FINDING_SEVERITIES),
    agentId: z.string().nullable(),
    agentName: z.string().nullable(),
    sessionId: z.string().nullable(),
    programId: z.string().nullable(),
    programName: z.string().nullable(),
    link: z.string().nullable().openapi({
      description: 'App path of the evidence (a task, a program or a chat).',
    }),
    firstSeen: z.number().int().openapi({ description: 'Epoch ms.' }),
    lastSeen: z.number().int().openapi({ description: 'Epoch ms.' }),
    count: z.number().int(),
    explanation: z.string().openapi({ description: 'One line: what is wrong.' }),
    fix: z.string().openapi({ description: 'What to do about it.' }),
    consistency: z
      .object({
        kind: z
          .string()
          .openapi({ description: 'The check: `program-duplicate`, `memory-dead-ref`, ...' }),
        memoryPath: z.string().nullable().openapi({
          description: 'A memory finding: the file, relative to its memory root.',
        }),
        line: z.number().int().nullable(),
        refs: z.array(z.string()).openapi({ description: 'Ids and paths involved.' }),
      })
      .nullable()
      .optional()
      .openapi({ description: 'Set for kind `consistency`.' }),
    fixAction: z
      .object({
        kind: z.string().openapi({ example: 'unforbid' }),
        label: z.string().openapi({ description: 'The button.' }),
        confirm: z.string().openapi({ description: 'The sentence to confirm before it runs.' }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          'Set when the fix is unambiguous: `POST .../fix` does it. Absent: follow the text `fix`.',
      }),
    dismissed: z.boolean(),
    dismissedAt: z.number().int().nullable(),
  })
  .openapi('HealthFinding')

export const FindingQuerySchema = z.object({
  agent: z.string().optional().openapi({ description: 'Agent id or slug.' }),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  kind: z.enum(FINDING_KINDS).optional(),
  dismissed: z
    .enum(['true', 'false'])
    .optional()
    .openapi({ description: '`true` also lists dismissed findings.' }),
})

export const FindingListSchema = z
  .object({
    findings: z.array(FindingSchema),
    open: z.number().int().openapi({ description: 'Findings not dismissed (all filters off).' }),
    scannedAt: z.number().int(),
  })
  .openapi('HealthFindingList')

export const FingerprintParam = z.object({
  fingerprint: z
    .string()
    .min(1)
    .max(300)
    .openapi({
      param: { name: 'fingerprint', in: 'path' },
      example: 'denial:program:abc:list_topics',
    }),
})

export const FindingAckSchema = z.object({ ok: z.literal(true) }).openapi('HealthFindingAck')

export const FindingFixBodySchema = z
  .object({ confirm: z.literal(true).openapi({ description: 'The person confirmed the change.' }) })
  .openapi('HealthFindingFixInput')

export const FindingFixResultSchema = z
  .object({
    ok: z.literal(true),
    outcome: z.string().openapi({ description: 'What was done, in words.' }),
  })
  .openapi('HealthFindingFixResult')
