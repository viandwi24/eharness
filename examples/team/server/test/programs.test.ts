/**
 * Programs (docs/plans/P40-team-autonomous-operations.md, phase A): the model and its API, runs as
 * task sessions with a structured report, authority enforced by the permission engine (allowed
 * calls run without any approval, everything else is refused with the program's reason, forbidden
 * is denied), budgets through the ledger, and the schedule trigger on the routine scheduler.
 * Scripted models only; ticks are driven by hand (`tickMs: 0`).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchRule } from 'eharness/permissions'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import type { Program } from '../src/domain/programs.ts'
import {
  checkProgramFields,
  outsideAuthorityReason,
  parseProgramSession,
  programDayScope,
  programRules,
  programRunOutcome,
  programRunPrompt,
  programSessionId,
} from '../src/domain/programs.ts'
import { originOfSession, profileOfSession } from '../src/domain/run-profiles.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
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

/** A server whose researcher and writer run scripted models; `catalog` prices them. */
function instance(
  script: Partial<Record<'researcher' | 'writer', ScriptedStepInput[]>>,
  options: { catalog?: Record<string, unknown> } = {},
): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40a-'))
  dirs.push(dir)
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
    ...(options.catalog === undefined ? {} : { catalog: options.catalog as never }),
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher', 'writer']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, app: server.app, models }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

type ProgramView = Program & {
  triggerState: null | { status: string; pausedReason: string | null; nextFireAt: number | null }
}
type TaskView = {
  id: string
  sessionId: string
  origin: string
  status: string
  summary: string | null
  costUsd: number
  report: null | { status: string; summary: string; outputs: string[]; notes?: string }
}

const BASE = {
  agentId: 'researcher',
  name: 'Video scripts',
  brief:
    'For every title in /library/videos/titles.md without a script, write /library/reports/<n>.md',
  authority: { read: ['/library/videos/**'], write: ['/library/reports/**'] },
  gates: ['publishing anything'],
  escalation: 'Stop when a title looks harmful.',
  forbidden: ['Edit(/library/reports/locked/**)'],
  budget: { perRunUsd: null, perDayUsd: null },
}

async function create(
  app: Server['app'],
  body: Record<string, unknown> = {},
): Promise<ProgramView> {
  const res = await app.request('/programs', json('POST', { ...BASE, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as ProgramView
}
async function runNow(app: Server['app'], id: string) {
  const res = await app.request(`/programs/${id}/run`, json('POST'))
  if (res.status !== 202) throw new Error(await res.text())
  return (await res.json()) as { sessionId: string; taskId: string | null; started: boolean }
}
async function runs(app: Server['app'], id: string): Promise<TaskView[]> {
  const res = await app.request(`/programs/${id}/runs`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { runs: TaskView[] }).runs
}
const ended = (t: TaskView | undefined) =>
  t !== undefined && t.status !== 'running' && t.status !== 'needs_action'
async function firstRun(app: Server['app'], id: string): Promise<TaskView> {
  await until('the run ends', async () => ended((await runs(app, id))[0]))
  return (await runs(app, id))[0] as TaskView
}
const finalReport = (r: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName: 'final_answer', input: r }],
})

describe('run profiles', () => {
  test('the origin of a session comes from its id, and the table holds the policy', () => {
    expect(originOfSession('dm:abc')).toBe('dm')
    expect(originOfSession('dm:lead:agent:call_1')).toBe('lead')
    expect(originOfSession('x', true)).toBe('lead')
    expect(originOfSession('routine:r:123')).toBe('routine')
    expect(originOfSession('program:p:123')).toBe('program')
    expect(originOfSession('heartbeat:a')).toBe('heartbeat')
    const program = profileOfSession('program:p:1')
    expect(program).toMatchObject({
      permissions: 'program-authority',
      unattended: true,
      feedsMemory: false,
      resultTo: 'program-report',
      task: { origin: 'program' },
      budget: 'program',
    })
    expect(profileOfSession('dm:a').task).toBeNull()
    expect(profileOfSession('routine:r:1').task).toEqual({ origin: 'routine' })
  })
})

