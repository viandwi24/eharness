/**
 * Developer API use cases (docs/plans/P56-developer-api.md): API agents and keys for the owner, and
 * the `/v1` side for the developers who call with a key (auth, limits, one-shot runs, stored
 * conversations). The model side is a port (`ApiRuntime`, `infra/eh/api-agents.ts`).
 */
import {
  type ApiAgent,
  type ApiAgentDraft,
  type ApiConversation,
  type ApiKey,
  type ApiKeyDraft,
  type ApiMode,
  type ApiRequestRow,
  base64Bytes,
  bearerOf,
  cleanDraft,
  cleanKeyDraft,
  generateKey,
  hashKey,
  IMAGE_MEDIA_TYPES,
  type ImageMediaType,
  keyIdOf,
  MAX_CONTEXT_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_INPUT_CHARS,
  REQUEST_LOG_RETENTION_DAYS,
  sameHash,
  utcDayStart,
} from '../domain/developer-api.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'

export type { ApiKey }
export { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES }

/** An error of the `/v1` side: its own status (401, 403, 404, 409, 429, ...) and a readable message. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

// --- ports -----------------------------------------------------------------------------------

export interface ApiAgentStore {
  list(includeArchived: boolean): ApiAgent[]
  /** By id or slug. */
  get(idOrSlug: string): ApiAgent | undefined
  insert(agent: ApiAgent): void
  update(agent: ApiAgent): void
}

export interface ApiKeyStore {
  get(id: string): ApiKey | undefined
  list(): ApiKey[]
  insert(key: ApiKey): void
  update(key: ApiKey): void
  /** Does any live key (not revoked, not expired) list this browser origin? */
  originKnown(origin: string, now: number): boolean
}

export interface ApiCallRecord {
  id: string
  at: number
  keyId: string
  agentId: string
  requestId: string
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UsageTotals {
  requests: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export interface UsageDay {
  /** Start of the UTC day, epoch ms. */
  day: number
  requests: number
  costUsd: number
}

export interface ApiRequestFilter {
  keyId?: string | undefined
  agentId?: string | undefined
  limit: number
  /** Rows older than this `at`. */
  before?: number | undefined
}

export interface ApiUsageStore {
  logRequest(row: ApiRequestRow): void
  finishRequest(
    id: string,
    patch: Pick<
      ApiRequestRow,
      'status' | 'errorCode' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'durationMs'
    >,
  ): void
  requests(filter: ApiRequestFilter): ApiRequestRow[]
  /** One model call, tagged with the key (written by the runtime hook). */
  recordCall(call: ApiCallRecord): void
  /** USD of the model calls of a key since `since` (the daily limit counts these). */
  costSince(keyId: string, since: number): number
  /** Admitted requests of a key since `since` (the rate limit counts these). */
  requestsSince(keyId: string, since: number): number
  totals(keyId: string | undefined, since: number): UsageTotals
  days(keyId: string | undefined, since: number): UsageDay[]
  pruneRequests(olderThan: number): number
}

export interface ApiConversationStore {
  insert(c: ApiConversation): void
  get(id: string): ApiConversation | undefined
  findOpen(agentId: string, keyId: string, endUserId: string): ApiConversation | undefined
  update(c: ApiConversation): void
  /** Conversations of an agent whose last message is older than `before`. */
  idle(agentId: string, before: number): ApiConversation[]
  delete(id: string): void
}

export interface RunSummary {
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Why the turn stopped (`complete`, `cost-cap`, `error`, ...). */
  stop: string
  errorCode?: string | undefined
}

export interface ApiRunRequest {
  agent: ApiAgent
  keyId: string
  requestId: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * Images of the last user message, in order (validated: type, base64, size). Held in memory for
   * the run only: never stored or logged.
   */
  images?: RunImage[] | undefined
  /** Untrusted extra facts. */
  context?: Record<string, unknown> | undefined
  outputSchema?: Record<string, unknown> | undefined
  signal?: AbortSignal | undefined
}

export interface ApiMessageRequest {
  agent: ApiAgent
  keyId: string
  requestId: string
  conversation: ApiConversation
  text: string
  signal?: AbortSignal | undefined
}

export interface ApiHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: number | null
}

/** The model side (`infra/eh/api-agents.ts`). */
export interface ApiRuntime {
  run(req: ApiRunRequest): Promise<{ output: unknown; summary: RunSummary }>
  /** The turn as a UI message stream (AI SDK format); `done` settles when it is stored. */
  stream(req: ApiMessageRequest): Promise<{ response: Response; done: Promise<RunSummary> }>
  /** The turn as text. */
  reply(req: ApiMessageRequest): Promise<{ text: string; summary: RunSummary }>
  history(
    agent: ApiAgent,
    conversation: ApiConversation,
    page: { limit: number; before?: string | undefined },
  ): Promise<{ messages: ApiHistoryMessage[]; nextBefore?: string | undefined }>
  /** Delete the stored messages of a conversation. */
  purge(agent: ApiAgent, conversation: ApiConversation): void
}

// --- the service -----------------------------------------------------------------------------

export interface DeveloperApiDeps {
  agents: ApiAgentStore
  keys: ApiKeyStore
  usage: ApiUsageStore
  conversations: ApiConversationStore
  runtime: ApiRuntime
  now?: () => number
  newId?: () => string
}

export interface KeyView extends Omit<ApiKey, 'hash'> {
  /** USD spent today (UTC) and requests in the last minute. */
  today: { costUsd: number; requests: number }
  /** Totals of the last 30 days. */
  month: UsageTotals
}

export interface RunImage {
  mediaType: ImageMediaType
  /** Standard base64, without a `data:` prefix. */
  data: string
}

export interface RunBody {
  input: string | Array<{ role: 'user' | 'assistant'; content: string }>
  context?: Record<string, unknown> | undefined
  outputSchema?: Record<string, unknown> | undefined
  images?: Array<{ mediaType: string; data: string }> | undefined
}

export interface RunResponse {
  output: unknown
  usage: { inputTokens: number; outputTokens: number }
  costUsd: number
}

export function createDeveloperApi(deps: DeveloperApiDeps) {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => crypto.randomUUID())
  const DAY = 86_400_000

