/**
 * Read side of the session context tools (docs/plans/P52-context-and-orders.md): the sessions and
 * runs of an agent over plain SQL. Read-only; the privacy decision is not made here.
 *
 * Search backend: a LIKE prefilter over the stored `parts` JSON (every term must occur, the term
 * JSON-escaped), newest messages first, capped at `SCAN_LIMIT` candidates and restricted to the
 * sessions of the agent that pass the caller's privacy scope; then each candidate is verified in
 * code against its real text parts, so JSON syntax, tool output and reasoning never match. FTS5
 * was not used: it needs a shadow index that triggers must keep in sync with the `parts` JSON on
 * every `persistEachStep` upsert, a backfill migration of the whole history, and a migration the
 * example would have to hand-write (drizzle cannot generate virtual tables). LIKE over the recent
 * window of the agent's own sessions is cheap at the size of one team and always correct; the
 * `search` method is the one place to swap for FTS5 later.
 */
import type { Database } from 'bun:sqlite'
import {
  agentOfSessionId,
  type ContextKind,
  contextKindOf,
  hasAllTerms,
  kindOfMessage,
  messageText,
  type StoredMessage,
  type StoredPart,
} from '../../domain/session-context.ts'

const SCAN_LIMIT = 1500
const SESSION_LIMIT = 600

export interface SessionInfo {
  sessionId: string
  agentId: string
  kind: ContextKind
  /** Thread title, chat name or run title. */
  title: string
  /** Channel session: the nodes that own it and where it answered last, with their names. */
  nodeIds: string[]
  nodeTitles: string[]
  /** Last stored message time (epoch ms); 0 when it has none. */
  lastAt: number
  preview: string
}

export interface RunInfo {
  taskId: string
  sessionId: string
  agentId: string
  kind: ContextKind
  title: string
  status: string
  startedAt: number
  endedAt: number | null
  summary: string | null
  report: { status: string; summary: string; outputs: string[]; notes?: string } | null
  costUsd: number
  programId: string | null
  programName: string | null
  brief: string | null
  pendingKind: string | null
}

export interface DecisionInfo {
  id: string
  kind: string
  status: string
  title: string
  body: string
  decidedBy: string | null
  decidedAt: number | null
  decisionNote: string | null
  outcome: unknown
  createdAt: number
}

export interface RetryInfo {
  state: string
  attempt: number
  maxAttempts: number
  nextAt: number
  errorCode: string
  errorMessage: string
}

interface MessageRow {
  id: string
  role: string
  parts: string
  metadata: string | null
  created_at: number
}

const toMessage = (row: MessageRow): StoredMessage => ({
  id: row.id,
  role: row.role,
  parts: JSON.parse(row.parts) as StoredPart[],
  ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
  createdAt: row.created_at,
})

/** The sessions of an agent: threads, channel sessions, runs, the heartbeat and the legacy DM. */
const AGENT_SESSIONS = `
  SELECT session_id, COALESCE(title, 'Chat') AS title, NULL AS node_id, NULL AS last_node_id FROM chat_threads WHERE agent_id = $agent
  UNION ALL SELECT 'dm:' || $agent, 'Chat', NULL, NULL WHERE NOT EXISTS (SELECT 1 FROM chat_threads WHERE session_id = 'dm:' || $agent)
  UNION ALL SELECT 'heartbeat:' || $agent, 'Heartbeat', NULL, NULL
  UNION ALL SELECT session_id, COALESCE(label, ''), node_id, last_node_id FROM ch_node_sessions WHERE agent_id = $agent
  UNION ALL SELECT session_id, title, NULL, NULL FROM tasks WHERE agent_id = $agent AND session_id NOT LIKE 'queued:%'`

const like = (term: string): string =>
  `%${JSON.stringify(term)
    .slice(1, -1)
    .replace(/[\\%_]/g, '\\$&')}%`

export class SessionContextStore {
  constructor(private readonly sqlite: Database) {}

  private nodeTitle(nodeId: string): string {
    const row = this.sqlite
      .query<{ title: string | null; native_id: string }, [string]>(
        'SELECT title, native_id FROM ch_nodes WHERE id = ?',
      )
      .get(nodeId)
    return row === null ? nodeId : (row.title ?? row.native_id)
  }

