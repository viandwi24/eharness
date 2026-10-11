/**
 * Heartbeat and daily digest (docs/plans/P40-team-autonomous-operations.md, phase E): the pure
 * rules (checklist, active hours, findings, deduplication, request clusters, the digest text), the
 * beat on a scripted model (no model call when there is nothing to check, ok shows nothing,
 * attention goes to the digest and urgent to the DM once), the parked beat, program suggestions,
 * the digest of a day, and the routine that wakes it (restart and recovery). Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { createProposal } from '../src/app/decisions.ts'
import { digestBuffer, teamStatus } from '../src/app/heartbeat.ts'
import {
  type BeatItem,
  buildDigest,
  checklistIsEmpty,
  checklistPath,
  clusterRequests,
  dailyCron,
  fingerprintOf,
  HEARTBEAT_ALLOWED,
  heartbeatKey,
  inActiveHours,
  localDay,
  localMinutes,
  observe,
  parseBeatResult,
  parseSystemKey,
  pushBeat,
  splitNew,
} from '../src/domain/heartbeat.ts'
import { originOfSession, profileOfSession } from '../src/domain/run-profiles.ts'
import type { Task } from '../src/domain/tasks.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  prefix = 'a'
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

type Slug = 'lead' | 'researcher'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
  leadId: string
}

function instance(
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: { dir?: string; catalog?: Record<string, unknown> } = {},
): Instance {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'team-p40e-'))
  if (options.dir === undefined) dirs.push(dir)
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
    instanceId: 'heartbeat-test',
    models: config,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog as never }),
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  const leadId = (server.deps.agents.getBySlug('lead') as { id: string }).id
  return { server, app: server.app, models, leadId }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

let prefix = 'a'
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `${prefix}-${toolName}-${Math.random()}` }],
})
const beatResult = (
  status: 'ok' | 'attention',
  items: Array<Partial<BeatItem> & { title: string }> = [],
): ScriptedStepInput =>
  call('final_answer', {
    status,
    items: items.map((i) => ({ kind: 'note', detail: 'detail', links: [], ...i })),
  })
const OK = [call('team_status', {}), beatResult('ok')]

interface BeatView {
  id: string
  status: string
  reason: string | null
  count: number
  items: BeatItem[]
  duplicates: number
}
interface HeartbeatView {
  config: {
    enabled: boolean
    everyMinutes: number
    activeFrom: string
    activeTo: string
    timezone: string | null
  }
  effectiveTimezone: string
  stored: boolean
  checklist: { path: string; exists: boolean; empty: boolean }
  trigger: { status: string; nextFireAt: number | null } | null
  beats: BeatView[]
  digest: {
    enabled: boolean
    time: string
    timezone: string | null
    effectiveTimezone: string
    buffered: number
  }
}

const view = async (app: Server['app'], agent: string): Promise<HeartbeatView> => {
  const res = await app.request(`/agents/${agent}/heartbeat`)
  expect(res.status).toBe(200)
  return (await res.json()) as HeartbeatView
}
const configure = async (app: Server['app'], agent: string, body: Record<string, unknown>) => {
  const res = await app.request(`/agents/${agent}/heartbeat`, json('PATCH', body))
  if (res.status !== 200) throw new Error(await res.text())
  return (await res.json()) as HeartbeatView
}
/** Always active (the hours are tested on their own), a real checklist. */
async function setUp(
  i: Instance,
  checklist: string | null = '- check the library for new findings',
) {
  await configure(i.app, i.leadId, { activeFrom: '00:00', activeTo: '00:00' })
  if (checklist !== null) {
    await i.server.deps.library.writeText(checklistPath(i.leadId), checklist)
  }
}
let slot = Date.now()
const fire = (i: Instance, agentId = i.leadId) =>
  i.server.heartbeats.heartbeat(agentId, { slot: ++slot })
async function beatEnds(i: Instance, n = 1) {
  await i.server.heartbeats.idle()
  await until('the beat is recorded', async () => {
    const beats = (await view(i.app, i.leadId)).beats
    return beats.length >= n && beats[0]?.status !== 'running'
  })
}
const callsOf = (i: Instance) => i.models.lead?.calls.length ?? 0

/** The bell: notifications not dismissed yet (`GET /notifications`). */
async function notifications(
  i: Instance,
): Promise<Array<{ id: string; kind: string; title: string; link: string | null }>> {
  const res = await i.app.request('/notifications')
  return ((await res.json()) as { notifications: never[] }).notifications
}

/** The `eh.event` messages the lead's first thread holds. */
async function dmEvents(i: Instance): Promise<Array<{ name: string; text: string }>> {
  const res = await i.app.request(`/sessions/dm:${i.leadId}/messages?limit=100`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
  return body.messages
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'data-eh.event')
    .map((p) => p.data as { name: string; text: string })
}

const task = (over: Partial<Task>): Task =>
  ({
    id: 't1',
    agentId: 'a',
    sessionId: 'task:t1',
    parentSessionId: null,
    origin: 'lead',
    title: 'Write the script',
    status: 'running',
    pendingKind: null,
    startedAt: 0,
    endedAt: null,
    summary: null,
    lastActivityAt: 0,
    costUsd: 0,
    tokens: 0,
    report: null,
    ...over,
  }) as Task

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0)

