/**
 * `sessionContext` plugin (docs/plans/P52-context-and-orders.md): read-only tools that let an agent
 * recover what was said or decided in its other chats and runs.
 *
 *  - `sessions_search`  browse the recent sessions, or search the text of messages
 *  - `session_read`     one session: compaction summary plus a window of messages
 *  - `runs_list`        program / routine / task runs with status and report
 *  - `run_read`         one run: status, error and retry, report, decisions and their answers
 *
 * Every session kind gets the same four tools (stable tool order); what a call may read is decided
 * by `decideAccess` (`domain/session-context.ts`) from the requester of the turn: owner/admin and the
 * web app read everything of the agent, a member or guest in a chat reads only that chat, a program
 * run reads its own lineage and what its brief names, a heartbeat reads its agent's sessions
 * (web chats only when an order names them). Everything shown is framed as untrusted data.
 * Every tool returns text, including refusals.
 */
import type { Database } from 'bun:sqlite'
import { tool } from 'ai'
import {
  definePlugin,
  errorText,
  type HarnessContext,
  type HarnessPlugin,
  untrustedContent,
} from 'eharness'
import { z } from 'zod'
import type { AgentDef } from '../../domain/agents.ts'
import { originOfSession } from '../../domain/run-profiles.ts'
import {
  type Access,
  type AccessScope,
  type AccessTarget,
  CONTEXT_KINDS,
  carriesPlatformId,
  clip,
  decideAccess,
  OTHER_AGENT_REASON,
  parsePlatformMessageId,
  queryTerms,
  RUN_READ_TOOL,
  RUNS_LIST_TOOL,
  renderMessage,
  SESSION_READ_TOOL,
  SESSIONS_SEARCH_TOOL,
  type StoredMessage,
  sessionRefsIn,
  snippetAround,
  stamp,
} from '../../domain/session-context.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import { SessionContextStore, type SessionInfo } from './session-context-store.ts'

export interface SessionContextOptions {
  sqlite: Database
  /** The agent of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => AgentDef | undefined
  /** An agent by id or slug (the `agent` argument of a lead or owner). */
  agentByRef?: (ref: string) => AgentDef | undefined
  /** Late-bound: the plugin is built before the gateway. */
  gateway?: () => ChannelGateway | undefined
  timezone?: () => string
  /**
   * Session ids the standing orders of an agent reference: the heartbeat may read those web chats
   * too (`canReadForHeartbeat`). The heartbeat module supplies it; absent = none.
   */
  heartbeatRefs?: (agentId: string) => readonly string[]
}

const when = z
  .string()
  .optional()
  .describe('A date (YYYY-MM-DD, in the team timezone) or an ISO date-time.')

const searchSchema = z.object({
  query: z
    .string()
    .max(300)
    .optional()
    .describe(
      'Words that must all occur in a message (quote a phrase). Without it the call lists your recent sessions. A platform message number ("12345") works too: it is in the header of chat messages.',
    ),
  kind: z.enum(CONTEXT_KINDS).optional().describe('Only sessions of this kind.'),
  chat: z
    .string()
    .optional()
    .describe('Only the session of a chat or topic: part of its name, or its node id.'),
  since: when,
  until: when,
  context: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe('Messages shown before and after each hit (default 2).'),
  limit: z.number().int().min(1).max(20).optional().describe('Sessions to show (default 6 / 15).'),
  agent: z
    .string()
    .optional()
    .describe("Another agent's sessions (slug or id); only the lead or an owner may."),
})

const readSchema = z.object({
  session: z
    .string()
    .optional()
    .describe(
      'Session id (from sessions_search or runs_list), or the name of a chat. Default: this session.',
    ),
  around: z
    .string()
    .optional()
    .describe('A message id of that session: show the window around it.'),
  platform_message: z
    .string()
    .optional()
    .describe(
      'The number of a message in a chat session, e.g. "12345" for "pesan 12345": show the window around it.',
    ),
  latest: z
    .number()
    .int()
    .min(1)
    .max(60)
    .optional()
    .describe('Show the last N messages (default 20).'),
  before: z
    .number()
    .int()
    .min(0)
    .max(40)
    .optional()
    .describe('Messages before the anchor (default 8).'),
  after: z
    .number()
    .int()
    .min(0)
    .max(40)
    .optional()
    .describe('Messages after the anchor (default 8).'),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(8000)
    .optional()
    .describe('Characters of each message to show (default 1500).'),
})

