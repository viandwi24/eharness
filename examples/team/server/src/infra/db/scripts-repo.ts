/**
 * Scripts on SQLite (P59 W4): definitions, immutable versions, run traces and key-value state.
 * Plain SQL on the app connection, like the tables store.
 */
import type { Database } from 'bun:sqlite'
import type { ScriptCopyRow, ScriptStore, ScriptTimer } from '../../app/ports.ts'
import type {
  ApprovalState,
  AuthorKind,
  HostCallRecord,
  RunOutcome,
  RunTrigger,
  Script,
  ScriptRun,
  ScriptStatus,
  ScriptVersion,
} from '../../domain/scripts.ts'

interface ScriptRow {
  id: string
  name: string
  description: string
  agent_id: string
  status: string
  latest_version: number
  active_version: number | null
  author_kind: string
  created_by: string
  approval_state: string
  approval_version: number | null
  approval_by: string | null
  approval_at: number | null
  approval_note: string | null
  routine_id: string | null
  last_run_at: number | null
  run_count: number
  error_count: number
  consecutive_failures: number
  disabled_reason: string | null
  created_at: number
  updated_at: number
}

interface VersionRow {
  script_id: string
  version: number
  source: string
  manifest: string
  hash: string
  note: string
  created_by: string
  author_kind: string
  created_at: number
}

interface RunRow {
  id: string
  script_id: string
  version: number
  trigger: string
  dry_run: number
  outcome: string
  reason: string | null
  error: string | null
  event: string | null
  result: string | null
  logs: string
  calls: string
  duration_ms: number
  cpu_ms: number
  started_by: string
  started_at: number
}

const toScript = (r: ScriptRow): Script => ({
  id: r.id,
  name: r.name,
  description: r.description,
  agentId: r.agent_id,
  status: r.status as ScriptStatus,
  latestVersion: r.latest_version,
  activeVersion: r.active_version,
  authorKind: r.author_kind as AuthorKind,
  createdBy: r.created_by,
  approval: {
    state: r.approval_state as ApprovalState,
    version: r.approval_version,
    by: r.approval_by,
    at: r.approval_at,
    note: r.approval_note,
  },
  routineId: r.routine_id,
  lastRunAt: r.last_run_at,
  runCount: r.run_count,
  errorCount: r.error_count,
  consecutiveFailures: r.consecutive_failures,
  disabledReason: r.disabled_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toVersion = (r: VersionRow): ScriptVersion => ({
  scriptId: r.script_id,
  version: r.version,
  source: r.source,
  manifest: JSON.parse(r.manifest) as Record<string, unknown>,
  hash: r.hash,
  note: r.note,
  createdBy: r.created_by,
  authorKind: r.author_kind as AuthorKind,
  createdAt: r.created_at,
})

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text))

const toRun = (r: RunRow): ScriptRun => ({
  id: r.id,
  scriptId: r.script_id,
  version: r.version,
  trigger: r.trigger as RunTrigger,
  dryRun: r.dry_run === 1,
  outcome: r.outcome as RunOutcome,
  reason: r.reason,
  error: r.error,
  event: parse(r.event),
  result: parse(r.result),
  logs: JSON.parse(r.logs) as string[],
  calls: JSON.parse(r.calls) as HostCallRecord[],
  durationMs: r.duration_ms,
  cpuMs: r.cpu_ms,
  startedBy: r.started_by,
  startedAt: r.started_at,
})

const COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  agentId: 'agent_id',
  status: 'status',
  latestVersion: 'latest_version',
  activeVersion: 'active_version',
  authorKind: 'author_kind',
  approvalState: 'approval_state',
  approvalVersion: 'approval_version',
  approvalBy: 'approval_by',
  approvalAt: 'approval_at',
  approvalNote: 'approval_note',
  routineId: 'routine_id',
  disabledReason: 'disabled_reason',
  consecutiveFailures: 'consecutive_failures',
}