describe('domain', () => {
  test('the origin of heartbeat:<agentId> and its profile', () => {
    expect(originOfSession('heartbeat:abc')).toBe('heartbeat')
    expect(profileOfSession('heartbeat:abc')).toMatchObject({
      unattended: true,
      feedsMemory: false,
      resultTo: 'none',
      task: null,
    })
    expect(HEARTBEAT_ALLOWED).toContain('team_status')
    expect(HEARTBEAT_ALLOWED).not.toContain('write_file')
    expect(parseSystemKey(heartbeatKey('x'))).toEqual({ kind: 'heartbeat', agentId: 'x' })
    expect(parseSystemKey('sys:digest')).toEqual({ kind: 'digest' })
    expect(parseSystemKey('program-1')).toBeUndefined()
    expect(parseSystemKey(null)).toBeUndefined()
  })

  test('an empty checklist is only headings, comments and bare markers', () => {
    expect(checklistIsEmpty(undefined)).toBe(true)
    expect(checklistIsEmpty('')).toBe(true)
    expect(
      checklistIsEmpty('# Heartbeat\n\n<!-- nothing yet\n  still nothing -->\n\n## Later\n'),
    ).toBe(true)
    expect(checklistIsEmpty('# H\n- [ ]\n-\n---\n')).toBe(true)
    expect(checklistIsEmpty('# H\n- [ ] check the reports\n')).toBe(false)
    expect(checklistIsEmpty('look at /library/inbox')).toBe(false)
  })

  test('active hours honour the timezone and windows that wrap midnight', () => {
    const noon = Date.UTC(2026, 9, 12, 12, 0)
    const c = { activeFrom: '08:00', activeTo: '20:00', timezone: 'UTC' }
    expect(inActiveHours(noon, c)).toBe(true)
    expect(inActiveHours(Date.UTC(2026, 9, 12, 20, 0), c)).toBe(false) // `to` is exclusive
    expect(inActiveHours(Date.UTC(2026, 9, 12, 7, 59), c)).toBe(false)
    // 12:00 UTC is 19:00 in Jakarta, 21:00 there is outside 08-20
    expect(inActiveHours(noon, { ...c, timezone: 'Asia/Jakarta' })).toBe(true)
    expect(inActiveHours(Date.UTC(2026, 9, 12, 14, 30), { ...c, timezone: 'Asia/Jakarta' })).toBe(
      false,
    )
    const night = { activeFrom: '22:00', activeTo: '06:00', timezone: 'UTC' }
    expect(inActiveHours(Date.UTC(2026, 9, 12, 23, 0), night)).toBe(true)
    expect(inActiveHours(Date.UTC(2026, 9, 12, 5, 0), night)).toBe(true)
    expect(inActiveHours(noon, night)).toBe(false)
    expect(inActiveHours(noon, { ...c, activeFrom: '09:00', activeTo: '09:00' })).toBe(true)
    expect(localMinutes(noon, 'Asia/Jakarta')).toBe(19 * 60)
    expect(localDay(Date.UTC(2026, 9, 12, 20, 0), 'Asia/Jakarta')).toBe('2026-10-13')
    expect(dailyCron('18:05')).toBe('5 18 * * *')
  })

  test('observe: stuck, waiting, failed, old decisions, programs, routines, connectors, budget', () => {
    const h = 3_600_000
    const findings = observe({
      now: NOW,
      tasks: [
        task({ id: 'stuck', lastActivityAt: NOW - 3 * h }),
        task({ id: 'fresh', lastActivityAt: NOW - h / 2 }),
        task({
          id: 'wait',
          status: 'needs_action',
          pendingKind: 'approval',
          lastActivityAt: NOW - 7 * h,
        }),
        task({ id: 'bad', status: 'failed', endedAt: NOW - h, summary: 'boom' }),
        task({ id: 'old-bad', status: 'failed', endedAt: NOW - 30 * h }),
        // a failed program run is the program's finding, not a task one
        task({ id: 'run', status: 'failed', endedAt: NOW - h, sessionId: 'program:p1:1' }),
      ],
      decisions: [
        {
          id: 'd1',
          title: 'Approve the plan',
          kind: 'proposal',
          createdAt: NOW - 25 * h,
          status: 'open',
        },
        { id: 'd2', title: 'New', kind: 'proposal', createdAt: NOW - h, status: 'open' },
      ],
      programs: [
        {
          program: { id: 'p1', name: 'Audit', status: 'active', agentId: 'a' },
          trigger: { status: 'active', pausedReason: null },
          runs: [{ id: 'run', status: 'failed', endedAt: NOW - h, summary: 'No access' }],
        },
        {
          program: { id: 'p2', name: 'Scripts', status: 'active', agentId: 'a' },
          trigger: { status: 'paused', pausedReason: 'max-failures' },
          runs: [],
        },
      ],
      routines: [
        {
          id: 'r1',
          name: 'Morning',
          status: 'active',
          pausedReason: null,
          failures: 2,
          maxFailures: 3,
          lastStatus: 'failed',
        },
        {
          id: 'r2',
          name: 'Weekly',
          status: 'paused',
          pausedReason: 'max-failures',
          failures: 3,
          maxFailures: 3,
          lastStatus: 'failed',
        },
        {
          id: 'r3',
          name: 'Fine',
          status: 'active',
          pausedReason: null,
          failures: 0,
          maxFailures: 3,
          lastStatus: 'succeeded',
        },
      ],
      connections: [
        { id: 'c1', label: 'GitHub', status: 'needs-auth' },
        { id: 'c2', label: 'Web', status: 'connected' },
      ],
      budget: { spentUsd: 96, limitUsd: 100 },
      requests: [],
      existing: [],
    })
    const byKind = (k: string) => findings.filter((f) => f.kind === k).map((f) => f.fingerprint)
    expect(byKind('task.stuck')).toEqual(['task.stuck:stuck'])
    expect(byKind('task.waiting')).toEqual(['task.waiting:wait'])
    expect(byKind('task.failed')).toEqual(['task.failed:bad'])
    expect(byKind('decision.open')).toEqual(['decision.open:d1'])
    expect(byKind('program.failing')).toEqual(['program.failing:p1:run'])
    expect(byKind('program.paused')).toEqual(['program.paused:p2'])
    expect(byKind('routine.failing')).toHaveLength(2)
    expect(byKind('connector.reauth')).toEqual(['connector.reauth:c1'])
    expect(byKind('budget.near')).toEqual(['budget.near:urgent'])
    // paused programs and routines and a budget at the limit are urgent, the rest is not
    expect(
      findings
        .filter((f) => f.urgent)
        .map((f) => f.kind)
        .sort(),
    ).toEqual(['budget.near', 'program.paused', 'routine.failing'])
    // deterministic
    expect(
      observe({
        now: NOW,
        tasks: [],
        decisions: [],
        programs: [],
        routines: [],
        connections: [],
        budget: { spentUsd: 10, limitUsd: 100 },
        requests: [],
        existing: [],
      }),
    ).toEqual([])
  })

  test('requests: at least three similar ones in 14 days, not two, not old ones', () => {
    const day = 86_400_000
    const ask = (text: string, daysAgo: number) => ({
      source: 'dm' as const,
      text,
      at: NOW - daysAgo * day,
    })
    const sales = [
      ask('Summarize the weekly sales numbers for Europe', 9),
      ask('Please summarize weekly sales numbers for Asia', 5),
      ask('Can you summarize the weekly sales numbers for the US', 1),
    ]
    const other = [ask('Translate the contract into French', 2)]
    const found = clusterRequests([...sales, ...other], NOW)
    expect(found).toHaveLength(1)
    expect(found[0]?.requests).toHaveLength(3)
    expect(found[0]?.topic).toContain('sale')
    // two are not a pattern
    expect(clusterRequests(sales.slice(0, 2), NOW)).toEqual([])
    // the third is too old
    expect(
      clusterRequests([sales[0] as never, sales[1] as never, ask(sales[2]?.text ?? '', 20)], NOW),
    ).toEqual([])
    // the same words over and over with nothing in common are no pattern either
    expect(
      clusterRequests(
        [ask('alpha bravo charlie', 1), ask('delta echo foxtrot', 2), ask('golf hotel india', 3)],
        NOW,
      ),
    ).toEqual([])

    const input = {
      now: NOW,
      tasks: [],
      decisions: [],
      programs: [],
      routines: [],
      connections: [],
      budget: null,
      requests: sales,
      existing: [],
    }
    expect(observe(input).map((f) => f.kind)).toEqual(['program.suggestion'])
    // a program or an open proposal about it already exists: no suggestion
    expect(observe({ ...input, existing: ['Weekly sales summary'] })).toEqual([])
  })

  test('deduplication by fingerprint inside the window, once per result', () => {
    const item = (title: string, fingerprint?: string): BeatItem => ({
      kind: 'task.stuck',
      title,
      detail: '',
      links: ['/tasks/1'],
      urgent: false,
      fingerprint: fingerprint ?? fingerprintOf({ kind: 'task.stuck', title, links: ['/tasks/1'] }),
    })
    const a = item('Stuck: Write script')
    expect(fingerprintOf(a)).toBe(fingerprintOf({ ...a, title: 'STUCK:  write script!' }))
    const first = splitNew([a, a, item('Other')], {}, NOW)
    expect(first.fresh.map((i) => i.title)).toEqual(['Stuck: Write script', 'Other'])
    expect(first.duplicates).toBe(1)
    const reported = { [a.fingerprint]: NOW }
    expect(splitNew([a], reported, NOW + 3_600_000).duplicates).toBe(1)
    // after the window it is reported again
    expect(splitNew([a], reported, NOW + 25 * 3_600_000).fresh).toHaveLength(1)
    // a suggestion keeps its longer window
    const s = { ...item('x', 'program.suggestion:sales'), kind: 'program.suggestion' }
    expect(splitNew([s], { [s.fingerprint]: NOW }, NOW + 10 * 86_400_000).fresh).toHaveLength(0)
    expect(splitNew([s], { [s.fingerprint]: NOW }, NOW + 15 * 86_400_000).fresh).toHaveLength(1)
  })

  test('history collapses identical skips, and a beat result is parsed defensively', () => {
    const rec = (id: string, status: 'skipped' | 'ok', reason: string | null, at: number) => ({
      id,
      at,
      endedAt: at,
      status,
      reason,
      count: 1,
      items: [],
      duplicates: 0,
    })
    let beats = pushBeat([], rec('1', 'skipped', 'empty checklist', 1))
    beats = pushBeat(beats, rec('2', 'skipped', 'empty checklist', 2))
    beats = pushBeat(beats, rec('3', 'skipped', 'outside active hours', 3))
    beats = pushBeat(beats, rec('4', 'ok', null, 4))
    expect(beats.map((b) => [b.status, b.count])).toEqual([
      ['ok', 1],
      ['skipped', 1],
      ['skipped', 2],
    ])
    expect(parseBeatResult({ status: 'maybe' })).toBeUndefined()
    expect(parseBeatResult(null)).toBeUndefined()
    expect(parseBeatResult({ status: 'ok' })).toEqual({ items: [] })
    const parsed = parseBeatResult({
      status: 'attention',
      items: [
        { title: '  ', detail: 'x' },
        { title: 'A', kind: 'task.stuck', links: ['/x', 3], urgent: true },
      ],
    })
    expect(parsed?.items).toHaveLength(1)
    expect(parsed?.items[0]).toMatchObject({ title: 'A', links: ['/x'], urgent: true })
    expect(parsed?.items[0]?.fingerprint).toBe('task.stuck:a:/x')
  })

  test('the digest text: what ran, what waits, what was noticed, what it cost', () => {
    const report = (summary: string, outputs: string[]) =>
      ({ status: 'done', summary, outputs }) as const
    const digest = buildDigest({
      since: NOW - 86_400_000,
      until: NOW,
      runs: [
        {
          programName: 'Video scripts',
          report: 'digest',
          task: {
            id: 't1',
            status: 'done',
            summary: null,
            report: report('Wrote 3 scripts', ['/library/reports/a.md']),
          },
        },
        {
          programName: 'Audit',
          report: 'task',
          task: { id: 't2', status: 'done', summary: null, report: report('Quiet day', []) },
        },
        {
          programName: 'Secret',
          report: 'silent',
          task: { id: 't3', status: 'done', summary: null, report: report('hidden', []) },
        },
      ],
      decisions: [{ id: 'd1', title: 'Approve the audit plan', kind: 'proposal', createdAt: 0 }],
      waiting: [{ id: 't4', title: 'Draft email', why: 'in Review' }],
      items: [
        {
          at: NOW,
          agentId: 'a',
          item: {
            kind: 'x',
            title: 'Connector needs sign-in: GitHub',
            detail: 'Reconnect it.',
            links: ['/connectors'],
            urgent: false,
            fingerprint: 'f',
          },
        },
      ],
      costUsd: 1.5,
      heartbeatCostUsd: 0.04,
    })
    expect(digest.empty).toBe(false)
    expect(digest.text).toContain('**Video scripts**: done — Wrote 3 scripts')
    expect(digest.text).toContain('/library/reports/a.md')
    expect(digest.text).toContain('1 more run(s) are on the board')
    expect(digest.text).not.toContain('Secret')
    expect(digest.text).toContain('Approve the audit plan')
    expect(digest.text).toContain('Draft email')
    expect(digest.text).toContain('Connector needs sign-in: GitHub')
    expect(digest.text).toContain('$1.50')
    expect(digest.text).toContain('heartbeat $0.0400')
    const quiet = buildDigest({
      since: 0,
      until: NOW,
      runs: [],
      decisions: [],
      waiting: [],
      items: [],
      costUsd: 0,
      heartbeatCostUsd: 0,
    })
    expect(quiet.empty).toBe(true)
  })
})