const runsSchema = z.object({
  kind: z.enum(['program', 'routine', 'task', 'delegated']).optional(),
  status: z
    .enum([
      'queued',
      'needs_action',
      'running',
      'retrying',
      'done',
      'failed',
      'stopped',
      'interrupted',
      'timed_out',
    ])
    .optional(),
  program: z.string().optional().describe('A program id or part of its name.'),
  since: when,
  until: when,
  limit: z.number().int().min(1).max(50).optional().describe('Default 12.'),
  agent: z.string().optional().describe("Another agent's runs; only the lead or an owner may."),
})

const runSchema = z.object({
  run: z.string().min(1).describe('A task id or a session id (from runs_list).'),
})

export const SESSIONS_SEARCH_DESCRIPTION =
  'Find what was said or decided in your OTHER chats and runs (other web chats, group chats, program runs, routines, tasks, the heartbeat). Without a query: your recent sessions with kind, name, last activity and a preview. With a query: the messages whose text has all the words, grouped per session, each hit with a snippet and the messages around it, plus the summary of the session when it was compacted. Use it before saying you do not know: when a standing order, a person or a program refers to something from another chat ("as agreed in the Crew group", "message 12345"), find it here, then open the session with session_read. Read-only; what you may see depends on who is asking.'
export const SESSION_READ_DESCRIPTION =
  'Read one session of yours: the summary of its earlier part (when it was compacted) and a window of messages: around a message id, around a chat message number (platform_message, e.g. "12345" for "pesan 12345"), or the latest N. The answer names the ids to continue from, so you can scroll older or newer. Tool calls are shown compactly (name, state, short result), files as references. Use it to recover the exact words and decisions of another chat or a run.'
export const RUNS_LIST_DESCRIPTION =
  'List your program, routine and task runs: status (including retrying and failed, with the error), start and end, and the summary of the report. Filter by kind, status, program or time. Use it to see what your runs did and whether they failed, to compare a program across days, and to find the session of a run (open it with session_read).'
export const RUN_READ_DESCRIPTION =
  'Read one run: status, error and retry state, what it was asked, its report (summary, outputs, notes), the decisions and escalations it raised and how the client answered them, and its session id (open the conversation with session_read). Use it to learn why a run failed or what was decided about it.'

const DAY = 86_400_000

/** A date or date-time of the team zone as epoch ms; undefined when it is not one. */
export function parseWhen(
  value: string | undefined,
  zone: string,
  end = false,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const v = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const utc = Date.parse(`${v}T00:00:00Z`)
    if (Number.isNaN(utc)) return undefined
    const shown = Date.parse(`${stamp(utc, zone).replace(' ', 'T')}:00Z`)
    return utc - (shown - utc) + (end ? DAY : 0)
  }
  const at = Date.parse(v)
  return Number.isNaN(at) ? undefined : at
}

const frame = (text: string, name: string): string =>
  untrustedContent(text, { source: 'session_context', name })

const dayLine = (at: number | null, zone: string): string => (at === null ? '-' : stamp(at, zone))

