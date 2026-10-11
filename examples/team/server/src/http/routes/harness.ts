/**
 * The routes of `eharness/http` (spec 26) on the Hono app: chat, resume and interrupt of a
 * session, session reads, the attention answers and the activity feed. The library is a `fetch`
 * handler: these entries forward to it. The OpenAPI entries are documentation only (the library
 * validates its own requests), so `shared/openapi.json` and the web's generated types cover them.
 */
import { OpenAPIHono, z } from '@hono/zod-openapi'
import { ChatQueuedSchema, ChatRequestSchema, EventStreamSchema } from '../schemas/chat.ts'
import { errorResponses, jsonError } from '../schemas/common.ts'
import {
  AttentionAnsweredSchema,
  AttentionAnswerSchema,
  AttentionListSchema,
  InterruptRequestSchema,
  InterruptResultSchema,
  SessionMessagesPageSchema,
  SessionSnapshotSchema,
} from '../schemas/harness.ts'
import { EventListSchema } from '../schemas/tasks.ts'

/** The module as a `fetch` handler (`createHarnessHttp(...).fetch`). */
export interface HarnessFetch {
  fetch(request: Request): Promise<Response>
}

const security = [{ Bearer: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const sse = { 'text/event-stream': { schema: EventStreamSchema } }
const SessionId = z.object({
  id: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'id', in: 'path' },
      example: 'dm:0198f0a2-0000-7000-8000-000000000000',
      description:
        'Session id: `dm:<agentId>` (the DM chat of an agent; `dm:<slug>` works too) or the `sessionId` of a task.',
    }),
})
const afterQuery = z
  .string()
  .regex(/^\d{1,15}$/)
  .optional()

