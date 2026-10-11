/**
 * Routines on the durable inbox (plan M7, decision D3, ADR-0040): the schedule rows, the
 * compare-and-set tick, overlap skip, missed fires, pause / resume, idempotent fires and
 * approvals of unattended runs. Two `compose()` calls on one database file stand for two
 * instances; ticks are driven by hand (`tickMs: 0`) so nothing depends on timers.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { fireId, type Routine, type RoutineRun } from '../src/domain/routines.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteRoutineStore } from '../src/infra/db/routines-repo.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { attn } from './support/attention.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}

function instance(
  dir: string,
  script: Partial<Record<'researcher' | 'writer', ScriptedStepInput[]>>,
  options: { first?: boolean; recoverAfterMs?: number } = {},
): Instance {
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      let model = models[slug]
      if (model === undefined) {
        model = scriptedModel([
          () => {
            throw new Error(`unexpected model call of ${slug}`)
          },
        ])
        models[slug] = model
      }
      return model
    },
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0, recoverAfterMs: options.recoverAfterMs ?? 30_000 },
  })
  servers.push(server)
  if (options.first) {
    for (const slug of ['lead', 'researcher', 'writer']) {
      const def = server.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(server.deps, def.id, { model: `m-${slug}` })
    }
  }
  return { server, app: server.app, models }
}

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'team-m7-'))
  dirs.push(dir)
  return dir
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function create(app: Server['app'], body: Record<string, unknown>): Promise<Routine> {
  const res = await app.request(
    '/routines',
    json('POST', { agentId: 'researcher', name: 'Briefing', prompt: 'Brief me.', ...body }),
  )
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as Routine
}
async function runs(app: Server['app'], id: string): Promise<RoutineRun[]> {
  const res = await app.request(`/routines/${id}/runs`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { runs: RoutineRun[] }).runs
}
async function routine(app: Server['app'], id: string): Promise<Routine> {
  return (await (await app.request(`/routines/${id}`)).json()) as Routine
}
/** Make a routine due: its slot is `at` (default: a second ago). */
function dueAt(server: Server, id: string, at: number): void {
  server.conn.sqlite.query('UPDATE routines SET next_fire_at = ? WHERE id = ?').run(at, id)
}
const finished = (r: RoutineRun) => r.status === 'succeeded' || r.status === 'failed'

describe('routine API', () => {
  test('create validates the schedule, sets the first slot; edit, pause and resume recompute it', async () => {
    const { app, server } = instance(tmp(), {}, {})
    const bad = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'x',
        prompt: 'p',
        schedule: { kind: 'cron', expr: 'nope', tz: 'UTC' },
      }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SCHEDULE')
    const tz = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'x',
        prompt: 'p',
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Mars/Base' },
      }),
    )
    expect(tz.status).toBe(400)
    const fast = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'x',
        prompt: 'p',
        schedule: { kind: 'every', everyMs: 1000 },
      }),
    )
    expect(fast.status).toBe(400) // schema: at least 10 s
    expect(
      (
        await app.request(
          '/routines',
          json('POST', {
            agentId: 'nope',
            name: 'x',
            prompt: 'p',
            schedule: { kind: 'every', everyMs: 60_000 },
          }),
        )
      ).status,
    ).toBe(404)

    const r = await create(app, {
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'Europe/Berlin' },
    })
    expect(r).toMatchObject({
      status: 'active',
      sessionMode: 'task',
      overlap: 'skip',
      catchUpWindowMs: null,
      failures: 0,
    })
    expect(r.nextFireAt).toBeGreaterThan(Date.now())
    const nextDate = new Date(r.nextFireAt as number)
    expect([1, 2, 3, 4, 5]).toContain(nextDate.getUTCDay())
    expect(new Date((r.nextFireAt as number) - 3600_000).getUTCHours()).toBeGreaterThanOrEqual(6) // 9:00 Berlin = 7/8 UTC

    const list = (await (await app.request('/routines?agentId=researcher')).json()) as {
      routines: Routine[]
    }
    expect(list.routines.map((x) => x.id)).toEqual([r.id])

    const patched = await app.request(
      `/routines/${r.id}`,
      json('PATCH', { name: 'Evening', schedule: { kind: 'every', everyMs: 3_600_000 } }),
    )
    expect(patched.status).toBe(200)
    const p = (await patched.json()) as Routine
    expect(p.name).toBe('Evening')
    expect((p.nextFireAt as number) - Date.now()).toBeGreaterThan(3_500_000)

    const paused = (await (
      await app.request(`/routines/${r.id}/pause`, { method: 'POST' })
    ).json()) as Routine
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'manual' })
    dueAt(server, r.id, 1) // stale slot while paused
    const resumed = (await (
      await app.request(`/routines/${r.id}/resume`, { method: 'POST' })
    ).json()) as Routine
    expect(resumed.status).toBe('active')
    expect(resumed.pausedReason).toBeNull()
    expect(resumed.nextFireAt as number).toBeGreaterThan(Date.now()) // recomputed, nothing replayed

    const gone = await app.request(`/routines/${r.id}`, { method: 'DELETE' })
    expect(gone.status).toBe(200)
    expect((await app.request(`/routines/${r.id}`)).status).toBe(404)
    const types = (await (await app.request('/activity?limit=200')).json()) as {
      events: Array<{ type: string; payload: { change?: string } }>
    }
    expect(
      types.events.filter((e) => e.type === 'routine-changed').map((e) => e.payload.change),
    ).toEqual(['created', 'updated', 'paused', 'resumed', 'deleted'])
  })
})