describe('program domain', () => {
  const program = {
    ...BASE,
    id: 'p1',
    agentId: 'a1',
    authority: {
      tools: ['web_fetch', 'WebFetch(domain:example.com)'],
      connectors: ['conn-1'],
      read: ['/library/in/**'],
      write: ['/library/out/**'],
    },
    trigger: { kind: 'manual' },
    report: 'task',
    deliverables: [],
    status: 'active',
    createdBy: 'client',
    createdAt: 0,
    updatedAt: 0,
    version: 1,
  } as unknown as Program

  test('validation rejects bad rules, globs and budgets', () => {
    expect(() => checkProgramFields({ name: ' ' })).toThrow()
    expect(() => checkProgramFields({ authority: { read: ['library/x'] } })).toThrow(
      /starting with \//,
    )
    expect(() => checkProgramFields({ authority: { write: ['/library/../x'] } })).toThrow(/\.\./)
    expect(() => checkProgramFields({ authority: { tools: ['not a rule'] } })).toThrow()
    expect(() => checkProgramFields({ forbidden: ['Bash(rm *)'] })).not.toThrow()
    expect(() => checkProgramFields({ budget: { perRunUsd: 0 } })).toThrow()
    expect(() => checkProgramFields({ budget: { perDayUsd: null } })).not.toThrow()
    expect(() => checkProgramFields({ report: 'loud' })).toThrow()
  })

  test('the authority becomes allow rules and forbidden becomes deny rules', () => {
    const rules = programRules(program, [
      { name: 'gh_list', connectorId: 'github', connectionIds: ['conn-1'] },
      { name: 'other', connectorId: 'web', connectionIds: ['conn-2'] },
    ])
    expect(rules.allow).toContain('web_fetch')
    expect(rules.allow).toContain('WebFetch(domain:example.com)')
    expect(rules.allow).toContain('gh_list') // by connection id
    expect(rules.allow).not.toContain('other')
    expect(rules.allow).toContain('Read(/library/in/**)')
    expect(rules.allow).toContain('Edit(/library/out/**)')
    expect(rules.allow).toContain('Read(/library/out/**)') // a write glob is readable
    // listing the directory itself is covered by `dir/**` (a gitignore glob does not match `dir`)
    expect(rules.allow).toContain('Read(/library/in)')
    expect(rules.allow).toContain('Read(/library/out)')
    expect(rules.allow).toContain('todo_write') // base tools
    expect(rules.deny).toEqual(['Edit(/library/reports/locked/**)'])
  })

  test('a granted directory can be listed, globbed and grepped, siblings stay out', () => {
    const rules = programRules(program)
    const roots = { roots: [{ virtual: '/', real: '/' }], polarity: 'allow' as const }
    const allowed = (toolName: string, input: Record<string, unknown>): boolean =>
      rules.allow.some((r) => matchRule(r, { toolName, input }, roots))
    expect(allowed('list_files', { prefix: '/library/in' })).toBe(true)
    expect(allowed('glob', { pattern: '**/*', path: '/library/in' })).toBe(true)
    expect(allowed('grep', { pattern: 'x', prefix: '/library/in' })).toBe(true)
    expect(allowed('read_file', { path: '/library/in/a.md' })).toBe(true)
    expect(allowed('list_files', { prefix: '/library/inbox' })).toBe(false)
    expect(allowed('list_files', { prefix: '/library' })).toBe(false)
  })

  test('session ids, day scope and the run prompt', () => {
    const id = programSessionId('p1', 1760000000000)
    expect(id).toBe('program:p1:1760000000000')
    expect(parseProgramSession(id)).toEqual({ programId: 'p1', runAt: 1760000000000 })
    expect(parseProgramSession('routine:p1:1')).toBeUndefined()
    expect(programDayScope('p1', Date.UTC(2026, 9, 11, 23, 59))).toBe('program:p1:2026-10-11')
    const prompt = programRunPrompt(program)
    for (const part of [
      program.brief,
      'web_fetch',
      'read /library/in/**',
      'Edit(/library/reports/locked/**)',
      'publishing anything',
      'Stop when a title looks harmful.',
      'Execute, Verify, Report',
      'retry once',
      'At most 3 attempts',
      'Never fail silently',
      'final_answer',
    ]) {
      expect(prompt).toContain(part)
    }
    expect(outsideAuthorityReason('P', 'delete_file')).toContain('request_authority')
  })

  test('the outcome of a turn: a failed report or a missing one is a failed run', () => {
    const report = { status: 'done' as const, summary: 's', outputs: [] }
    expect(programRunOutcome('complete', report)).toMatchObject({ status: 'done', failed: false })
    expect(programRunOutcome('complete', { ...report, status: 'partial' })).toMatchObject({
      status: 'done',
    })
    expect(programRunOutcome('complete', { ...report, status: 'failed' })).toMatchObject({
      status: 'failed',
      failed: true,
    })
    expect(programRunOutcome('cost-cap', undefined)).toMatchObject({
      status: 'failed',
      failed: true,
    })
    expect(programRunOutcome('cost-cap', undefined).summary).toContain('raise the budget')
    expect(programRunOutcome('output-invalid', undefined).summary).toContain('final report')
    expect(programRunOutcome('complete', undefined)).toMatchObject({
      status: 'done',
      failed: false,
    })
  })
})

