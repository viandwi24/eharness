/**
 * The team server's use of `eharness/http` (spec 26): chat (`POST /sessions/{id}/chat`, resume,
 * interrupt), session reads, the attention queue answers and the activity feed, all as one
 * `fetch` handler that `http/app.ts` mounts on the Hono app.
 *
 * What is the app's, not the library's:
 *  - the principal is the single OWNER; `authorize` is the bearer check (`app/auth.ts`);
 *  - a session id is a chat thread (`chat:<agentId>:<threadId>` of a thread row, or the first
 *    thread's `dm:<agentId>` / `dm:<slug>`) or the session of a task row: all resolve to the agent
 *    that runs them (`resolve`);
 *  - a thread of an archived agent, or an archived thread, is read-only; task sessions take messages through
 *    `POST /tasks/{id}/messages` (the inbox), not through the chat route;
 *  - question answers (`ask_user_question`) are turned into the tool output with `answerOutput`;
 *  - `DomainError` keeps its status and code (`onError`).
 *
 * The order a request meets the hooks (authorize, validate, session/peek, attention hooks) and
 * why each exists: docs/guides/walkthrough-server.md section 14.
 */
import { HarnessError, isRecord } from 'eharness'
import type { ActivityStore, AttentionAnswer } from 'eharness/activity'
import { ASK_TOOL, answerOutput, pendingQuestions } from 'eharness/ask'
import { createHarnessHttp, type HarnessHttp } from 'eharness/http'
import { checkBearer } from '../../app/auth.ts'
import { OWNER } from '../../app/chat.ts'
import { DomainError } from '../../app/errors.ts'
import type { Actor, AgentRepo, TaskStore, ThreadStore } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { MAX_NOTE_CHARS, userDeclinedText } from '../../domain/approvals.ts'
import { dmSessionId, isDmSession } from '../../domain/chat.ts'
import { notFound } from '../../domain/errors.ts'
import { parseChatSession } from '../../domain/threads.ts'
import type { AgentFactory } from './agent-factory.ts'
import type { TeamService } from './team-service.ts'

export interface TeamHttpOptions {
  factory: AgentFactory
  agents: AgentRepo
  tasks: TaskStore
  /** Chat threads: a `chat:` session exists only for a thread that has a row. */
  threads: ThreadStore
  team: TeamService
  /** The shared event store: the `activity` routes read it, answers append `attention-answered`. */
  activity: ActivityStore
  /** `TEAM_TOKEN`; absent or empty = open. */
  token: string | undefined
  /** Identifies this server process (the `boot` frame of `/activity/stream`). */
  bootId: string
  /** Store poll interval of the activity stream (ms). */
  pollMs?: number
  /** The file parts of a chat message, checked against the library of uploads (throws `DomainError`). */
  checkChatBody: (body: unknown) => Promise<unknown>
  /** Largest request body (chat attachments are base64 data URLs). */
  maxBodyBytes: number
  /**
   * Save "always allow" as a rule of the agent (`scope: 'agent'`) or of every agent (`'all'`): the
   * tool is allowed in all its sessions from now on (still asked where a connector pins it).
   */
  rememberRule?: (agent: AgentDef, toolName: string, scope: 'agent' | 'all') => void
}

const STATUS = { invalid: 400, not_found: 404, conflict: 409, forbidden: 403 } as const

const json = (status: number, code: string, message: string, details?: unknown): Response =>
  new Response(
    JSON.stringify({ error: { code, message, ...(details === undefined ? {} : { details }) } }),
    { status, headers: { 'content-type': 'application/json' } },
  )

/** A refused answer body (`EH_INVALID_INPUT`: 400 with the library's error shape). */
const invalidAnswer = (message: string): HarnessError =>
  new HarnessError('EH_INVALID_INPUT', message, { details: { reason: 'answer' } })

