import { z } from '@hono/zod-openapi'
import {
  MAX_ABOUT,
  MAX_DISPLAY_NAME,
  MAX_LANGUAGE,
  MAX_OPERATING_RULES,
  MAX_OVERLAY,
  MAX_REASON,
  MAX_VOICE,
  PERSONA_SOURCES,
  PROPOSAL_STATUSES,
} from '../../app/catalog.ts'

export const PersonaIdentitySchema = z
  .object({
    displayName: z.string().openapi({
      description: `How the agent names itself (max ${MAX_DISPLAY_NAME}); empty = the agent name.`,
    }),
    about: z
      .string()
      .openapi({ description: `One short line about what it is for (max ${MAX_ABOUT}).` }),
    language: z.string().openapi({
      description: `Default answer language (max ${MAX_LANGUAGE}); empty = the language of the person.`,
    }),
    emoji: z.boolean().openapi({ description: 'Whether it may use emoji.' }),
  })
  .openapi('PersonaIdentity')

export const PersonaVersionSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    version: z.number().int(),
    identity: PersonaIdentitySchema,
    voice: z.string().openapi({
      description: `Free-text voice and preferences (max ${MAX_VOICE} characters).`,
    }),
    operatingRules: z.string().openapi({
      description: `Admin-only operating rules (max ${MAX_OPERATING_RULES} characters); edited here only.`,
    }),
    source: z.enum(PERSONA_SOURCES),
    authorName: z.string().nullable(),
    authorRole: z.string().nullable(),
    authorRef: z.string().nullable(),
    reason: z.string().nullable(),
    diff: z.string().openapi({ description: 'Readable diff against the previous version.' }),
    revertOf: z.number().int().nullable(),
    proposalId: z.string().nullable(),
    createdAt: z.number().int(),
  })
  .openapi('PersonaVersion')

export const PersonaProposalSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    baseVersion: z.number().int(),
    identity: PersonaIdentitySchema,
    voice: z.string(),
    reason: z.string(),
    request: z.string().nullable().openapi({
      description: 'The words of the person that asked, as the agent quoted them.',
    }),
    diff: z.string(),
    source: z.enum(['web', 'chat']),
    proposerName: z.string().nullable(),
    proposerRole: z.string().nullable(),
    proposerRef: z.string().nullable(),
    sessionId: z.string().nullable(),
    status: z.enum(PROPOSAL_STATUSES),
    decidedBy: z.string().nullable(),
    decidedAt: z.number().int().nullable(),
    appliedVersion: z.number().int().nullable(),
    createdAt: z.number().int(),
  })
  .openapi('PersonaProposal')

export const PersonaStateSchema = z
  .object({
    agentId: z.string(),
    current: PersonaVersionSchema,
    pending: z.array(PersonaProposalSchema),
    limits: z.object({
      voice: z.number().int(),
      operatingRules: z.number().int(),
      overlay: z.number().int(),
      reason: z.number().int(),
    }),
  })
  .openapi('PersonaState')

export const PersonaEditSchema = z
  .object({
    identity: PersonaIdentitySchema.partial().optional(),
    voice: z.string().optional(),
    operatingRules: z.string().optional(),
    reason: z.string().max(MAX_REASON).optional(),
  })
  .openapi('PersonaEdit')

export const PersonaHistorySchema = z
  .object({ items: z.array(PersonaVersionSchema) })
  .openapi('PersonaHistory')

export const PersonaRevertSchema = z
  .object({ version: z.number().int().min(1) })
  .openapi('PersonaRevert')

export const PersonaProposalParam = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: 'id', in: 'path' }, description: 'Agent id or slug.' }),
  proposalId: z
    .string()
    .min(1)
    .openapi({ param: { name: 'proposalId', in: 'path' } }),
})

export const PERSONA_LIMITS = {
  voice: MAX_VOICE,
  operatingRules: MAX_OPERATING_RULES,
  overlay: MAX_OVERLAY,
  reason: MAX_REASON,
}
