/**
 * The work queue (docs/plans/P40-team-autonomous-operations.md, phase C, decision D6): queued
 * tasks, the manager tools, worker programs (one session per task), Review (accept / send back),
 * "Waiting for you" from open decisions and the atomic claim. Scripted models only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ScriptedModel,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { columnsOf, createTask } from '../src/app/work-queue.ts'
import type { Decision } from '../src/domain/decisions.ts'
import type { Program } from '../src/domain/programs.ts'
import { checkProgramFields, programRules } from '../src/domain/programs.ts'
import { boardColumn, inReview, type Task } from '../src/domain/tasks.ts'
import {
  briefWithFeedback,
  checkTaskFields,
  isQueuedSession,
  queuedSessionId,
} from '../src/domain/work-queue.ts'
import { sqliteTaskStore } from '../src/infra/db/tasks-repo.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

/** The owner-facing create route was removed (P55): tests queue through the use case. */
const serverOfApp = new WeakMap<object, Server>()

type Slug = 'lead' | 'researcher' | 'writer'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
  dbFile: string
}

function fresh(script: Partial<Record<Slug, ScriptedStepInput[]>>): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40c-'))
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
  const dbFile = join(dir, 'team.db')
  const server = compose({
    dbFile,
    instanceId: 'work-queue-test',
    models: config,
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
  serverOfApp.set(server.app, server)
  return { server, app: server.app, models, dbFile }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

type TaskView = Task
async function listTasks(app: Server['app'], query = ''): Promise<TaskView[]> {
  const res = await app.request(`/tasks?limit=200${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { tasks: TaskView[] }).tasks
}
async function getTask(app: Server['app'], id: string): Promise<TaskView> {
  const res = await app.request(`/tasks/${id}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { task: TaskView }).task
}
async function queue(app: Server['app'], body: Record<string, unknown>): Promise<TaskView> {
  const server = serverOfApp.get(app) as Server
  return createTask(server.deps, body as never) as TaskView
}
const post = (app: Server['app'], path: string, body?: unknown) =>
  app.request(path, json('POST', body))

const WORKER = {
  name: 'Script writer',
  brief:
    'Take the task you were given. Write the script of the video it names into /library/scripts/<slug>.md.',
  authority: {
    read: ['/library/production/**', '/library/scripts/**'],
    write: ['/library/scripts/**'],
  },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
async function createProgram(app: Server['app'], body: Record<string, unknown>): Promise<Program> {
  const res = await app.request('/programs', json('POST', { ...WORKER, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as Program
}
async function runNow(app: Server['app'], id: string) {
  const res = await app.request(`/programs/${id}/run`, json('POST'))
  if (res.status !== 202) throw new Error(await res.text())
  return (await res.json()) as {
    sessionId: string | null
    started: boolean
    idle: boolean
  }
}
const settled = (t: TaskView) =>
  t.status !== 'running' && t.status !== 'needs_action' && t.status !== 'queued'
async function runs(app: Server['app'], programId: string): Promise<TaskView[]> {
  return ((await (await app.request(`/programs/${programId}/runs`)).json()) as { runs: TaskView[] })
    .runs
}

let seq = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStep => ({
  toolCalls: [{ toolName, input, toolCallId: `c-${toolName}-${++seq}` }],
})
const finalReport = (r: Record<string, unknown>): ScriptedStep => call('final_answer', r)
const toolNames = (m: ScriptedModel | undefined, call = 0): string[] =>
  ((m?.calls[call]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

/** The steps of a writer that drafts one script and completes its task. */
const draft = (slug: string, text = 'a script'): ScriptedStepInput[] => [
  call('write_file', { path: `/library/scripts/${slug}.md`, content: text }),
  call('complete_task', { summary: `drafted ${slug}`, outputs: [`/library/scripts/${slug}.md`] }),
  finalReport({
    status: 'done',
    summary: `drafted ${slug}`,
    outputs: [`/library/scripts/${slug}.md`],
  }),
]

async function toolParts(app: Server['app'], sessionId: string, tool: string) {
  const res = await app.request(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=50`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
  return body.messages.flatMap((m) => m.parts).filter((p) => p.type === `tool-${tool}`)
}

describe('domain', () => {
  const base = { createdBy: 'client', acceptedAt: null, report: null } as const
  const report = { status: 'done' as const, summary: 's', outputs: [] as string[] }

  test('board columns: queued, running, waiting, review, done', () => {
    expect(boardColumn({ ...base, status: 'queued' }, false)).toBe('queued')
    expect(boardColumn({ ...base, status: 'running' }, false)).toBe('running')
    expect(boardColumn({ ...base, status: 'needs_action' }, false)).toBe('waiting')
    // a parked run shows `running`; an open decision of its session is what makes it the client's turn
    expect(boardColumn({ ...base, status: 'running' }, true)).toBe('waiting')
    expect(boardColumn({ ...base, status: 'done', report }, false)).toBe('review')
    expect(
      boardColumn({ ...base, status: 'done', report: { ...report, status: 'partial' } }, false),
    ).toBe('review')
    expect(
      boardColumn(
        { ...base, status: 'done', report: { ...report, status: 'needs_decision' } },
        false,
      ),
    ).toBe('done')
    expect(boardColumn({ ...base, status: 'done', report, acceptedAt: 5 }, false)).toBe('done')
    expect(boardColumn({ ...base, status: 'failed', report }, false)).toBe('done')
    // a task that did not come from the queue never waits for a review
    expect(boardColumn({ ...base, createdBy: null, status: 'done', report }, false)).toBe('done')
    expect(inReview({ ...base, status: 'done', report })).toBe(true)
  })

  test('validation, feedback text and the placeholder session', () => {
    expect(() => checkTaskFields({ title: ' ' })).toThrow()
    expect(() => checkTaskFields({ inputs: ['library/x'] })).toThrow()
    expect(() => checkTaskFields({ inputs: ['/library/../x'] })).toThrow()
    expect(() => checkTaskFields({ priority: 'asap' as never })).toThrow()
    expect(() => checkTaskFields({ dueAt: -1 })).toThrow()
    expect(() => checkProgramFields({ worker: { maxTasks: 0 } })).toThrow()
    expect(() => checkProgramFields({ worker: { maxTasks: 5 } })).not.toThrow()
    expect(briefWithFeedback('Write it.', 2, ' shorter ')).toBe(
      'Write it.\n\n## Feedback from the client (round 2)\n\nshorter',
    )
    expect(isQueuedSession(queuedSessionId('t1'))).toBe(true)
    // a worker program may report its task without naming complete_task
    const rules = programRules({
      authority: { tools: [], connectors: [], read: [], write: [] },
      forbidden: [],
      worker: { maxTasks: 2 },
    })
    expect(rules.allow).toContain('complete_task')
    expect(
      programRules({
        authority: { tools: [], connectors: [], read: [], write: [] },
        forbidden: [],
      }).allow,
    ).not.toContain('complete_task')
  })
})

describe('the queue on the API', () => {
  test('create, change, cancel: a queued task has an owner and no session', async () => {
    const { app, server } = fresh({})
    const t = await queue(app, {
      agentId: 'writer',
      hold: true,
      title: 'Script: the island',
      brief: '## Goal\nA 5 minute script.',
      inputs: ['/library/production/videos.md'],
      priority: 'high',
      dueAt: Date.parse('2026-11-01'),
    })
    expect(t).toMatchObject({
      status: 'queued',
      agentId: server.deps.agents.getBySlug('writer')?.id,
      createdBy: 'client',
      // assigned by the client through the API: the client's task, not a program run
      origin: 'user',
      priority: 'high',
      round: 1,
      acceptedAt: null,
      inputs: ['/library/production/videos.md'],
    })
    expect(isQueuedSession(t.sessionId)).toBe(true)
    const detail = (await (await app.request(`/tasks/${t.id}`)).json()) as {
      task: TaskView
      messages: unknown[]
    }
    expect(detail.messages).toEqual([])
    expect((await listTasks(app, '&status=queued')).map((x) => x.id)).toEqual([t.id])

    // errors the client can read
    const deps = server.deps
    expect(() => createTask(deps, { agentId: 'nobody', title: 'x' })).toThrow()
    expect(() => createTask(deps, { agentId: 'writer', title: 'x', inputs: ['nope'] })).toThrow()

    const patched = await app.request(
      `/tasks/${t.id}`,
      json('PATCH', { priority: 'urgent', agentId: 'researcher', dueAt: null }),
    )
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      priority: 'urgent',
      dueAt: null,
      agentId: server.deps.agents.getBySlug('researcher')?.id,
    })
    // a queued task has no session to message
    expect((await post(app, `/tasks/${t.id}/messages`, { text: 'hi' })).status).toBe(409)
    // not in review: cannot be accepted or sent back
    expect((await post(app, `/tasks/${t.id}/accept`)).status).toBe(409)
    expect((await post(app, `/tasks/${t.id}/send-back`, { note: 'x' })).status).toBe(409)

    const cancelled = await post(app, `/tasks/${t.id}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ status: 'stopped' })
    expect((await post(app, `/tasks/${t.id}/cancel`)).status).toBe(409)
    expect((await app.request(`/tasks/${t.id}`, json('PATCH', { title: 'y' }))).status).toBe(409)
  })
})

describe('manager', () => {
  test('in its DM the manager reads the board and queues tasks for the writer and the researcher', async () => {
    const { app, server, models } = fresh({
      lead: [
        call('list_tasks', {}),
        call('create_task', {
          agent: 'researcher',
          title: 'Research: tide tables',
          hold: true,
          brief: 'Find how tide tables are built. Save to /library/research/tide-tables.md.',
          inputs: ['/library/production/videos.md'],
          priority: 'high',
          due: '2026-11-15',
        }),
        call('create_task', {
          agent: 'writer',
          title: 'Script: the lighthouse',
          hold: true,
          brief: 'Write the script. Save to /library/scripts/the-lighthouse.md.',
        }),
        call('create_task', { agent: 'nobody', title: 'bad' }),
        call('list_tasks', { column: 'queued' }),
        { text: 'Queued two tasks.' },
      ],
    })
    // the board is empty at first
    const res = await app.request(
      '/sessions/dm:lead/chat',
      postAs('dm:lead', userMessage('plan the week')),
    )
    expect(res.status).toBe(200)
    await res.text()
    // the lead has the manager tools in its DM, no worker tool; role agents have none of them
    expect(toolNames(models.lead)).toEqual(
      expect.arrayContaining(['create_task', 'list_tasks', 'update_task']),
    )
    expect(toolNames(models.lead)).not.toContain('complete_task')

    const lead = server.deps.agents.getBySlug('lead')
    const queued = await listTasks(app, '&status=queued')
    expect(queued.map((t) => t.title).sort()).toEqual([
      'Research: tide tables',
      'Script: the lighthouse',
    ])
    for (const t of queued) expect(t.createdBy).toBe(lead?.id as string)
    const research = queued.find((t) => t.title.startsWith('Research')) as TaskView
    expect(research).toMatchObject({
      agentId: server.deps.agents.getBySlug('researcher')?.id,
      priority: 'high',
      inputs: ['/library/production/videos.md'],
    })
    expect(research.dueAt).toBe(Date.parse('2026-11-15'))

    const lists = await toolParts(app, 'dm:lead', 'list_tasks')
    expect(String(lists[0]?.output)).toBe('No tasks match.')
    expect(String(lists[1]?.output)).toContain('Research: tide tables')
    expect(String(lists[1]?.output)).toContain('[queued]')
    const creates = await toolParts(app, 'dm:lead', 'create_task')
    expect(String(creates[0]?.output)).toContain('Assigned task')
    expect(String(creates[0]?.output)).toContain('on hold')
    expect(String(creates[2]?.output)).toMatch(/^ERROR: could not queue the task: /)
    // a role agent has no manager tools in its chat
    expect(columnsOf(server.deps, queued).get(research.id)).toBe('queued')
  })

  test('a role agent chat gets neither the manager tools nor complete_task', async () => {
    const { app, models } = fresh({ researcher: [{ text: 'hi' }] })
    await (
      await app.request(
        '/sessions/dm:researcher/chat',
        postAs('dm:researcher', userMessage('hello')),
      )
    ).text()
    const names = toolNames(models.researcher)
    for (const n of ['create_task', 'list_tasks', 'update_task', 'complete_task']) {
      expect(names).not.toContain(n)
    }
  })

  test('update_task re-prioritises, reassigns and cancels; a program run gets the manager tools only when its authority names them', async () => {
    let oneId = ''
    const { app, server, models } = fresh({
      lead: [call('create_task', { agent: 'writer', title: 'One', hold: true }), { text: 'ok' }],
      researcher: [
        () => call('update_task', { id: oneId, priority: 'urgent', agent: 'researcher' }),
        () => call('update_task', { id: oneId, cancel: true }),
        finalReport({ status: 'done', summary: 'managed', outputs: [] }),
      ],
    })
    await (await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))).text()
    oneId = ((await listTasks(app, '&status=queued'))[0] as TaskView).id
    const managing = await createProgram(app, {
      agentId: 'researcher',
      name: 'Triage',
      authority: { tools: ['list_tasks', 'update_task'], read: [], write: [] },
    })
    const run = await runNow(app, managing.id)
    await until('the run ends', async () => {
      const r = await runs(app, managing.id)
      return r.length === 1 && settled(r[0] as TaskView)
    })
    const names = toolNames(models.researcher)
    expect(names).toEqual(expect.arrayContaining(['list_tasks', 'update_task']))
    // create_task and complete_task were not named: not offered
    expect(names).not.toContain('create_task')
    expect(names).not.toContain('complete_task')
    const parts = await toolParts(app, run.sessionId as string, 'update_task')
    expect(String(parts[0]?.output)).toContain('priority urgent')
    expect(String(parts[1]?.output)).toMatch(/^Cancelled task/)
    const after = await getTask(app, oneId)
    expect(after).toMatchObject({
      status: 'stopped',
      priority: 'urgent',
      agentId: server.deps.agents.getBySlug('researcher')?.id,
    })
  })
})

describe('writer worker program', () => {
  test('drafts a script per task, moves each to Review; send back re-queues with the note and the next run revises', async () => {
    const { app, server, models } = fresh({
      writer: [
        // run 1: the high priority task first, then the other one
        ...draft('the-lighthouse', 'v1 lighthouse'),
        ...draft('the-island', 'v1 island'),
        // run 2: the lighthouse again, with the client's note
        call('read_file', { path: '/library/scripts/the-lighthouse.md' }),
        call('write_file', {
          path: '/library/scripts/the-lighthouse.md',
          content: 'v2 lighthouse, shorter',
        }),
        call('complete_task', {
          summary: 'shortened',
          outputs: ['/library/scripts/the-lighthouse.md'],
        }),
        finalReport({
          status: 'done',
          summary: 'revised',
          outputs: ['/library/scripts/the-lighthouse.md'],
        }),
      ],
    })
    // the client's list of videos is a library file; the tasks come from it
    await server.deps.library.writeText(
      '/library/production/videos.md',
      '- The island\n- The lighthouse\n- The tide\n',
    )
    // the worker program owns the queue of the writer: create it first, tasks then wait for it
    const worker = await createProgram(app, { agentId: 'writer', worker: { maxTasks: 5 } })
    expect(worker.worker).toEqual({ maxTasks: 5 })
    const island = await queue(app, {
      agentId: 'writer',
      title: 'Script: The island',
      brief: 'Draft /library/scripts/the-island.md',
      inputs: ['/library/production/videos.md'],
    })
    const lighthouse = await queue(app, {
      agentId: 'writer',
      title: 'Script: The lighthouse',
      brief: 'Draft /library/scripts/the-lighthouse.md',
      inputs: ['/library/production/videos.md'],
      priority: 'high',
    })

    const started = await runNow(app, worker.id)
    expect(started).toMatchObject({ started: true, idle: false })
    await until('both tasks are done', async () => {
      const tasks = await listTasks(app)
      return tasks.length === 2 && tasks.every(settled)
    })
    // one session per task, run-shaped ids, history = the worker's runs
    const a = await getTask(app, lighthouse.id)
    const b = await getTask(app, island.id)
    expect(a.sessionId).toBe(started.sessionId as string)
    expect(b.sessionId).toMatch(/^program:[^:]+:\d+$/)
    expect(b.sessionId).not.toBe(a.sessionId)
    expect((await runs(app, worker.id)).map((r) => r.id).sort()).toEqual([a.id, b.id].sort())
    for (const t of [a, b]) {
      expect(t).toMatchObject({ status: 'done', origin: 'program', acceptedAt: null, round: 1 })
      expect(t.report?.status).toBe('done')
      expect(boardColumn(t, false)).toBe('review')
    }
    expect(a.report?.outputs).toEqual(['/library/scripts/the-lighthouse.md'])
    expect(b.report?.outputs).toEqual(['/library/scripts/the-island.md'])
    expect((await server.deps.library.read('/library/scripts/the-island.md'))?.text).toBe(
      'v1 island',
    )
    // the task of the run is the model's brief
    expect(JSON.stringify(models.writer?.prompts[0])).toContain(
      'Draft /library/scripts/the-lighthouse.md',
    )
    // the worker tools: complete_task, not the manager tools
    expect(toolNames(models.writer)).toContain('complete_task')
    // the manager tools are offered to a run only when its program names them
    expect(toolNames(models.writer)).not.toContain('create_task')

    // accept one, send the other back with a note
    const accepted = await post(app, `/tasks/${island.id}/accept`)
    expect(accepted.status).toBe(200)
    expect(((await accepted.json()) as TaskView).acceptedAt).not.toBeNull()
    expect(boardColumn(await getTask(app, island.id), false)).toBe('done')
    expect((await post(app, `/tasks/${island.id}/accept`)).status).toBe(409)
    expect((await post(app, `/tasks/${lighthouse.id}/send-back`, {})).status).toBe(400)
    const back = await post(app, `/tasks/${lighthouse.id}/send-back`, { note: 'Make it shorter.' })
    expect(back.status).toBe(200)
    expect(await back.json()).toMatchObject({ status: 'queued', round: 2, report: null })
    const requeued = await getTask(app, lighthouse.id)
    expect(requeued.brief).toContain('Draft /library/scripts/the-lighthouse.md')
    expect(requeued.brief).toContain('## Feedback from the client (round 2)')
    expect(requeued.brief).toContain('Make it shorter.')
    expect(boardColumn(requeued, false)).toBe('queued')

    // run 2 takes only the sent-back task, in a fresh session; the earlier one is in its history
    await until('the worker is free', async () => (await runs(app, worker.id)).every(settled))
    await sleep(5) // a new run id (ms) after the first
    const second = await runNow(app, worker.id)
    expect(second.started).toBe(true)
    await until('the revision is done', async () => settled(await getTask(app, lighthouse.id)))
    const revised = await getTask(app, lighthouse.id)
    expect(revised).toMatchObject({ status: 'done', round: 2, acceptedAt: null })
    expect(revised.report?.summary).toBe('revised')
    expect(revised.sessionId).toBe(second.sessionId as string)
    expect(revised.history).toEqual([a.sessionId])
    expect(boardColumn(revised, false)).toBe('review')
    expect((await server.deps.library.read('/library/scripts/the-lighthouse.md'))?.text).toBe(
      'v2 lighthouse, shorter',
    )
    // the revision prompt carried the client's note
    expect(JSON.stringify(models.writer?.prompts[6])).toContain('Make it shorter.')
  })

  test('complete_task: outputs must exist; outside a queued task it says so; nothing queued is an idle run', async () => {
    const { app } = fresh({
      writer: [
        call('complete_task', { summary: 'done', outputs: ['/library/scripts/missing.md'] }),
        call('write_file', { path: '/library/scripts/x.md', content: 'x' }),
        call('complete_task', { summary: 'done', outputs: ['/library/scripts/x.md'] }),
        finalReport({
          status: 'partial',
          summary: 'half of it',
          outputs: ['/library/scripts/x.md'],
        }),
        // a run of a non-worker program: there is no task to complete
        call('complete_task', { summary: 'x', outputs: [] }),
        finalReport({ status: 'done', summary: 'n/a', outputs: [] }),
      ],
    })
    const worker = await createProgram(app, { agentId: 'writer', worker: {} })
    expect(worker.worker).toEqual({ maxTasks: 3 })
    const idle = await runNow(app, worker.id)
    expect(idle).toEqual({
      sessionId: null,
      taskId: null,
      started: false,
      idle: true,
      ...{},
    } as never)

    const t = await queue(app, { agentId: 'writer', title: 'Script: x' })
    const started = await runNow(app, worker.id)
    await until('the task ends', async () => settled(await getTask(app, t.id)))
    const parts = await toolParts(app, started.sessionId as string, 'complete_task')
    expect(String(parts[0]?.output)).toMatch(/^ERROR: These outputs do not exist/)
    expect(String(parts[1]?.output)).toMatch(/^Recorded/)
    // partial work is reviewed too
    const done = await getTask(app, t.id)
    expect(done.report?.status).toBe('partial')
    expect(boardColumn(done, false)).toBe('review')

    const plain = await createProgram(app, {
      agentId: 'writer',
      name: 'Plain',
      authority: { tools: ['complete_task'], read: [], write: [] },
    })
    const run = await runNow(app, plain.id)
    await until(
      'the plain run ends',
      async () =>
        (await runs(app, plain.id)).every(settled) && (await runs(app, plain.id)).length === 1,
    )
    const out = await toolParts(app, run.sessionId as string, 'complete_task')
    expect(String(out[0]?.output)).toMatch(/^ERROR: This run has no queued task/)
  })
})

describe('researcher worker program', () => {
  test('picks queued research items one at a time and writes a file for each', async () => {
    const { app, server } = fresh({
      researcher: [
        call('write_file', { path: '/library/research/tide-tables.md', content: 'tides' }),
        call('complete_task', {
          summary: 'tides researched',
          outputs: ['/library/research/tide-tables.md'],
        }),
        finalReport({
          status: 'done',
          summary: 'tides researched',
          outputs: ['/library/research/tide-tables.md'],
        }),
        call('write_file', { path: '/library/research/sea-glass.md', content: 'glass' }),
        call('complete_task', {
          summary: 'glass researched',
          outputs: ['/library/research/sea-glass.md'],
        }),
        finalReport({
          status: 'done',
          summary: 'glass researched',
          outputs: ['/library/research/sea-glass.md'],
        }),
      ],
    })
    const worker = await createProgram(app, {
      agentId: 'researcher',
      name: 'Research items',
      brief: 'Research the task you were given. Write /library/research/<slug>.md.',
      authority: { read: ['/library/**'], write: ['/library/research/**'] },
      worker: { maxTasks: 1 },
    })
    const glass = await queue(app, {
      agentId: 'researcher',
      title: 'Research: sea glass',
      priority: 'low',
    })
    const tides = await queue(app, {
      agentId: 'researcher',
      title: 'Research: tide tables',
      dueAt: Date.now() + 86_400_000,
    })
    // a task of another agent is never taken
    const other = await queue(app, { agentId: 'writer', title: 'Not yours', hold: true })
    // one task per run: the nearest due date (tides) first, then the rest
    const first = await runNow(app, worker.id)
    await until('tides done', async () => settled(await getTask(app, tides.id)))
    expect((await getTask(app, glass.id)).status).toBe('queued')
    await sleep(5)
    const second = await runNow(app, worker.id)
    expect(second.sessionId).not.toBe(first.sessionId)
    await until('glass done', async () => settled(await getTask(app, glass.id)))
    expect((await getTask(app, other.id)).status).toBe('queued')
    expect((await server.deps.library.read('/library/research/tide-tables.md'))?.text).toBe('tides')
    expect((await server.deps.library.read('/library/research/sea-glass.md'))?.text).toBe('glass')
    for (const t of [tides, glass]) {
      expect(boardColumn(await getTask(app, t.id), false)).toBe('review')
    }
    // a third run finds nothing for the researcher
    await sleep(5)
    expect(await runNow(app, worker.id)).toMatchObject({ idle: true, started: false })
  })
})

describe('task inputs that are uploads', () => {
  test('an image input reaches the run as a file part; text uploads, missing files and other paths stay paths', async () => {
    const { app, models } = fresh({
      researcher: [finalReport({ status: 'done', summary: 'looked', outputs: [] })],
    })
    const up = async (name: string, type: string, content: BlobPart): Promise<string> => {
      const form = new FormData()
      form.set('file', new File([content], name, { type }))
      const res = await app.request('/library/files', { method: 'POST', body: form })
      expect(res.status).toBe(201)
      return ((await res.json()) as { path: string }).path
    }
    const photo = await up('photo.png', 'image/png', new Uint8Array([137, 80, 78, 71, 1, 2, 3]))
    const notes = await up('notes.csv', 'text/csv', 'a,b\n1,2\n')
    const worker = await createProgram(app, {
      agentId: 'researcher',
      name: 'Look',
      authority: { read: ['/library/**'], write: ['/library/research/**'] },
      worker: { maxTasks: 1 },
    })
    const task = await queue(app, {
      agentId: 'researcher',
      title: 'Look at the photo',
      inputs: [photo, notes, '/uploads/2020-01-01/missing.png', '/library/other.png'],
    })
    await runNow(app, worker.id)
    await until('done', async () => settled(await getTask(app, task.id)))
    const prompt = JSON.stringify(models.researcher?.prompts[0])
    expect(prompt).toContain('image/png')
    expect(prompt).not.toContain('text/csv')
    // every input stays named in the prompt text
    for (const path of [photo, notes, '/library/other.png']) expect(prompt).toContain(path)
    // the stored user message keeps the reference, one file part
    const res = await app.request(
      `/sessions/${encodeURIComponent((await getTask(app, task.id)).sessionId as string)}/messages?limit=20`,
    )
    const body = (await res.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>
    }
    const files = body.messages.flatMap((m) => m.parts).filter((p) => p.type === 'file')
    expect(files).toHaveLength(1)
    expect(String(files[0]?.url).startsWith('library:///uploads/')).toBe(true)
  })
})

describe('waiting for you', () => {
  test('a task whose run parked on a decision is in the Waiting column until it is decided', async () => {
    const { app, server } = fresh({
      writer: [
        call('escalate_wait', {
          title: 'Which tone?',
          question: 'Funny or serious?',
          options: ['funny', 'serious'],
        }),
        ...draft('tone'),
      ],
    })
    const worker = await createProgram(app, { agentId: 'writer', worker: { maxTasks: 1 } })
    const t = await queue(app, { agentId: 'writer', title: 'Script: tone' })
    await runNow(app, worker.id)
    let decision: Decision | undefined
    await until('an open decision', async () => {
      decision = (
        (await (await app.request('/decisions?status=open')).json()) as { decisions: Decision[] }
      ).decisions[0]
      return decision !== undefined
    })
    const parked = await getTask(app, t.id)
    expect(parked.status).toBe('running')
    expect(columnsOf(server.deps, [parked]).get(t.id)).toBe('waiting')
    const approved = await post(app, `/decisions/${(decision as Decision).id}/approve`, {
      choice: 'funny',
    })
    expect(approved.status).toBe(200)
    await until('the task finished', async () => settled(await getTask(app, t.id)))
    expect(columnsOf(server.deps, [await getTask(app, t.id)]).get(t.id)).toBe('review')
  })
})

describe('atomic claim', () => {
  test('two stores on one database never take the same task', async () => {
    const { server, dbFile } = fresh({})
    const a = sqliteTaskStore(server.conn.sqlite)
    const other = new Database(dbFile)
    try {
      const b = sqliteTaskStore(other)
      const agent = server.deps.agents.getBySlug('writer')?.id as string
      for (let i = 0; i < 20; i++) {
        a.enqueue({
          agentId: agent,
          title: `t${i}`,
          brief: null,
          inputs: [],
          priority: 'normal',
          dueAt: null,
          createdBy: 'client',
          now: 1000 + i,
        })
      }
      const got: string[] = []
      for (let i = 0; i < 30; i++) {
        const store = i % 2 === 0 ? a : b
        const task = store.claimNext(agent, `program:p:${i}`, 2000 + i)
        if (task !== undefined) got.push(task.id)
      }
      expect(got).toHaveLength(20)
      expect(new Set(got).size).toBe(20)
      expect(a.queued(agent)).toEqual([])
    } finally {
      other.close()
    }
  })

  test('two worker runs at once split the queue: every task is run exactly once', async () => {
    const same = Array.from({ length: 6 }, () =>
      finalReport({ status: 'done', summary: 'done', outputs: [] }),
    )
    const { app } = fresh({ writer: same })
    const p1 = await createProgram(app, {
      agentId: 'writer',
      name: 'Worker A',
      worker: { maxTasks: 2 },
    })
    const p2 = await createProgram(app, {
      agentId: 'writer',
      name: 'Worker B',
      worker: { maxTasks: 2 },
    })
    for (let i = 0; i < 4; i++) await queue(app, { agentId: 'writer', title: `Task ${i}` })
    const [r1, r2] = await Promise.all([runNow(app, p1.id), runNow(app, p2.id)])
    expect(r1.started && r2.started).toBe(true)
    await until('all tasks done', async () => {
      const tasks = await listTasks(app)
      return tasks.length === 4 && tasks.every(settled)
    })
    const tasks = await listTasks(app)
    expect(tasks.every((t) => t.status === 'done')).toBe(true)
    expect(new Set(tasks.map((t) => t.sessionId)).size).toBe(4)
    const total = (await runs(app, p1.id)).length + (await runs(app, p2.id)).length
    expect(total).toBe(4)
    // no task was run twice
    expect(tasks.every((t) => t.history.length === 0 && t.round === 1)).toBe(true)
  })
})

describe('schedule', () => {
  test('a scheduled worker program skips a slot with nothing queued and takes the tasks of the next one', async () => {
    const { app, server } = fresh({
      writer: [...draft('slot')],
    })
    const worker = await createProgram(app, {
      agentId: 'writer',
      worker: { maxTasks: 2 },
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    const owned = server.deps.routines.getByProgram(worker.id)
    const setDue = (at: number) =>
      server.conn.sqlite
        .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
        .run(at, owned?.id as string)
    const now = Date.now()
    setDue(now - 2000)
    await server.routines.tick(now)
    const skipped = (await (await app.request(`/routines/${owned?.id}/runs`)).json()) as {
      runs: Array<{ status: string; reason?: string | null }>
    }
    expect(skipped.runs[0]).toMatchObject({ status: 'skipped' })
    expect(await runs(app, worker.id)).toHaveLength(0)

    const t = await queue(app, { agentId: 'writer', title: 'Script: slot' })
    setDue(now - 1000)
    await server.routines.tick(now + 1)
    await until('the task is done', async () => settled(await getTask(app, t.id)))
    expect((await getTask(app, t.id)).sessionId).toBe(`program:${worker.id}:${now - 1000}`)
    await until('routine run succeeded', async () => {
      const r = (await (await app.request(`/routines/${owned?.id}/runs`)).json()) as {
        runs: Array<{ status: string }>
      }
      return r.runs[0]?.status === 'succeeded'
    })
  })
})