describe('configuration', () => {
  test('on for the lead only by default; the routine follows the config', async () => {
    const i = instance({})
    const lead = await view(i.app, i.leadId)
    expect(lead.config).toMatchObject({
      enabled: true,
      everyMinutes: 30,
      activeFrom: '08:00',
      activeTo: '20:00',
    })
    expect(lead.stored).toBe(false)
    expect(lead.trigger?.status).toBe('active')
    const researcher = (await view(i.app, 'researcher')).config
    expect(researcher.enabled).toBe(false)
    expect((await view(i.app, 'researcher')).trigger).toBeNull()
    // the routines of the heartbeat and the digest are internal: not listed as routines
    const routines = (await (await i.app.request('/routines')).json()) as { routines: unknown[] }
    expect(routines.routines).toEqual([])

    // retime
    const next = await configure(i.app, i.leadId, { everyMinutes: 10 })
    expect(next.config.everyMinutes).toBe(10)
    expect(next.stored).toBe(true)
    const routine = i.server.deps.routines.getByProgram(heartbeatKey(i.leadId))
    expect(routine?.schedule).toEqual({ kind: 'every', everyMs: 600_000 })
    // off pauses, on resumes
    expect((await configure(i.app, i.leadId, { enabled: false })).trigger?.status).toBe('paused')
    expect((await configure(i.app, i.leadId, { enabled: true })).trigger?.status).toBe('active')
    // another agent gets a heartbeat and a checklist template to write in
    const on = await configure(i.app, 'researcher', { enabled: true, createChecklist: true })
    expect(on.trigger?.status).toBe('active')
    expect(on.checklist).toMatchObject({ exists: true, empty: true })
    // validation
    for (const bad of [{ everyMinutes: 1 }, { activeFrom: '8am' }, { timezone: 'Mars/Base' }]) {
      expect((await i.app.request(`/agents/lead/heartbeat`, json('PATCH', bad))).status).toBe(400)
    }
    expect((await i.app.request('/agents/nobody/heartbeat')).status).toBe(404)
  })

  test('the digest: default 18:00 in the team timezone, its routine follows', async () => {
    const i = instance({})
    const d = (await (await i.app.request('/digest')).json()) as {
      time: string
      timezone: string | null
      effectiveTimezone: string
      enabled: boolean
    }
    expect(d).toMatchObject({
      enabled: true,
      time: '18:00',
      timezone: null,
      effectiveTimezone: i.server.deps.settings.get().timezone,
    })
    // the team timezone is a workspace setting; the digest follows it
    const set = await i.app.request('/settings', json('PATCH', { timezone: 'Asia/Jakarta' }))
    expect(set.status).toBe(200)
    expect(((await set.json()) as { timezone: string }).timezone).toBe('Asia/Jakarta')
    expect(i.server.deps.routines.getByProgram('sys:digest')?.schedule).toEqual({
      kind: 'cron',
      expr: '0 18 * * *',
      tz: 'Asia/Jakarta',
    })
    expect(
      (await i.app.request('/settings', json('PATCH', { timezone: 'Mars/Base' }))).status,
    ).toBe(400)
    const res = await i.app.request('/digest', json('PATCH', { time: '07:30', timezone: 'UTC' }))
    expect(res.status).toBe(200)
    expect(i.server.deps.routines.getByProgram('sys:digest')?.schedule).toEqual({
      kind: 'cron',
      expr: '30 7 * * *',
      tz: 'UTC',
    })
    expect((await i.app.request('/digest', json('PATCH', { time: '25:00' }))).status).toBe(400)
    await i.app.request('/digest', json('PATCH', { enabled: false }))
    expect(i.server.deps.routines.getByProgram('sys:digest')?.status).toBe('paused')
  })
})

