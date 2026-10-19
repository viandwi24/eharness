import { z } from '@hono/zod-openapi'
import {
  EffectiveGrantSchema,
  ProgramAuthoritySchema,
  ProgramBudgetSchema,
  ProgramTriggerSchema,
} from './programs.ts'
import { DeliverableSchema } from './tasks.ts'

const KINDS = ['proposal', 'escalation', 'amendment', 'change'] as const
const STATUSES = ['open', 'approved', 'rejected', 'expired'] as const

export const DecisionKindSchema = z.enum(KINDS).openapi('DecisionKind')
export const DecisionStatusSchema = z.enum(STATUSES).openapi('DecisionStatus')

const list = (max: number) => z.array(z.string().min(1).max(500)).max(max)
const ReportSchema = z.enum(['digest', 'task', 'silent'])

export const ProposedProgramSchema = z
  .object({
    agentId: z.string().openapi({ description: 'The agent that will run the program.' }),
    name: z.string(),
    brief: z.string(),
    authority: ProgramAuthoritySchema,
    gates: z.array(z.string()),
    escalation: z.string(),
    forbidden: z.array(z.string()),
    budget: ProgramBudgetSchema,
    trigger: ProgramTriggerSchema,
    report: ReportSchema,
    deliverables: z.array(DeliverableSchema).optional(),
  })
  .openapi('ProposedProgram')

export const ProposalPayloadSchema = z
  .object({
    program: ProposedProgramSchema,
    runOnce: z.boolean().openapi({
      description:
        'true: a one-off plan (created with a manual trigger and run once on approval). false: a standing program, created as proposed.',
    }),
  })
  .openapi('ProposalPayload')

export const EscalationPayloadSchema = z
  .object({
    question: z.string(),
    options: z
      .array(z.string())
      .openapi({ description: 'Answers to pick from; empty: approve or reject.' }),
    standDown: z.array(z.string()).optional().openapi({
      description:
        'The options that mean "leave it for now" (a subset of `options`): the ones the agent flagged plus the server\'s fallback word list. A pick of one is remembered by a standing program, so a client shows the hint from this list and keeps no word list of its own.',
    }),
    orderActions: z.record(z.string(), z.string()).optional().openapi({
      description:
        'Questions about standing orders: what the server does for each option (`remove:<order>`, `pause:<order>`, `keep-both:<pair>`, `keep:<order>`, `none`). The card needs nothing from it: the options are the buttons.',
    }),
    source: z.enum(['agent', 'report']).openapi({
      description:
        '`agent`: it called `escalate` (its run is parked); `report`: its final report said `needs_decision`.',
    }),
    takeover: z
      .object({
        profileId: z.string(),
        link: z.object({
          label: z.string().openapi({ example: 'Open browser' }),
          path: z.string().openapi({
            description: 'A path of the web app (`/browser/<profileId>`): the card links to it.',
          }),
        }),
      })
      .optional()
      .openapi({
        description:
          'A browser takeover (`browser_request_human`): the agent needs a person in the live browser of this profile. Approve means "handed back" (the live page also settles it), reject means "declined".',
      }),
  })
  .openapi('EscalationPayload')

export const AmendmentPayloadSchema = z
  .object({
    authority: ProgramAuthoritySchema.openapi({
      description: 'The authority to add to the program (the client may narrow it).',
    }),
    why: z.string(),
    suggestion: z
      .object({ tool: z.string(), runs: z.number().int(), denials: z.number().int() })
      .optional()
      .openapi({
        description:
          'Set when agent health suggested it from repeated denials of a program (no run is parked on it).',
      }),
  })
  .openapi('AmendmentPayload')

const ChangeSnapshotSchema = z
  .object({
    brief: z.string().optional(),
    authority: ProgramAuthoritySchema.optional(),
    forbidden: z.array(z.string()).optional(),
    gates: z.array(z.string()).optional(),
    escalation: z.string().optional(),
    trigger: ProgramTriggerSchema.optional(),
    budget: ProgramBudgetSchema.optional(),
    deliverables: z.array(DeliverableSchema).optional(),
    report: ReportSchema.optional(),
  })
  .openapi('ProgramChange')