  const needAgent = (id: string): ApiAgent => {
    const a = deps.agents.get(id)
    if (a === undefined) throw notFound('API agent', id)
    return a
  }

  const view = (k: ApiKey): KeyView => {
    const { hash: _hash, ...rest } = k
    const t = now()
    return {
      ...rest,
      today: {
        costUsd: deps.usage.costSince(k.id, utcDayStart(t)),
        requests: deps.usage.requestsSince(k.id, t - 60_000),
      },
      month: deps.usage.totals(k.id, t - 30 * DAY),
    }
  }

  /** Slugs of a key must name API agents that exist. */
  const checkAgents = (slugs: string[]): string[] =>
    slugs.map((s) => {
      const a = deps.agents.get(s)
      if (a === undefined || a.archivedAt !== null) throw invalid(`unknown API agent: ${s}`)
      return a.slug
    })

  // --- owner: agents -------------------------------------------------------------------------

  const owner = {
    listAgents: (includeArchived = false): ApiAgent[] => deps.agents.list(includeArchived),
    getAgent: needAgent,
    createAgent(draft: ApiAgentDraft): ApiAgent {
      const c = cleanDraft(draft)
      if (deps.agents.get(c.slug) !== undefined) {
        throw conflict(`an API agent with the slug "${c.slug}" exists`, 'SLUG_TAKEN')
      }
      const t = now()
      const agent: ApiAgent = {
        id: newId(),
        ...c,
        version: 1,
        archivedAt: null,
        createdAt: t,
        updatedAt: t,
      }
      deps.agents.insert(agent)
      return agent
    },
    updateAgent(idOrSlug: string, patch: Partial<ApiAgentDraft>): ApiAgent {
      const cur = needAgent(idOrSlug)
      const merged = cleanDraft({
        slug: cur.slug,
        name: cur.name,
        description: cur.description,
        instructions: cur.instructions,
        rules: cur.rules,
        model: cur.model,
        modelProfile: cur.modelProfile,
        readFolders: cur.readFolders,
        writeFolder: cur.writeFolder,
        webSearch: cur.webSearch,
        retentionDays: cur.retentionDays,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      })
      const next: ApiAgent = { ...cur, ...merged, version: cur.version + 1, updatedAt: now() }
      deps.agents.update(next)
      return next
    },
    /** Archive: the agent stops answering; its keys keep the slug. */
    archiveAgent(idOrSlug: string): ApiAgent {
      const cur = needAgent(idOrSlug)
      const next: ApiAgent = {
        ...cur,
        archivedAt: now(),
        version: cur.version + 1,
        updatedAt: now(),
      }
      deps.agents.update(next)
      return next
    },

    // --- owner: keys -------------------------------------------------------------------------

    listKeys: (): KeyView[] => deps.keys.list().map(view),
    async createKey(draft: ApiKeyDraft): Promise<{ key: string; view: KeyView }> {
      const c = cleanKeyDraft(draft)
      const agents = checkAgents(c.agents)
      const g = await generateKey()
      const record: ApiKey = {
        id: g.id,
        name: c.name,
        hash: g.hash,
        agents,
        dailyCostLimitUsd: c.dailyCostLimitUsd,
        rateLimitPerMin: c.rateLimitPerMin,
        origins: c.origins,
        expiresAt: c.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: now(),
      }
      deps.keys.insert(record)
      return { key: g.key, view: view(record) }
    },
    updateKey(id: string, patch: Partial<ApiKeyDraft>): KeyView {
      const cur = deps.keys.get(id)
      if (cur === undefined) throw notFound('API key', id)
      const c = cleanKeyDraft({
        name: cur.name,
        agents: cur.agents,
        dailyCostLimitUsd: cur.dailyCostLimitUsd,
        rateLimitPerMin: cur.rateLimitPerMin,
        origins: cur.origins,
        expiresAt: cur.expiresAt,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      })
      const next: ApiKey = { ...cur, ...c, agents: checkAgents(c.agents) }
      deps.keys.update(next)
      return view(next)
    },
    revokeKey(id: string): KeyView {
      const cur = deps.keys.get(id)
      if (cur === undefined) throw notFound('API key', id)
      if (cur.revokedAt !== null) return view(cur)
      const next: ApiKey = { ...cur, revokedAt: now() }
      deps.keys.update(next)
      return view(next)
    },
    requests: (filter: ApiRequestFilter): ApiRequestRow[] => deps.usage.requests(filter),
    usage(keyId: string | undefined, days: number): { totals: UsageTotals; days: UsageDay[] } {
      const since = utcDayStart(now()) - (days - 1) * DAY
      return { totals: deps.usage.totals(keyId, since), days: deps.usage.days(keyId, since) }
    },
  }