describe('team timezone', () => {
  test('active hours default to the team timezone; a per-agent timezone overrides it', async () => {
    const i = instance({})
    const set = (tz: string) => i.app.request('/settings', json('PATCH', { timezone: tz }))
    const at = Date.UTC(2026, 9, 12, 2, 0) // 02:00 UTC = 09:00 in Jakarta
    const reason = async (n: number) =>
      (await i.server.heartbeats.heartbeat(i.leadId, { slot: at + n })).reason
    expect((await view(i.app, i.leadId)).config.timezone).toBeNull()
    await set('Asia/Jakarta')
    // inside 08:00-20:00 there, so the beat gets as far as the (missing) checklist
    expect(await reason(0)).toBe('empty checklist')
    await set('UTC')
    expect(await reason(1)).toBe('outside active hours')
    // an own timezone wins over the team's
    const own = await configure(i.app, i.leadId, { timezone: 'Asia/Jakarta' })
    expect(own).toMatchObject({ effectiveTimezone: 'Asia/Jakarta' })
    expect(await reason(2)).toBe('empty checklist')
    // null goes back to following the team
    const back = await configure(i.app, i.leadId, { timezone: null })
    expect(back).toMatchObject({ effectiveTimezone: 'UTC' })
    expect(await reason(3)).toBe('outside active hours')
  })
})

