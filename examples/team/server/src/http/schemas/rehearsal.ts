import { z } from '@hono/zod-openapi'
import { UiMessageSchema } from './chat.ts'
import { DeliverableResultSchema, TaskReportSchema } from './tasks.ts'

const libraryPath = z.string().min(1).max(500)

export const RehearsalSampleSchema = z
  .object({
    copy: z.array(libraryPath).max(50).openapi({
      description:
        'Library files or directories (`/library/data/`, `/library/data/**`) copied into the scratch overlay.',
    }),
    files: z
      .array(
        z.object({
          path: libraryPath.openapi({ example: '/library/inputs/sample.md' }),
          content: z.string().max(500_000),
        }),
      )
      .max(20)
      .openapi({ description: 'Text files the client attached: written into the overlay.' }),
    task: z
      .object({
        title: z.string().min(1).max(200),
        brief: z.string().max(20_000),
        inputs: z.array(libraryPath).max(50),
      })
      .nullable()
      .openapi({
        description:
          'Worker programs: the sample work item the rehearsal works on (a draft; the real board is not touched).',
      }),
    reads: z.enum(['library', 'sample']).openapi({
      description:
        '`library`: reads see the real library under the overlay. `sample`: only the sample files (and the inputs of the sample task) are visible.',
    }),
  })
  .openapi('RehearsalSample')

export const RehearsalSampleInputSchema =
  RehearsalSampleSchema.partial().openapi('RehearsalSampleInput')

export const SimulatedActionSchema = z
  .object({ tool: z.string(), input: z.unknown(), at: z.number().int() })
  .openapi('SimulatedAction', {
    description:
      'A call of an external write tool that was not made: the model read `SIMULATED: would call <tool> with <input>`.',
  })

export const WouldAskSchema = z
  .object({
    kind: z.enum(['escalation', 'amendment', 'proposal', 'report']),
    title: z.string(),
    question: z.string(),
    details: z.string().optional(),
    options: z.array(z.string()).optional(),
    at: z.number().int(),
  })
  .openapi('WouldAsk', {
    description:
      'A decision the run would have raised in the Decision Center (nothing was created).',
  })

export const RehearsalFileSchema = z
  .object({
    path: z.string(),
    size: z.number().int(),
    mediaType: z.string().nullable(),
    text: z
      .string()
      .nullable()
      .openapi({ description: 'Text of a text file; null for binary or over the caps.' }),
    base64: z.string().nullable(),
    truncated: z.boolean().openapi({ description: 'The content is not stored (over the caps).' }),
  })
  .openapi('RehearsalFile')

export const RehearsalSchema = z
  .object({
    id: z.string(),
    programId: z.string(),
    programVersion: z
      .number()
      .int()
      .openapi({ description: 'The program version it ran against.' }),
    programFingerprint: z.string().openapi({
      description:
        'What the program was when it ran (brief, authority, deliverables, ...): an edit that matters changes it.',
    }),
    sessionId: z.string().openapi({ example: 'rehearsal:0198…:1760000000000' }),
    testId: z.string().nullable(),
    status: z.enum(['running', 'done', 'failed']),
    stop: z.string().nullable(),
    error: z.string().nullable(),
    sample: RehearsalSampleSchema,
    budgetUsd: z.number(),
    startedAt: z.number().int(),
    endedAt: z.number().int().nullable(),
    report: TaskReportSchema.nullable(),
    deliverables: DeliverableResultSchema.nullable().openapi({
      description: 'The deliverable checks against the overlay; null when the program lists none.',
    }),
    simulated: z.array(SimulatedActionSchema),
    wouldAsk: z.array(WouldAskSchema),
    toolsCalled: z.array(z.string()),
    files: z.array(RehearsalFileSchema).openapi({
      description:
        'Files the run produced (new or changed against the sample), from the overlay. The list endpoint leaves their content out.',
    }),
    deleted: z.array(z.string()),
    costUsd: z.number(),
  })
  .openapi('Rehearsal', {
    description:
      'A test run of a program on sample data: library writes went to a scratch overlay, external writes were simulated, decisions are recorded as "would ask".',
  })

export const RehearsalListSchema = z
  .object({ rehearsals: z.array(RehearsalSchema) })
  .openapi('RehearsalList')

export const RehearsalStartSchema = z
  .object({
    sample: RehearsalSampleInputSchema.optional(),
    budgetUsd: z.number().positive().max(5).optional().openapi({
      description: 'Spend cap of this rehearsal (default 0.5, at most 5). A separate ledger scope.',
    }),
  })
  .openapi('RehearsalStart')

export const RehearsalIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Rehearsal id.' }),
})

export const RehearsalMessagesSchema = z
  .object({ messages: z.array(UiMessageSchema) })
  .openapi('RehearsalMessages')

export const TestExpectSchema = z
  .object({
    deliverablesPass: z.boolean().openapi({
      description: 'Every deliverable of the program must pass (vacuous when it lists none).',
    }),
    mustNotCall: z.array(z.string().min(1).max(100)).max(50).openapi({
      description: 'Tool names the run must not call; a trailing `*` is a prefix.',
    }),
    reportStatus: z.enum(['done', 'partial', 'failed', 'needs_decision']).nullable().openapi({
      description: 'The report must say this; null = any.',
    }),
  })
  .openapi('TestExpect')

export const TestResultSchema = z
  .object({
    status: z.enum(['running', 'pass', 'fail', 'error']),
    rehearsalId: z.string().nullable(),
    programFingerprint: z.string().openapi({
      description:
        'The program as it was when this ran. An edit that changes what a run does (not pausing, the schedule or the budget) makes the result stale.',
    }),
    failures: z.array(z.string()),
    at: z.number().int(),
  })
  .openapi('TestResult')

export const TestCaseSchema = z
  .object({
    id: z.string(),
    programId: z.string(),
    name: z.string(),
    sample: RehearsalSampleSchema,
    expect: TestExpectSchema,
    lastResult: TestResultSchema.nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('TestCase')

export const TestSummarySchema = z
  .object({
    total: z.number().int(),
    passing: z.number().int(),
    failing: z
      .number()
      .int()
      .openapi({ description: 'Failed or errored at the current program version.' }),
    stale: z
      .number()
      .int()
      .openapi({ description: 'Never run, or not run since the last edit of the program.' }),
    running: z.number().int(),
  })
  .openapi('TestSummary')

export const TestCaseViewSchema = TestCaseSchema.extend({
  stale: z.boolean().openapi({
    description: 'The last result is older than an edit that matters: run the test again.',
  }),
}).openapi('TestCaseView')

export const TestListSchema = z
  .object({ cases: z.array(TestCaseViewSchema), summary: TestSummarySchema })
  .openapi('TestList')

export const TestCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    rehearsalId: z.string().optional().openapi({
      description:
        'Take the sample of this rehearsal; the case is judged against that run at once.',
    }),
    sample: RehearsalSampleInputSchema.optional(),
    expect: TestExpectSchema.partial().optional(),
  })
  .openapi('TestCreate')

export const TestPatchSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    sample: RehearsalSampleInputSchema.optional(),
    expect: TestExpectSchema.partial().optional(),
  })
  .openapi('TestPatch')

export const TestRunSchema = z
  .object({
    caseId: z.string().optional().openapi({ description: 'One case; absent: all of them.' }),
  })
  .openapi('TestRun')

export const TestRunStartedSchema = z
  .object({ started: z.number().int() })
  .openapi('TestRunStarted')

export const TestIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Test case id.' }),
})