  // --- /v1: auth and limits ------------------------------------------------------------------

  /** The key of a request, or `ApiError` 401 (the same answer for every kind of failure). */
  async function authenticate(authorization: string | undefined): Promise<ApiKey> {
    const bad = new ApiError(
      401,
      'INVALID_API_KEY',
      'Missing, invalid, expired or revoked API key.',
    )
    const given = bearerOf(authorization)
    const id = given === undefined ? undefined : keyIdOf(given)
    if (given === undefined || id === undefined) throw bad
    const key = deps.keys.get(id)
    // hash even when the id is unknown: no timing difference between "no such key" and "wrong secret"
    const hash = await hashKey(given)
    if (key === undefined || !sameHash(hash, key.hash)) throw bad
    if (key.revokedAt !== null) throw bad
    if (key.expiresAt !== null && key.expiresAt <= now()) throw bad
    return key
  }

  /** The agent a key may call: unknown, archived and not-allowed all read as 404. */
  function agentOfKey(key: ApiKey, slug: string): ApiAgent {
    const agent = deps.agents.get(slug)
    if (agent === undefined || agent.archivedAt !== null || !key.agents.includes(agent.slug)) {
      throw new ApiError(404, 'AGENT_NOT_FOUND', `No API agent "${slug}" for this key.`)
    }
    return agent
  }

  function checkLimits(key: ApiKey): void {
    const t = now()
    if (key.rateLimitPerMin !== null) {
      const recent = deps.usage.requestsSince(key.id, t - 60_000)
      if (recent >= key.rateLimitPerMin) {
        throw new ApiError(
          429,
          'RATE_LIMITED',
          `Rate limit reached: this key allows ${key.rateLimitPerMin} requests per minute. Try again in a minute.`,
          60,
        )
      }
    }
    if (key.dailyCostLimitUsd !== null) {
      const day = utcDayStart(t)
      const spent = deps.usage.costSince(key.id, day)
      if (spent >= key.dailyCostLimitUsd) {
        throw new ApiError(
          429,
          'DAILY_COST_LIMIT',
          `Daily cost limit reached: this key may spend $${key.dailyCostLimitUsd.toFixed(2)} per day (UTC) and has spent $${spent.toFixed(4)}. It resets at 00:00 UTC.`,
          Math.max(1, Math.ceil((day + DAY - t) / 1000)),
        )
      }
    }
  }