describe('a beat', () => {
  test('an empty checklist costs no model call', async () => {
    const i = instance({})
    await setUp(i, null)
    // no file at all, then a file with only headings and comments
    expect(await fire(i)).toMatchObject({ started: false, reason: 'empty checklist' })
    await i.server.deps.library.writeText(checklistPath(i.leadId), '# Checklist\n<!-- later -->\n')
    expect(await fire(i)).toMatchObject({ started: false, reason: 'empty checklist' })
    expect(callsOf(i)).toBe(0)
    const beats = (await view(i.app, i.leadId)).beats
    // identical skips collapse into one record
    expect(beats).toHaveLength(1)
    expect(beats[0]).toMatchObject({ status: 'skipped', reason: 'empty checklist', count: 2 })
  })

  test('outside the active hours it is skipped, with no model call', async () => {
    const i = instance({})
    await setUp(i)
    const at = ++slot
    const m = localMinutes(at, 'UTC')
    const hhmm = (min: number) =>
      `${String(Math.floor((((min % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String((((min % 1440) + 1440) % 1440) % 60).padStart(2, '0')}`
    await configure(i.app, i.leadId, { activeFrom: hhmm(m + 120), activeTo: hhmm(m + 180) })
    expect(await i.server.heartbeats.heartbeat(i.leadId, { slot: at })).toMatchObject({
      started: false,
      reason: 'outside active hours',
    })
    expect(callsOf(i)).toBe(0)
    // run now follows the same rules
    const res = await i.app.request(`/agents/${i.leadId}/heartbeat/run`, json('POST'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ started: false, reason: 'outside active hours' })
  })

  test('ok: nothing is shown, nothing is queued', async () => {
    const i = instance({ lead: OK })
    await setUp(i)
    expect((await fire(i)).started).toBe(true)
    await beatEnds(i)
    const v = await view(i.app, i.leadId)
    expect(v.beats[0]).toMatchObject({ status: 'ok', items: [], duplicates: 0 })
    expect(digestBuffer(i.server.deps).buffer).toEqual([])
    expect(await dmEvents(i)).toEqual([])
    // the beat ran in its own rolling session, not in the DM, and made no task
    const tasks = (await (await i.app.request('/tasks')).json()) as {
      tasks: Array<{ sessionId: string }>
    }
    expect(tasks.tasks.filter((t) => t.sessionId.startsWith('heartbeat:'))).toEqual([])
    const first = i.models.lead?.prompts[0]
    expect(JSON.stringify(first)).toContain('check the library for new findings')
    // read-only: the tools it saw include team_status, and the gate lets only that set through
    const names = ((i.models.lead?.calls[0]?.tools ?? []) as Array<{ name: string }>).map(
      (t) => t.name,
    )
    expect(names).toContain('team_status')
    expect(names).toContain('propose_plan')
    // the heartbeat never parks: urgent items go to the lead DM, a pattern goes to propose_plan
    expect(names).not.toContain('escalate')
    expect(HEARTBEAT_ALLOWED).not.toContain('escalate')
  })

  test('attention: new items go to the digest buffer, urgent ones to the bell, once', async () => {
    const items = [
      {
        kind: 'program.failing',
        title: 'Audit run failed',
        detail: 'No access to the channel',
        links: ['/programs'],
      },
      {
        kind: 'budget.near',
        title: 'Budget 96% used',
        detail: 'Runs stop at the limit.',
        links: ['/settings'],
        urgent: true,
      },
    ]
    const i = instance({
      lead: [
        call('team_status', {}),
        beatResult('attention', items),
        call('team_status', {}),
        beatResult('attention', items),
      ],
    })
    await setUp(i)
    await fire(i)
    await beatEnds(i)
    const v = await view(i.app, i.leadId)
    expect(v.beats[0]?.status).toBe('attention')
    expect(v.beats[0]?.items.map((x) => x.title)).toEqual(['Audit run failed', 'Budget 96% used'])
    // both wait for the digest; only the urgent one reached the bell, as one alert (P40 phase M)
    expect(digestBuffer(i.server.deps).buffer.map((e) => e.item.title)).toEqual([
      'Audit run failed',
      'Budget 96% used',
    ])
    expect(v.digest.buffered).toBe(2)
    expect(await dmEvents(i)).toEqual([]) // nothing is written into a chat any more
    const bell = await notifications(i)
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ kind: 'alert', title: 'Budget 96% used', link: '/settings' })

    // the same findings again: ok, counted as duplicates, nothing new anywhere
    await fire(i)
    await beatEnds(i, 2)
    const again = await view(i.app, i.leadId)
    expect(again.beats[0]).toMatchObject({ status: 'ok', items: [], duplicates: 2 })
    expect(digestBuffer(i.server.deps).buffer).toHaveLength(2)
    expect(await notifications(i)).toHaveLength(1)
  })

  test('overlap: a running beat is not started twice', async () => {
    const i = instance({
      lead: [
        { toolCalls: [{ toolName: 'team_status', input: {}, toolCallId: 'a-slow' }], delayMs: 250 },
        beatResult('ok'),
      ],
    })
    await setUp(i)
    const first = await fire(i)
    expect(first.started).toBe(true)
    // the first beat is still on its model call
    expect(await fire(i)).toMatchObject({
      started: false,
      reason: 'the previous beat is still running',
    })
    await beatEnds(i, 2)
    expect((await view(i.app, i.leadId)).beats.map((b) => b.status)).toEqual(['skipped', 'ok'])
    // nothing parked and no decision was opened
    const open = (await (await i.app.request('/decisions?status=open')).json()) as {
      decisions: unknown[]
    }
    expect(open.decisions).toEqual([])
  })

  test('a failing model call is a failed beat, not a crash, and the next beat runs', async () => {
    const i = instance({
      lead: [{ throws: new Error('provider down') }, ...OK],
    })
    await setUp(i)
    await fire(i)
    await beatEnds(i)
    const failed = (await view(i.app, i.leadId)).beats[0]
    expect(failed?.status).toBe('failed')
    expect(failed?.reason).toBeTruthy()
    await fire(i)
    await beatEnds(i, 2)
    expect((await view(i.app, i.leadId)).beats.map((b) => b.status)).toEqual(['ok', 'failed'])
  })

  test('the heartbeat cannot write: a call outside its read-only authority is refused', async () => {
    const i = instance({
      lead: [
        call('memory_create', { path: '/memories/workspace/oops.md', file_text: 'x' }),
        call('send_message', { to: 'main', message: 'hello' }),
        beatResult('ok'),
      ],
    })
    await setUp(i)
    await fire(i)
    await beatEnds(i)
    const text = JSON.stringify(
      await i.server.factory.peek(`heartbeat:${i.leadId}`).messages({ limit: 50 }),
    )
    expect(text).toContain('Not available in a heartbeat: memory_create')
    expect(text).toContain('Not available in a heartbeat: send_message')
    expect(await i.server.deps.library.read('/memories/workspace/oops.md')).toBeUndefined()
  })
})

