/**
 * The public Developer API (`/v1`, docs/plans/P56-developer-api.md). Its own auth: `Authorization:
 * Bearer ehk_...` (an API key), never the owner's token or cookie. CORS is per key (`origins`).
 * Errors keep the one shape `{ error: { code, message } }`.
 */
import { OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { ApiError, type ApiKey, type DeveloperApi } from '../../app/developer-api.ts'
import { DomainError } from '../../app/errors.ts'
import { requestLimit } from '../body-limit.ts'
import { ErrorSchema } from '../schemas/common.ts'
import {
  V1AgentsSchema,
  V1ConversationCreateSchema,
  V1ConversationSchema,
  V1HistorySchema,
  V1MessageBodySchema,
  V1MessageResponseSchema,
  V1RunBodySchema,
  V1RunResponseSchema,
  V1StreamSchema,
} from '../schemas/developer.ts'

/** Largest request body of `/v1` (the input limit is lower: this only stops absurd bodies early). */
const MAX_V1_BODY = 1024 * 1024

const security = [{ ApiKey: [] }]
const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } })
const errors = {
  400: { description: 'Invalid request', content: json(ErrorSchema) },
  401: { description: 'Missing, invalid, expired or revoked API key', content: json(ErrorSchema) },
  404: { description: 'No such agent or conversation for this key', content: json(ErrorSchema) },
  429: {
    description:
      'Rate limit or daily cost limit of the key, or the workspace budget (`RATE_LIMITED`, `DAILY_COST_LIMIT`, `WORKSPACE_BUDGET`). `Retry-After` says when to try again.',
    content: json(ErrorSchema),
  },
} as const

const failure = (
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

/** Any error of a `/v1` handler as the one error shape (internal details never leave the server). */
function fail(error: unknown): Response {
  if (error instanceof ApiError) {
    return failure(
      error.status,
      error.code,
      error.message,
      error.retryAfterSec === undefined
        ? undefined
        : { 'retry-after': String(error.retryAfterSec) },
    )
  }
  if (error instanceof DomainError) {
    const status = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 }[error.kind]
    return failure(status, error.code, error.message)
  }
  const code = (error as { code?: unknown }).code
  if (code === 'EH_SESSION_BUSY') {
    return failure(
      409,
      'CONVERSATION_BUSY',
      'The agent is still answering the previous message. Wait for it to finish.',
    )
  }
  if (code === 'EH_SESSION_CLOSED')
    return failure(409, 'CONVERSATION_BUSY', 'The conversation is closing. Try again.')
  if (code === 'EH_PROVIDER_AUTH') {
    return failure(502, 'AGENT_FAILED', 'The model provider is not configured. Tell the owner.')
  }
  console.error(error)
  return failure(500, 'INTERNAL', 'internal server error')
}

type Env = { Variables: { key: ApiKey } }

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).host
  } catch {
    return undefined
  }
}