  /** Admit a request: limits, then a log row (it counts for the rate limit from now on). */
  function admit(key: ApiKey, agent: ApiAgent, mode: ApiMode, conversationId?: string): string {
    try {
      checkLimits(key)
    } catch (e) {
      // a turned-away request is logged too (status 429), but does not count against the limits
      if (e instanceof ApiError) {
        deps.usage.logRequest({
          id: newId(),
          at: now(),
          keyId: key.id,
          agentId: agent.id,
          mode,
          conversationId: conversationId ?? null,
          status: e.status,
          errorCode: e.code,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: 0,
        })
      }
      throw e
    }
    const id = newId()
    deps.usage.logRequest({
      id,
      at: now(),
      keyId: key.id,
      agentId: agent.id,
      mode,
      conversationId: conversationId ?? null,
      status: 0,
      errorCode: null,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
    })
    deps.keys.update({ ...key, lastUsedAt: now() })
    return id
  }

  const finish = (
    requestId: string,
    started: number,
    status: number,
    summary?: RunSummary,
    errorCode?: string,
  ): void =>
    deps.usage.finishRequest(requestId, {
      status,
      errorCode: errorCode ?? summary?.errorCode ?? null,
      inputTokens: summary?.inputTokens ?? 0,
      outputTokens: summary?.outputTokens ?? 0,
      costUsd: summary?.costUsd ?? 0,
      durationMs: now() - started,
    })

  /** A run that stopped on the workspace budget is a 429 with a readable message. */
  function stopError(summary: RunSummary): ApiError | undefined {
    if (summary.stop === 'cost-cap') {
      return new ApiError(
        429,
        'WORKSPACE_BUDGET',
        'The workspace budget is used up, so this request was stopped. Ask the owner to raise it.',
      )
    }
    if (summary.stop === 'error') {
      return new ApiError(502, 'AGENT_FAILED', 'The agent could not finish the request. Try again.')
    }
    if (summary.stop === 'output-invalid') {
      return new ApiError(
        502,
        'OUTPUT_INVALID',
        'The agent could not produce an answer that matches outputSchema.',
      )
    }
    return undefined
  }

  const messagesOf = (input: RunBody['input']): ApiRunRequest['messages'] => {
    if (typeof input === 'string') {
      if (input.trim() === '') throw new ApiError(400, 'INVALID_INPUT', 'input must not be empty.')
      if (input.length > MAX_INPUT_CHARS) {
        throw new ApiError(413, 'INPUT_TOO_LARGE', `input is over ${MAX_INPUT_CHARS} characters.`)
      }
      return [{ role: 'user', content: input }]
    }
    if (input.length === 0) throw new ApiError(400, 'INVALID_INPUT', 'input must not be empty.')
    let total = 0
    const out = input.map((m) => {
      if ((m.role as string) !== 'user' && (m.role as string) !== 'assistant') {
        throw new ApiError(400, 'INVALID_INPUT', 'message roles must be "user" or "assistant".')
      }
      total += m.content.length
      return { role: m.role, content: m.content }
    })
    if (total > MAX_INPUT_CHARS) {
      throw new ApiError(413, 'INPUT_TOO_LARGE', `input is over ${MAX_INPUT_CHARS} characters.`)
    }
    if (out.at(-1)?.role !== 'user') {
      throw new ApiError(400, 'INVALID_INPUT', 'the last message must have the role "user".')
    }
    return out
  }