describe('program suggestions', () => {
  const asks = [
    'Summarize the weekly sales numbers for Europe',
    'Please summarize weekly sales numbers for Asia',
    'Can you summarize the weekly sales numbers for the US',
  ]
  async function ask(i: Instance, text: string) {
    const sessionId = `dm:${i.leadId}`
    const res = await i.app.request(
      `/sessions/${encodeURIComponent(sessionId)}/chat`,
      postAs(sessionId, userMessage(text)),
    )
    expect(res.status).toBe(200)
    await res.text()
  }

  test('team_status suggests a program only after three similar requests', async () => {
    const i = instance({ lead: [{ text: 'ok' }, { text: 'ok' }, { text: 'ok' }] })
    await ask(i, asks[0] as string)
    await ask(i, asks[1] as string)
    expect((await teamStatus(i.server.deps, i.leadId)).findings).toEqual([])
    await ask(i, asks[2] as string)
    const status = await teamStatus(i.server.deps, i.leadId)
    expect(status.findings.map((f) => f.kind)).toEqual(['program.suggestion'])
    expect(status.text).toContain('propose_plan')
    // a suggestion is made once, not on every beat
    expect((await teamStatus(i.server.deps, i.leadId)).findings).toEqual([])
  })

  test('the model writes the proposal; nothing is created without the client', async () => {
    const i = instance({
      lead: [
        { text: 'ok' },
        { text: 'ok' },
        { text: 'ok' },
        call('team_status', {}),
        call('propose_plan', {
          title: 'Weekly sales summary every Monday',
          agent: 'lead',
          name: 'Weekly sales summary',
          brief: 'Summarize the weekly sales numbers per region into /library/reports/sales/.',
          authority: { read: ['/library/sales/**'], write: ['/library/reports/sales/**'] },
          schedule: { cron: '0 8 * * 1', timezone: 'UTC' },
          report: 'digest',
        }),
        beatResult('attention', [
          {
            kind: 'program.suggestion',
            title: 'Proposed a weekly sales summary',
            detail: 'Asked three times.',
            links: ['/decisions'],
          },
        ]),
      ],
    })
    await setUp(i)
    for (const text of asks) await ask(i, text)
    await fire(i)
    await beatEnds(i)
    const res = (await (await i.app.request('/decisions?status=open&kind=proposal')).json()) as {
      decisions: Array<{ title: string; agentId: string; sessionId: string }>
    }
    expect(res.decisions).toHaveLength(1)
    expect(res.decisions[0]).toMatchObject({
      title: 'Weekly sales summary every Monday',
      agentId: i.leadId,
      sessionId: `heartbeat:${i.leadId}`,
    })
    // no program exists until the client approves
    const programs = (await (await i.app.request('/programs')).json()) as { programs: unknown[] }
    expect(programs.programs).toEqual([])
    // the model read the examples in the status it was given
    const toolResult = JSON.stringify(i.models.lead?.prompts.at(-1))
    expect(toolResult).toContain('program.suggestion')
    expect((await view(i.app, i.leadId)).beats[0]?.status).toBe('attention')
  })
})

