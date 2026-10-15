/**
 * What agent health reads (`app/health.ts`): tool parts and error notices of the stored
 * sessions, the model call log, and the dismissed findings. No table of its own: dismissals are rows
 * of `settings` (`health:dismissed:<fingerprint>`), like the heartbeat state.
 */
import type { Database } from 'bun:sqlite'
import type { HealthStore, StoredCall, StoredTool } from '../../app/ports.ts'
import { type NoticeEvent, readToolPart } from '../../domain/health.ts'

const DISMISSED = 'health:dismissed:'
/** Newest messages scanned per pass: a bound on the work, far above a day of a small team. */
const MAX_MESSAGES = 4000

interface MessageRow {
  session_id: string
  id: string
  parts: string
  created_at: number
}

export function sqliteHealthStore(sqlite: Database): HealthStore {
  const messages = sqlite.query<MessageRow, [number, number]>(
    `SELECT session_id, id, parts, created_at FROM eh_messages
     WHERE role = 'assistant' AND created_at >= ?
       AND (parts LIKE '%"type":"tool-%' OR parts LIKE '%"type":"dynamic-tool"%'
            OR parts LIKE '%"type":"data-eh.notice"%')
     ORDER BY created_at DESC LIMIT ?`,
  )
  return {
    scanMessages(since) {
      const tools: StoredTool[] = []
      const notices: Array<Omit<NoticeEvent, 'agentId' | 'link'>> = []
      for (const row of messages.all(since, MAX_MESSAGES)) {
        let parts: unknown
        try {
          parts = JSON.parse(row.parts)
        } catch {
          continue
        }
        if (!Array.isArray(parts)) continue
        for (const p of parts as Array<Record<string, unknown>>) {
          if (typeof p !== 'object' || p === null) continue
          if (p.type === 'data-eh.notice') {
            const data = p.data as { code?: unknown; message?: unknown } | undefined
            if (typeof data?.code === 'string') {
              notices.push({
                sessionId: row.session_id,
                at: row.created_at,
                code: data.code,
                message: typeof data.message === 'string' ? data.message : '',
              })
            }
            continue
          }
          const read = readToolPart(p)
          if (read === undefined) continue
          tools.push({ sessionId: row.session_id, messageId: row.id, at: row.created_at, ...read })
        }
      }
      return { tools, notices }
    },

    calls(since) {
      return sqlite
        .query<
          {
            id: string
            session_id: string | null
            agent_id: string | null
            started_at: number
            kind: string
            status: string
            input_tokens: number | null
            error_name: string | null
            error_message: string | null
          },
          [number]
        >(
          `SELECT id, session_id, agent_id, started_at, kind, status, input_tokens, error_name, error_message
           FROM model_calls WHERE started_at >= ? ORDER BY started_at LIMIT 20000`,
        )
        .all(since)
        .map(
          (r): StoredCall => ({
            id: r.id,
            sessionId: r.session_id,
            agentId: r.agent_id,
            at: r.started_at,
            kind: r.kind,
            status: r.status,
            inputTokens: r.input_tokens,
            errorName: r.error_name,
            errorMessage: r.error_message,
          }),
        )
    },

    lastMessageAt(sessionId) {
      return (
        sqlite
          .query<{ at: number | null }, [string]>(
            'SELECT MAX(created_at) AS at FROM eh_messages WHERE session_id = ?',
          )
          .get(sessionId)?.at ?? null
      )
    },

    dismissed() {
      const out = new Map<string, number>()
      for (const r of sqlite
        .query<{ key: string; updated_at: number }, [string]>(
          `SELECT key, updated_at FROM settings WHERE key LIKE ? ESCAPE '\\'`,
        )
        .all(`${DISMISSED.replace(/[\\%_]/g, '\\$&')}%`)) {
        out.set(r.key.slice(DISMISSED.length), r.updated_at)
      }
      return out
    },

    dismiss(fingerprint, now) {
      sqlite
        .query(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, 'true', ?)
           ON CONFLICT (key) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(`${DISMISSED}${fingerprint}`, now)
    },

    restore(fingerprint) {
      return (
        sqlite.query('DELETE FROM settings WHERE key = ?').run(`${DISMISSED}${fingerprint}`)
          .changes > 0
      )
    },
  }
}
