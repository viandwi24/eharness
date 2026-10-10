import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  abortChat,
  chat,
  chatMessages,
  chatStats,
  compactChat,
  resumeChat,
} from '../../app/chat.ts'
import type { ChatMessage, Deps } from '../../app/ports.ts'
import { MAX_REQUEST_BYTES, requestLimit } from '../body-limit.ts'
import {
  AbortRequestSchema,
  AbortResultSchema,
  ChatQueuedSchema,
  ChatRequestSchema,
  ChatStatsSchema,
  CompactResultSchema,
  EventStreamSchema,
  MessagesPageSchema,
} from '../schemas/chat.ts'
import { errorResponses, IdParam, jsonError } from '../schemas/common.ts'

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const sse = { 'text/event-stream': { schema: EventStreamSchema } }

/** A raw `Response` (a stream, or the core's own 409) satisfies any declared response. */
const raw = (response: Response): never => response as never

const chatRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/chat',
  tags: ['chats'],
  summary: 'Send a message, answer an approval or regenerate (useChat)',
  description: [
    'The body is an AI SDK `useChat` request; the response is the UI message stream (`text/event-stream`).',
    '',
    '- **Send**: the last message is a user message. Attachments are `file` parts (`data:` / `https:` URLs, or the `library:///uploads/…` url returned by `POST /library/files`).',
    '- **Approvals**: when a turn ends with an `approval-requested` tool part, the client posts the assistant message back with the part in `approval-responded` (`addToolApprovalResponse` + `sendAutomaticallyWhen`). The continuation streams into the **same** message id.',
    '- **Regenerate / edit**: `trigger: "regenerate-message"`, or a user message with `messageId`.',
    '',
    'Busy policy: while a turn of this chat runs, a new user message is **steered** into it (`ifBusy=steer`, default): on this instance the response follows the running turn; when another instance runs it the message goes through the durable inbox and the route answers `202`. `ifBusy=reject` answers `409 EH_SESSION_BUSY` instead. Approvals, regenerate and edit never steer: `409`.',
    '',
    'Errors after the turn started (model failure, stale approval answer) arrive as an `error` chunk inside the stream, not as an HTTP status.',
  ].join('\n'),
  security,
  middleware: [requestLimit(MAX_REQUEST_BYTES)] as const,
  request: {
    params: IdParam,
    query: z.object({
      ifBusy: z
        .enum(['steer', 'reject'])
        .optional()
        .openapi({ description: 'What a user message does while a turn runs. Default `steer`.' }),
    }),
    body: { required: true, content: json(ChatRequestSchema) },
  },
  responses: {
    200: {
      description: 'The UI message stream of the turn',
      content: sse,
      headers: z.object({
        'x-vercel-ai-ui-message-stream': z.literal('v1'),
      }),
    },
    202: {
      description: 'Steered into a turn running on another instance',
      content: json(ChatQueuedSchema),
    },
    404: jsonError('Unknown agent'),
    409: jsonError('`EH_SESSION_BUSY`, `EH_SESSION_CLOSED` or archived agent'),
    413: jsonError('Request body too large'),
    ...errorResponses,
  },
})

const resumeRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/chat/stream',
  tags: ['chats'],
  summary: 'Resume the running turn (useChat resume)',
  description:
    'Replays the chunks of the active turn from `from` and follows it until it ends, also when another instance runs it (stream log, ADR-0039). `204` when nothing streams: use the stored messages. A continuation turn after an approval replays only the continuation: refetch the message at the end.',
  security,
  request: {
    params: IdParam,
    query: z.object({
      from: z
        .string()
        .regex(/^\d{1,15}$/)
        .optional()
        .openapi({
          description: 'Chunk cursor (0-based). Also read from `Last-Event-ID`. Default 0.',
        }),
    }),
  },
  responses: {
    200: { description: 'The UI message stream from the cursor', content: sse },
    204: { description: 'No turn is streaming' },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const abortRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/chat/abort',
  tags: ['chats'],
  summary: 'Stop the running turn (any instance)',
  security,
  request: { params: IdParam, body: { required: false, content: json(AbortRequestSchema) } },
  responses: {
    200: { description: 'Where the abort went', content: json(AbortResultSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const messagesRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/messages',
  tags: ['chats'],
  summary: 'Stored messages of the chat (paginated, newest page first)',
  security,
  request: {
    params: IdParam,
    query: z.object({
      before: z.string().optional().openapi({ description: 'Message id: only older messages.' }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(200)
        .default(50)
        .openapi({ description: 'Page size (1-200).' }),
    }),
  },
  responses: {
    200: { description: 'A page, chronological', content: json(MessagesPageSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

const compactRoute = createRoute({
  method: 'post',
  path: '/agents/{id}/compact',
  tags: ['chats'],
  summary: 'Summarise the older part of the chat now',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'The summary, or nothing to compact', content: json(CompactResultSchema) },
    404: jsonError('Unknown agent'),
    409: jsonError('A turn runs (`EH_SESSION_BUSY`) or the agent is archived'),
    ...errorResponses,
  },
})

const statsRoute = createRoute({
  method: 'get',
  path: '/agents/{id}/stats',
  tags: ['chats'],
  summary: 'Context size, usage, active turn and pending approvals',
  security,
  request: { params: IdParam },
  responses: {
    200: { description: 'Session statistics', content: json(ChatStatsSchema) },
    404: jsonError('Unknown agent'),
    ...errorResponses,
  },
})

export function chatRoutes(deps: Deps): OpenAPIHono {
  return new OpenAPIHono()
    .openapi(chatRoute, async (c) => {
      const { id } = c.req.valid('param')
      const { ifBusy } = c.req.valid('query')
      const body = c.req.valid('json')
      const outcome = await chat(
        deps,
        id,
        {
          messages: body.messages as unknown as ChatMessage[],
          ...(body.trigger === undefined ? {} : { trigger: body.trigger }),
          ...(body.messageId === undefined ? {} : { messageId: body.messageId }),
        },
        ifBusy === undefined ? {} : { ifBusy },
      )
      if (outcome.kind === 'queued') {
        return c.json(
          { inboxId: outcome.inboxId, delivered: 'steer' as const, target: outcome.target },
          202,
        )
      }
      return raw(outcome.response)
    })
    .openapi(resumeRoute, async (c) => {
      const { id } = c.req.valid('param')
      return raw(await resumeChat(deps, id, c.req.raw))
    })
    .openapi(abortRoute, async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      return c.json(await abortChat(deps, id, body?.reason), 200)
    })
    .openapi(messagesRoute, async (c) => {
      const { id } = c.req.valid('param')
      const { before, limit } = c.req.valid('query')
      const page = await chatMessages(deps, id, {
        ...(before === undefined ? {} : { before }),
        limit,
      })
      return c.json(page as never, 200)
    })
    .openapi(compactRoute, async (c) => {
      const result = await compactChat(deps, c.req.valid('param').id)
      return c.json(result as never, 200)
    })
    .openapi(statsRoute, async (c) => c.json(await chatStats(deps, c.req.valid('param').id), 200))
}