describe('the daily digest', () => {
  const catalog = { scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } } }

  test('what ran, what waits, what the heartbeat noticed, what it cost', async () => {
    const i = instance(
      {
        researcher: [
          {
            toolCalls: [
              {
                toolName: 'final_answer',
                input: {
                  status: 'done',
                  summary: 'Wrote 3 scripts',
                  outputs: ['/library/reports/a.md'],
                },
                toolCallId: 'a-r1',
              },
            ],
            usage: { inputTokens: 500_000, outputTokens: 250_000 },
          },
        ],
        lead: [
          call('team_status', {}),
          beatResult('attention', [
            {
              kind: 'connector.reauth',
              title: 'Connector needs sign-in: GitHub',
              detail: 'Reconnect it.',
              links: ['/connectors'],
            },
          ]),
        ],
      },
      { catalog },
    )
    await setUp(i)
    // a program that reports in the digest ran
    const created = await i.app.request(
      '/programs',
      json('POST', {
        agentId: 'researcher',
        name: 'Video scripts',
        brief: 'Write scripts.',
        authority: { write: ['/library/reports/**'] },
        report: 'digest',
      }),
    )
    expect(created.status).toBe(201)
    const program = (await created.json()) as { id: string }
    await i.app.request(`/programs/${program.id}/run`, json('POST'))
    await until('the run ends', async () => {
      const runs = (await (await i.app.request(`/programs/${program.id}/runs`)).json()) as {
        runs: Array<{ status: string }>
      }
      return runs.runs[0]?.status === 'done'
    })
    // a decision waits
    createProposal(i.server.deps, {
      agentId: i.leadId,
      sessionId: null,
      title: 'Approve the audit plan',
      runOnce: false,
      program: { name: 'Audit', brief: 'Audit the community.' },
    })
    // the heartbeat noticed something
    await fire(i)
    await beatEnds(i)

    expect(await i.server.heartbeats.digest({ slot: Date.now() + 1000 })).toBe('sent')
    expect(await dmEvents(i)).toEqual([]) // the digest is a page, not a chat message
    const page = (await (await i.app.request('/briefings')).json()) as {
      briefings: Array<{ id: string; body: string; items: Array<{ kind: string }> }>
    }
    expect(page.briefings).toHaveLength(1)
    expect(page.briefings[0]?.items.map((x) => x.kind)).toEqual(
      expect.arrayContaining(['run', 'decision', 'noticed']),
    )
    const bell = await notifications(i)
    expect(bell.filter((n) => n.kind === 'briefing')).toHaveLength(1)
    const text = page.briefings[0]?.body ?? ''
    expect(text).toContain('**Video scripts**: done — Wrote 3 scripts')
    expect(text).toContain('/library/reports/a.md')
    expect(text).toContain('Approve the audit plan')
    expect(text).toContain('Connector needs sign-in: GitHub')
    expect(text).toMatch(/\$[1-9]/) // priced: the program run cost something
    // built from data: the lead made no model call for it
    expect(i.models.lead?.calls.length).toBe(2)
    // the buffer is consumed, and a recovered fire the same day sends nothing twice
    expect(digestBuffer(i.server.deps).buffer).toEqual([])
    expect(await i.server.heartbeats.digest({ slot: Date.now() + 2000 })).toBe('duplicate')
    expect((await (await i.app.request('/briefings')).json()).briefings).toHaveLength(1)
  })

  test('a quiet day sends nothing; turning it off sends nothing', async () => {
    const i = instance({})
    expect(await i.server.heartbeats.digest({ slot: ++slot })).toBe('empty')
    expect((await (await i.app.request('/briefings')).json()).briefings).toEqual([])
    expect(await notifications(i)).toEqual([])
    await i.app.request('/digest', json('PATCH', { enabled: false }))
    expect(await i.server.heartbeats.digest({ slot: ++slot })).toBe('off')
  })
})

