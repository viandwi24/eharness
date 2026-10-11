/**
 * A turn a dead process left active is closed by the repair pass (no waiting for the stale
 * timeout), the chat can continue at once, and the task row of an interrupted delegation says
 * `interrupted` (not `failed`). Two `compose()` calls on one database stand for the killed and the
 * restarted instance; the heartbeat of the "dead" one is aged by SQL.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { deriveTaskStatus, statusFromStop } from '../src/domain/tasks.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { sqliteLock } from '../src/infra/eh/storage.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

function instance(dir: string, steps: ScriptedStepInput[], first = false): Server {
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => model,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: !first, everyMs: 0 },
  })
  servers.push(server)
  return server
}

describe('task status of interrupted work', () => {
  test('a stopped-by-crash turn is interrupted, not failed', () => {
    expect(statusFromStop('interrupted')).toBe('interrupted')
    const base = { pendingApprovals: 0, pendingQuestions: 0, activeTurn: false }
    expect(deriveTaskStatus({ ...base, staleTurn: true, lastStop: null }).status).toBe(
      'interrupted',
    )
    expect(
      deriveTaskStatus({ ...base, staleTurn: false, lastStop: null, interruptedNotice: true })
        .status,
    ).toBe('interrupted')
    expect(deriveTaskStatus({ ...base, staleTurn: false, lastStop: 'error' }).status).toBe('failed')
  })
})

describe('the lock of a restarted instance', () => {
  test('is taken over for the same stable owner, never from the live holder (same lock object) or another owner', async () => {
    const db = new Database(':memory:')
    db.run(
      'CREATE TABLE eh_locks (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)',
    )
    const signal = new AbortController().signal
    const first = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    const release = await first.acquire('s', { signal })
    // the process has ONE lock object: the lease it still holds (`held`) is never taken over, so
    // a second acquire on the same object is refused
    expect(first.acquire('s', { signal })).rejects.toThrow('locked elsewhere')
    // a different lock object with the same stable owner cannot tell a live holder from a dead
    // previous run (the tracking is per object), so it takes the lease over: that is the restart
    // case, and why the app builds exactly one lock object per process
    const sibling = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    const siblingRelease = await sibling.acquire('s', { signal })
    expect(siblingRelease).toBeDefined()
    await release()
    await siblingRelease()
    db.run("INSERT OR REPLACE INTO eh_locks VALUES ('t', 'srv:old-run', ?)", [Date.now() + 60_000])
    // the restarted instance (fresh lock object, same owner) takes over what its previous run held
    const restarted = sqliteLock(db, { owner: 'srv', takeOver: true, leaseMs: 60_000 })
    const releaseRestarted = await restarted.acquire('t', { signal })
    expect(releaseRestarted).toBeDefined()
    // another instance cannot
    db.run("INSERT OR REPLACE INTO eh_locks VALUES ('u', 'other:run', ?)", [Date.now() + 60_000])
    expect(restarted.acquire('u', { signal })).rejects.toThrow('locked elsewhere')
    // every lease is released before the database closes: each holds a renewal timer on it
    await releaseRestarted()
    db.close()
  })
})

describe('a released lease', () => {
  // regression: a lease nobody released kept its renewal timer, which fired on a closed database
  // later and failed an unrelated test ("Cannot use a closed database", unhandled between tests)
  test('stops renewing: closing the database right after the release leaves no timer behind', async () => {
    const db = new Database(':memory:')
    db.run(
      'CREATE TABLE eh_locks (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)',
    )
    const lock = sqliteLock(db, { leaseMs: 30 })
    const release = await lock.acquire('s', { signal: new AbortController().signal })
    await release()
    db.close()
    // the renewal interval is 10 ms: an uncleared timer would throw an unhandled error here
    await sleep(60)
  })
})

describe('boot repair of a dead turn', () => {
  test('the repair pass closes it, the chat answers at once, the message has no dangling call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-restart-'))
    dirs.push(dir)
    // instance A "dies" in the middle of a turn: a slow step with a tool call
    const a = instance(
      dir,
      [
        {
          text: 'working',
          toolCalls: [{ toolName: 'write_file', input: { path: '/library/z.md', content: 'z' } }],
          delayMs: 400,
        },
      ],
      true,
    )
    for (const slug of ['lead', 'researcher']) {
      const def = a.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(a.deps, def.id, { model: 'm' })
    }
    const res = await a.app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('start')),
    )
    expect(res.status).toBe(200)
    void res.text().catch(() => undefined)
    const stats = async (s: Server) =>
      (await (await s.app.request('/agents/researcher/stats')).json()) as {
        activeTurn: { owner: string } | null
      }
    await until('turn active', async () => (await stats(a)).activeTurn !== null)
    // the owner is gone: its heartbeat is old
    const sqlite = new Database(join(dir, 'team.db'))
    sqlite.run(
      "UPDATE eh_state SET state = json_set(state, '$.core.activeTurn.heartbeatAt', 0) WHERE json_extract(state, '$.core.activeTurn') IS NOT NULL",
    )
    sqlite.run('UPDATE eh_locks SET until = 0')
    sqlite.close()

    const b = instance(dir, [{ text: 'back again' }])
    await b.ready
    await until('recovered by the repair pass', async () => (await stats(b)).activeTurn === null)
    const stored = (await (await b.app.request('/sessions/dm:researcher/messages')).json()) as {
      messages: Array<{
        role: string
        metadata?: { eharness?: { stop?: string; kind?: string } }
        parts: Array<{ type: string; state?: string }>
      }>
    }
    const interrupted = stored.messages.find((m) => m.metadata?.eharness?.stop === 'interrupted')
    expect(interrupted).toBeDefined()
    const dangling = stored.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type.startsWith('tool-') && p.state === 'input-available')
    expect(dangling).toHaveLength(0)
    const next = await b.app.request(
      '/sessions/dm:researcher/chat',
      postAs(`dm:researcher`, userMessage('Continue')),
    )
    expect(next.status).toBe(200)
    expect(await next.text()).toContain('back again')
  })
})

describe('boot repair of a heartbeat beat', () => {
  // found by the soak test (scripts/soak.ts): the rolling session `heartbeat:<agentId>` has no task
  // row, so a killed beat kept its active turn and a `running` record for good
  test('a beat the dead process left running is closed with its turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-restart-hb-'))
    dirs.push(dir)
    const a = instance(
      dir,
      [{ toolCalls: [{ toolName: 'team_status', input: {} }], delayMs: 1500 }],
      true,
    )
    const lead = a.deps.agents.getBySlug('lead')
    if (lead === undefined) throw new Error('seed missing')
    await a.app.request(`/agents/${lead.id}/heartbeat`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeFrom: '00:00', activeTo: '00:00' }),
    })
    await a.deps.library.writeText(
      `/memories/agents/${lead.id}/HEARTBEAT.md`,
      '- look at the board\n',
    )
    const started = await a.heartbeats.heartbeat(lead.id, { slot: Date.now() })
    expect(started.started).toBe(true)
    const stats = async (s: Server) =>
      (await (await s.app.request(`/agents/${lead.id}/stats`)).json()) as {
        activeTurn: unknown | null
      }
    await until('the beat session has an active turn', async () => {
      const row = a.conn.sqlite
        .query('SELECT state FROM eh_state WHERE session_id = ?')
        .get(`heartbeat:${lead.id}`) as { state: string } | null
      return row?.state.includes('"activeTurn"') === true
    })
    // the owner is gone
    const sqlite = new Database(join(dir, 'team.db'))
    sqlite.run(
      "UPDATE eh_state SET state = json_set(state, '$.core.activeTurn.heartbeatAt', 0) WHERE json_extract(state, '$.core.activeTurn') IS NOT NULL",
    )
    sqlite.run('UPDATE eh_locks SET until = 0')
    sqlite.close()

    const b = instance(dir, [{ text: 'unused' }])
    await b.ready
    await until('the beat record is closed', async () => {
      const view = (await (await b.app.request(`/agents/${lead.id}/heartbeat`)).json()) as {
        beats: Array<{ status: string; reason: string | null }>
      }
      return view.beats[0]?.status === 'failed'
    })
    const view = (await (await b.app.request(`/agents/${lead.id}/heartbeat`)).json()) as {
      beats: Array<{ status: string; reason: string | null }>
    }
    expect(view.beats[0]?.reason).toContain('interrupted')
    void stats
  })
})

describe('boot repair of a scheduled program run', () => {
  // found by the soak test (scripts/soak.ts): the run's turn was closed as interrupted, but its
  // routine run row stayed `enqueued` for good (nothing reported the end to the routine)
  test('the routine run of a killed program run ends too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-restart-run-'))
    dirs.push(dir)
    const a = instance(
      dir,
      [
        {
          toolCalls: [
            { toolName: 'write_file', input: { path: '/library/reports/r.md', content: 'x' } },
          ],
          delayMs: 1500,
        },
      ],
      true,
    )
    const res = await a.app.request('/programs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'researcher',
        name: 'Nightly',
        brief: 'Write the report.',
        authority: { read: ['/library/**'], write: ['/library/reports/**'] },
        gates: [],
        escalation: '',
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
        trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
      }),
    })
    expect(res.status).toBe(201)
    const program = (await res.json()) as { id: string }
    const owned = a.deps.routines.getByProgram(program.id)
    const now = Date.now()
    a.conn.sqlite
      .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
      .run(now - 1000, owned?.id as string)
    await a.routines.tick(now)
    await until('the run is on its model call', async () => {
      const row = a.conn.sqlite
        .query("SELECT state FROM eh_state WHERE session_id LIKE 'program:%'")
        .get() as { state: string } | null
      return row?.state.includes('"activeTurn"') === true
    })
    const sqlite = new Database(join(dir, 'team.db'))
    sqlite.run(
      "UPDATE eh_state SET state = json_set(state, '$.core.activeTurn.heartbeatAt', 0) WHERE json_extract(state, '$.core.activeTurn') IS NOT NULL",
    )
    sqlite.run('UPDATE eh_locks SET until = 0')
    sqlite.close()

    const b = instance(dir, [{ text: 'unused' }])
    await b.ready
    const state = () =>
      b.conn.sqlite
        .query(
          'SELECT r.status AS run, t.state AS task FROM routine_runs r JOIN tasks t ON t.session_id = r.session_id',
        )
        .get() as { run: string; task: string } | null
    await until('the task is interrupted', async () => state()?.task === 'interrupted')
    await until('the routine run ends with it', async () => state()?.run !== 'enqueued', 4000)
    expect(state()?.run).toBe('failed')
  })
})