describe('program API', () => {
  test('create validates, normalizes and lists; edit, pause, resume and delete', async () => {
    const { app } = instance({})
    const bad = await app.request(
      '/programs',
      json('POST', { ...BASE, authority: { read: ['nope'] } }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_PROGRAM')
    expect(
      (await app.request('/programs', json('POST', { ...BASE, agentId: 'ghost' }))).status,
    ).toBe(404)

    const p = await create(app, {
      forbidden: [' Edit(/library/reports/locked/**) ', 'Edit(/library/reports/locked/**)'],
    })
    expect(p).toMatchObject({
      status: 'active',
      report: 'task',
      createdBy: 'client',
      trigger: { kind: 'manual' },
      triggerState: null,
      forbidden: ['Edit(/library/reports/locked/**)'],
      authority: {
        tools: [],
        connectors: [],
        read: ['/library/videos/**'],
        write: ['/library/reports/**'],
      },
    })
    expect(
      (
        (await (await app.request('/programs?agentId=researcher')).json()) as {
          programs: unknown[]
        }
      ).programs,
    ).toHaveLength(1)
    expect(
      ((await (await app.request('/programs?agentId=writer')).json()) as { programs: unknown[] })
        .programs,
    ).toHaveLength(0)

    const patched = (await (
      await app.request(
        `/programs/${p.id}`,
        json('PATCH', { name: 'Scripts v2', budget: { perDayUsd: 5 }, version: p.version }),
      )
    ).json()) as ProgramView
    expect(patched).toMatchObject({ name: 'Scripts v2', version: p.version + 1 })
    expect(patched.budget).toEqual({ perRunUsd: null, perDayUsd: 5, maxOutputTokens: null })
    const stale = await app.request(
      `/programs/${p.id}`,
      json('PATCH', { name: 'x', version: p.version }),
    )
    expect(stale.status).toBe(409)

    const paused = (await (
      await app.request(`/programs/${p.id}/pause`, json('POST'))
    ).json()) as ProgramView
    expect(paused.status).toBe('paused')
    const resumed = (await (
      await app.request(`/programs/${p.id}/resume`, json('POST'))
    ).json()) as ProgramView
    expect(resumed.status).toBe('active')

    expect((await app.request(`/programs/${p.id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/programs/${p.id}`)).status).toBe(404)
    expect((await app.request(`/programs/${p.id}/run`, json('POST'))).status).toBe(404)
  })
})

describe('a program run', () => {
  test('runs as a task session: brief in, structured report stored, authority enforced by the engine', async () => {
    const { app, server, models } = instance({
      researcher: [
        {
          toolCalls: [
            // inside the authority: no approval, it just runs
            {
              toolName: 'write_file',
              input: { path: '/library/reports/1.md', content: 'script one' },
            },
            // outside it: not granted, refused with the program's reason (nobody is asked)
            { toolName: 'write_file', input: { path: '/library/secret.md', content: 'nope' } },
            // a read-only grant does not allow deleting
            { toolName: 'delete_file', input: { path: '/library/videos/titles.md' } },
            // reading is free for the engine in dontAsk, but only the granted paths are readable
            { toolName: 'read_file', input: { path: '/library/other.md' } },
            { toolName: 'read_file', input: { path: '/library/videos/titles.md' } },
            // forbidden: inside the write glob, but denied
            {
              toolName: 'write_file',
              input: { path: '/library/reports/locked/x.md', content: 'no' },
            },
          ],
        },
        finalReport({
          status: 'partial',
          summary: 'Wrote one script; two things were outside my authority.',
          outputs: ['/library/reports/1.md'],
          notes: 'needs delete access',
        }),
      ],
    })
    const p = await create(app)
    const started = await runNow(app, p.id)
    expect(started).toMatchObject({ started: true })
    expect(started.sessionId).toMatch(new RegExp(`^program:${p.id}:\\d+$`))

    const run = await firstRun(app, p.id)
    expect(run).toMatchObject({ origin: 'program', sessionId: started.sessionId, status: 'done' })
    expect(run.report).toEqual({
      status: 'partial',
      summary: 'Wrote one script; two things were outside my authority.',
      outputs: ['/library/reports/1.md'],
      notes: 'needs delete access',
    })
    expect(run.summary).toBe('Wrote one script; two things were outside my authority.')

    // the board lists it, owned by the program's agent
    const board = (await (await app.request('/tasks')).json()) as { tasks: TaskView[] }
    expect(board.tasks.find((t) => t.sessionId === started.sessionId)?.origin).toBe('program')

    // files: the in-authority write happened, the others did not
    const fs = libraryFs(server.conn.sqlite)
    expect(await fs.read('/library/reports/1.md')).not.toBeNull()
    expect(await fs.read('/library/secret.md')).toBeNull()
    expect(await fs.read('/library/reports/locked/x.md')).toBeNull()

    // nobody was asked: the attention queue is empty, the run never waited
    const attention = (await (await app.request('/approvals')).json()) as { approvals: unknown[] }
    expect(attention.approvals).toHaveLength(0)

    // the model read the refusals
    const detail = (await (await app.request(`/tasks/${run.id}`)).json()) as { messages: unknown[] }
    const text = JSON.stringify(detail.messages)
    expect(text).toContain('Outside the authority of program')
    expect(text).toContain('Forbidden by program')
    expect(text).toContain('/library/reports/1.md')
    const parts = (detail.messages as Array<{ parts: Array<Record<string, unknown>> }>).flatMap(
      (m) => m.parts,
    )
    const verdicts = parts
      .filter(
        (p) =>
          typeof p.type === 'string' &&
          p.type.startsWith('tool-') &&
          p.type !== 'tool-final_answer',
      )
      .map((p) => `${String(p.type).slice(5)}:${String(p.state)}`)
    // in order: write ok, write refused, delete refused, read refused, read allowed, write forbidden
    expect(verdicts).toEqual([
      'write_file:output-available',
      'write_file:output-denied',
      'delete_file:output-denied',
      'read_file:output-denied',
      'read_file:output-available',
      'write_file:output-denied',
    ])

    // the run prompt carried the brief and the rules
    const prompt = JSON.stringify(models.researcher?.prompts[0])
    expect(prompt).toContain('For every title in /library/videos/titles.md')
    expect(prompt).toContain('publishing anything')
    expect(prompt).toContain('Execute, Verify, Report')
  })

  test('a failed report is a failed task; no report at all (output-invalid) is a failed task too', async () => {
    const a = instance({
      researcher: [
        finalReport({
          status: 'failed',
          summary: 'The source was empty: nothing to write.',
          outputs: [],
        }),
      ],
    })
    const pa = await create(a.app)
    await runNow(a.app, pa.id)
    const ra = await firstRun(a.app, pa.id)
    expect(ra.status).toBe('failed')
    expect(ra.report?.status).toBe('failed')
    expect(ra.summary).toContain('nothing to write')

    // the model only produces invalid reports (3 answers checked): no valid report, no silent success
    const bad = finalReport({ status: 'great', summary: 'x', outputs: [] })
    const b = instance({ researcher: [bad, bad, bad, bad] })
    const pb = await create(b.app)
    await runNow(b.app, pb.id)
    const rb = await firstRun(b.app, pb.id)
    expect(rb.status).toBe('failed')
    expect(rb.report).toBeNull()
    expect(rb.summary).toContain('final report')
  })

  test('one run at a time: a second run now is refused while the first is going', async () => {
    const { app } = instance({
      researcher: [
        { text: 'thinking', delayMs: 150 },
        finalReport({ status: 'done', summary: 'ok', outputs: [] }),
      ],
    })
    const p = await create(app)
    await runNow(app, p.id)
    const second = await app.request(`/programs/${p.id}/run`, json('POST'))
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe('PROGRAM_BUSY')
    await firstRun(app, p.id)
  })
})

describe('budgets through the ledger', () => {
  // pricing is per million tokens: one step of 1M in + 1M out costs 3 USD; a reservation is cheap
  const catalog = { scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } } }
  const step = (extra: Partial<ScriptedStepInput> = {}): ScriptedStepInput => ({
    toolCalls: [{ toolName: 'write_file', input: { path: '/library/reports/a.md', content: 'a' } }],
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ...(extra as object),
  })

  test('perRunUsd stops a run that spent it, before the next model call', async () => {
    const { app, models } = instance(
      {
        researcher: [
          step(),
          finalReport({ status: 'done', summary: 'never reached', outputs: [] }),
        ],
      },
      { catalog },
    )
    const p = await create(app, { budget: { perRunUsd: 1, perDayUsd: null } })
    await runNow(app, p.id)
    const run = await firstRun(app, p.id)
    expect(run.status).toBe('failed')
    expect(run.summary).toContain('budget')
    expect(run.report).toBeNull()
    expect(models.researcher?.calls).toHaveLength(1) // the second step was refused
  })

  test('perDayUsd is a ledger scope of the program and the day: later runs the same day are refused', async () => {
    const { app, server, models } = instance(
      {
        researcher: [
          step(),
          finalReport({ status: 'done', summary: 'never reached', outputs: [] }),
        ],
      },
      { catalog },
    )
    const p = await create(app, { budget: { perRunUsd: null, perDayUsd: 1 } })
    await runNow(app, p.id)
    expect((await firstRun(app, p.id)).status).toBe('failed')
    expect(models.researcher?.calls).toHaveLength(1)

    await sleep(5) // a new runAt
    await runNow(app, p.id)
    await until('second run ends', async () => {
      const list = await runs(app, p.id)
      return list.length === 2 && list.every(ended)
    })
    expect(models.researcher?.calls).toHaveLength(1) // refused before any model call
    const row = server.conn.sqlite
      .query<{ scope: string; limit_usd: string | null }, [string]>(
        'SELECT scope, limit_usd FROM eh_budget_scope WHERE scope LIKE ?',
      )
      .get(`program:${p.id}:%`)
    expect(row?.scope).toBe(programDayScope(p.id, Date.now()))
    expect(Number(row?.limit_usd)).toBe(1)
  })
})