describe('the routine that wakes it', () => {
  test('a due slot fires the beat; the same slot is never a second beat', async () => {
    const i = instance({ lead: OK })
    await setUp(i)
    await configure(i.app, i.leadId, { everyMinutes: 5 })
    const routine = i.server.deps.routines.getByProgram(heartbeatKey(i.leadId))
    const due = (routine?.nextFireAt ?? 0) + 1000
    const report = await i.server.routines.tick(due)
    // internal runs are not part of the tick report
    expect(report.fired).toEqual([])
    await beatEnds(i)
    expect((await view(i.app, i.leadId)).beats[0]?.status).toBe('ok')
    // the slot after it is a new beat only when due
    const quiet = await i.server.routines.tick(due + 1000)
    expect(quiet.skipped).toEqual([])
    expect((await view(i.app, i.leadId)).beats).toHaveLength(1)
    expect(callsOf(i)).toBe(2)
  })

  test('restart: no duplicate routines; a claimed fire a dead tick left is recovered once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40e-'))
    dirs.push(dir)
    const a = instance({}, { dir })
    await setUp(a)
    const before = a.server.deps.routines.getByProgram(heartbeatKey(a.leadId))
    const digestRoutine = a.server.deps.routines.getByProgram('sys:digest')
    expect(before).toBeDefined()
    expect(digestRoutine).toBeDefined()
    // a tick claimed a slot and died before the beat started
    const store = a.server.conn.sqlite
    const claimedAt = Date.now() - 120_000
    const slotAt = Date.now() - 60_000
    store
      .query(
        `INSERT INTO routine_runs (id, routine_id, scheduled_at, trigger, status, session_id, claimed_at)
         VALUES ('stale-run', ?, ?, 'schedule', 'claimed', ?, ?)`,
      )
      .run(before?.id as string, slotAt, `routine:${before?.id}:${slotAt}`, claimedAt)
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    const b = instance({ lead: OK }, { dir })
    await configure(b.app, b.leadId, { activeFrom: '00:00', activeTo: '00:00' })
    await b.server.deps.library.writeText(checklistPath(b.leadId), '- check things')
    expect(b.server.deps.routines.getByProgram(heartbeatKey(b.leadId))?.id).toBe(before?.id)
    expect(b.server.deps.routines.getByProgram('sys:digest')?.id).toBe(digestRoutine?.id)
    const report = await b.server.routines.tick(Date.now())
    expect(report.recovered).toBe(1)
    await beatEnds(b)
    expect((await view(b.app, b.leadId)).beats).toHaveLength(1)
    expect(b.server.deps.routines.getRun('stale-run')?.status).toBe('succeeded')
    // recovering again changes nothing
    await b.server.routines.tick(Date.now())
    expect((await view(b.app, b.leadId)).beats).toHaveLength(1)
    expect(callsOf(b)).toBe(2)
  })

  test('a beat the server died in the middle of is closed, and the next beat runs', async () => {
    const i = instance({ lead: OK })
    await setUp(i)
    // a beat recorded as running long ago, with no turn behind it
    const old = Date.now() - 3_600_000
    i.server.deps.heartbeat.store.updateState(
      i.leadId,
      (s) => ({
        ...s,
        beats: [
          {
            id: String(old),
            at: old,
            endedAt: null,
            status: 'running',
            reason: null,
            count: 1,
            items: [],
            duplicates: 0,
          },
        ],
      }),
      old,
    )
    expect((await fire(i)).started).toBe(true)
    await beatEnds(i, 2)
    const beats = (await view(i.app, i.leadId)).beats
    expect(beats.map((b) => b.status)).toEqual(['ok', 'failed'])
    expect(beats[1]?.reason).toContain('interrupted')
  })
})
