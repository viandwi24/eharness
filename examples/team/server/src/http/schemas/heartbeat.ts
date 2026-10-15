import { z } from '@hono/zod-openapi'
import {
  BEAT_STATUSES,
  MAX_EVERY_MINUTES,
  MAX_POSTS_PER_DAY,
  MIN_EVERY_MINUTES,
} from '../../app/catalog.ts'

export const HeartbeatDestinationSchema = z
  .object({
    connectionId: z.string().min(1),
    nodeId: z.string().min(1).openapi({ description: 'The conversation (chat or topic) id.' }),
  })
  .openapi('HeartbeatDestination')

export const HeartbeatDestinationViewSchema = HeartbeatDestinationSchema.extend({
  label: z.string().openapi({ description: 'The chat (and topic) name.' }),
  platform: z.string(),
  kind: z.string(),
  proactive: z.boolean().openapi({
    description: 'false: the chat settings do not allow unasked posts, so every post is refused.',
  }),
}).openapi('HeartbeatDestinationView')

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
    mode: z.enum(['off', 'notes', 'speak']).openapi({
      description:
        '`off`: findings only (digest, bell). `notes`: also reads the chats and keeps daily notes, never posts. `speak`: may also post to `reportTo`. Stored configs without it: `speak` with a `reportTo`, else `notes`.',
    }),
    reportTo: HeartbeatDestinationSchema.nullable().openapi({
      description:
        'The one chat or topic (of a connection bound to the agent) the beat may post to, unasked and through the chat proactive policy. null = it never posts.',
    }),
    maxPostsPerDay: z.number().int().min(0).max(MAX_POSTS_PER_DAY).openapi({
      description: 'Posts to `reportTo` per local day; further ones are refused.',
    }),
    wakeOnActivity: z.boolean().openapi({
      description:
        'Also beat early when a watched chat gets new messages (the chats the checklist names, else every group, channel and topic the agent is allowed in).',
    }),
    minGapMinutes: z.number().int().min(1).max(MAX_EVERY_MINUTES).openapi({
      description: 'An early beat starts at the earliest this long after the previous beat.',
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
    decision: z.enum(['note', 'say', 'escalate']).optional().openapi({
      description: 'What the beat did about it: noted, said it in the chat, or told the owner.',
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
      description: 'false while nothing was ever set: the config is the default of the role.',
    }),
    checklist: z.object({
      path: z.string().openapi({ description: 'A memory file of the agent.' }),
      exists: z.boolean(),
      empty: z.boolean().openapi({
        description: 'Only headings and comments: the beat is skipped, no model call.',
      }),
      suggestion: z.string().openapi({
        description: 'A short starting point to insert into the file (never written by itself).',
      }),
    }),
    destinations: z.array(HeartbeatDestinationViewSchema).openapi({
      description: 'The places the beat may report to: postable chats of the agent connections.',
    }),
    watched: z.array(z.object({ nodeId: z.string(), title: z.string() })).openapi({
      description: 'The chats whose new messages wake the beat and are counted for it.',
    }),
    postsToday: z.number().int().openapi({ description: 'Posts to `reportTo` made today.' }),
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
