/**
 * The HTTP app: an OpenAPIHono root with `/openapi.json` (OpenAPI 3.1 generated from the zod
 * schemas), `/docs` (Scalar), bearer-token auth and one error shape
 * `{ error: { code, message } }` (docs/plans/P32-team-example.md §5).
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { HTTPException } from 'hono/http-exception'
import { checkBearer, originAllowed } from '../app/auth.ts'
import { DomainError } from '../app/errors.ts'
import type { Deps } from '../app/ports.ts'
import { agentRoutes } from './routes/agents.ts'
import { chatRoutes } from './routes/chat.ts'
import { connectorRoutes } from './routes/connectors.ts'
import { type HarnessFetch, harnessRoutes } from './routes/harness.ts'
import { healthRoutes } from './routes/health.ts'
import { libraryRoutes } from './routes/library.ts'
import { logRoutes } from './routes/logs.ts'
import { modeRoutes } from './routes/modes.ts'
import { providerRoutes } from './routes/providers.ts'
import { routineRoutes } from './routes/routines.ts'
import { settingsRoutes } from './routes/settings.ts'
import { taskRoutes } from './routes/tasks.ts'
import { uploadRoutes } from './routes/uploads.ts'

export interface AppOptions {
  deps: Deps
  /** `TEAM_TOKEN`; absent or empty = open (localhost only). */
  token?: string | undefined
  /**
   * Origins allowed to send state-changing requests that carry an `Origin` header (the web app and
   * this server's own public origin). Absent: the check is off (tests).
   */
  allowedOrigins?: readonly string[] | undefined
  /** `eharness/http` (`infra/eh/harness-http.ts`): chat, sessions, attention answers, activity. */
  harness: HarnessFetch
}

export const OPENAPI_INFO = {
  title: 'eharness team server',
  version: '0.1.0',
  description:
    'Team-agent server built on eharness (docs/plans/P32-team-example.md). Bearer token auth when TEAM_TOKEN is set; open otherwise.',
} as const

/** The OpenAPI document header; shared with `scripts/export-openapi.ts`. */
type OpenAPIObjectConfig = Parameters<OpenAPIHono['getOpenAPI31Document']>[0]

export const OPENAPI_DOC: OpenAPIObjectConfig = {
  openapi: '3.1.0',
  info: OPENAPI_INFO,
  tags: [
    { name: 'system', description: 'Health.' },
    { name: 'agents', description: 'Agent definitions (blueprints).' },
    {
      name: 'chats',
      description:
        'Sessions (`eharness/http`): the DM chat `dm:<agentId>` and task sessions: stream, resume, interrupt, history. Plus compact, stats and the tools menu of an agent.',
    },
    { name: 'library', description: 'Shared files: agent artifacts, uploads, version history.' },
    { name: 'memory', description: 'Workspace and per-agent memory files.' },
    { name: 'settings', description: 'Workspace settings read by the agent factory.' },
    {
      name: 'providers',
      description:
        'Model providers: definitions with their form fields, saved profiles (secrets encrypted, never returned), connection tests and model lists with prices and context windows.',
    },
    {
      name: 'routines',
      description: 'Scheduled prompts per agent (multi-instance safe, on the durable inbox).',
    },
    { name: 'tasks', description: 'Delegated work across agents (the board).' },
    {
      name: 'approvals',
      description:
        'Approvals and questions waiting for a person, across sessions: the list and `POST /attention/{id}/answer`.',
    },
    {
      name: 'logs',
      description: 'Model call log: every provider call with timing, tokens, cost and payloads.',
    },
    {
      name: 'events',
      description: 'The feed of changes (`eharness/http` activity): JSON and SSE.',
    },
  ],
}

const STATUS = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 } as const