  /** Checks the images of a run; errors never echo image data. */
  const imagesOf = (images: RunBody['images']): RunImage[] => {
    if (images === undefined) return []
    if (images.length > MAX_IMAGES) {
      throw new ApiError(400, 'INVALID_IMAGES', `send at most ${MAX_IMAGES} images.`)
    }
    return images.map((image, i) => {
      if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(image.mediaType)) {
        throw new ApiError(
          400,
          'INVALID_IMAGES',
          `images.${i}.mediaType must be one of ${IMAGE_MEDIA_TYPES.join(', ')}.`,
        )
      }
      // cheap upper bound first, so a huge string is not scanned
      if (Math.floor(image.data.length / 4) * 3 > MAX_IMAGE_BYTES + 2) {
        throw new ApiError(
          413,
          'IMAGE_TOO_LARGE',
          `images.${i} is over ${MAX_IMAGE_BYTES} bytes (1.5 MB).`,
        )
      }
      const bytes = base64Bytes(image.data)
      if (bytes === undefined) {
        throw new ApiError(
          400,
          'INVALID_IMAGES',
          `images.${i}.data is not valid base64 (standard alphabet, padded, no "data:" prefix).`,
        )
      }
      if (bytes > MAX_IMAGE_BYTES) {
        throw new ApiError(
          413,
          'IMAGE_TOO_LARGE',
          `images.${i} is over ${MAX_IMAGE_BYTES} bytes (1.5 MB).`,
        )
      }
      return { mediaType: image.mediaType as ImageMediaType, data: image.data }
    })
  }

  const v1 = {
    authenticate,
    agentOfKey,

    /** Mode A: one-shot. Nothing is stored but the metadata of the request. */
    async run(
      key: ApiKey,
      slug: string,
      body: RunBody,
      signal?: AbortSignal,
    ): Promise<RunResponse> {
      const agent = agentOfKey(key, slug)
      const messages = messagesOf(body.input)
      const images = imagesOf(body.images)
      if (body.context !== undefined && JSON.stringify(body.context).length > MAX_CONTEXT_CHARS) {
        throw new ApiError(
          413,
          'CONTEXT_TOO_LARGE',
          `context is over ${MAX_CONTEXT_CHARS} characters.`,
        )
      }
      if (body.outputSchema !== undefined && body.outputSchema.type !== 'object') {
        throw new ApiError(
          400,
          'INVALID_OUTPUT_SCHEMA',
          'outputSchema must be a JSON Schema with "type": "object".',
        )
      }
      const requestId = admit(key, agent, 'run')
      const started = now()
      try {
        const { output, summary } = await deps.runtime.run({
          agent,
          keyId: key.id,
          requestId,
          messages,
          ...(images.length === 0 ? {} : { images }),
          context: body.context,
          outputSchema: body.outputSchema,
          signal,
        })
        const err = stopError(summary)
        if (err !== undefined) {
          finish(requestId, started, err.status, summary, err.code)
          throw err
        }
        finish(requestId, started, 200, summary)
        return {
          output,
          usage: { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens },
          costUsd: summary.costUsd,
        }
      } catch (e) {
        if (e instanceof ApiError) throw e
        // the model cannot take images: the core refuses before anything runs
        const refused = e as { code?: unknown; details?: { reason?: unknown } }
        if (
          refused.code === 'EH_INVALID_INPUT' &&
          refused.details?.reason === 'unsupported-modality'
        ) {
          const err = new ApiError(400, 'IMAGES_UNSUPPORTED', (e as Error).message)
          finish(requestId, started, err.status, undefined, err.code)
          throw err
        }
        finish(requestId, started, 500, undefined, 'INTERNAL')
        throw e
      }
    },

    /** Mode B: open (or reuse, with an `endUserId`) a conversation. */
    openConversation(
      key: ApiKey,
      body: {
        agent: string
        endUserId?: string | undefined
        metadata?: Record<string, unknown> | undefined
      },
    ): { conversation: ApiConversation; created: boolean } {
      const agent = agentOfKey(key, body.agent)
      const endUserId = body.endUserId?.trim() || null
      if (endUserId !== null && endUserId.length > 200) {
        throw new ApiError(400, 'INVALID_INPUT', 'endUserId is over 200 characters.')
      }
      if (body.metadata !== undefined && JSON.stringify(body.metadata).length > 10_000) {
        throw new ApiError(413, 'METADATA_TOO_LARGE', 'metadata is over 10000 characters.')
      }
      if (endUserId !== null) {
        const open = deps.conversations.findOpen(agent.id, key.id, endUserId)
        if (open !== undefined) return { conversation: open, created: false }
      }
      const t = now()
      const conversation: ApiConversation = {
        id: newId(),
        agentId: agent.id,
        keyId: key.id,
        endUserId,
        metadata: body.metadata ?? {},
        status: 'open',
        createdAt: t,
        updatedAt: t,
        lastMessageAt: t,
      }
      deps.conversations.insert(conversation)
      return { conversation, created: true }
    },

    /** A conversation of this key; any other reads as 404. */
    conversationOf(key: ApiKey, id: string): { conversation: ApiConversation; agent: ApiAgent } {
      const c = deps.conversations.get(id)
      const agent = c === undefined ? undefined : deps.agents.get(c.agentId)
      if (
        c === undefined ||
        agent === undefined ||
        c.keyId !== key.id ||
        agent.archivedAt !== null ||
        !key.agents.includes(agent.slug)
      ) {
        throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'No such conversation for this key.')
      }
      return { conversation: c, agent }
    },

    closeConversation(key: ApiKey, id: string): ApiConversation {
      const { conversation } = v1.conversationOf(key, id)
      const next = { ...conversation, status: 'closed' as const, updatedAt: now() }
      deps.conversations.update(next)
      return next
    },

    /** Delete the conversation and its stored messages. */
    deleteConversation(key: ApiKey, id: string): void {
      const { conversation, agent } = v1.conversationOf(key, id)
      deps.runtime.purge(agent, conversation)
      deps.conversations.delete(conversation.id)
    },

    history(
      key: ApiKey,
      id: string,
      page: { limit: number; before?: string | undefined },
    ): ReturnType<ApiRuntime['history']> {
      const { conversation, agent } = v1.conversationOf(key, id)
      return deps.runtime.history(agent, conversation, page)
    },

    /** Mode B: a message; the answer is a UI message stream, or text when `stream` is false. */
    async message(
      key: ApiKey,
      id: string,
      text: string,
      opts: { stream: boolean; signal?: AbortSignal | undefined },
    ): Promise<
      | { kind: 'stream'; response: Response }
      | { kind: 'json'; text: string; usage: RunResponse['usage']; costUsd: number }
    > {
      const { conversation, agent } = v1.conversationOf(key, id)
      if (conversation.status === 'closed') {
        throw new ApiError(
          409,
          'CONVERSATION_CLOSED',
          'This conversation is closed. Open a new one.',
        )
      }
      if (text.trim() === '') throw new ApiError(400, 'INVALID_INPUT', 'text must not be empty.')
      if (text.length > MAX_INPUT_CHARS) {
        throw new ApiError(413, 'INPUT_TOO_LARGE', `text is over ${MAX_INPUT_CHARS} characters.`)
      }
      const requestId = admit(key, agent, 'conversation', conversation.id)
      const started = now()
      deps.conversations.update({ ...conversation, lastMessageAt: started, updatedAt: started })
      const req: ApiMessageRequest = {
        agent,
        keyId: key.id,
        requestId,
        conversation,
        text,
        signal: opts.signal,
      }
      try {
        if (opts.stream) {
          const { response, done } = await deps.runtime.stream(req)
          void done.then(
            (summary) => finish(requestId, started, stopError(summary)?.status ?? 200, summary),
            () => finish(requestId, started, 500, undefined, 'INTERNAL'),
          )
          return { kind: 'stream', response }
        }
        const { text: answer, summary } = await deps.runtime.reply(req)
        const err = stopError(summary)
        finish(requestId, started, err?.status ?? 200, summary, err?.code)
        if (err !== undefined) throw err
        return {
          kind: 'json',
          text: answer,
          usage: { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens },
          costUsd: summary.costUsd,
        }
      } catch (e) {
        // a busy session (another turn runs) and other failures before the turn: log and rethrow
        if (!(e instanceof ApiError)) {
          const code = (e as { code?: unknown }).code
          finish(
            requestId,
            started,
            code === 'EH_SESSION_BUSY' ? 409 : 500,
            undefined,
            typeof code === 'string' ? code : 'INTERNAL',
          )
        }
        throw e
      }
    },

    /** Browser origin check of a key: no `Origin` header = server to server. */
    originAllowed: (key: ApiKey, origin: string | undefined): boolean =>
      origin === undefined || key.origins.includes(origin),
    /** A preflight carries no key: is the origin listed on any live key? */
    originKnown: (origin: string): boolean => deps.keys.originKnown(origin, now()),
  }

  /**
   * Retention: conversations idle longer than their agent's `retentionDays` are deleted with their
   * messages; the request log keeps 90 days. Returns what was removed.
   */
  function sweep(): { conversations: number; requests: number } {
    const t = now()
    let conversations = 0
    for (const agent of deps.agents.list(true)) {
      for (const c of deps.conversations.idle(agent.id, t - agent.retentionDays * DAY)) {
        deps.runtime.purge(agent, c)
        deps.conversations.delete(c.id)
        conversations += 1
      }
    }
    const requests = deps.usage.pruneRequests(t - REQUEST_LOG_RETENTION_DAYS * DAY)
    return { conversations, requests }
  }

  return { owner, v1, sweep }
}

export type DeveloperApi = ReturnType<typeof createDeveloperApi>