export function harnessRoutes(harness: HarnessFetch): OpenAPIHono {
  const app = new OpenAPIHono()
  const doc = app.openAPIRegistry

  doc.registerPath({
    method: 'get',
    path: '/sessions/{id}',
    tags: ['chats'],
    summary: 'Stored state of a session (running, active turn, pending items, usage)',
    description:
      '`eharness/http`. A session that does not exist reads as an empty snapshot. `running` is true when a turn runs on any instance.',
    security,
    request: { params: SessionId },
    responses: {
      200: { description: 'The snapshot', content: json(SessionSnapshotSchema) },
      404: jsonError('Unknown agent or task'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/sessions/{id}/messages',
    tags: ['chats'],
    summary: 'Stored messages of a session (paginated, oldest first within the page)',
    description:
      '`eharness/http`. The newest page first: pass `nextBefore` as `before` for older ones.',
    security,
    request: {
      params: SessionId,
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
      200: { description: 'A page', content: json(SessionMessagesPageSchema) },
      404: jsonError('Unknown agent or task'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'post',
    path: '/sessions/{id}/chat',
    tags: ['chats'],
    summary: 'Send a message, answer an approval or regenerate (useChat)',
    description: [
      '`eharness/http` (spec 26 §5). The body is an AI SDK `useChat` request; the response is the UI message stream (`text/event-stream`).',
      '',
      '- **Send**: the last message is a user message. Attachments are `file` parts (`data:` / `https:` URLs, or the `library:///uploads/…` url returned by `POST /library/files`; media type and reference are checked here).',
      '- **Approvals**: a client that posts the assistant message back with the part in `approval-responded` continues into the **same** message id (the web app answers through `POST /attention/{id}/answer` instead). A message none of whose answers is waiting any more is `409 EH_HTTP_ALREADY_ANSWERED`.',
      '- **Regenerate / edit**: `trigger: "regenerate-message"`, or a user message with `messageId`.',
      '- **Idempotency**: the `Idempotency-Key` header, else the user message id; a repeat is `409 EH_HTTP_DUPLICATE_REQUEST` (with `details.active` and the turn).',
      '',
      'Busy policy (`?ifBusy=`, default `steer`): while a turn of this chat runs, a new user message is **steered** into it: on this instance the response follows the running turn; when another instance runs it the message goes through the durable inbox and the route answers `202`. `reject` answers `409 EH_SESSION_BUSY`. Approvals, regenerate and edit never steer: `409`.',
      '',
      'Only DM sessions take chat (a task takes messages through `POST /tasks/{id}/messages`: `409 TASK_SESSION`); an archived agent answers `409 AGENT_ARCHIVED`. Errors after the turn started arrive as an `error` chunk inside the stream.',
    ].join('\n'),
    security,
    request: {
      params: SessionId,
      query: z.object({
        ifBusy: z.enum(['steer', 'reject']).optional().openapi({
          description: 'What a user message does while a turn runs. Default `steer`.',
        }),
      }),
      body: { required: true, content: json(ChatRequestSchema) },
    },
    responses: {
      200: {
        description:
          'The UI message stream of the turn (headers `x-eharness-turn-id`, `x-eharness-session-id`)',
        content: sse,
      },
      202: {
        description: 'Steered into a turn running on another instance',
        content: json(ChatQueuedSchema),
      },
      404: jsonError('Unknown agent'),
      409: jsonError(
        '`EH_SESSION_BUSY`, `EH_SESSION_CLOSED`, `EH_HTTP_ALREADY_ANSWERED`, `EH_HTTP_DUPLICATE_REQUEST`, `AGENT_ARCHIVED`, `TASK_SESSION`',
      ),
      413: jsonError('Request body too large'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/sessions/{id}/chat/stream',
    tags: ['chats'],
    summary: 'Resume the running turn (useChat resume)',
    description:
      '`eharness/http`. Replays the chunks of the active turn from `from` (also `Last-Event-ID`) and follows it until it ends, also when another instance runs it. `204` when nothing streams. Works for task sessions too.',
    security,
    request: {
      params: SessionId,
      query: z.object({
        from: afterQuery.openapi({ description: 'Chunk cursor (0-based). Default 0.' }),
      }),
    },
    responses: {
      200: { description: 'The UI message stream from the cursor', content: sse },
      204: { description: 'No turn is streaming' },
      404: jsonError('Unknown agent or task'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'post',
    path: '/sessions/{id}/interrupt',
    tags: ['chats'],
    summary: 'Stop the running turn (any instance)',
    description: '`eharness/http`. Works for task sessions too.',
    security,
    request: {
      params: SessionId,
      body: { required: false, content: json(InterruptRequestSchema) },
    },
    responses: {
      200: { description: 'Where the interrupt went', content: json(InterruptResultSchema) },
      404: jsonError('Unknown agent or task'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/attention',
    tags: ['approvals'],
    summary: 'The library attention queue (approvals and questions of every session)',
    description:
      '`eharness/http`. The raw `listAttention` items. The web reads `GET /approvals` instead, which adds the agent, the task and the question texts.',
    security,
    responses: {
      200: { description: 'Pending items', content: json(AttentionListSchema) },
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'post',
    path: '/attention/{id}/answer',
    tags: ['approvals'],
    summary: 'Answer an approval or a question',
    description: [
      '`eharness/http`. `respond()` on the session that owns the item, from whichever instance receives the request. A step can raise several approvals at once: each answer is recorded on its own (`status: "recorded"`, `remaining` = items still waiting) and the answer to the last one resumes the session (`status: "resumed"`). Nothing streams: the continuation runs server side and shows in the activity feed.',
      '',
      '- Approval: `{ kind: "approval", approved, reason?, note?, remember? }`. `remember: "session"` grants the tool for the rest of the session. `note` is shown to the model after the result.',
      '- Question: `{ kind: "question", answers }` (one per question, `null` dismisses).',
      '',
      'An item that is gone is `404`; answered elsewhere first is `200 already-answered`; a running turn is `409`.',
    ].join('\n'),
    security,
    request: {
      params: z.object({
        id: z
          .string()
          .min(1)
          .openapi({
            param: { name: 'id', in: 'path' },
            description: 'The `id` of an item of `GET /approvals`.',
          }),
      }),
      body: { required: true, content: json(AttentionAnswerSchema) },
    },
    responses: {
      200: {
        description: 'Recorded, resumed or already answered',
        content: json(AttentionAnsweredSchema),
      },
      404: jsonError('No such pending item'),
      409: jsonError('A turn of the session is running'),
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/activity',
    tags: ['events'],
    summary: 'Events after a cursor (JSON)',
    description:
      '`eharness/http` (`readActivityPage`). Every event of the app and of the sessions, in `seq` order.',
    security,
    request: {
      query: z.object({
        after: afterQuery.openapi({ description: 'Return events with a higher `seq`. Default 0.' }),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
    responses: {
      200: { description: 'Events, oldest first', content: json(EventListSchema) },
      ...errorResponses,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/activity/stream',
    tags: ['events'],
    summary: 'Live event feed (SSE)',
    description:
      '`eharness/http` (`handleActivityStream`): every instance tails the shared events log (poll, 500 ms), so a client connected to instance B sees what instance A did. Starts after `after` (or `Last-Event-ID`); without either it starts at the current head. Frames: `retry` + `: connected` + `event: boot` at once; `resync` when the cursor is behind the retention mark or ahead of the head; `: keep-alive` every 8 s.',
    security,
    request: {
      query: z.object({
        after: afterQuery.openapi({ description: 'Replay events with a higher `seq`.' }),
      }),
    },
    responses: {
      200: {
        description: 'Server-sent events',
        content: { 'text/event-stream': { schema: EventStreamSchema } },
      },
      ...errorResponses,
    },
  })

  const forward = (c: { req: { raw: Request } }): Promise<Response> => harness.fetch(c.req.raw)
  for (const path of [
    '/sessions',
    '/sessions/*',
    '/attention',
    '/attention/*',
    '/activity',
    '/activity/*',
  ]) {
    app.all(path, forward)
  }
  return app
}