export function createTeamHttp(options: TeamHttpOptions): HarnessHttp {
  const { factory, agents, tasks, team } = options

  /** The agent that runs a session, and the canonical id (`dm:<slug>` is accepted for `dm:<id>`). */
  const resolve = (sessionId: string): { def: AgentDef; id: string } | undefined => {
    // a background worker belongs to the agent of the session that started it
    const worker = sessionId.lastIndexOf(':worker:')
    if (worker > 0) {
      const parent = resolve(sessionId.slice(0, worker))
      return parent === undefined ? undefined : { def: parent.def, id: sessionId }
    }
    const chat = parseChatSession(sessionId)
    if (chat !== undefined && !chat.child && chat.threadId !== null) {
      // a `chat:` id of a thread that was never created is not a session
      const thread = options.threads.getBySession(sessionId)
      const def = thread === undefined ? undefined : agents.get(thread.agentId)
      return def === undefined ? undefined : { def, id: sessionId }
    }
    if (sessionId.startsWith('channel:')) {
      // a channel conversation exists only as a thread row (`infra/channels`)
      const thread = options.threads.getBySession(sessionId)
      const def = thread === undefined ? undefined : agents.get(thread.agentId)
      return def === undefined ? undefined : { def, id: sessionId }
    }
    if (isDmSession(sessionId)) {
      const key = sessionId.slice('dm:'.length)
      const def = agents.get(key) ?? agents.getBySlug(key)
      return def === undefined ? undefined : { def, id: dmSessionId(def.id) }
    }
    const task = tasks.getBySession(sessionId)
    const def = task === undefined ? undefined : agents.get(task.agentId)
    return def === undefined ? undefined : { def, id: sessionId }
  }
  const need = (sessionId: string): { def: AgentDef; id: string } => {
    const found = resolve(sessionId)
    if (found === undefined) throw notFound('session', sessionId)
    return found
  }

  /** `ask_user_question` answers (`{ kind: 'question', answers }`); everything else is the library's. */
  const parseAnswer = (call: {
    item?: { kind: string; toolCallId: string; toolName: string; input: unknown }
    body: unknown
    defaultParse(): AttentionAnswer
  }): AttentionAnswer | undefined => {
    const answer = isRecord(call.body) ? call.body.answer : undefined
    if (isRecord(answer) && answer.kind === 'approval' && answer.approved === false) {
      // a note on a declined call reaches the model as the user's own words (D4)
      const parsed = call.defaultParse()
      if (parsed.kind !== 'approval') return parsed
      const note = [parsed.reason, parsed.note].filter((t): t is string => !!t?.trim()).join('\n\n')
      const { note: _note, reason: _reason, ...rest } = parsed
      return note === '' ? parsed : { ...rest, reason: userDeclinedText(note) }
    }
    if (!isRecord(answer) || answer.kind !== 'question') return undefined
    const { answers } = answer
    if (answers !== null && !Array.isArray(answers)) {
      throw invalidAnswer('answers must be an array or null.')
    }
    const item = call.item
    // not pending any more: any answer works, the library reports `not-found` / `already-answered`
    if (item === undefined) return { kind: 'client-tool', output: '' }
    if (item.toolName !== ASK_TOOL) throw invalidAnswer(`${item.toolCallId} is not a question.`)
    const question = pendingQuestions({
      approvals: [],
      clientTools: [{ toolCallId: item.toolCallId, toolName: item.toolName, input: item.input }],
      externals: [],
    } as never)[0]
    if (question === undefined) throw invalidAnswer('the question is not readable.')
    const out = answerOutput(question, answers === null ? null : { answers })
    return 'output' in out
      ? { kind: 'client-tool', output: out.output }
      : { kind: 'client-tool', errorText: out.errorText }
  }

  const http = createHarnessHttp<Actor>(undefined, {
    authorize: ({ request }) =>
      checkBearer(options.token, request.headers.get('authorization') ?? undefined)
        ? OWNER
        : { deny: 401, code: 'UNAUTHORIZED', message: 'missing or invalid bearer token' },
    maxBodyBytes: options.maxBodyBytes,

    session: async (id) => {
      const { def, id: sessionId } = need(id)
      await factory.prepare(def)
      return factory.openSession(def, sessionId)
    },
    // a pure read: no session.start hooks, nothing resumes (agent.peek). On the agent that runs
    // the session, so `busy()` knows a turn of this very process (`local`) from another instance's
    peek: async (id) => {
      const { def, id: sessionId } = need(id)
      await factory.prepare(def)
      return factory.agentFor(def, sessionId).peek(sessionId)
    },

    chat: {
      // the web steers by default; a client that wants a 409 asks for `reject`
      ifBusy: ['reject', 'steer'],
      defaultIfBusy: 'steer',
      actorOf: (principal) => ({
        id: principal.id,
        ...(principal.name === undefined ? {} : { name: principal.name }),
      }),
      maxTextBytes: 1024 * 1024,
      // attachments are `library:///uploads/...` references checked by `checkChatBody`; nothing else
      // than `data:` and these references may reach the model (no client-chosen http URLs)
      allowFileUrls: (url) => url.protocol === 'library:',
      authorizeKind: ({ sessionId }) => {
        if (!isDmSession(sessionId)) {
          return json(
            409,
            'TASK_SESSION',
            'A task session takes messages through POST /tasks/{id}/messages.',
          )
        }
        const found = resolve(sessionId)
        const def = found?.def
        if (def?.archivedAt !== null && def !== undefined) {
          return json(409, 'AGENT_ARCHIVED', `agent is archived: ${def.slug}`)
        }
        if (found !== undefined && options.threads.getBySession(found.id)?.archivedAt != null) {
          return json(409, 'THREAD_ARCHIVED', 'this chat is archived: restore it to continue')
        }
        return undefined
      },
      // the attachments of the message: allowlist, `library:` references (may normalise the body)
      validate: async ({ body }) => {
        const checked = await options.checkChatBody(body)
        return checked === body ? undefined : { body: checked as typeof body }
      },
    },

    attention: {
      roots: () => team.attentionRoots(),
      peek: (id) => factory.peek(id),
      // opens the session on the agent that runs it (a child of the lead runs on its own agent)
      open: async (id) => {
        const { def, id: sessionId } = need(id)
        await factory.prepare(def)
        return factory.openSession(def, sessionId)
      },
      decorate: (item) => team.decorateAttention(item),
      // the continuation of a lead's own question / approval ended: reports that arrived meanwhile
      // (no held wake, e.g. stored before a restart) wake it now
      onSettled: ({ sessionId, result }) =>
        result?.stop === 'complete' ? team.afterLeadAnswer(sessionId) : undefined,
      allowRemember: true,
      maxNoteChars: MAX_NOTE_CHARS,
      // one owner sees and answers everything
      canAnswer: () => true,
      parseAnswer,
      store: options.activity,
    },

    activity: {
      store: options.activity,
      bootId: options.bootId,
      filter: () => 'all',
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    },

    onError: (error) => {
      if (!(error instanceof DomainError)) return undefined
      return json(STATUS[error.kind], error.code, error.message, error.details)
    },
    onFailure: (error) => console.error(error),
  })

  /**
   * "Always allow" (D3 of the e2e pass). The library records the grant for later steps; the calls
   * of the same tool that already wait in this very batch are answered with it now, so one click
   * clears the cards of the turn. The body may carry `scope`: `session` (default), `agent` (a rule
   * of this agent, all its sessions) or `all` (a rule of every agent). The siblings are answered
   * first, the answer that was sent last, so it is the one that resumes the session.
   */
  async function answerWithGrant(request: Request): Promise<Response> {
    const match = /\/attention\/([^/]+)\/answer$/.exec(new URL(request.url).pathname)
    if (request.method !== 'POST' || match === null) return http.fetch(request)
    let body: unknown
    try {
      body = await request.clone().json()
    } catch {
      return http.fetch(request)
    }
    const answer = isRecord(body) ? body.answer : undefined
    if (
      !isRecord(body) ||
      !isRecord(answer) ||
      answer.kind !== 'approval' ||
      answer.approved !== true ||
      typeof body.sessionId !== 'string'
    ) {
      return http.fetch(request)
    }
    const scope = answer.scope
    if (scope !== undefined && scope !== 'session' && scope !== 'agent' && scope !== 'all') {
      return json(400, 'EH_INVALID_INPUT', "scope must be 'session', 'agent' or 'all'")
    }
    const wantsGrant = answer.remember === 'session' || scope === 'agent' || scope === 'all'
    if (!wantsGrant) return http.fetch(request)
    const sessionId = body.sessionId
    const id = decodeURIComponent(match[1] as string)
    // the library only knows `remember: 'session'`: a wider scope is the same grant plus a rule
    const { scope: _scope, ...plain } = answer
    const forward = (attentionId: string, payload: Record<string, unknown>): Request =>
      new Request(
        request.url.replace(
          /\/attention\/[^/]+\/answer$/,
          `/attention/${encodeURIComponent(attentionId)}/answer`,
        ),
        {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify({ ...body, answer: payload }),
        },
      )
    try {
      const pending = await factory.peek(sessionId).pending()
      const mine = pending?.approvals.find((a) => a.approvalId === id)
      if (pending !== null && mine !== undefined) {
        for (const sibling of pending.approvals) {
          if (sibling.approvalId === id || sibling.toolName !== mine.toolName) continue
          if (sibling.answer !== undefined || sibling.granted === true) continue
          await http.fetch(forward(sibling.approvalId, { kind: 'approval', approved: true }))
        }
        if (scope === 'agent' || scope === 'all') {
          const found = resolve(sessionId)
          if (found !== undefined) options.rememberRule?.(found.def, mine.toolName, scope)
        }
      }
    } catch (error) {
      console.warn(`team: answering the siblings of an always-allow failed: ${String(error)}`)
    }
    return http.fetch(forward(id, { ...plain, remember: 'session' }))
  }

  return { ...http, fetch: answerWithGrant }
}
