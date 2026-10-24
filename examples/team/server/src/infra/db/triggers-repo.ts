/** Triggers and their firing log in SQLite (`triggers`, `trigger_fires`). */
import type { Database } from 'bun:sqlite'
import type { NewTriggerRow, TriggerPatchRow, TriggerStore } from '../../app/ports.ts'
import { isStreamType } from '../../domain/event-stream.ts'
import type {
  FireResult,
  Trigger,
  TriggerAction,
  TriggerActionKind,
  TriggerFilters,
  TriggerFire,
  TriggerScope,
} from '../../domain/triggers.ts'

interface Row {
  id: string
  name: string
  enabled: number
  event_types: string
  scope: string
  filters: string
  action: string
  webhook_secret: string | null
  cooldown_sec: number
  allow_self: number
  created_by: string
  notes: string | null
  created_at: number
  updated_at: number
  last_fired_at: number | null
  fire_count: number
  error_count: number
}

interface FireRow {
  id: string
  trigger_id: string
  event_id: string
  event_type: string
  at: number
  result: string
  reason: string | null
  action_kind: string
  duration_ms: number
  detail: string
}

const toTrigger = (r: Row): Trigger => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled !== 0,
  eventTypes: (JSON.parse(r.event_types) as string[]).filter(isStreamType),
  scope: JSON.parse(r.scope) as TriggerScope,
  filters: JSON.parse(r.filters) as TriggerFilters,
  action: JSON.parse(r.action) as TriggerAction,
  hasSecret: r.webhook_secret !== null,
  cooldownSec: r.cooldown_sec,
  allowSelf: r.allow_self !== 0,
  createdBy: r.created_by,
  notes: r.notes,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastFiredAt: r.last_fired_at,
  fireCount: r.fire_count,
  errorCount: r.error_count,
})

const toFire = (r: FireRow): TriggerFire => ({
  id: r.id,
  triggerId: r.trigger_id,
  eventId: r.event_id,
  eventType: r.event_type,
  at: r.at,
  result: r.result as FireResult,
  reason: r.reason,
  actionKind: r.action_kind as TriggerActionKind,
  durationMs: r.duration_ms,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
})

export interface SqliteTriggerStore extends TriggerStore {
  /** The sealed webhook secret (the engine opens it to sign). */
  sealedSecret(id: string): string | null
  /** Log a firing; one whose action ran (ok or error) also updates the trigger's counters. */
  recordFire(fire: TriggerFire): void
  /** Delete firings older than `olderThan`; returns how many. */
  pruneFires(olderThan: number): number
  /** The most recent firing of a trigger. */
  lastFire(triggerId: string): TriggerFire | undefined
}