/** The tools of one session (exported for tests). */
export function sessionContextTools(
  options: SessionContextOptions,
  caller: { sessionId: string; hasParent: boolean; agentSlug: string },
): Record<string, unknown> {
  const store = new SessionContextStore(options.sqlite)
  const zone = (): string => options.timezone?.() ?? 'UTC'
  const self = options.agentOf(caller.agentSlug)
  const origin = originOfSession(caller.sessionId, caller.hasParent)

  interface Resolved {
    scope: AccessScope
    ownerAsking: boolean
  }

  /** Who is asking, as an access scope. */
  async function resolve(): Promise<Resolved> {
    const sid = caller.sessionId
    const agentId = self?.id ?? ''
    if (origin === 'heartbeat') {
      return {
        scope: { kind: 'heartbeat', refs: options.heartbeatRefs?.(agentId) ?? [] },
        ownerAsking: false,
      }
    }
    if (origin === 'program' || origin === 'rehearsal') {
      const programId = /^(?:program|rehearsal):([^:]+):/.exec(sid)?.[1]
      const brief = programId === undefined ? undefined : store.programBrief(programId)
      return {
        scope: {
          kind: 'unattended',
          lineage:
            programId === undefined ? [sid] : [`program:${programId}:`, `rehearsal:${programId}:`],
          refs: sessionRefsIn(brief ?? ''),
        },
        ownerAsking: false,
      }
    }
    if (origin === 'routine') {
      const routineId = /^routine:([^:]+):/.exec(sid)?.[1]
      const prompt = routineId === undefined ? undefined : store.routinePrompt(routineId)
      return {
        scope: {
          kind: 'unattended',
          lineage: routineId === undefined ? [sid] : [`routine:${routineId}:`],
          refs: sessionRefsIn(prompt ?? ''),
        },
        ownerAsking: false,
      }
    }
    if (origin === 'task') {
      const taskId = /^task:([^:]+):/.exec(sid)?.[1]
      const brief = taskId === undefined ? undefined : store.taskBrief(taskId)
      return {
        scope: {
          kind: 'unattended',
          lineage: taskId === undefined ? [sid] : [`task:${taskId}:`],
          refs: sessionRefsIn(brief ?? ''),
        },
        ownerAsking: false,
      }
    }
    // a person's chat: the web app (the owner) or a chat channel (the directory role of the sender)
    const gw = options.gateway?.()
    const conversation = gw?.conversationOf(sid)
    const requester = await gw?.requesterOf(sid).catch(() => undefined)
    // the owner typed it in the web app, also into a chat thread: the web owner's full scope
    if ((conversation === undefined && requester === undefined) || gw?.webTurn(sid) === true) {
      return { scope: { kind: 'full', crossAgent: true }, ownerAsking: true }
    }
    if (requester !== undefined && (requester.role === 'owner' || requester.role === 'admin')) {
      return {
        scope: { kind: 'full', crossAgent: true },
        ownerAsking: requester.role === 'owner',
      }
    }
    // member, guest, or a chat turn whose sender is not known: this conversation only
    const nodes = [conversation?.nodeId, conversation?.node.id, requester?.nodeId].filter(
      (n): n is string => n !== undefined,
    )
    return { scope: { kind: 'chat', nodes: store.nodeFamily(nodes) }, ownerAsking: false }
  }

  const callerIs = (): { agentId: string; isLead: boolean } => ({
    agentId: self?.id ?? '',
    isLead: self?.role === 'lead',
  })

  const targetOf = (info: SessionInfo, scope: AccessScope): AccessTarget => ({
    sessionId: info.sessionId,
    agentId: info.agentId === '' ? undefined : info.agentId,
    kind: info.kind,
    nodeIds: info.nodeIds,
    ...(scope.kind === 'chat' ? { postedNodes: store.postedNodes(info.sessionId) } : {}),
  })

  /** The agent a call is about: itself, or (lead / owner) another. */
  function agentArg(
    arg: string | undefined,
    r: Resolved,
  ): { ok: true; agentId: string; name: string } | { ok: false; text: string } {
    if (self === undefined) return { ok: false, text: 'ERROR: unknown agent.' }
    if (arg === undefined || arg === self.id || arg === self.slug) {
      return { ok: true, agentId: self.id, name: self.name }
    }
    const other = options.agentByRef?.(arg)
    if (other === undefined) return { ok: false, text: `ERROR: there is no agent "${arg}".` }
    const verdict: Access = decideAccess(
      r.scope,
      callerIs(),
      { sessionId: '', agentId: other.id, kind: 'web' },
      { ownerAsking: r.ownerAsking },
    )
    return verdict.ok
      ? { ok: true, agentId: other.id, name: other.name }
      : { ok: false, text: verdict.reason === '' ? OTHER_AGENT_REASON : verdict.reason }
  }

  const sessionLine = (s: SessionInfo): string =>
    `- ${s.sessionId} | ${s.kind} | "${s.title.replace(/\s+/g, ' ')}" | last ${dayLine(s.lastAt, zone())}${
      s.preview === '' ? '' : ` | ${clip(s.preview.replace(/\s+/g, ' '), 100)}`
    }`

  const showMessages = (
    messages: StoredMessage[],
    mark: string | undefined,
    maxChars: number,
  ): string =>
    messages
      .map((m) => renderMessage(m, { zone: zone(), maxChars, mark: m.id === mark }))
      .join('\n')

  async function search(input: z.infer<typeof searchSchema>): Promise<string> {
    const r = await resolve()
    const who = agentArg(input.agent, r)
    if (!who.ok) return who.text
    const since = parseWhen(input.since, zone())
    const until = parseWhen(input.until, zone(), true)
    const listed = store.sessionsOf(who.agentId, {
      kind: input.kind,
      chat: input.chat,
      since,
      until,
      limit: 400,
    })
    const allowed: SessionInfo[] = []
    let hidden = 0
    for (const s of listed) {
      const verdict = decideAccess(r.scope, callerIs(), targetOf(s, r.scope), {
        ownerAsking: r.ownerAsking,
      })
      if (verdict.ok) allowed.push(s)
      else hidden++
    }
    const privacy =
      hidden > 0
        ? `\n(${hidden} other session(s) are not shown: they are private to their participants.)`
        : ''
    const query = input.query?.trim() ?? ''
    if (query === '') {
      const rows = allowed.slice(0, input.limit ?? 15)
      if (rows.length === 0) return `No sessions to show.${privacy}`
      return `Recent sessions of ${who.name} (newest activity first). Open one with session_read.\n${frame(
        rows.map(sessionLine).join('\n'),
        'sessions',
      )}${privacy}`
    }
    const terms = queryTerms(query)
    const byId = new Map(allowed.map((s) => [s.sessionId, s]))
    const hits = store.search([...byId.keys()], terms, { since, until })
    if (hits.length === 0) {
      return `No message of ${allowed.length} searched session(s) has all of: ${terms.join(', ')}. Try fewer or different words, a wider time range, or without the chat filter.${privacy}`
    }
    const grouped = new Map<string, typeof hits>()
    for (const h of hits) {
      const list = grouped.get(h.sessionId) ?? []
      list.push(h)
      grouped.set(h.sessionId, list)
    }
    const context = input.context ?? 2
    const blocks: string[] = []
    for (const [sessionId, list] of [...grouped].slice(0, input.limit ?? 6)) {
      const info = byId.get(sessionId) as SessionInfo
      const lines = [
        `## ${sessionId} | ${info.kind} | "${info.title.replace(/\s+/g, ' ')}" | last ${dayLine(info.lastAt, zone())} | ${list.length} hit(s)`,
      ]
      const summary = store.compactionSummary(sessionId)
      if (summary !== undefined) lines.push(`Summary of its earlier part: ${clip(summary, 700)}`)
      for (const h of list.slice(0, 3)) {
        lines.push(
          `Hit ${h.message.id} (${stamp(h.message.createdAt, zone())} ${h.message.role}): ${snippetAround(h.text, terms)}`,
        )
        if (context > 0) {
          const window = [
            ...store.before(sessionId, h.message.id, context),
            h.message,
            ...store.after(sessionId, h.message.id, context),
          ]
          lines.push(showMessages(window, h.message.id, 400))
        }
      }
      if (list.length > 3) lines.push(`(+${list.length - 3} more hit(s) in this session)`)
      lines.push(`Open: session_read { session: "${sessionId}", around: "${list[0]?.message.id}" }`)
      blocks.push(lines.join('\n'))
    }
    return `${grouped.size} session(s) match${grouped.size > (input.limit ?? 6) ? ` (first ${input.limit ?? 6} shown)` : ''}.\n${frame(
      blocks.join('\n\n'),
      'search',
    )}${privacy}`
  }

  async function read(input: z.infer<typeof readSchema>): Promise<string> {
    const r = await resolve()
    const ref = input.session?.trim() || caller.sessionId
    let info = store.sessionInfo(ref)
    if (info === undefined) {
      // a chat name instead of an id: resolve it among the sessions the caller may see
      const candidates = store
        .sessionsOf(self?.id ?? '', { chat: ref, limit: 10 })
        .filter(
          (s) =>
            decideAccess(r.scope, callerIs(), targetOf(s, r.scope), { ownerAsking: r.ownerAsking })
              .ok,
        )
      if (candidates.length === 1)
        info = store.sessionInfo((candidates[0] as SessionInfo).sessionId)
      else if (candidates.length > 1) {
        return `"${ref}" names several sessions; pick one:\n${frame(candidates.map(sessionLine).join('\n'), 'sessions')}`
      }
    }
    if (info === undefined) {
      return `ERROR: no session "${ref}" has stored messages. Find the id with sessions_search or runs_list.`
    }
    const verdict = decideAccess(r.scope, callerIs(), targetOf(info, r.scope), {
      ownerAsking: r.ownerAsking,
    })
    if (!verdict.ok) return verdict.reason
    const sessionId = info.sessionId
    const maxChars = input.max_chars ?? 1500
    let anchor = input.around
    if (input.platform_message !== undefined) {
      const id = parsePlatformMessageId(input.platform_message) ?? input.platform_message.trim()
      const found = store.findPlatformMessage(sessionId, id, carriesPlatformId)
      if (found === undefined) {
        return `No message #${id} appears in session ${sessionId}. It may be in another chat's session, or older than what was stored (use sessions_search with the number).`
      }
      anchor = found.id
    }
    let messages: StoredMessage[]
    let how: string
    if (anchor !== undefined) {
      const center = store.message(sessionId, anchor)
      if (center === undefined) return `ERROR: session ${sessionId} has no message ${anchor}.`
      messages = [
        ...store.before(sessionId, anchor, input.before ?? 8),
        center,
        ...store.after(sessionId, anchor, input.after ?? 8),
      ]
      how = `around ${anchor}`
    } else {
      messages = store.latest(sessionId, input.latest ?? 20)
      how = `the latest ${messages.length}`
    }
    const head = `Session ${sessionId} | ${info.kind} | "${info.title.replace(/\s+/g, ' ')}" | showing ${how}.`
    const summary = store.compactionSummary(sessionId)
    const first = store.first(sessionId)
    const firstShown = messages[0]
    const lastShown = messages[messages.length - 1]
    const body = [
      summary === undefined
        ? undefined
        : `Summary of the earlier part (compacted):\n${clip(summary, 4000)}`,
      messages.length === 0 ? '(no messages)' : showMessages(messages, anchor, maxChars),
    ]
      .filter((x) => x !== undefined)
      .join('\n\n')
    const nav = [
      firstShown !== undefined && first !== undefined && firstShown.id !== first.id
        ? `Older: session_read { session: "${sessionId}", around: "${firstShown.id}", after: 0 }`
        : 'This is the start of the session.',
      lastShown === undefined
        ? undefined
        : `Newer: session_read { session: "${sessionId}", around: "${lastShown.id}", before: 0 }`,
    ]
      .filter((x) => x !== undefined)
      .join('\n')
    return `${head}\n${frame(body, sessionId)}\n${nav}`
  }

  const runLine = (run: ReturnType<SessionContextStore['run']> & object): string => {
    const retry = ['retrying', 'failed'].includes(run.status)
      ? store.retry(run.sessionId)
      : undefined
    return `- ${run.taskId} | ${run.kind}${run.programName === null ? '' : ` "${run.programName}"`} | "${run.title.replace(/\s+/g, ' ')}" | ${run.status} | started ${dayLine(run.startedAt, zone())}${
      run.endedAt === null ? '' : `, ended ${dayLine(run.endedAt, zone())}`
    } | session ${run.sessionId}${
      run.report === null && run.summary === null
        ? ''
        : ` | ${clip((run.report?.summary ?? run.summary ?? '').replace(/\s+/g, ' '), 140)}`
    }${retry === undefined ? '' : ` | ${retry.state} attempt ${retry.attempt}/${retry.maxAttempts}: ${clip(retry.errorMessage.replace(/\s+/g, ' '), 120)}`}`
  }

  async function runs(input: z.infer<typeof runsSchema>): Promise<string> {
    const r = await resolve()
    const who = agentArg(input.agent, r)
    if (!who.ok) return who.text
    const rows = store.runs(who.agentId, {
      kind: input.kind,
      status: input.status,
      program: input.program,
      since: parseWhen(input.since, zone()),
      until: parseWhen(input.until, zone(), true),
      limit: 200,
    })
    const shown: typeof rows = []
    let hidden = 0
    for (const run of rows) {
      const info: SessionInfo = {
        sessionId: run.sessionId,
        agentId: run.agentId,
        kind: run.kind,
        title: run.title,
        nodeIds: [],
        nodeTitles: [],
        lastAt: 0,
        preview: '',
      }
      const verdict = decideAccess(r.scope, callerIs(), targetOf(info, r.scope), {
        ownerAsking: r.ownerAsking,
      })
      if (verdict.ok) shown.push(run)
      else hidden++
    }
    const limited = shown.slice(0, input.limit ?? 12)
    const note =
      hidden > 0 ? `\n(${hidden} other run(s) are not shown: not yours to read here.)` : ''
    if (limited.length === 0) return `No runs to show.${note}`
    return `Runs of ${who.name}, newest first. Open one with run_read.\n${frame(limited.map(runLine).join('\n'), 'runs')}${note}`
  }

  async function runRead(input: z.infer<typeof runSchema>): Promise<string> {
    const r = await resolve()
    const run = store.run(input.run.trim())
    if (run === undefined) return `ERROR: no run "${input.run}". List runs with runs_list.`
    const info: SessionInfo = {
      sessionId: run.sessionId,
      agentId: run.agentId,
      kind: run.kind,
      title: run.title,
      nodeIds: [],
      nodeTitles: [],
      lastAt: 0,
      preview: '',
    }
    const verdict = decideAccess(r.scope, callerIs(), targetOf(info, r.scope), {
      ownerAsking: r.ownerAsking,
    })
    if (!verdict.ok) return verdict.reason
    const z = zone()
    const lines: string[] = [
      `Run ${run.taskId} | ${run.kind}${run.programName === null ? '' : ` of program "${run.programName}"`} | ${run.status}${run.pendingKind === null ? '' : ` (waiting: ${run.pendingKind})`}`,
      `Title: ${run.title}`,
      `Started ${dayLine(run.startedAt, z)}${run.endedAt === null ? ', not ended' : `, ended ${dayLine(run.endedAt, z)}`}; cost $${run.costUsd.toFixed(4)}`,
    ]
    const retry = store.retry(run.sessionId)
    if (retry !== undefined) {
      lines.push(
        `Retry: ${retry.state}, attempt ${retry.attempt} of ${retry.maxAttempts}${retry.state === 'pending' ? `, next at ${dayLine(retry.nextAt, z)}` : ''}; last error ${retry.errorCode}: ${clip(retry.errorMessage, 500)}`,
      )
    }
    if (run.report !== null) {
      lines.push(
        `Report (${run.report.status}): ${clip(run.report.summary, 1500)}`,
        run.report.outputs.length > 0
          ? `Outputs: ${run.report.outputs.join(', ')}`
          : 'Outputs: none',
        run.report.notes === undefined ? '' : `Notes: ${clip(run.report.notes, 800)}`,
      )
    } else if (run.summary !== null) lines.push(`Summary: ${clip(run.summary, 1500)}`)
    if (run.brief !== null && run.brief !== '') lines.push(`Brief: ${clip(run.brief, 1200)}`)
    const decisions = store.decisions(run.sessionId)
    for (const d of decisions) {
      lines.push(
        `Decision ${d.id} (${d.kind}, ${d.status}): ${d.title}${d.body === '' ? '' : ` - ${clip(d.body.replace(/\s+/g, ' '), 600)}`}`,
        d.decidedAt === null
          ? '  Not answered yet.'
          : `  Answered ${dayLine(d.decidedAt, z)} by ${d.decidedBy ?? 'the client'}${d.decisionNote === null || d.decisionNote === '' ? '' : `: ${clip(d.decisionNote, 600)}`}`,
      )
    }
    return `${lines[0]}\n${frame(
      lines
        .slice(1)
        .filter((l) => l !== '')
        .join('\n'),
      run.taskId,
    )}\nConversation of this run: session_read { session: "${run.sessionId}" }`
  }

  const guard =
    <I, O extends Promise<string>>(fn: (input: I) => O) =>
    async (input: I): Promise<string> => {
      try {
        return await fn(input)
      } catch (error) {
        return `ERROR: could not read: ${errorText(error)}`
      }
    }

  return {
    [SESSIONS_SEARCH_TOOL]: tool({
      description: SESSIONS_SEARCH_DESCRIPTION,
      inputSchema: searchSchema,
      metadata: { risk: 'read', idempotent: true },
      execute: guard(search),
    }),
    [SESSION_READ_TOOL]: tool({
      description: SESSION_READ_DESCRIPTION,
      inputSchema: readSchema,
      metadata: { risk: 'read', idempotent: true },
      execute: guard(read),
    }),
    [RUNS_LIST_TOOL]: tool({
      description: RUNS_LIST_DESCRIPTION,
      inputSchema: runsSchema,
      metadata: { risk: 'read', idempotent: true },
      execute: guard(runs),
    }),
    [RUN_READ_TOOL]: tool({
      description: RUN_READ_DESCRIPTION,
      inputSchema: runSchema,
      metadata: { risk: 'read', idempotent: true },
      execute: guard(runRead),
    }),
  }
}

export function sessionContext(options: SessionContextOptions): HarnessPlugin<'session-context'> {
  return definePlugin({
    name: 'session-context',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      return {
        tools: sessionContextTools(options, {
          sessionId: ctx.session.id,
          hasParent: ctx.session.parent !== undefined,
          agentSlug: ctx.agent.id,
        }) as never,
      }
    },
  })
}