export const ChangePayloadSchema = z
  .object({
    programId: z.string(),
    programName: z.string().openapi({ description: 'The name when it was proposed.' }),
    patch: ChangeSnapshotSchema.openapi({
      description:
        'What approving applies: only the fields that differ (authority and budget are the full result).',
    }),
    before: ChangeSnapshotSchema.openapi({
      description: 'The same fields when proposed; approving fails when the program differs now.',
    }),
    diff: z
      .array(
        z.object({
          field: z.string(),
          label: z.string(),
          before: z.string(),
          after: z.string(),
        }),
      )
      .openapi({ description: 'Readable before and after per field.' }),
  })
  .openapi('ChangePayload')

export const DecisionOutcomeSchema = z
  .object({
    decision: z.string().openapi({ description: '`approved`, `rejected` or the option picked.' }),
    programId: z.string().optional(),
    runSessionId: z
      .string()
      .optional()
      .openapi({ description: 'Session of the one-off run an approved proposal started.' }),
    effect: z.string().optional().openapi({
      description:
        'What the server did because of the answer ("Removed order ..."), for a question about standing orders.',
    }),
  })
  .openapi('DecisionOutcome')

const base = {
  id: z.string(),
  status: DecisionStatusSchema,
  title: z.string(),
  body: z.string().openapi({ description: 'Markdown: goal, plan steps, why, evidence links.' }),
  agentId: z.string().openapi({ description: 'The agent that asks.' }),
  sessionId: z.string().nullable().openapi({ description: 'The session it came from.' }),
  programId: z.string().nullable(),
  waitId: z
    .string()
    .nullable()
    .openapi({ description: 'The external wait the session is parked on.' }),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  decisionNote: z.string().nullable(),
  outcome: DecisionOutcomeSchema.nullable(),
  createdAt: z.number().int(),
  grant: EffectiveGrantSchema.nullable().optional().openapi({
    description: 'Proposals and amendments: what the authority really resolves to for the agent.',
  }),
}

export const DecisionSchema = z
  .discriminatedUnion('kind', [
    z.object({ ...base, kind: z.literal('proposal'), payload: ProposalPayloadSchema }),
    z.object({ ...base, kind: z.literal('escalation'), payload: EscalationPayloadSchema }),
    z.object({ ...base, kind: z.literal('amendment'), payload: AmendmentPayloadSchema }),
    z.object({ ...base, kind: z.literal('change'), payload: ChangePayloadSchema }),
  ])
  .openapi('Decision')

export const DecisionListSchema = z
  .object({
    decisions: z.array(DecisionSchema),
    open: z
      .number()
      .int()
      .openapi({ description: 'All open decisions (the badge), whatever the filter.' }),
  })
  .openapi('DecisionList')

export const DecisionQuerySchema = z.object({
  status: DecisionStatusSchema.optional(),
  kind: DecisionKindSchema.optional(),
  agentId: z.string().optional().openapi({ description: 'Agent id or slug.' }),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const DecisionIdParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Decision id.' }),
})

export const ProposalEditSchema = z
  .object({
    agentId: z.string().min(1).optional(),
    name: z.string().min(1).max(120).optional(),
    brief: z.string().min(1).max(20_000).optional(),
    authority: ProgramAuthoritySchema.partial().optional(),
    gates: list(100).optional(),
    escalation: z.string().max(20_000).optional(),
    forbidden: list(100).optional(),
    budget: ProgramBudgetSchema.partial().optional(),
    trigger: ProgramTriggerSchema.optional(),
    report: ReportSchema.optional(),
    deliverables: z.array(DeliverableSchema).max(20).optional(),
  })
  .openapi('ProposalEdit')

export const ApproveBodySchema = z
  .object({
    note: z
      .string()
      .max(4000)
      .optional()
      .openapi({ description: 'Shown to the agent as the note of the answer.' }),
    choice: z.string().optional().openapi({
      description: 'Escalation with options: the option picked (the answer the agent gets).',
    }),
    edit: z
      .object({
        program: ProposalEditSchema.optional(),
        runOnce: z.boolean().optional(),
      })
      .optional()
      .openapi({
        description:
          'Proposal: what the client changed before approving; absent fields stay as proposed.',
      }),
    authority: ProgramAuthoritySchema.partial().optional().openapi({
      description: 'Amendment: grant this instead of what was asked (narrower).',
    }),
  })
  .openapi('DecisionApprove')

export const RejectBodySchema = z
  .object({ note: z.string().max(4000).optional() })
  .openapi('DecisionReject')
