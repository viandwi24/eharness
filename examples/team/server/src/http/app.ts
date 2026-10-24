/**
 * The HTTP app: an OpenAPIHono root with `/openapi.json` (OpenAPI 3.1 generated from the zod
 * schemas), `/docs` (Scalar), bearer-token auth and one error shape
 * `{ error: { code, message } }` (docs/plans/P32-team-example.md §5).
 */
import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { checkBearer, originAllowed } from '../app/auth.ts'
import type { DeveloperApi } from '../app/developer-api.ts'
import { DomainError } from '../app/errors.ts'
import { createLoginAuth, createLoginThrottle, SESSION_COOKIE } from '../app/login.ts'
import type { Deps } from '../app/ports.ts'
import { liveProfileOf, takeLiveTicket } from './live-tickets.ts'
import { agentHealthRoutes } from './routes/agent-health.ts'
import { agentRoutes } from './routes/agents.ts'
import { alarmRoutes } from './routes/alarms.ts'
import { artifactRoutes } from './routes/artifacts.ts'
import { auditRoutes } from './routes/audit.ts'
import { authRoutes } from './routes/auth.ts'
import { backupRoutes } from './routes/backups.ts'
import { browserRoutes } from './routes/browser.ts'
import { channelRoutes } from './routes/channels.ts'
import { chatRoutes } from './routes/chat.ts'
import { connectorRoutes } from './routes/connectors.ts'
import { decisionRoutes } from './routes/decisions.ts'
import { developerRoutes } from './routes/developer.ts'
import { eventRoutes } from './routes/events.ts'
import { type HarnessFetch, harnessRoutes } from './routes/harness.ts'
import { healthRoutes } from './routes/health.ts'
import { heartbeatRoutes } from './routes/heartbeat.ts'
import { libraryRoutes } from './routes/library.ts'
import { logRoutes } from './routes/logs.ts'
import { modeRoutes } from './routes/modes.ts'
import { notificationRoutes } from './routes/notifications.ts'
import { pauseRoutes } from './routes/pause.ts'
import { peopleRoutes } from './routes/people.ts'
import { personaRoutes } from './routes/persona.ts'
import { programRoutes } from './routes/programs.ts'
import { providerRoutes } from './routes/providers.ts'
import { routineRoutes } from './routes/routines.ts'
import { sessionToolsRoutes } from './routes/session-tools.ts'
import { settingsRoutes } from './routes/settings.ts'
import { storageRoutes } from './routes/storage.ts'
import { taskRoutes } from './routes/tasks.ts'
import { threadRoutes } from './routes/threads.ts'
import { triggerRoutes } from './routes/triggers.ts'
import { uploadRoutes } from './routes/uploads.ts'
import { usageRoutes } from './routes/usage.ts'
import { v1Routes } from './routes/v1.ts'

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
  /**
   * The content routes of artifacts (`/art/*`, `infra/artifacts/content.ts`), mounted outside the
   * login and token checks: they carry their own signed tokens or share tokens.
   */
  content?: { fetch: (request: Request) => Response | Promise<Response> } | undefined
  /**
   * The Developer API (docs/plans/P56-developer-api.md): `/developer/*` for the owner and the public
   * `/v1/*` with its own API-key auth and per-key CORS. Absent: neither is mounted.
   */
  developer?: DeveloperApi | undefined
  /**
   * Password login (`BASIC_AUTH_PASSWORD`). Set: every route except `/health` and `/auth/*` needs
   * the `team_session` cookie or the bearer `token`. Unset: no login, behaviour unchanged.
   */
  login?:
    | {
        password: string
        /** Server secret mixed into the session signing key. */
        secret: string
        /** `TEAM_PUBLIC_URL`: an https URL makes the cookie `Secure`. */
        publicUrl?: string | undefined
        /** Believe `X-Forwarded-For` / `X-Forwarded-Proto` (a reverse proxy in front). */
        trustProxy?: boolean | undefined
        now?: (() => number) | undefined
      }
    | undefined
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
      name: 'persona',
      description:
        'The editable persona of an agent: identity, voice, operating rules; versions, proposals and revert.',
    },
    {
      name: 'chats',
      description:
        'Sessions (`eharness/http`): chat thread sessions (`chat:<agentId>:<threadId>`, or `dm:<agentId>` for the first thread of an old agent) and task sessions: stream, resume, interrupt, history. Plus compact, stats and the tools menu of a thread.',
    },
    {
      name: 'threads',
      description:
        'Chat threads per agent, all equal: new chat, rename, archive, and "Discuss in chat" (a new thread seeded with an alert or a run).',
    },
    {
      name: 'notifications',
      description: 'The bell: urgent alerts and the daily digest (one notification per day).',
    },
    { name: 'library', description: 'Shared files: agent artifacts, uploads, version history.' },
    {
      name: 'artifacts',
      description:
        'Generated pages, documents, images, diagrams, tables and code with versions, signed content URLs, exports and public sharing (docs/plans/P45-team-artifacts.md).',
    },
    { name: 'memory', description: 'Workspace and per-agent memory files.' },
    {
      name: 'browser',
      description:
        'Browsers agents drive (docs/plans/P48-browser.md): adapters and their managed runtimes (download, start, stop), profiles with their logins, resource usage, screenshots, and the live view with takeover (a WebSocket).',
    },
    { name: 'settings', description: 'Workspace settings read by the agent factory.' },
    {
      name: 'backups',
      description:
        'Verified snapshots of the whole database and a readable export of every library and memory file; restore of files (new versions, nothing deleted).',
    },
    {
      name: 'storage',
      description:
        'Where the data directory lives and how big each part is (disk, database, library, backups, scratch dirs), warnings, and owner maintenance actions (compact, checkpoint, retention, clear media).',
    },
    {
      name: 'providers',
      description:
        'Model providers: definitions with their form fields, saved profiles (secrets encrypted, never returned), connection tests and model lists with prices and context windows.',
    },
    {
      name: 'routines',
      description: 'Scheduled prompts per agent (multi-instance safe, on the durable inbox).',
    },
    {
      name: 'programs',
      description:
        'Standing orders: what an agent does on its own (brief, enforced authority, gates, budget, trigger), with run history.',
    },
    {
      name: 'decisions',
      description:
        'The Decision Center: proposals (a plan or a program), escalations (a parked run asks) and amendments (a run asks for more authority), decided by the client.',
    },
    {
      name: 'heartbeat',
      description:
        'The ambient monitor of an agent (silent unless something needs the client) and the daily digest of what ran, what waits and what it cost.',
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
    {
      name: 'developer',
      description:
        'The Developers page: API agents (isolated agents other applications call), API keys with limits and origins, the request log and usage (docs/plans/P56-developer-api.md).',
    },
    {
      name: 'v1',
      description:
        'The public Developer API, for other machines: `Authorization: Bearer ehk_...`. Mode A runs an agent once, mode B keeps conversations and streams answers in the AI SDK UI message stream format. Errors: `{ error: { code, message } }`.',
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

/**
 * Open prefixes: artifact content (`/art/`: signed or share tokens, no cookie) and the public share
 * metadata (`/share/<token>`).
 */
const isOpenPrefix = (path: string): boolean =>
  path.startsWith('/art/') || path.startsWith('/share/')

/**
 * `/v1/*` has its own auth (API keys) and CORS (per key): the owner's token, cookie and origin
 * check do not apply to it, and an owner credential does not open it.
 */
const isDeveloperApi = (path: string): boolean => path === '/v1' || path.startsWith('/v1/')

/**
 * Paths that stay open when password login is on: the probe and the login endpoints. The docs, the
 * OpenAPI document and the OAuth callback are protected (the callback is a top-level GET
 * navigation, so the SameSite=Lax session cookie still reaches it).
 */
const PUBLIC_WITH_LOGIN = new Set(['/health', '/auth/login', '/auth/logout', '/auth/session'])

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
    // a sandboxed artifact page has the opaque origin `null`: it never gets to the API, any method
    if (c.req.header('origin') === 'null' && !c.req.path.startsWith('/art/')) {
      return c.json(
        {
          error: {
            code: 'FORBIDDEN_ORIGIN',
            message: 'requests from a sandboxed page are refused',
          },
        },
        403,
      )
    }
    if (isOpenPrefix(c.req.path) || isDeveloperApi(c.req.path)) return next()
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

  const login = options.login?.password
    ? createLoginAuth({
        password: options.login.password,
        secret: options.login.secret,
        ...(options.login.now ? { now: options.login.now } : {}),
      })
    : undefined
  const trustProxy = options.login?.trustProxy === true
  const bearerOk = (c: Context): boolean =>
    options.token !== undefined &&
    options.token !== '' &&
    checkBearer(options.token, c.req.header('authorization'))
  const clientOf = (c: Context): string => {
    if (trustProxy) {
      const first = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      if (first) return first
    }
    const env = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined
    return env?.requestIP?.(c.req.raw)?.address ?? 'unknown'
  }
  const secure = (c: Context): boolean =>
    options.login?.publicUrl?.startsWith('https:') === true ||
    new URL(c.req.url).protocol === 'https:' ||
    (trustProxy && c.req.header('x-forwarded-proto') === 'https')

  app.use('*', async (c, next) => {
    if (isOpenPrefix(c.req.path) || isDeveloperApi(c.req.path)) return next()
    // the live view WebSocket carries a one-time ticket instead of a header (live-tickets.ts)
    const liveProfile = liveProfileOf(c.req.path)
    if (liveProfile !== undefined && takeLiveTicket(c.req.query('ticket'), liveProfile))
      return next()
    if (login) {
      if (PUBLIC_WITH_LOGIN.has(c.req.path)) return next()
      if (bearerOk(c) || (await login.verify(getCookie(c, SESSION_COOKIE)))) return next()
      return c.json({ error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.' } }, 401)
    }
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
    authRoutes({
      login,
      throttle: createLoginThrottle(options.login?.now),
      clientOf,
      secure,
      bearerOk,
    }),
  )
  app.route(
    '/',
    healthRoutes(() => options.deps.clock.now()),
  )
  app.route('/', agentRoutes(options.deps))
  app.route('/', personaRoutes(options.deps))
  app.route('/', modeRoutes(options.deps))
  app.route('/', chatRoutes(options.deps))
  app.route('/', threadRoutes(options.deps))
  app.route('/', notificationRoutes(options.deps))
  app.route('/', alarmRoutes(options.deps))
  app.route('/', sessionToolsRoutes(options.deps))
  app.route('/', harnessRoutes(options.harness))
  app.route('/', uploadRoutes(options.deps))
  app.route('/', taskRoutes(options.deps))
  app.route('/', libraryRoutes(options.deps))
  app.route('/', artifactRoutes(options.deps))
  app.route('/', settingsRoutes(options.deps))
  app.route('/', pauseRoutes(options.deps))
  app.route('/', backupRoutes(options.deps))
  app.route('/', storageRoutes(options.deps))
  app.route('/', usageRoutes(options.deps))
  app.route('/', providerRoutes(options.deps))
  app.route('/', connectorRoutes(options.deps))
  app.route('/', browserRoutes(options.deps, { allowedOrigins: options.allowedOrigins }))
  app.route('/', routineRoutes(options.deps))
  app.route('/', programRoutes(options.deps))
  app.route('/', decisionRoutes(options.deps))
  app.route('/', heartbeatRoutes(options.deps))
  app.route('/', channelRoutes(options.deps))
  app.route('/', peopleRoutes(options.deps))
  app.route('/', logRoutes(options.deps))
  app.route('/', auditRoutes(options.deps))
  app.route('/', eventRoutes(options.deps))
  app.route('/', triggerRoutes(options.deps))
  app.route('/', agentHealthRoutes(options.deps))
  if (options.developer !== undefined) {
    app.route('/', developerRoutes(options.developer))
    app.route('/', v1Routes(options.developer))
  }

  const content = options.content
  if (content !== undefined) app.all('/art/*', (c) => content.fetch(c.req.raw))

  app.doc31('/openapi.json', OPENAPI_DOC)
  // relative: behind the web server the app is mounted under `/api`, so `/api/docs` must read `/api/openapi.json`
  app.get('/docs', Scalar({ url: 'openapi.json', pageTitle: OPENAPI_INFO.title }))
  return app
}