/** HTTP status of eharness error codes that reach the route as exceptions (spec 10). */
const EH_STATUS: Record<string, number> = {
  EH_SESSION_BUSY: 409,
  EH_SESSION_CLOSED: 409,
  EH_PENDING_RESPONSE: 409,
  EH_INVALID_INPUT: 400,
  EH_STORAGE: 503,
  // the lock service is down (not contention, which is EH_SESSION_BUSY): "storage unavailable"
  EH_LOCK_UNAVAILABLE: 503,
  EH_PROVIDER_AUTH: 502,
  EH_PROVIDER: 502,
  EH_COMPACTION_FAILED: 502,
}

/** Paths that need no token. */
const PUBLIC = new Set(['/health', '/openapi.json', '/docs', '/oauth/callback'])

export function createApp(options: AppOptions): OpenAPIHono {
  const app = new OpenAPIHono({
    // request validation failures use the same error shape
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: result.error.issues
                .map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`)
                .join('; '),
              details: result.error.issues,
            },
          },
          400,
        )
      }
    },
  })

  app.openAPIRegistry.registerComponent('securitySchemes', 'Bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'The value of TEAM_TOKEN. Not required when the server runs without one.',
  })

  app.use('*', async (c, next) => {
    if (
      options.allowedOrigins !== undefined &&
      !originAllowed(c.req.method, c.req.header('origin'), options.allowedOrigins)
    ) {
      return c.json(
        { error: { code: 'FORBIDDEN_ORIGIN', message: 'cross-origin request refused' } },
        403,
      )
    }
    return next()
  })

  app.use('*', async (c, next) => {
    if (PUBLIC.has(c.req.path)) return next()
    if (!checkBearer(options.token, c.req.header('authorization'))) {
      return c.json(
        { error: { code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' } },
        401,
      )
    }
    return next()
  })

  app.onError((error, c) => {
    if (error instanceof DomainError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        STATUS[error.kind],
      )
    }
    // the validator reports a malformed body as an HTTPException with its own status
    if (error instanceof HTTPException) {
      return c.json({ error: { code: 'BAD_REQUEST', message: error.message } }, error.status as 400)
    }
    // a malformed JSON body surfaces as a SyntaxError from the validator
    if (error instanceof SyntaxError) {
      return c.json(
        { error: { code: 'INVALID_JSON', message: 'request body is not valid JSON' } },
        400,
      )
    }
    // eharness errors carry a code: busy / closed are conflicts, invalid input a bad request
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('EH_')) {
      const status = EH_STATUS[code] ?? 500
      if (code === 'EH_PROVIDER_AUTH') {
        // safe text, and the hint that fixes it
        return c.json(
          {
            error: {
              code,
              message: 'The model provider rejected the API key. Set it in Settings > Providers.',
            },
          },
          502,
        )
      }
      if (status >= 500) {
        // storage and provider failures may carry SQL or upstream text: log it, answer generically
        console.error(error)
        return c.json({ error: { code, message: 'internal server error' } }, status as 500)
      }
      return c.json({ error: { code, message: error.message } }, status as 400)
    }
    console.error(error)
    return c.json({ error: { code: 'INTERNAL', message: 'internal server error' } }, 500)
  })

  app.notFound((c) =>
    c.json(
      { error: { code: 'NOT_FOUND', message: `no route: ${c.req.method} ${c.req.path}` } },
      404,
    ),
  )

  app.route(
    '/',
    healthRoutes(() => options.deps.clock.now()),
  )
  app.route('/', agentRoutes(options.deps))
  app.route('/', modeRoutes(options.deps))
  app.route('/', chatRoutes(options.deps))
  app.route('/', harnessRoutes(options.harness))
  app.route('/', uploadRoutes(options.deps))
  app.route('/', taskRoutes(options.deps))
  app.route('/', libraryRoutes(options.deps))
  app.route('/', settingsRoutes(options.deps))
  app.route('/', providerRoutes(options.deps))
  app.route('/', connectorRoutes(options.deps))
  app.route('/', routineRoutes(options.deps))
  app.route('/', logRoutes(options.deps))

  app.doc31('/openapi.json', OPENAPI_DOC)
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: OPENAPI_INFO.title }))
  return app
}
