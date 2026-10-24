/**
 * The audit of platform actions (the Audit page, `GET /audit/actions`): pure helpers to read rows
 * across pages and to write them as CSV. A row never carries a message body: the channel governor
 * records ids, targets and `text=<N chars>` only.
 */
import type { ChannelAuditPage, ChannelAuditQuery, ChannelAuditRow } from '../domain/channels.ts'

/** Most rows one export holds. */
export const AUDIT_EXPORT_MAX = 10_000

export const AUDIT_CSV_COLUMNS = [
  'time',
  'connection',
  'platform',
  'connector',
  'kind',
  'action',
  'chat',
  'user',
  'link',
  'requested_by',
  'role',
  'origin',
  'agent',
  'session',
  'result',
  'duration_ms',
  'summary',
  'note',
] as const

const NUMBER = /^-?\d+(\.\d+)?$/

/**
 * One CSV field: quoted when it holds a comma, quote or line break, quotes doubled. Text that a
 * spreadsheet would run as a formula (a person picks their own display name) gets a leading `'`.
 */
export function csvField(value: string | number | undefined): string {
  if (value === undefined) return ''
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !NUMBER.test(text))
    text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function auditCsv(rows: readonly ChannelAuditRow[]): string {
  const lines = [AUDIT_CSV_COLUMNS.join(',')]
  for (const r of rows) {
    lines.push(
      [
        new Date(r.at).toISOString(),
        r.connectionLabel,
        r.platform,
        r.transport === undefined ? '' : r.transport === 'user' ? 'account' : 'bot',
        r.kind,
        r.action,
        r.target.chat,
        r.target.user,
        r.target.link,
        r.requester,
        r.role,
        r.origin,
        r.agentName ?? r.agentId,
        r.sessionId,
        r.result,
        r.durationMs,
        r.summary,
        r.note,
      ]
        .map(csvField)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Every row of the query (newest first) up to `max`, following the cursor. */
export async function collectAudit(
  page: (query: ChannelAuditQuery) => Promise<ChannelAuditPage>,
  query: Omit<ChannelAuditQuery, 'cursor' | 'limit'>,
  max = AUDIT_EXPORT_MAX,
): Promise<ChannelAuditRow[]> {
  const out: ChannelAuditRow[] = []
  let cursor: string | undefined
  while (out.length < max) {
    const got = await page({
      ...query,
      ...(cursor === undefined ? {} : { cursor }),
      limit: Math.min(500, max - out.length),
    })
    out.push(...got.items)
    if (got.next === undefined || got.items.length === 0) break
    cursor = got.next
  }
  return out
}
