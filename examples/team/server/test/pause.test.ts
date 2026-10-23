/**
 * Pause all: one durable gate for everything automatic. A paused workspace skips scheduled slots
 * (recorded, never replayed), keeps queued tasks queued, holds chat wakes when asked, and still
 * lets the owner act (manual run, chat). Nothing changes status, the state survives a reopen and
 * is not exported.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { createTask } from '../src/app/work-queue.ts'
import { collectEntities } from '../src/app/workspace-export.ts'
import { skipReasonText } from '../src/domain/pause.ts'
import type { Routine, RoutineRun } from '../src/domain/routines.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
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
  dbFile: string
}

function instance(
  script: Partial<Record<'lead' | 'researcher', ScriptedStepInput[]>>,
  dir = mkdtempSync(join(tmpdir(), 'team-pause-')),
): Instance {
  if (!dirs.includes(dir)) dirs.push(dir)
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
  const dbFile = join(dir, 'team.db')
  const server = compose({
    dbFile,
    instanceId: 'pause-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0, retryUnknown: false },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, app: server.app, models, dbFile }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

interface PauseView {
  paused: boolean
  pausedAt: number | null
  pausedBy: string | null
  note: string | null
  holdChannels: boolean
  held: {
    programs: number
    routines: number
    reminders: number
    heartbeat: boolean
    digest: boolean
    queuedTasks: number
    runningTurns: number
  }
  skippedWhilePaused: number
}
const getPause = async (app: Server['app']): Promise<PauseView> =>
  (await (await app.request('/workspace/pause')).json()) as PauseView
const pause = async (
  app: Server['app'],
  body: Record<string, unknown> = {},
): Promise<PauseView> => {
  const res = await app.request('/workspace/pause', json('POST', body))
  expect(res.status).toBe(200)
  return (await res.json()) as PauseView
}
const resume = async (app: Server['app']): Promise<PauseView> => {
  const res = await app.request('/workspace/resume', json('POST'))
  expect(res.status).toBe(200)
  return (await res.json()) as PauseView
}

async function createRoutine(app: Server['app']): Promise<Routine> {
  const res = await app.request(
    '/routines',
    json('POST', {
      agentId: 'researcher',
      name: 'Briefing',
      prompt: 'Brief me.',
      schedule: { kind: 'every', everyMs: 3_600_000 },
    }),
  )
  expect(res.status).toBe(201)
  return (await res.json()) as Routine
}
const runsOf = async (app: Server['app'], id: string): Promise<RoutineRun[]> =>
  ((await (await app.request(`/routines/${id}/runs`)).json()) as { runs: RoutineRun[] }).runs
const routineOf = async (app: Server['app'], id: string): Promise<Routine> =>
  (await (await app.request(`/routines/${id}`)).json()) as Routine
const dueAt = (server: Server, id: string, at: number): void => {
  server.conn.sqlite.query('UPDATE routines SET next_fire_at = ? WHERE id = ?').run(at, id)
}

describe('the gate and its API', () => {
  test('pause is idempotent, keeps pausedAt, counts what it holds, and resume restores everything', async () => {
    const { app, server } = instance({})
    const r = await createRoutine(app)
    expect((await getPause(app)).paused).toBe(false)

    const first = await pause(app, { note: 'deploying' })
    expect(first).toMatchObject({
      paused: true,
      pausedBy: 'owner',
      note: 'deploying',
      holdChannels: true,
      skippedWhilePaused: 0,
    })
    expect(first.held.routines).toBe(1)
    expect(first.held.heartbeat).toBe(true)
    const second = await pause(app, { note: 'still deploying', holdChannels: false })
    expect(second.pausedAt).toBe(first.pausedAt)
    expect(second).toMatchObject({ note: 'still deploying', holdChannels: false })

    // no item changed status
    expect((await routineOf(app, r.id)).status).toBe('active')

    const done = await resume(app)
    expect(done).toMatchObject({ paused: false, pausedAt: null, skippedWhilePaused: 0 })
    expect((await routineOf(app, r.id)).status).toBe('active')

    const events = (await (await app.request('/activity?limit=200')).json()) as {
      events: Array<{ type: string; payload: { change?: string } }>
    }
    expect(
      events.events
        .filter((e) => e.type === 'settings-changed' && e.payload.change !== undefined)
        .map((e) => e.payload.change),
    ).toEqual(['paused', 'paused', 'resumed'])
    expect(server.deps.pause.get().pausedAt).toBeNull()
  })

  test('the state survives a reopen of the database and other rows are untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-pause-'))
    const a = instance({}, dir)
    a.server.deps.settings.patch({ teamName: 'Keep me' }, Date.now())
    const before = a.server.conn.sqlite
      .query<{ key: string; value: string }, []>(
        "SELECT key, value FROM settings WHERE key != 'workspace-pause' ORDER BY key",
      )
      .all()
    const paused = await pause(a.app, { note: 'across restarts' })
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    const b = instance({}, dir)
    const after = await getPause(b.app)
    expect(after).toMatchObject({
      paused: true,
      pausedAt: paused.pausedAt,
      note: 'across restarts',
    })
    expect(
      b.server.conn.sqlite
        .query<{ key: string; value: string }, []>(
          "SELECT key, value FROM settings WHERE key != 'workspace-pause' ORDER BY key",
        )
        .all(),
    ).toEqual(before)
    await resume(b.app)
    expect(
      b.server.conn.sqlite
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM settings WHERE key = 'workspace-pause'",
        )
        .get()?.n,
    ).toBe(0)
  })

  test('the export does not carry the paused state', async () => {
    const { app, server } = instance({})
    await pause(app, { note: 'secret-pause-note' })
    const files = await collectEntities(server.deps)
    expect(files.length).toBeGreaterThan(0)
    const all = files.map((f) => Buffer.from(f.bytes).toString('utf8')).join('\n')
    expect(all).not.toContain('workspace-pause')
    expect(all).not.toContain('secret-pause-note')
    const res = await app.request('/backups/export')
    expect(res.status).toBe(200)
    const zip = Buffer.from(await res.arrayBuffer()).toString('latin1')
    expect(zip).not.toContain('workspace-pause')
  })
})

describe('routines', () => {
  test('a due slot is skipped as paused, advances the schedule and is not replayed after resume', async () => {
    const { app, server, models } = instance({ researcher: [{ text: 'briefing' }] })
    const r = await createRoutine(app)
    await pause(app)
    const now = Date.now()
    dueAt(server, r.id, now - 1000)

    const report = await server.routines.tick(now)
    expect(report.fired).toHaveLength(0)
    expect(report.skipped).toEqual([{ routineId: r.id, scheduledAt: now - 1000, reason: 'paused' }])
    const [run] = await runsOf(app, r.id)
    expect(run).toMatchObject({ status: 'skipped', reason: 'paused' })
    expect(skipReasonText(run?.reason ?? null)).toBe('Skipped: workspace paused')
    const after = await routineOf(app, r.id)
    expect(after.status).toBe('active')
    expect(after.fireCount).toBe(0)
    expect(after.nextFireAt as number).toBeGreaterThan(now)
    expect(models.researcher?.prompts.length ?? 0).toBe(0)
    expect((await getPause(app)).skippedWhilePaused).toBe(1)

    await resume(app)
    const again = await server.routines.tick(now + 1000)
    expect(again.fired).toHaveLength(0)
    expect(await runsOf(app, r.id)).toHaveLength(1)
    expect(models.researcher?.prompts.length ?? 0).toBe(0)

    // the next slot after the pause fires as usual
    dueAt(server, r.id, now + 2000)
    const next = await server.routines.tick(now + 2500)
    expect(next.fired).toHaveLength(1)
    await until('fired run finished', async () => {
      const latest = (await runsOf(app, r.id))[0]
      return latest?.status === 'succeeded'
    })
  })

  test('a one-shot slot due while paused stays pending and fires once, late, after resume', async () => {
    const { app, server, models } = instance({ researcher: [{ text: 'reminder done' }] })
    const res = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'Once',
        prompt: 'Say it once.',
        schedule: { kind: 'at', at: Date.now() + 3_600_000 },
      }),
    )
    expect(res.status).toBe(201)
    const r = (await res.json()) as Routine
    await pause(app)
    const slot = Date.now()
    dueAt(server, r.id, slot)

    const during = await server.routines.tick(slot + 1000)
    expect(during.fired).toHaveLength(0)
    expect(await runsOf(app, r.id)).toHaveLength(0) // nothing recorded, nothing advanced
    expect((await routineOf(app, r.id)).nextFireAt).toBe(slot)
    expect((await routineOf(app, r.id)).status).toBe('active')

    await resume(app)
    // far later than the grace period: late because of the pause, so it fires instead of being missed
    const after = await server.routines.tick(slot + 10 * 60_000)
    expect(after.fired).toHaveLength(1)
    await until('one-shot answered', () => (models.researcher?.prompts.length ?? 0) === 1)
    const done = await runsOf(app, r.id)
    expect(done).toHaveLength(1)
    expect(done[0]?.status).not.toBe('skipped')
    // fired once: the schedule is complete
    expect((await routineOf(app, r.id)).status).toBe('paused')
    expect((await server.routines.tick(slot + 20 * 60_000)).fired).toHaveLength(0)
  })

  test('a one-shot slot that was missed before the pause is still skipped as missed', async () => {
    const { app, server } = instance({})
    const res = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'Old',
        prompt: 'Old.',
        schedule: { kind: 'at', at: Date.now() + 3_600_000 },
      }),
    )
    const r = (await res.json()) as Routine
    const old = Date.now() - 10 * 60_000
    dueAt(server, r.id, old)
    await pause(app)
    await resume(app)
    const report = await server.routines.tick(Date.now())
    expect(report.skipped).toEqual([{ routineId: r.id, scheduledAt: old, reason: 'missed' }])
  })

  test('a manual run still works while paused', async () => {
    const { app, models } = instance({ researcher: [{ text: 'manual briefing' }] })
    const r = await createRoutine(app)
    await pause(app)
    const res = await app.request(`/routines/${r.id}/run`, json('POST'))
    expect(res.status).toBe(202)
    await until('manual run answered', () => (models.researcher?.prompts.length ?? 0) === 1)
  })
})

describe('queued tasks', () => {
  test('stay queued while paused and start after resume', async () => {
    const { app, server } = instance({
      researcher: [{ text: 'done' }, { text: 'done' }, { text: 'done' }],
    })
    const researcher = server.deps.agents.getBySlug('researcher')?.id as string
    await pause(app)
    const task = createTask(server.deps, { agentId: researcher, title: 'Collect numbers' })
    expect(task.status).toBe('queued')
    await sleep(120)
    expect(server.deps.tasks.get(task.id)?.status).toBe('queued')
    expect((await getPause(app)).held.queuedTasks).toBe(1)

    const done = await resume(app)
    expect(done.paused).toBe(false)
    await until('task started', () => server.deps.tasks.get(task.id)?.status !== 'queued')
  })
})

describe('chat channels', () => {
  const ceo = { id: '1001', name: 'Vian Dwi', username: 'vian' }

  async function connect(server: Server, leadId: string): Promise<MockAdapter> {
    const gw = server.channels
    gw.configure({
      connectionId: 'c1',
      agentId: leadId,
      rate: { chatMinIntervalMs: 0 },
      people: { defaultRole: 'guest', policy: {} },
    })
    const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room' })
    gw.settings.set(room.id, { enabled: true, label: 'Ops', ack: false } as never)
    const mock = createMockAdapter({ connectionId: 'c1' })
    await gw.register(mock)
    gw.people.setRole('c1', ceo.id, { role: 'owner' }, 'owner')
    return mock
  }

  test('with holdChannels a message is kept but no agent wakes; without it the agent answers', async () => {
    const i = instance({ lead: [{ text: 'hi there' }] })
    const lead = i.server.deps.agents.getBySlug('lead')?.id as string
    const mock = await connect(i.server, lead)

    await pause(i.app, { holdChannels: true })
    await mock.say({ from: ceo, text: '@team_bot status?', id: 'm1', mentionSelf: true })
    await sleep(500)
    expect(mock.sent).toHaveLength(0)
    expect(i.models.lead?.prompts.length ?? 0).toBe(0)
    const row = i.server.conn.sqlite
      .query<{ handled: number; disposition: string }, []>(
        "SELECT handled, disposition FROM ch_messages WHERE native_id = 'm1'",
      )
      .get()
    expect(row).toMatchObject({ handled: 1, disposition: 'observed' })

    // pausing without the channel hold lets messages through
    await pause(i.app, { holdChannels: false })
    await mock.say({ from: ceo, text: '@team_bot again?', id: 'm2', mentionSelf: true })
    await until('answered', () => mock.sent.some((s) => s.message.text === 'hi there'))

    // after resume nothing answers the held message
    await resume(i.app)
    await sleep(400)
    expect(mock.sent).toHaveLength(1)
    expect(i.models.lead?.prompts.length).toBe(1)
  })
})