describe('schedule trigger on the routine scheduler', () => {
  test('a schedule program owns a routine; a due slot starts a run; pause stops it', async () => {
    const { app, server } = instance({
      researcher: [
        finalReport({ status: 'done', summary: 'scheduled run done', outputs: [] }),
        finalReport({ status: 'done', summary: 'should not run', outputs: [] }),
      ],
    })
    const p = await create(app, {
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    expect(p.triggerState).toMatchObject({ status: 'active' })
    expect(p.triggerState?.nextFireAt).toBeGreaterThan(Date.now())
    // the owned routine is not a routine of the Routines page
    const listed = (await (await app.request('/routines')).json()) as { routines: unknown[] }
    expect(listed.routines).toHaveLength(0)
    const owned = server.deps.routines.getByProgram(p.id)
    expect(owned).toMatchObject({ programId: p.id, sessionMode: 'task', overlap: 'skip' })

    const now = Date.now()
    server.conn.sqlite
      .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
      .run(now - 1000, owned?.id as string)
    const report = await server.routines.tick(now)
    expect(report.fired).toHaveLength(1)
    const run = await firstRun(app, p.id)
    expect(run.sessionId).toBe(`program:${p.id}:${now - 1000}`)
    expect(run.report?.summary).toBe('scheduled run done')
    // the routine run learns the outcome from the program run
    await until('routine run succeeded', async () => {
      const r = (await (await app.request(`/routines/${owned?.id}/runs`)).json()) as {
        runs: Array<{ status: string }>
      }
      return r.runs[0]?.status === 'succeeded'
    })

    // pause: the trigger stops firing
    const paused = (await (
      await app.request(`/programs/${p.id}/pause`, json('POST'))
    ).json()) as ProgramView
    expect(paused).toMatchObject({
      status: 'paused',
      triggerState: { status: 'paused', pausedReason: 'manual' },
    })
    server.conn.sqlite
      .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
      .run(now + 5, owned?.id as string)
    const quiet = await server.routines.tick(now + 10_000)
    expect(quiet.fired).toHaveLength(0)
    expect(await runs(app, p.id)).toHaveLength(1)

    // resume: the next slot is in the future, nothing missed fires
    const resumed = (await (
      await app.request(`/programs/${p.id}/resume`, json('POST'))
    ).json()) as ProgramView
    expect(resumed.triggerState?.status).toBe('active')
    expect(resumed.triggerState?.nextFireAt).toBeGreaterThan(Date.now())

    // switching to manual removes the schedule; deleting removes the routine
    const manual = (await (
      await app.request(`/programs/${p.id}`, json('PATCH', { trigger: { kind: 'manual' } }))
    ).json()) as ProgramView
    expect(manual.triggerState).toBeNull()
    expect(server.deps.routines.getByProgram(p.id)).toBeUndefined()
  })

  test('a run that reports failure counts as a failed fire of the routine', async () => {
    const { app, server } = instance({
      researcher: [
        finalReport({ status: 'failed', summary: 'could not reach the source', outputs: [] }),
      ],
    })
    const p = await create(app, {
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    const owned = server.deps.routines.getByProgram(p.id)
    const now = Date.now()
    server.conn.sqlite
      .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
      .run(now - 1000, owned?.id as string)
    await server.routines.tick(now)
    await firstRun(app, p.id)
    await until('routine run failed', async () => {
      const r = (await (await app.request(`/routines/${owned?.id}/runs`)).json()) as {
        runs: Array<{ status: string; reason: string | null }>
      }
      return (
        r.runs[0]?.status === 'failed' &&
        (r.runs[0]?.reason ?? '').includes('could not reach the source')
      )
    })
    expect(server.deps.routines.getByProgram(p.id)?.failures).toBe(1)
  })

  test('a program deleted while a fire was claimed fails that fire', async () => {
    const { app, server } = instance({})
    const p = await create(app, {
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    const owned = server.deps.routines.getByProgram(p.id)
    // delete the program row only (the routine stays), as a crash between the two deletes would
    server.conn.sqlite.query('DELETE FROM programs WHERE id = ?').run(p.id)
    const now = Date.now()
    server.conn.sqlite
      .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
      .run(now - 1000, owned?.id as string)
    await server.routines.tick(now)
    const r = (await (await app.request(`/routines/${owned?.id}/runs`)).json()) as {
      runs: Array<{ status: string; reason: string | null }>
    }
    expect(r.runs[0]).toMatchObject({ status: 'failed', reason: 'the program was deleted' })
  })
})
