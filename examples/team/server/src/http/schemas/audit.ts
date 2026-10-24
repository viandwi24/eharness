import { z } from '@hono/zod-openapi'

const epoch = z.coerce.number().int().min(0)

/** Filters shared by the list and the CSV export. */
export const AuditFilterQuery = z.object({
  connectionId: z.string().min(1).optional().openapi({ description: 'Only this connection.' }),
  platform: z.string().min(1).optional().openapi({ description: 'The platform, `telegram`.' }),
  transport: z.enum(['bot', 'user']).optional().openapi({
    description: 'The connector kind: `bot` (Bot API) or `user` (a user account).',
  }),
  kind: z.enum(['action', 'read']).optional().openapi({
    description: '`action` = writes and moderation, `read` = lookups. Both when omitted.',
  }),
  action: z.string().min(1).max(100).optional().openapi({
    description: 'The tool or sub-action name (`promote_member`, `telegram_user_manage`, ...).',
  }),
  chat: z.string().min(1).max(200).optional().openapi({
    description: 'A chat: its internal id, or part of its title or of the target the call named.',
  }),
  requester: z.string().min(1).max(200).optional().openapi({
    description: 'Part of the name of the person who asked (`web owner`, `autonomous routine`).',
  }),
  agentId: z.string().min(1).optional().openapi({ description: 'The agent that made the call.' }),
  result: z.enum(['ok', 'error', 'refused', 'rate_limited']).optional(),
  from: epoch.optional().openapi({ description: 'At or after this time (epoch ms).' }),
  to: epoch.optional().openapi({ description: 'At or before this time (epoch ms).' }),
})

export const AuditListQuery = AuditFilterQuery.extend({
  cursor: z.string().min(1).optional().openapi({ description: '`next` of the previous page.' }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const AuditRowSchema = z
  .object({
    id: z.string(),
    at: z.number().int().openapi({ description: 'Epoch ms.' }),
    connectionId: z.string(),
    connectionLabel: z.string(),
    platform: z.string(),
    transport: z.enum(['bot', 'user']).optional(),
    kind: z.enum(['action', 'read']),
    action: z.string(),
    target: z.object({
      chat: z.string().optional(),
      chatId: z.string().optional().openapi({ description: 'Internal id of the chat.' }),
      user: z.string().optional(),
      link: z.string().optional(),
    }),
    requester: z.string().optional(),
    role: z.string().optional(),
    member: z.string().optional(),
    origin: z.string().optional(),
    agentId: z.string().optional(),
    agentName: z.string().optional(),
    sessionId: z.string().optional(),
    summary: z.string().optional().openapi({
      description:
        '`key=value` preview of the parameters; message text appears only as `text=<N chars>`.',
    }),
    result: z.enum(['ok', 'error', 'refused', 'rate_limited']),
    note: z.string().optional(),
    durationMs: z.number().int().optional(),
  })
  .openapi('AuditRow')

export const AuditPageSchema = z
  .object({
    items: z.array(AuditRowSchema).openapi({ description: 'Newest first.' }),
    next: z.string().optional().openapi({ description: 'Pass as `cursor` for older rows.' }),
  })
  .openapi('AuditPage')