export function sqliteTriggerStore(sqlite: Database): SqliteTriggerStore {
  const get = (id: string): Trigger | undefined => {
    const row = sqlite.query<Row, [string]>('SELECT * FROM triggers WHERE id = ?').get(id)
    return row === null ? undefined : toTrigger(row)
  }
  return {
    list() {
      return sqlite
        .query<Row, []>('SELECT * FROM triggers ORDER BY created_at, id')
        .all()
        .map(toTrigger)
    },
    get,
    insert(r: NewTriggerRow) {
      sqlite
        .query(
          `INSERT INTO triggers (id, name, enabled, event_types, scope, filters, action, webhook_secret,
             cooldown_sec, allow_self, created_by, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.name,
          r.enabled ? 1 : 0,
          JSON.stringify(r.eventTypes),
          JSON.stringify(r.scope),
          JSON.stringify(r.filters),
          JSON.stringify(r.action),
          r.sealedSecret,
          r.cooldownSec,
          r.allowSelf ? 1 : 0,
          r.createdBy,
          r.notes,
          r.now,
          r.now,
        )
      return get(r.id) as Trigger
    },
    update(id, patch: TriggerPatchRow, now) {
      const sets: string[] = ['updated_at = ?']
      const args: Array<string | number | null> = [now]
      const set = (col: string, v: string | number | null): void => {
        sets.push(`${col} = ?`)
        args.push(v)
      }
      if (patch.name !== undefined) set('name', patch.name)
      if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0)
      if (patch.eventTypes !== undefined) set('event_types', JSON.stringify(patch.eventTypes))
      if (patch.scope !== undefined) set('scope', JSON.stringify(patch.scope))
      if (patch.filters !== undefined) set('filters', JSON.stringify(patch.filters))
      if (patch.action !== undefined) set('action', JSON.stringify(patch.action))
      if (patch.sealedSecret !== undefined) set('webhook_secret', patch.sealedSecret)
      if (patch.cooldownSec !== undefined) set('cooldown_sec', patch.cooldownSec)
      if (patch.allowSelf !== undefined) set('allow_self', patch.allowSelf ? 1 : 0)
      if (patch.notes !== undefined) set('notes', patch.notes)
      const res = sqlite
        .query(`UPDATE triggers SET ${sets.join(', ')} WHERE id = ?`)
        .run(...args, id)
      return res.changes === 0 ? undefined : get(id)
    },
    delete(id) {
      sqlite.query('DELETE FROM trigger_fires WHERE trigger_id = ?').run(id)
      return sqlite.query('DELETE FROM triggers WHERE id = ?').run(id).changes > 0
    },
    sealedSecret(id) {
      return (
        sqlite
          .query<{ s: string | null }, [string]>(
            'SELECT webhook_secret AS s FROM triggers WHERE id = ?',
          )
          .get(id)?.s ?? null
      )
    },
    recordFire(f) {
      sqlite.transaction(() => {
        sqlite
          .query(
            `INSERT INTO trigger_fires (id, trigger_id, event_id, event_type, at, result, reason, action_kind, duration_ms, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            f.id,
            f.triggerId,
            f.eventId,
            f.eventType,
            f.at,
            f.result,
            f.reason,
            f.actionKind,
            f.durationMs,
            JSON.stringify(f.detail),
          )
        if (f.result !== 'skipped') {
          sqlite
            .query(
              'UPDATE triggers SET last_fired_at = ?, fire_count = fire_count + 1, error_count = error_count + ? WHERE id = ?',
            )
            .run(f.at, f.result === 'error' ? 1 : 0, f.triggerId)
        }
      })()
    },
    fires(q) {
      const where: string[] = []
      const args: Array<string | number> = []
      if (q.triggerId !== undefined) {
        where.push('trigger_id = ?')
        args.push(q.triggerId)
      }
      if (q.result !== undefined) {
        where.push('result = ?')
        args.push(q.result)
      }
      if (q.before !== undefined) {
        where.push('id < ?')
        args.push(q.before)
      }
      const rows = sqlite
        .query<FireRow, Array<string | number>>(
          `SELECT * FROM trigger_fires ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY id DESC LIMIT ?`,
        )
        .all(...args, q.limit + 1)
      const page = rows.slice(0, q.limit)
      const last = page.at(-1)
      return {
        items: page.map(toFire),
        ...(rows.length > q.limit && last !== undefined ? { next: last.id } : {}),
      }
    },
    executedSince(since) {
      return (
        sqlite
          .query<{ n: number }, [number]>(
            "SELECT COUNT(*) AS n FROM trigger_fires WHERE at >= ? AND result IN ('ok', 'error')",
          )
          .get(since)?.n ?? 0
      )
    },
    pruneFires(olderThan) {
      return sqlite.query('DELETE FROM trigger_fires WHERE at < ?').run(olderThan).changes
    },
    lastFire(triggerId) {
      const row = sqlite
        .query<FireRow, [string]>(
          'SELECT * FROM trigger_fires WHERE trigger_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(triggerId)
      return row === null ? undefined : toFire(row)
    },
  }
}
