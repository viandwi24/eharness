import { z } from '@hono/zod-openapi'
import { BEAT_STATUSES, MAX_EVERY_MINUTES, MIN_EVERY_MINUTES } from '../../app/catalog.ts'

export const OrderDestinationSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('chat'),
      connectionId: z.string(),
      nodeId: z.string().openapi({ description: 'The conversation (chat or topic) id.' }),
    }),
    z.object({
      kind: z.literal('web'),
      sessionId: z
        .string()
        .openapi({ description: 'The web chat thread (session) it reports into.' }),
    }),
  ])
  .openapi('OrderDestination')

export const StandingOrderSchema = z
  .object({
    id: z.string(),
    text: z.string().openapi({ description: "The person's words, lightly cleaned." }),
    by: z.string().openapi({ description: 'Who asked: an identity id, or `web:owner`.' }),
    name: z.string(),
    role: z.string(),
    uid: z
      .string()
      .optional()
      .openapi({ description: 'Platform user id of the asker (for a mention).' }),
    report: OrderDestinationSchema,
    reportLabel: z.string().openapi({ description: 'Where it reports, named for a person.' }),
    mention: z.boolean().openapi({ description: 'Mention the asker when reporting.' }),
    at: z.number().int().openapi({ description: 'When it was given.' }),
    active: z.boolean(),
  })
  .openapi('StandingOrder')

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24 hours')

export const HeartbeatConfigSchema = z
  .object({
    enabled: z.boolean().openapi({
      description:
        'Advanced. The monitor runs unless this is false; with no standing order and an empty checklist a beat costs nothing anyway.',
    }),
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

export const HeartbeatPatchSchema = HeartbeatConfigSchema.partial().openapi('HeartbeatPatch')

export const BeatItemSchema = z
  .object({
    kind: z.string(),
    title: z.string(),
    detail: z.string(),
    links: z.array(z.string()),
    urgent: z.boolean(),
    fingerprint: z.string(),
    decision: z.enum(['note', 'report', 'say', 'escalate']).optional().openapi({
      description:
        'What the beat did about it: noted, reported to the destination of an order, or told the owner (`say` is the old word for report).',
    }),
    reason: z
      .string()
      .optional()
      .openapi({ description: 'One line: why (for the owner to audit).' }),
  })
  .openapi('BeatItem')

export const BeatRecordSchema = z
  .object({
    id: z.string().openapi({ description: 'The routine slot of the beat.' }),
    at: z.number().int(),
    endedAt: z.number().int().nullable(),
    status: z.enum(BEAT_STATUSES),
    trigger: z.enum(['schedule', 'activity']).optional().openapi({
      description: 'What started it: the interval (default) or new messages in a watched chat.',
    }),
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
      description: 'false while nothing was ever set: the config is the default.',
    }),
    orders: z.array(StandingOrderSchema).openapi({
      description:
        'The standing orders: lines of `HEARTBEAT.md` the agent keeps when a person gives it an ongoing instruction in chat. Oldest first.',
    }),
    checklist: z.object({
      path: z.string().openapi({ description: 'A memory file of the agent.' }),
      exists: z.boolean(),
      empty: z.boolean().openapi({
        description: 'No order and only headings and comments: the beat is skipped, no model call.',
      }),
    }),
    watched: z.array(z.object({ nodeId: z.string(), title: z.string() })).openapi({
      description: 'The chats whose new messages wake the beat and are counted for it.',
    }),
    notes: z.object({ path: z.string(), exists: z.boolean() }).openapi({
      description: "Today's observation notes (a library file, team timezone).",
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