  /** The node and its ancestors (a topic's room): what "the same chat" means for a member. */
  nodeFamily(nodeIds: readonly string[]): string[] {
    const out = new Set<string>()
    const parent = this.sqlite.query<{ parent_id: string | null }, [string]>(
      'SELECT parent_id FROM ch_nodes WHERE id = ?',
    )
    for (const id of nodeIds) {
      let at: string | null = id
      for (let depth = 0; at !== null && !out.has(at) && depth < 6; depth++) {
        out.add(at)
        at = parent.get(at)?.parent_id ?? null
      }
    }
    return [...out]
  }

  private lastMessage = (sessionId: string): StoredMessage | undefined => {
    const row = this.sqlite
      .query<MessageRow, [string]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 12`,
      )
      .all(sessionId)
      .map(toMessage)
      .find((m) => kindOfMessage(m) === undefined && messageText(m) !== '')
    return row
  }

  /** The agent's sessions, most recent activity first (activity = the newest stored message). */
  sessionsOf(
    agentId: string,
    filter: {
      kind?: ContextKind | undefined
      chat?: string | undefined
      since?: number | undefined
      until?: number | undefined
      limit?: number | undefined
    } = {},
  ): SessionInfo[] {
    const rows = this.sqlite
      .query<
        {
          session_id: string
          title: string
          node_id: string | null
          last_node_id: string | null
          last_at: number | null
        },
        { agent: string; limit: number }
      >(
        `WITH s AS (${AGENT_SESSIONS})
         SELECT s.session_id, MAX(s.title) AS title, MAX(s.node_id) AS node_id, MAX(s.last_node_id) AS last_node_id,
                (SELECT MAX(m.created_at) FROM eh_messages m WHERE m.session_id = s.session_id) AS last_at
         FROM s GROUP BY s.session_id HAVING last_at IS NOT NULL
         ORDER BY last_at DESC LIMIT $limit`,
      )
      .all({ agent: agentId, limit: SESSION_LIMIT })
    const out: SessionInfo[] = []
    for (const r of rows) {
      const kind = contextKindOf(r.session_id)
      if (filter.kind !== undefined && filter.kind !== kind) continue
      if (filter.since !== undefined && (r.last_at ?? 0) < filter.since) continue
      if (filter.until !== undefined && (r.last_at ?? 0) >= filter.until) continue
      const nodeIds = [r.node_id, r.last_node_id].filter((x): x is string => x !== null)
      const nodeTitles = [...new Set(nodeIds.map((n) => this.nodeTitle(n)))]
      const title = kind === 'channel' ? nodeTitles.join(' / ') || r.title : r.title
      if (filter.chat !== undefined) {
        const want = filter.chat.toLowerCase()
        const hit =
          nodeIds.some((n) => n.toLowerCase() === want) ||
          nodeTitles.some((t) => t.toLowerCase().includes(want)) ||
          this.nodeFamilyTitles(nodeIds).some((t) => t.toLowerCase().includes(want))
        if (!hit) continue
      }
      const last = this.lastMessage(r.session_id)
      out.push({
        sessionId: r.session_id,
        agentId,
        kind,
        title,
        nodeIds,
        nodeTitles,
        lastAt: r.last_at ?? 0,
        preview: last === undefined ? '' : messageText(last),
      })
      if (out.length >= (filter.limit ?? 200)) break
    }
    return out
  }

  /** Titles of the nodes (and their topics) of a room, so `chat: "Crew"` also finds its topics. */
  private nodeFamilyTitles(nodeIds: readonly string[]): string[] {
    return this.nodeFamily(nodeIds).map((n) => this.nodeTitle(n))
  }

  /** One session by id: its owner agent, kind and node; undefined when nothing is stored under it. */
  sessionInfo(sessionId: string): SessionInfo | undefined {
    const has = this.sqlite
      .query<{ n: number }, [string]>(
        'SELECT COUNT(*) AS n FROM (SELECT 1 FROM eh_messages WHERE session_id = ? LIMIT 1)',
      )
      .get(sessionId)
    if (has === null || has.n === 0) return undefined
    const kind = contextKindOf(sessionId)
    let agentId = agentOfSessionId(sessionId)
    let nodeIds: string[] = []
    let title = ''
    if (kind === 'channel') {
      const r = this.sqlite
        .query<
          { agent_id: string; node_id: string; last_node_id: string | null; label: string | null },
          [string]
        >(
          'SELECT agent_id, node_id, last_node_id, label FROM ch_node_sessions WHERE session_id = ?',
        )
        .get(sessionId)
      if (r !== null) {
        agentId = r.agent_id
        nodeIds = [r.node_id, r.last_node_id].filter((x): x is string => x !== null)
        title = [...new Set(nodeIds.map((n) => this.nodeTitle(n)))].join(' / ') || (r.label ?? '')
      }
    }
    if (
      agentId === undefined ||
      kind === 'delegated' ||
      kind === 'task' ||
      kind === 'program' ||
      kind === 'routine'
    ) {
      const t = this.sqlite
        .query<{ agent_id: string; title: string }, [string]>(
          'SELECT agent_id, title FROM tasks WHERE session_id = ?',
        )
        .get(sessionId)
      if (t !== null) {
        agentId = t.agent_id
        title = t.title
      }
    }
    if (kind === 'web') {
      const t = this.sqlite
        .query<{ agent_id: string; title: string | null }, [string]>(
          'SELECT agent_id, title FROM chat_threads WHERE session_id = ?',
        )
        .get(sessionId)
      if (t !== null) {
        agentId = t.agent_id
        title = t.title ?? 'Chat'
      } else title = 'Chat'
    }
    return {
      sessionId,
      agentId: agentId ?? '',
      kind,
      title: title || sessionId,
      nodeIds,
      nodeTitles: nodeIds.map((n) => this.nodeTitle(n)),
      lastAt: 0,
      preview: '',
    }
  }

  /** Nodes (chats) a run posted to: its session's outbox rows. */
  postedNodes(sessionId: string): string[] {
    const rows = this.sqlite
      .query<{ conversation_id: string }, [string]>(
        'SELECT DISTINCT conversation_id FROM channel_outbox WHERE session_id = ?',
      )
      .all(sessionId)
    const out = new Set<string>()
    const byNative = this.sqlite.query<{ id: string }, [string]>(
      'SELECT id FROM ch_nodes WHERE native_id = ?',
    )
    for (const r of rows) {
      out.add(r.conversation_id)
      for (const n of byNative.all(r.conversation_id)) out.add(n.id)
    }
    return [...out]
  }

  /** The newest compaction summary of a session, if it was compacted. */
  compactionSummary(sessionId: string): string | undefined {
    const rows = this.sqlite
      .query<MessageRow, [string]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? AND metadata LIKE '%"eh.compaction"%' ORDER BY id DESC LIMIT 1`,
      )
      .all(sessionId)
    for (const row of rows) {
      const m = toMessage(row)
      const data = m.parts.find((p) => p.type === 'data-eh.compaction')?.data as
        | { summary?: unknown }
        | undefined
      if (typeof data?.summary === 'string') return data.summary
    }
    return undefined
  }

  /**
   * Messages whose text has every term, in the given sessions, newest first. Ordinary messages
   * only (user and assistant, no kind messages).
   */
  search(
    sessionIds: readonly string[],
    terms: readonly string[],
    range: { since?: number | undefined; until?: number | undefined } = {},
  ): Array<{ sessionId: string; message: StoredMessage; text: string }> {
    if (sessionIds.length === 0 || terms.length === 0) return []
    const params: Record<string, string | number> = {
      ids: JSON.stringify(sessionIds),
      since: range.since ?? 0,
      until: range.until ?? Number.MAX_SAFE_INTEGER,
      limit: SCAN_LIMIT,
    }
    const likes = terms.map((t, i) => {
      params[`t${i}`] = like(t)
      return `AND parts LIKE $t${i} ESCAPE '\\'`
    })
    const rows = this.sqlite
      .query<MessageRow & { session_id: string }, Record<string, string | number>>(
        `SELECT session_id, id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id IN (SELECT value FROM json_each($ids))
           AND role IN ('user','assistant') AND created_at >= $since AND created_at < $until
           ${likes.join(' ')}
         ORDER BY id DESC LIMIT $limit`,
      )
      .all(params)
    const out: Array<{ sessionId: string; message: StoredMessage; text: string }> = []
    for (const row of rows) {
      const message = toMessage(row)
      if (kindOfMessage(message) !== undefined) continue
      const text = messageText(message)
      if (hasAllTerms(text, terms)) out.push({ sessionId: row.session_id, message, text })
    }
    return out
  }

  /** The first message of a session whose text carries the platform message `carries` accepts. */
  findPlatformMessage(
    sessionId: string,
    platformId: string,
    carries: (text: string, id: string) => boolean,
  ): StoredMessage | undefined {
    const rows = this.sqlite
      .query<MessageRow, [string, string]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? AND parts LIKE ? ORDER BY id ASC LIMIT 400`,
      )
      .all(sessionId, `%${platformId}%`)
    return rows
      .map(toMessage)
      .find((m) => kindOfMessage(m) === undefined && carries(messageText(m), platformId))
  }

  message(sessionId: string, id: string): StoredMessage | undefined {
    const row = this.sqlite
      .query<MessageRow, [string, string]>(
        'SELECT id, role, parts, metadata, created_at FROM eh_messages WHERE session_id = ? AND id = ?',
      )
      .get(sessionId, id)
    return row === null ? undefined : toMessage(row)
  }

  /** `count` messages before `id` (oldest first), kind messages other than the summary left out. */
  before(sessionId: string, id: string, count: number): StoredMessage[] {
    return this.sqlite
      .query<MessageRow, [string, string, number]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, id, count)
      .map(toMessage)
      .filter(visible)
      .reverse()
  }

  after(sessionId: string, id: string, count: number): StoredMessage[] {
    return this.sqlite
      .query<MessageRow, [string, string, number]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sessionId, id, count)
      .map(toMessage)
      .filter(visible)
  }

  latest(sessionId: string, count: number): StoredMessage[] {
    return this.sqlite
      .query<MessageRow, [string, number]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionId, count)
      .map(toMessage)
      .filter(visible)
      .reverse()
  }

  /** The first stored message of a session (its brief or opening). */
  first(sessionId: string): StoredMessage | undefined {
    const row = this.sqlite
      .query<MessageRow, [string]>(
        `SELECT id, role, parts, metadata, created_at FROM eh_messages
         WHERE session_id = ? ORDER BY id ASC LIMIT 1`,
      )
      .get(sessionId)
    return row === null ? undefined : toMessage(row)
  }

  // --- runs ------------------------------------------------------------------------------------

  private runOf(r: {
    id: string
    session_id: string
    agent_id: string
    title: string
    state: string
    started_at: number
    ended_at: number | null
    summary: string | null
    report: string | null
    cost_usd: number
    brief: string | null
    pending_kind: string | null
  }): RunInfo {
    const program = /^(?:program|rehearsal):([^:]+):/.exec(r.session_id)?.[1] ?? null
    const name =
      program === null
        ? null
        : (this.sqlite
            .query<{ name: string }, [string]>('SELECT name FROM programs WHERE id = ?')
            .get(program)?.name ?? null)
    return {
      taskId: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id,
      kind: contextKindOf(r.session_id),
      title: r.title,
      status: r.state,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      summary: r.summary,
      report: r.report === null ? null : JSON.parse(r.report),
      costUsd: r.cost_usd,
      programId: program,
      programName: name,
      brief: r.brief,
      pendingKind: r.pending_kind,
    }
  }

  runs(
    agentId: string,
    filter: {
      kind?: ContextKind | undefined
      status?: string | undefined
      /** Program id or name (a case-insensitive part of it). */
      program?: string | undefined
      since?: number | undefined
      until?: number | undefined
      limit?: number | undefined
    } = {},
  ): RunInfo[] {
    const rows = this.sqlite
      .query<
        Parameters<SessionContextStore['runOf']>[0],
        { agent: string; since: number; until: number; limit: number }
      >(
        `SELECT id, session_id, agent_id, title, state, started_at, ended_at, summary, report, cost_usd, brief, pending_kind
         FROM tasks WHERE agent_id = $agent AND session_id NOT LIKE 'queued:%'
           AND started_at >= $since AND started_at < $until
         ORDER BY started_at DESC LIMIT $limit`,
      )
      .all({
        agent: agentId,
        since: filter.since ?? 0,
        until: filter.until ?? Number.MAX_SAFE_INTEGER,
        limit: 400,
      })
    const out: RunInfo[] = []
    for (const r of rows) {
      const run = this.runOf(r)
      if (filter.kind !== undefined && run.kind !== filter.kind) continue
      if (filter.status !== undefined && run.status !== filter.status) continue
      if (filter.program !== undefined) {
        const want = filter.program.toLowerCase()
        if (
          run.programId?.toLowerCase() !== want &&
          !(run.programName ?? '').toLowerCase().includes(want)
        )
          continue
      }
      out.push(run)
      if (out.length >= (filter.limit ?? 20)) break
    }
    return out
  }

  /** A run by task id or session id. */
  run(ref: string): RunInfo | undefined {
    const r = this.sqlite
      .query<Parameters<SessionContextStore['runOf']>[0], [string, string]>(
        `SELECT id, session_id, agent_id, title, state, started_at, ended_at, summary, report, cost_usd, brief, pending_kind
         FROM tasks WHERE id = ? OR session_id = ?`,
      )
      .get(ref, ref)
    return r === null ? undefined : this.runOf(r)
  }

  retry(sessionId: string): RetryInfo | undefined {
    const r = this.sqlite
      .query<
        {
          state: string
          attempt: number
          max_attempts: number
          next_at: number
          error_code: string
          error_message: string
        },
        [string]
      >(
        'SELECT state, attempt, max_attempts, next_at, error_code, error_message FROM turn_retries WHERE session_id = ?',
      )
      .get(sessionId)
    return r === null
      ? undefined
      : {
          state: r.state,
          attempt: r.attempt,
          maxAttempts: r.max_attempts,
          nextAt: r.next_at,
          errorCode: r.error_code,
          errorMessage: r.error_message,
        }
  }

  decisions(sessionId: string): DecisionInfo[] {
    return this.sqlite
      .query<
        {
          id: string
          kind: string
          status: string
          title: string
          body: string
          decided_by: string | null
          decided_at: number | null
          decision_note: string | null
          outcome: string | null
          created_at: number
        },
        [string]
      >(
        `SELECT id, kind, status, title, body, decided_by, decided_at, decision_note, outcome, created_at
         FROM decisions WHERE session_id = ? ORDER BY created_at ASC LIMIT 20`,
      )
      .all(sessionId)
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        status: d.status,
        title: d.title,
        body: d.body,
        decidedBy: d.decided_by,
        decidedAt: d.decided_at,
        decisionNote: d.decision_note,
        outcome: d.outcome === null ? null : JSON.parse(d.outcome),
        createdAt: d.created_at,
      }))
  }

  /** What a program says in its brief and notes (session references of a run). */
  programBrief(programId: string): string | undefined {
    const r = this.sqlite
      .query<{ brief: string; notes: string }, [string]>(
        'SELECT brief, notes FROM programs WHERE id = ?',
      )
      .get(programId)
    return r === null ? undefined : `${r.brief}\n${r.notes}`
  }

  routinePrompt(routineId: string): string | undefined {
    return (
      this.sqlite
        .query<{ prompt: string }, [string]>('SELECT prompt FROM routines WHERE id = ?')
        .get(routineId)?.prompt ?? undefined
    )
  }

  taskBrief(taskId: string): string | undefined {
    return (
      this.sqlite
        .query<{ brief: string | null }, [string]>('SELECT brief FROM tasks WHERE id = ?')
        .get(taskId)?.brief ?? undefined
    )
  }
}

/** Kind messages other than the compaction summary are internal: not shown. */
const visible = (m: StoredMessage): boolean => {
  const kind = kindOfMessage(m)
  return kind === undefined || kind === 'eh.compaction'
}
