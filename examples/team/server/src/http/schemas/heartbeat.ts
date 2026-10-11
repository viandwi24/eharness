import { z } from '@hono/zod-openapi'
import { BEAT_STATUSES, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES } from '../../app/catalog.ts'

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 hours')

export const HeartbeatConfigSchema = z
  .object({
    enabled: z.boolean(),
    everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES),
    activeFrom: clock.openapi({ description: 'Start of the active hours, in `timezone`.' }),
    activeTo: clock.openapi({
      description: 'End of the active hours (exclusive); a window may wrap midnight.',
    }),
    timezone: z.string().min(1).max(64).nullable().openapi({
      description: 'IANA timezone; null = the team timezone (workspace setting).',
    }),
  })
  .openapi('HeartbeatConfig')

export const HeartbeatPatchSchema = HeartbeatConfigSchema.partial()
  .extend({
    createChecklist: z.boolean().optional().openapi({
      description: 'Create `HEARTBEAT.md` with a template when the agent has none yet.',
    }),
  })
  .openapi('HeartbeatPatch')

export const BeatItemSchema = z
  .object({
    kind: z.string(),
    title: z.string(),
    detail: z.string(),
    links: z.array(z.string()),
    urgent: z.boolean(),
    fingerprint: z.string(),
  })
  .openapi('BeatItem')

export const BeatRecordSchema = z
  .object({
    id: z.string().openapi({ description: 'The routine slot of the beat.' }),
    at: z.number().int(),
    endedAt: z.number().int().nullable(),
    status: z.enum(BEAT_STATUSES),
    reason: z.string().nullable().openapi({ description: 'Why it was skipped or failed.' }),
    count: z.number().int().openapi({ description: 'Identical skips in a row, collapsed.' }),
    items: z.array(BeatItemSchema).openapi({ description: 'What it reported (new items only).' }),
    duplicates: z
      .number()
      .int()
      .openapi({ description: 'Findings already reported inside the window.' }),
  })
  .openapi('BeatRecord')

export const DigestConfigSchema = z
  .object({
    enabled: z.boolean(),
    time: clock,
    timezone: z.string().nullable().openapi({
      description: 'IANA timezone; null = the team timezone (workspace setting).',
    }),
  })
  .openapi('DigestConfig')

export const DigestViewSchema = DigestConfigSchema.extend({
  effectiveTimezone: z.string().openapi({ description: 'The timezone in effect.' }),
  buffered: z.number().int().openapi({ description: 'Items waiting for the next digest.' }),
  lastSentAt: z.number().int().nullable(),
}).openapi('DigestView')

export const DigestPatchSchema = DigestConfigSchema.partial().openapi('DigestPatch')

export const HeartbeatSchema = z
  .object({
    agentId: z.string(),
    config: HeartbeatConfigSchema,
    effectiveTimezone: z.string().openapi({
      description: 'The timezone of the active hours in effect: its own, else the team timezone.',
    }),
    stored: z.boolean().openapi({
      description: 'false while nothing was ever set: the config is the default of the role.',
    }),
    checklist: z.object({
      path: z.string().openapi({ description: 'A memory file of the agent.' }),
      exists: z.boolean(),
      empty: z.boolean().openapi({
        description: 'Only headings and comments: the beat is skipped, no model call.',
      }),
    }),
    trigger: z
      .object({
        status: z.enum(['active', 'paused']),
        nextFireAt: z.number().int().nullable(),
        lastFireAt: z.number().int().nullable(),
      })
      .nullable(),
    beats: z.array(BeatRecordSchema).openapi({ description: 'Newest first (the last 50).' }),
    digest: DigestViewSchema,
  })
  .openapi('Heartbeat')

export const BeatRunSchema = z
  .object({
    started: z.boolean(),
    reason: z.string().optional().openapi({ description: 'Why nothing started.' }),
  })
  .openapi('BeatRun')