export function sqliteScriptStore(sqlite: Database): ScriptStore {
  const get = (ref: string): Script | undefined => {
    const r = sqlite
      .query<ScriptRow, [string, string]>('SELECT * FROM scripts WHERE id = ? OR name = ? LIMIT 1')
      .get(ref, ref)
    return r === null ? undefined : toScript(r)
  }
  const kvRead = (scriptId: string, key: string, now: number): string | undefined =>
    sqlite
      .query<{ value: string }, [string, string, number]>(
        'SELECT value FROM script_kv WHERE script_id = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)',
      )
      .get(scriptId, key, now)?.value ?? undefined
  const kvExpiry = (scriptId: string, key: string, now: number): number | undefined =>
    sqlite
      .query<{ expires_at: number | null }, [string, string, number]>(
        'SELECT expires_at FROM script_kv WHERE script_id = ? AND key = ? AND expires_at > ?',
      )
      .get(scriptId, key, now)?.expires_at ?? undefined
  const kvWrite = (
    scriptId: string,
    key: string,
    value: string,
    now: number,
    expiresAt: number | undefined,
  ): void => {
    sqlite
      .query(
        `INSERT INTO script_kv (script_id, key, value, updated_at, expires_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (script_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           expires_at = excluded.expires_at`,
      )
      .run(scriptId, key, value, now, expiresAt ?? null)
  }
  return {
    list() {
      return sqlite.query<ScriptRow, []>('SELECT * FROM scripts ORDER BY name').all().map(toScript)
    },
    get,
    insert(s, v) {
      sqlite
        .transaction(() => {
          sqlite
            .query(
              `INSERT INTO scripts (id, name, description, agent_id, status, latest_version, active_version, author_kind, created_by,
                 approval_state, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'draft', 1, NULL, ?, ?, 'none', ?, ?)`,
            )
            .run(s.id, s.name, s.description, s.agentId, s.authorKind, s.createdBy, s.now, s.now)
          sqlite
            .query(
              `INSERT INTO script_versions (script_id, version, source, manifest, hash, note, created_by, author_kind, created_at)
               VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              s.id,
              v.source,
              JSON.stringify(v.manifest),
              v.hash,
              v.note,
              s.createdBy,
              s.authorKind,
              s.now,
            )
        })
        .immediate()
      return get(s.id) as Script
    },
    addVersion(scriptId, v, now) {
      return sqlite
        .transaction(() => {
          const cur = sqlite
            .query<{ latest_version: number }, [string]>(
              'SELECT latest_version FROM scripts WHERE id = ?',
            )
            .get(scriptId)
          if (cur === null) throw new Error(`no script ${scriptId}`)
          const version = cur.latest_version + 1
          sqlite
            .query(
              `INSERT INTO script_versions (script_id, version, source, manifest, hash, note, created_by, author_kind, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              scriptId,
              version,
              v.source,
              JSON.stringify(v.manifest),
              v.hash,
              v.note,
              v.createdBy,
              v.authorKind,
              now,
            )
          sqlite
            .query(
              'UPDATE scripts SET latest_version = ?, author_kind = ?, updated_at = ? WHERE id = ?',
            )
            .run(version, v.authorKind, now, scriptId)
          return version
        })
        .immediate()
    },
    update(id, patch, now) {
      const sets: string[] = []
      const values: Array<string | number | null> = []
      for (const [k, v] of Object.entries(patch)) {
        const col = COLUMNS[k]
        if (col === undefined || v === undefined) continue
        sets.push(`${col} = ?`)
        values.push(v as string | number | null)
      }
      if (sets.length > 0)
        sqlite
          .query(`UPDATE scripts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...values, now, id)
      return get(id)
    },
    delete(id) {
      return sqlite
        .transaction(() => {
          sqlite.query('DELETE FROM script_versions WHERE script_id = ?').run(id)
          sqlite.query('DELETE FROM script_runs WHERE script_id = ?').run(id)
          sqlite.query('DELETE FROM script_kv WHERE script_id = ?').run(id)
          sqlite.query('DELETE FROM script_copies WHERE script_id = ?').run(id)
          sqlite.query('DELETE FROM script_timers WHERE script_id = ?').run(id)
          return sqlite.query('DELETE FROM scripts WHERE id = ?').run(id).changes > 0
        })
        .immediate()
    },
    version(scriptId, version) {
      const r = sqlite
        .query<VersionRow, [string, number]>(
          'SELECT * FROM script_versions WHERE script_id = ? AND version = ?',
        )
        .get(scriptId, version)
      return r === null ? undefined : toVersion(r)
    },
    versions(scriptId) {
      return sqlite
        .query<VersionRow, [string]>(
          'SELECT * FROM script_versions WHERE script_id = ? ORDER BY version DESC',
        )
        .all(scriptId)
        .map(toVersion)
    },
    recordRun(run) {
      sqlite
        .query(
          `INSERT INTO script_runs (id, script_id, version, trigger, dry_run, outcome, reason, error, event, result, logs, calls,
             duration_ms, cpu_ms, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.scriptId,
          run.version,
          run.trigger,
          run.dryRun ? 1 : 0,
          run.outcome,
          run.reason,
          run.error,
          run.event === undefined ? null : JSON.stringify(run.event),
          run.result === undefined ? null : JSON.stringify(run.result),
          JSON.stringify(run.logs),
          JSON.stringify(run.calls),
          run.durationMs,
          run.cpuMs,
          run.startedBy,
          run.startedAt,
        )
      if (!run.dryRun && run.outcome !== 'skipped') {
        const failed = run.outcome !== 'ok'
        sqlite
          .query(
            `UPDATE scripts SET last_run_at = ?, run_count = run_count + 1, error_count = error_count + ?,
               consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END WHERE id = ?`,
          )
          .run(run.startedAt, failed ? 1 : 0, failed ? 1 : 0, run.scriptId)
      }
    },
    runs(scriptId, q) {
      const where = ['script_id = ?']
      const params: Array<string | number> = [scriptId]
      if (q.before !== undefined) {
        where.push('id < ?')
        params.push(q.before)
      }
      if (q.dryRun !== undefined) {
        where.push('dry_run = ?')
        params.push(q.dryRun ? 1 : 0)
      }
      if (q.outcomes !== undefined && q.outcomes.length > 0) {
        where.push(`outcome IN (${q.outcomes.map(() => '?').join(', ')})`)
        params.push(...q.outcomes)
      }
      return sqlite
        .query<RunRow, Array<string | number>>(
          `SELECT * FROM script_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        )
        .all(...params, q.limit)
        .map(toRun)
    },
    run(id) {
      const r = sqlite.query<RunRow, [string]>('SELECT * FROM script_runs WHERE id = ?').get(id)
      return r === null ? undefined : toRun(r)
    },
    runsSince(scriptId, since) {
      return (
        sqlite
          .query<{ n: number }, [string, number]>(
            "SELECT COUNT(*) AS n FROM script_runs WHERE script_id = ? AND started_at >= ? AND dry_run = 0 AND outcome <> 'skipped'",
          )
          .get(scriptId, since)?.n ?? 0
      )
    },
    pruneRuns(olderThan, keepPerScript) {
      const a = sqlite.query('DELETE FROM script_runs WHERE started_at < ?').run(olderThan).changes
      const b = sqlite
        .query(
          `DELETE FROM script_runs WHERE id IN (
             SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY script_id ORDER BY id DESC) AS n FROM script_runs)
             WHERE n > ?)`,
        )
        .run(keepPerScript).changes
      return a + b
    },
    kvGet(scriptId, key, now = Date.now()) {
      return kvRead(scriptId, key, now)
    },
    kvSet(scriptId, key, value, now, expiresAt) {
      kvWrite(scriptId, key, value, now, expiresAt)
    },
    kvIncr(scriptId, key, by, now, expiresAt) {
      return sqlite
        .transaction(() => {
          const raw = kvRead(scriptId, key, now)
          const before = raw === undefined ? 0 : (JSON.parse(raw) as unknown)
          if (typeof before !== 'number' || !Number.isFinite(before))
            return { error: `${key} holds no number` }
          const value = before + by
          // a running counter keeps its expiry unless a new one is given
          kvWrite(
            scriptId,
            key,
            JSON.stringify(value),
            now,
            expiresAt ?? kvExpiry(scriptId, key, now),
          )
          return { value }
        })
        .immediate()
    },
    kvOnce(scriptId, key, now, expiresAt) {
      return sqlite
        .transaction(() => {
          if (kvRead(scriptId, key, now) !== undefined) return false
          kvWrite(scriptId, key, 'true', now, expiresAt)
          return true
        })
        .immediate()
    },
    kvRate(scriptId, key, limit, windowMs, now) {
      return sqlite
        .transaction(() => {
          const raw = kvRead(scriptId, key, now)
          const parsed = raw === undefined ? [] : (JSON.parse(raw) as unknown)
          const hits = (Array.isArray(parsed) ? parsed : []).filter(
            (x): x is number => typeof x === 'number' && x > now - windowMs,
          )
          const allowed = hits.length < limit
          if (allowed) hits.push(now)
          kvWrite(scriptId, key, JSON.stringify(hits), now, now + windowMs)
          const oldest = hits[0] ?? now
          return {
            allowed,
            remaining: Math.max(0, limit - hits.length),
            resetAt: oldest + windowMs,
          }
        })
        .immediate()
    },
    kvPrune(now) {
      return sqlite
        .query('DELETE FROM script_kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
        .run(now).changes
    },
    kvDelete(scriptId, key) {
      return (
        sqlite.query('DELETE FROM script_kv WHERE script_id = ? AND key = ?').run(scriptId, key)
          .changes > 0
      )
    },
    kvKeys(scriptId, prefix, now = Date.now()) {
      return sqlite
        .query<{ key: string }, [string, string, string, number]>(
          `SELECT key FROM script_kv WHERE script_id = ? AND substr(key, 1, length(?)) = ?
             AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT 1000`,
        )
        .all(scriptId, prefix, prefix, now)
        .map((r) => r.key)
    },
    copiesAdd(scriptId, rows, now) {
      const q = sqlite.query(
        `INSERT INTO script_copies (script_id, connection_id, source_node, source_id, target_node, target_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      sqlite.transaction(() => {
        for (const r of rows)
          q.run(scriptId, r.connectionId, r.sourceNode, r.sourceId, r.targetNode, r.targetId, now)
      })()
    },
    copiesOf(scriptId, sourceNode, sourceId) {
      return sqlite
        .query<CopyDb, [string, string, string]>(
          `SELECT connection_id, source_node, source_id, target_node, target_id FROM script_copies
           WHERE script_id = ? AND source_node = ? AND source_id = ? ORDER BY created_at, target_id LIMIT 100`,
        )
        .all(scriptId, sourceNode, sourceId)
        .map(copyOf)
    },
    copySource(scriptId, targetNode, targetId) {
      const r = sqlite
        .query<CopyDb, [string, string, string]>(
          `SELECT connection_id, source_node, source_id, target_node, target_id FROM script_copies
           WHERE script_id = ? AND target_node = ? AND target_id = ? LIMIT 1`,
        )
        .get(scriptId, targetNode, targetId)
      return r === null ? undefined : copyOf(r)
    },
    timerAdd(x) {
      sqlite
        .transaction(() => {
          if (x.key !== undefined)
            sqlite
              .query('DELETE FROM script_timers WHERE script_id = ? AND key = ?')
              .run(x.scriptId, x.key)
          sqlite
            .query(
              'INSERT INTO script_timers (id, script_id, key, due_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(x.id, x.scriptId, x.key ?? null, x.dueAt, x.data, x.createdAt)
        })
        .immediate()
    },
    timerCancel(scriptId, ref) {
      if (ref.id !== undefined)
        return (
          sqlite
            .query('DELETE FROM script_timers WHERE script_id = ? AND id = ?')
            .run(scriptId, ref.id).changes > 0
        )
      if (ref.key !== undefined)
        return (
          sqlite
            .query('DELETE FROM script_timers WHERE script_id = ? AND key = ?')
            .run(scriptId, ref.key).changes > 0
        )
      return false
    },
    timersOf(scriptId, limit) {
      return sqlite
        .query<TimerDb, [string, number]>(
          'SELECT * FROM script_timers WHERE script_id = ? ORDER BY due_at, id LIMIT ?',
        )
        .all(scriptId, limit)
        .map(timerOf)
    },
    timersCount(scriptId) {
      return (
        sqlite
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) AS n FROM script_timers WHERE script_id = ?',
          )
          .get(scriptId)?.n ?? 0
      )
    },
    timersTake(now, limit) {
      return sqlite
        .query<TimerDb, [number, number]>(
          `DELETE FROM script_timers WHERE id IN (
             SELECT id FROM script_timers WHERE due_at <= ? ORDER BY due_at, id LIMIT ?)
           RETURNING *`,
        )
        .all(now, limit)
        .map(timerOf)
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    },
    pruneCopies(olderThan) {
      return sqlite.query('DELETE FROM script_copies WHERE created_at < ?').run(olderThan).changes
    },
  }
}

interface TimerDb {
  id: string
  script_id: string
  key: string | null
  due_at: number
  data: string
  created_at: number
}
const timerOf = (r: TimerDb): ScriptTimer => ({
  id: r.id,
  scriptId: r.script_id,
  ...(r.key === null ? {} : { key: r.key }),
  dueAt: r.due_at,
  data: r.data,
  createdAt: r.created_at,
})

interface CopyDb {
  connection_id: string
  source_node: string
  source_id: string
  target_node: string
  target_id: string
}
const copyOf = (r: CopyDb): ScriptCopyRow => ({
  connectionId: r.connection_id,
  sourceNode: r.source_node,
  sourceId: r.source_id,
  targetNode: r.target_node,
  targetId: r.target_id,
})