export function v1Routes(api: DeveloperApi): OpenAPIHono<Env> {
  const app = new OpenAPIHono<Env>()
  const { v1 } = api
  const doc = app.openAPIRegistry
  doc.registerComponent('securitySchemes', 'ApiKey', {
    type: 'http',
    scheme: 'bearer',
    description:
      'An API key made on the Developers page: `Authorization: Bearer ehk_...`. Only `/v1` accepts it.',
  })

  const CORS_HEADERS = {
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    'access-control-max-age': '600',
    vary: 'Origin',
  }
  const withCors = (res: Response, origin: string | undefined, allowed: boolean): Response => {
    if (origin === undefined || !allowed) return res
    const headers = new Headers(res.headers)
    headers.set('access-control-allow-origin', origin)
    headers.set('access-control-expose-headers', 'retry-after, x-vercel-ai-ui-message-stream')
    headers.append('vary', 'Origin')
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }

  app.use('/v1/*', requestLimit(MAX_V1_BODY))
  app.use('/v1/*', async (c, next) => {
    const origin = c.req.header('origin')
    if (c.req.method === 'OPTIONS') {
      // a preflight carries no key: answer for the origins some live key lists
      if (origin !== undefined && v1.originKnown(origin)) {
        return new Response(null, {
          status: 204,
          headers: { ...CORS_HEADERS, 'access-control-allow-origin': origin },
        })
      }
      return failure(403, 'ORIGIN_NOT_ALLOWED', 'This origin is not allowed for any API key.')
    }
    let key: ApiKey
    try {
      key = await v1.authenticate(c.req.header('authorization'))
    } catch (e) {
      return withCors(fail(e), origin, origin !== undefined && v1.originKnown(origin))
    }
    // the owner's own web app (same host as the API) may use the Try it console without listing itself
    const sameHost = origin !== undefined && hostOf(origin) === c.req.header('host')
    if (!sameHost && !v1.originAllowed(key, origin)) {
      return failure(
        403,
        'ORIGIN_NOT_ALLOWED',
        "This origin is not allowed for this key. Add it to the key's origins, or call from your server.",
      )
    }
    c.set('key', key)
    await next()
    c.res = withCors(c.res, origin, true)
  })

  /** Parse a JSON body with a schema: a readable 400, never a stack. */
  async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      throw new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.')
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
      )
    }
    return parsed.data
  }
  const keyOf = (c: Context<Env>): ApiKey => c.get('key')
  const param = (c: Context<Env>, name: string): string => c.req.param(name) ?? ''
  const safe =
    (fn: (c: Context<Env>) => Promise<Response> | Response) =>
    async (c: Context<Env>): Promise<Response> => {
      try {
        return await fn(c)
      } catch (e) {
        return fail(e)
      }
    }

  const view = (
    c: {
      id: string
      keyId: string
      endUserId: string | null
      metadata: Record<string, unknown>
      status: 'open' | 'closed'
      createdAt: number
      lastMessageAt: number
    },
    agent: string,
    reused?: boolean,
  ) => ({
    id: c.id,
    agent,
    endUserId: c.endUserId,
    metadata: c.metadata,
    status: c.status,
    createdAt: c.createdAt,
    lastMessageAt: c.lastMessageAt,
    ...(reused === undefined ? {} : { reused }),
  })

  app.get(
    '/v1/agents',
    safe((c) => {
      const key = keyOf(c)
      const agents = api.owner
        .listAgents(false)
        .filter((a) => key.agents.includes(a.slug))
        .map((a) => ({ slug: a.slug, name: a.name, description: a.description }))
      return c.json({ agents })
    }),
  )

  app.post(
    '/v1/agents/:slug/run',
    safe(async (c) => {
      const input = await body(c, V1RunBodySchema)
      const out = await v1.run(keyOf(c), param(c, 'slug'), input, c.req.raw.signal)
      return c.json(out)
    }),
  )

  app.post(
    '/v1/conversations',
    safe(async (c) => {
      const input = await body(c, V1ConversationCreateSchema)
      const { conversation, created } = v1.openConversation(keyOf(c), input)
      return c.json(view(conversation, input.agent, !created), created ? 201 : 200)
    }),
  )

  app.get(
    '/v1/conversations/:id',
    safe((c) => {
      const { conversation, agent } = v1.conversationOf(keyOf(c), param(c, 'id'))
      return c.json(view(conversation, agent.slug))
    }),
  )

  app.post(
    '/v1/conversations/:id/close',
    safe((c) => {
      const closed = v1.closeConversation(keyOf(c), param(c, 'id'))
      const { agent } = v1.conversationOf(keyOf(c), closed.id)
      return c.json(view(closed, agent.slug))
    }),
  )

  app.delete(
    '/v1/conversations/:id',
    safe((c) => {
      v1.deleteConversation(keyOf(c), param(c, 'id'))
      return c.json({ deleted: true })
    }),
  )

  app.get(
    '/v1/conversations/:id/messages',
    safe(async (c) => {
      const limit = Number(c.req.query('limit') ?? '50')
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiError(400, 'INVALID_REQUEST', 'limit must be a whole number from 1 to 200.')
      }
      return c.json(
        await v1.history(keyOf(c), param(c, 'id'), { limit, before: c.req.query('before') }),
      )
    }),
  )

  const sendMessage = safe(async (c) => {
    const input = await body(c, V1MessageBodySchema)
    let text = input.text
    if (text === undefined && input.messages !== undefined) {
      const last = input.messages.findLast((m) => m.role === 'user')
      text =
        last?.content ??
        (last?.parts ?? [])
          .map((p) =>
            (p as { type?: string; text?: string }).type === 'text'
              ? ((p as { text?: string }).text ?? '')
              : '',
          )
          .join('')
    }
    if (text === undefined || text.trim() === '') {
      throw new ApiError(400, 'INVALID_REQUEST', 'send `text` (or the `messages` of useChat).')
    }
    const stream = input.stream ?? c.req.query('stream') !== 'false'
    const out = await v1.message(keyOf(c), param(c, 'id'), text, {
      stream,
      signal: c.req.raw.signal,
    })
    if (out.kind === 'stream') return out.response
    return c.json({ text: out.text, usage: out.usage, costUsd: out.costUsd })
  })
  app.post('/v1/conversations/:id/messages', sendMessage)

  // `eharness/client` (`createHarnessTransport`, baseUrl `<server>/v1`) posts chats to
  // `/sessions/:id/chat`: the same conversation, under the library's route shape
  app.post('/v1/sessions/:id/chat', sendMessage)
  app.get(
    '/v1/sessions/:id/chat/stream',
    safe((c) => {
      v1.conversationOf(keyOf(c), param(c, 'id'))
      // nothing to resume: answers are streamed in the response of the POST
      return new Response(null, { status: 204 })
    }),
  )

  // --- documentation (the handlers above validate with the same schemas) ------------------------
  const ConvId = z.object({
    id: z.string().openapi({
      param: { name: 'id', in: 'path' },
      description: 'Conversation id from `POST /v1/conversations`.',
    }),
  })
  doc.registerPath({
    method: 'get',
    path: '/v1/agents',
    tags: ['v1'],
    summary: 'The API agents this key may call',
    security,
    responses: { 200: { description: 'Agents', content: json(V1AgentsSchema) }, 401: errors[401] },
  })
  doc.registerPath({
    method: 'post',
    path: '/v1/agents/{slug}/run',
    tags: ['v1'],
    summary: 'Mode A: run an agent once',
    description:
      'One-shot: send an input, get an answer. Nothing is stored except metadata (time, key, tokens, cost). With `outputSchema` the answer is validated JSON.\n\n```bash\ncurl -X POST $BASE/v1/agents/support-bot/run \\\n  -H "Authorization: Bearer $EHARNESS_KEY" -H "content-type: application/json" \\\n  -d \'{"input":"Where is order 1042?","context":{"customer":"Acme"}}\'\n```',
    security,
    request: {
      params: z.object({
        slug: z.string().openapi({ param: { name: 'slug', in: 'path' }, example: 'support-bot' }),
      }),
      body: { required: true, content: json(V1RunBodySchema) },
    },
    responses: {
      200: {
        description: 'The answer',
        content: {
          'application/json': {
            schema: V1RunResponseSchema,
            examples: {
              text: {
                summary: 'Text',
                value: {
                  output: 'Order 1042 shipped on Monday.',
                  usage: { inputTokens: 412, outputTokens: 31 },
                  costUsd: 0.0021,
                },
              },
              structured: {
                summary: 'With outputSchema',
                value: {
                  output: { intent: 'shipping', urgent: false },
                  usage: { inputTokens: 380, outputTokens: 22 },
                  costUsd: 0.0018,
                },
              },
            },
          },
        },
      },
      413: { description: 'Input too large', content: json(ErrorSchema) },
      502: {
        description:
          'The agent failed, or its answer never matched `outputSchema` (`OUTPUT_INVALID`)',
        content: json(ErrorSchema),
      },
      ...errors,
    },
  })
  doc.registerPath({
    method: 'post',
    path: '/v1/conversations',
    tags: ['v1'],
    summary: 'Mode B: open a conversation',
    description:
      'Returns `201` for a new conversation, `200` (with `reused: true`) when an open conversation of the same `endUserId` and agent exists for this key.',
    security,
    request: { body: { required: true, content: json(V1ConversationCreateSchema) } },
    responses: {
      200: { description: 'An open conversation was reused', content: json(V1ConversationSchema) },
      201: { description: 'A new conversation', content: json(V1ConversationSchema) },
      ...errors,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/v1/conversations/{id}',
    tags: ['v1'],
    summary: 'A conversation',
    security,
    request: { params: ConvId },
    responses: {
      200: { description: 'The conversation', content: json(V1ConversationSchema) },
      ...errors,
    },
  })
  doc.registerPath({
    method: 'delete',
    path: '/v1/conversations/{id}',
    tags: ['v1'],
    summary: 'Delete a conversation and its messages',
    security,
    request: { params: ConvId },
    responses: {
      200: { description: 'Deleted', content: json(z.object({ deleted: z.boolean() })) },
      ...errors,
    },
  })
  doc.registerPath({
    method: 'post',
    path: '/v1/conversations/{id}/close',
    tags: ['v1'],
    summary: 'Close a conversation',
    description:
      'A closed conversation takes no more messages (`409 CONVERSATION_CLOSED`); its history stays until retention deletes it.',
    security,
    request: { params: ConvId },
    responses: {
      200: { description: 'The closed conversation', content: json(V1ConversationSchema) },
      ...errors,
    },
  })
  doc.registerPath({
    method: 'get',
    path: '/v1/conversations/{id}/messages',
    tags: ['v1'],
    summary: 'The messages of a conversation (newest page, oldest first)',
    description: 'Text only: tool calls and reasoning are never returned.',
    security,
    request: {
      params: ConvId,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z
          .string()
          .optional()
          .openapi({ description: '`nextBefore` of the previous page.' }),
      }),
    },
    responses: { 200: { description: 'A page', content: json(V1HistorySchema) }, ...errors },
  })
  doc.registerPath({
    method: 'post',
    path: '/v1/conversations/{id}/messages',
    tags: ['v1'],
    summary: 'Send a message; the answer streams',
    description:
      'Default: Server-Sent Events in the AI SDK UI message stream format, so `useChat` (`DefaultChatTransport({ api })`) and `eharness/client` can read it. The body may be `{ text }` or what `useChat` sends (`{ messages }`: the last user message is used). With `"stream": false` (or `?stream=false`) the answer is one JSON object.\n\n```bash\ncurl -N -X POST $BASE/v1/conversations/$ID/messages \\\n  -H "Authorization: Bearer $EHARNESS_KEY" -H "content-type: application/json" \\\n  -d \'{"text":"Hello"}\'\n```',
    security,
    request: { params: ConvId, body: { required: true, content: json(V1MessageBodySchema) } },
    responses: {
      200: {
        description: 'A UI message stream, or JSON when `stream` is false',
        content: {
          'text/event-stream': { schema: V1StreamSchema },
          'application/json': { schema: V1MessageResponseSchema },
        },
      },
      409: {
        description:
          'The conversation is closed (`CONVERSATION_CLOSED`) or still answering (`CONVERSATION_BUSY`)',
        content: json(ErrorSchema),
      },
      ...errors,
    },
  })

  return app
}