describe('ticker', () => {
  test('two tickers on one database fire a due routine exactly once', async () => {
    const dir = tmp()
    const a = instance(dir, { researcher: [{ text: 'briefing A' }] }, { first: true })
    const b = instance(dir, { researcher: [{ text: 'briefing B' }] })
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    const now = Date.now()
    dueAt(a.server, r.id, now - 1000)

    const [ra, rb] = await Promise.all([a.server.routines.tick(now), b.server.routines.tick(now)])
    expect(ra.fired.length + rb.fired.length).toBe(1)

    const [run] = await runs(a.app, r.id)
    expect(run?.scheduledAt).toBe(now - 1000)
    expect(run?.sessionId).toBe(`routine:${r.id}:${now - 1000}`)
    await until('run succeeded', async () => finished((await runs(a.app, r.id))[0] as RoutineRun))
    expect(await runs(a.app, r.id)).toHaveLength(1)
    expect((await runs(a.app, r.id))[0]?.status).toBe('succeeded')
    // exactly one model call across both instances
    const calls =
      (a.models.researcher?.prompts.length ?? 0) + (b.models.researcher?.prompts.length ?? 0)
    expect(calls).toBe(1)
    const after = await routine(a.app, r.id)
    expect(after.fireCount).toBe(1)
    expect(after.nextFireAt as number).toBeGreaterThan(now)
    expect(after.lastStatus).toBe('succeeded')
    // the run is a task of origin routine on the board
    const board = (await (await a.app.request('/tasks')).json()) as {
      tasks: Array<{ origin: string; sessionId: string }>
    }
    expect(board.tasks.find((t) => t.sessionId === run?.sessionId)?.origin).toBe('routine')
    const feed = (await (await a.app.request('/activity?limit=200')).json()) as {
      events: Array<{ type: string }>
    }
    expect(feed.events.filter((e) => e.type === 'routine-fired').length).toBeGreaterThanOrEqual(2)
  })

  test('the compare-and-set lets one of two connections claim a slot', () => {
    const dir = tmp()
    const a = openDatabase(join(dir, 'team.db'))
    const b = openDatabase(join(dir, 'team.db'))
    try {
      const sa = sqliteRoutineStore(a.sqlite)
      const sb = sqliteRoutineStore(b.sqlite)
      const r = sa.insert({
        id: 'r1',
        agentId: 'ag',
        name: 'n',
        prompt: 'p',
        schedule: { kind: 'every', everyMs: 60_000 },
        sessionMode: 'task',
        overlap: 'skip',
        catchUpWindowMs: null,
        maxFailures: 3,
        maxFires: null,
        endAt: null,
        nextFireAt: 1000,
        now: 1,
      })
      const claim = (store: typeof sa) =>
        store.claimSlot({
          routineId: r.id,
          expectedNext: 1000,
          scheduledAt: 1000,
          nextFireAt: 61_000,
          fire: true,
          status: 'claimed',
          sessionId: 'routine:r1:1000',
          now: 2000,
        })
      const first = claim(sa)
      const second = claim(sb)
      expect(first?.scheduledAt).toBe(1000)
      expect(second).toBeUndefined()
      expect(sb.get('r1')?.fireCount).toBe(1)
      expect(sb.get('r1')?.nextFireAt).toBe(61_000)
    } finally {
      a.close()
      b.close()
    }
  })

  test('missed fires are skipped after downtime; the catch-up window fires the latest slot once', async () => {
    const dir = tmp()
    const a = instance(dir, { researcher: [{ text: 'caught up' }] }, { first: true })
    const now = Date.now()
    const hour = 3_600_000
    const lastMark = Math.floor(now / hour) * hour

    const skipping = await create(a.app, {
      name: 'skip',
      schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    })
    dueAt(a.server, skipping.id, lastMark - 3 * hour)
    const catching = await create(a.app, {
      name: 'catch',
      catchUpWindowMs: 2 * hour,
      schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
    })
    dueAt(a.server, catching.id, lastMark - 3 * hour)

    const report = await a.server.routines.tick(now)
    expect(report.skipped).toEqual([
      { routineId: skipping.id, scheduledAt: lastMark - 3 * hour, reason: 'missed' },
    ])
    expect(report.fired).toHaveLength(1)

    const skippedRuns = await runs(a.app, skipping.id)
    expect(skippedRuns).toHaveLength(1)
    expect(skippedRuns[0]).toMatchObject({ status: 'skipped', reason: 'missed' })
    const s = await routine(a.app, skipping.id)
    expect(s.fireCount).toBe(0) // nothing replayed
    expect(s.nextFireAt).toBe(lastMark + hour)

    const caught = (await runs(a.app, catching.id))[0] as RoutineRun
    expect(caught.scheduledAt).toBe(lastMark) // the latest missed slot, once
    expect(caught.status === 'enqueued' || caught.status === 'succeeded').toBe(true)
    expect(await runs(a.app, catching.id)).toHaveLength(1)
    expect((await routine(a.app, catching.id)).nextFireAt).toBe(lastMark + hour)
  })

  test('overlap skip drops a fire while the previous run is in the way', async () => {
    const a = instance(
      tmp(),
      { researcher: [{ text: 'slow briefing', delayMs: 500 }, { text: 'second briefing' }] },
      { first: true },
    )
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    let now = Date.now()
    dueAt(a.server, r.id, now - 100)
    expect((await a.server.routines.tick(now)).fired).toHaveLength(1)

    now = Date.now()
    dueAt(a.server, r.id, now - 100)
    const second = await a.server.routines.tick(now)
    expect(second.fired).toHaveLength(0)
    expect(second.skipped).toHaveLength(1)
    expect(second.skipped[0]?.reason).toStartWith('overlap')

    await until('first run finished', async () =>
      (await runs(a.app, r.id)).some((x) => x.status === 'succeeded'),
    )
    const all = await runs(a.app, r.id)
    expect(all.map((x) => x.status).sort()).toEqual(['skipped', 'succeeded'])
    // free again: the next slot fires
    now = Date.now()
    dueAt(a.server, r.id, now - 100)
    expect((await a.server.routines.tick(now)).fired).toHaveLength(1)
    await until(
      'second run finished',
      async () => (await runs(a.app, r.id)).filter((x) => x.status === 'succeeded').length === 2,
    )
  })

  test('overlap queue fires anyway', async () => {
    const a = instance(
      tmp(),
      { researcher: [{ text: 'one', delayMs: 300 }, { text: 'two' }] },
      { first: true },
    )
    const r = await create(a.app, {
      overlap: 'queue',
      sessionMode: 'dm',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    for (let i = 0; i < 2; i++) {
      const now = Date.now()
      dueAt(a.server, r.id, now - 100)
      expect((await a.server.routines.tick(now)).fired).toHaveLength(1)
      await sleep(5)
    }
    await until(
      'both ran',
      async () => (await runs(a.app, r.id)).filter((x) => x.status === 'succeeded').length === 2,
    )
  })

  test('pause stops the ticker, resume recomputes the slot and resets failures', async () => {
    const a = instance(tmp(), { researcher: [{ text: 'never' }] }, { first: true })
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    const now = Date.now()
    dueAt(a.server, r.id, now - 100)
    await a.app.request(`/routines/${r.id}/pause`, { method: 'POST' })
    expect((await a.server.routines.tick(now)).fired).toHaveLength(0)
    expect(await runs(a.app, r.id)).toHaveLength(0)
    a.server.conn.sqlite.query('UPDATE routines SET failures = 2 WHERE id = ?').run(r.id)
    const resumed = (await (
      await a.app.request(`/routines/${r.id}/resume`, { method: 'POST' })
    ).json()) as Routine
    expect(resumed.failures).toBe(0)
    expect(resumed.nextFireAt as number).toBeGreaterThan(Date.now() + 3_000_000)
    expect((await a.server.routines.tick(Date.now())).fired).toHaveLength(0)
  })

  test('a one-shot and maxFires stop the routine after the last fire', async () => {
    const a = instance(
      tmp(),
      { researcher: [{ text: 'once' }, { text: 'twice' }] },
      { first: true },
    )
    const at = await create(a.app, {
      name: 'once',
      schedule: { kind: 'at', at: Date.now() + 60_000 },
    })
    const t = at.nextFireAt as number
    expect((await a.server.routines.tick(t)).fired).toHaveLength(1)
    const done = await routine(a.app, at.id)
    expect(done).toMatchObject({
      status: 'paused',
      pausedReason: 'completed',
      nextFireAt: null,
      fireCount: 1,
    })
    const capped = await create(a.app, {
      name: 'cap',
      maxFires: 1,
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    const now = Date.now()
    dueAt(a.server, capped.id, now - 100)
    expect((await a.server.routines.tick(now)).fired).toHaveLength(1)
    expect(await routine(a.app, capped.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'max-fires',
    })
    const exhausted = await a.app.request(`/routines/${capped.id}/resume`, { method: 'POST' })
    expect(exhausted.status).toBe(409)
    await until('runs done', async () => (await runs(a.app, capped.id)).every(finished))
  })

  test('a retried fire is deduplicated: recovery enqueues the claimed slot again, nothing runs twice', async () => {
    const a = instance(
      tmp(),
      { researcher: [{ text: 'only once' }, { text: 'extra' }] },
      { first: true, recoverAfterMs: 0 },
    )
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    const slot = Date.now() - 500
    // the first attempt: claimed the slot and enqueued, then "crashed" before recording the enqueue
    const run = sqliteRoutineStore(a.server.conn.sqlite).claimSlot({
      routineId: r.id,
      expectedNext: r.nextFireAt as number,
      scheduledAt: slot,
      nextFireAt: slot + 3_600_000,
      fire: true,
      status: 'claimed',
      sessionId: `routine:${r.id}:${slot}`,
      now: Date.now() - 1000,
    }) as RoutineRun
    const def = a.server.deps.agents.getBySlug('researcher')
    if (def === undefined) throw new Error('seed')
    await a.server.factory.prepare(def)
    const first = await a.server.factory
      .openSession(def, run.sessionId)
      .enqueue('Brief me.', { mode: 'queue', id: fireId(r.id, slot) })
    expect(first.duplicate).toBeUndefined()

    const report = await a.server.routines.tick(Date.now())
    expect(report.recovered).toBe(1)
    const [after] = await runs(a.app, r.id)
    expect(after?.inboxId).toBe(first.inboxId) // the existing item, not a second one
    expect(after?.reason).toBe('duplicate enqueue')
    await until('run succeeded', async () => finished((await runs(a.app, r.id))[0] as RoutineRun))
    await sleep(200)
    expect(a.models.researcher?.prompts.length).toBe(1)
    const messages = await a.server.factory.peek(run.sessionId).messages()
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  test('consecutive failures pause the routine', async () => {
    const boom: ScriptedStepInput = () => {
      throw new Error('model is down')
    }
    const a = instance(tmp(), { researcher: [boom, boom, boom] }, { first: true })
    const r = await create(a.app, {
      maxFailures: 2,
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    for (let i = 0; i < 2; i++) {
      const now = Date.now()
      dueAt(a.server, r.id, now - 100)
      await a.server.routines.tick(now)
      await until(
        `run ${i} failed`,
        async () => (await runs(a.app, r.id)).filter((x) => x.status === 'failed').length === i + 1,
      )
      await sleep(5)
    }
    const after = await routine(a.app, r.id)
    expect(after).toMatchObject({ status: 'paused', pausedReason: 'max-failures', failures: 2 })
    expect(after.lastStatus).toStartWith('failed')
    const feed = (await (await a.app.request('/activity?limit=300')).json()) as {
      events: Array<{ type: string; payload: { reason?: string } }>
    }
    expect(
      feed.events.some((e) => e.type === 'routine-changed' && e.payload.reason === 'max-failures'),
    ).toBe(true)
  })
})

describe('a failed run says why', () => {
  test('a provider auth failure: the run reason names the fix, the task row keeps the cause, the routine counts it', async () => {
    const denied = Object.assign(new Error('Incorrect API key provided'), { statusCode: 401 })
    const a = instance(tmp(), { researcher: [{ throws: denied }] }, { first: true })
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    const now = Date.now()
    dueAt(a.server, r.id, now - 100)
    await a.server.routines.tick(now)
    await until('run failed', async () =>
      (await runs(a.app, r.id)).some((x) => x.status === 'failed'),
    )
    const run = (await runs(a.app, r.id)).find((x) => x.status === 'failed') as RoutineRun
    expect(run.reason).toContain('Settings > Providers')
    const task = a.server.deps.tasks.getBySession(run.sessionId)
    expect(task?.status).toBe('failed')
    expect(task?.summary).toContain('API key')
    expect((await routine(a.app, r.id)).failures).toBe(1)
  })

  test('any other model error (code and message) is the summary of the failed task', async () => {
    const boom: ScriptedStepInput = () => {
      throw new Error('model is down')
    }
    const a = instance(tmp(), { researcher: [boom] }, { first: true })
    const r = await create(a.app, { schedule: { kind: 'every', everyMs: 3_600_000 } })
    const now = Date.now()
    dueAt(a.server, r.id, now - 100)
    await a.server.routines.tick(now)
    await until('run failed', async () =>
      (await runs(a.app, r.id)).some((x) => x.status === 'failed'),
    )
    const run = (await runs(a.app, r.id)).find((x) => x.status === 'failed') as RoutineRun
    const task = a.server.deps.tasks.getBySession(run.sessionId)
    expect(task?.status).toBe('failed')
    expect(task?.summary).toStartWith('EH_RUN_FAILED')
  })
})

describe('unattended runs', () => {
  test('a fire that needs approval waits in /approvals and is never approved by the scheduler', async () => {
    const a = instance(
      tmp(),
      {
        researcher: [
          { toolCalls: [{ toolName: 'read_file', input: { path: '/library/old.md' } }] },
          { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old.md' } }] },
          { text: 'cleaned' },
        ],
      },
      { first: true },
    )
    await libraryFs(a.server.conn.sqlite).write('/library/old.md', 'old\n')
    const r = await create(a.app, {
      name: 'Clean up',
      prompt: 'Remove /library/old.md',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    const now = Date.now()
    dueAt(a.server, r.id, now - 100)
    await a.server.routines.tick(now)
    await until('needs action', async () => (await runs(a.app, r.id))[0]?.status === 'needs_action')

    const pending = (
      (await (await a.app.request('/approvals')).json()) as {
        approvals: Array<{ id: string; sessionId: string; toolName: string; taskId: string | null }>
      }
    ).approvals
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      toolName: 'delete_file',
      sessionId: `routine:${r.id}:${now - 100}`,
    })
    const needs = (
      (await (await a.app.request('/tasks?status=needs_action')).json()) as {
        tasks: Array<{ origin: string }>
      }
    ).tasks
    expect(needs.map((t) => t.origin)).toEqual(['routine'])
    expect(await libraryFs(a.server.conn.sqlite).read('/library/old.md')).not.toBeNull() // nothing ran

    // while it waits, the next fire is skipped (the previous run is not finished)
    dueAt(a.server, r.id, Date.now() - 100)
    const second = await a.server.routines.tick(Date.now())
    expect(second.skipped[0]?.reason).toStartWith('overlap')

    const answered = await attn(a.app, pending[0], { approved: true })
    expect(answered.status).toBe(200)
    await until('run succeeded', async () =>
      (await runs(a.app, r.id)).some((x) => x.status === 'succeeded'),
    )
    expect(await libraryFs(a.server.conn.sqlite).read('/library/old.md')).toBeNull()
    expect((await routine(a.app, r.id)).failures).toBe(0)
  })

  test('a DM routine lands in the DM chat and its run gets its outcome; run now respects overlap', async () => {
    const a = instance(
      tmp(),
      { researcher: [{ text: 'Good morning!', delayMs: 400 }] },
      { first: true },
    )
    const r = await create(a.app, {
      sessionMode: 'dm',
      prompt: 'Good morning brief',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    const res = await a.app.request(`/routines/${r.id}/run`, { method: 'POST' })
    expect(res.status).toBe(202)
    const run = (await res.json()) as RoutineRun
    expect(run).toMatchObject({ trigger: 'manual', status: 'enqueued' })
    expect(run.sessionId).toStartWith('dm:')
    const busy = await a.app.request(`/routines/${r.id}/run`, { method: 'POST' })
    expect(busy.status).toBe(409)
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('ROUTINE_BUSY')

    await until(
      'outcome recorded',
      async () => (await runs(a.app, r.id))[0]?.status === 'succeeded',
    )
    const dm = (await (await a.app.request('/sessions/dm:researcher/messages')).json()) as {
      messages: Array<{ role: string; parts: Array<{ text?: string }> }>
    }
    expect(dm.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(dm.messages[0]?.parts[0]?.text).toBe('Good morning brief')
    // manual runs do not move the schedule
    expect((await routine(a.app, r.id)).fireCount).toBe(0)
  })

  test('a DM run that parks on a wait with no person follows its continuation turn', async () => {
    const a = instance(tmp(), { researcher: [{ text: 'slow', delayMs: 1_500 }] }, { first: true })
    const r = await create(a.app, {
      sessionMode: 'dm',
      prompt: 'Brief',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    })
    const res = await a.app.request(`/routines/${r.id}/run`, { method: 'POST' })
    const run = (await res.json()) as RoutineRun
    const row = a.server.conn.sqlite
      .query<{ inbox_id: string | null }, [string]>(
        'SELECT inbox_id FROM routine_runs WHERE id = ?',
      )
      .get(run.id)
    const inboxId = row?.inbox_id as string
    expect(inboxId).toBeTruthy()
    const outcomes = a.server.routines.outcomes
    // the first turn parks on a delegated task (no person): the run keeps going
    await outcomes.turnEnded({
      sessionId: run.sessionId,
      inboxId,
      stop: 'tool-pending',
      needsPerson: false,
    })
    expect((await runs(a.app, r.id))[0]?.status).toBe('enqueued')
    // the continuation turn has no inbox id
    await outcomes.turnEnded({ sessionId: run.sessionId, stop: 'complete', needsPerson: false })
    expect((await runs(a.app, r.id))[0]?.status).toBe('succeeded')
  })
})
