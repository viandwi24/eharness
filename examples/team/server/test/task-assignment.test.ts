/**
 * Assigning work (docs/plans/P40-team-autonomous-operations.md, phase N): a task assigned to an
 * agent starts on its own with the agent's normal tools and permissions, per-agent concurrency and
 * the team cap queue the rest, hold, task grants, review by creator, send back restarts, and the
 * worker programs of before keep owning the queue of their agent. Scripted models only.
 */
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
import { createTask, dispatchQueue } from '../src/app/work-queue.ts'
import { inReview, type Task } from '../src/domain/tasks.ts'
import {
  assignedSessionId,
  normalizeGrants,
  parseAssignedSession,
  queueReason,
  taskGrantRules,
  taskRunPrompt,
} from '../src/domain/work-queue.ts'
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

type Slug = 'lead' | 'researcher' | 'writer'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}

function fresh(script: Partial<Record<Slug, ScriptedStepInput[]>>): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40m-'))
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
    instanceId: 'task-assignment-test',
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
  return { server, app: server.app, models }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
/** The owner-facing create route was removed (P55): tests assign through the use case. */
const serverOfApp = new WeakMap<object, Server>()
type TaskView = Task & { column?: string; queue?: string | null }
async function getTask(app: Server['app'], id: string): Promise<TaskView> {
  const res = await app.request(`/tasks/${id}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { task: TaskView }).task
}
async function assign(app: Server['app'], body: Record<string, unknown>): Promise<TaskView> {
  const server = serverOfApp.get(app) as Server
  return createTask(server.deps, body as never) as TaskView
}
const post = (app: Server['app'], path: string, body?: unknown) =>
  app.request(path, json('POST', body))
const settled = (t: TaskView) => !['running', 'needs_action', 'queued'].includes(t.status)

/**
 * Library edits are allowed for role agents out of the box (`appRulesOf`: the point of a writer), so
 * a task never parks on a write unless the agent's own rules ask first. This is that rule: the
 * "Ask first" a client sets on an agent, which a task grant lifts for exactly the granted tools.
 */
function askBeforeWriting(server: Server, slug: string): void {
  const def = server.deps.agents.getBySlug(slug)
  if (def === undefined) throw new Error('seed')
  updateAgent(server.deps, def.id, {
    rules: { ...def.rules, ask: [...def.rules.ask, 'write_file'] },
  })
}

let seq = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStep => ({
  toolCalls: [{ toolName, input, toolCallId: `c-${toolName}-${++seq}` }],
})
const report = (summary = 'done', extra: Partial<ScriptedStep> = {}): ScriptedStep => ({
  ...call('final_answer', { status: 'done', summary, outputs: [] }),
  ...extra,
})

describe('domain', () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({
      id: 't1',
      title: 'Write the note',
      agentId: 'a',
      status: 'queued',
      priority: 'normal',
      dueAt: null,
      brief: 'Make it short.',
      inputs: ['/library/a.md'],
      round: 1,
      grants: null,
      ...over,
    }) as Task

  test('the session of an assigned task and why a queued task waits', () => {
    expect(assignedSessionId('t1', 2)).toBe('task:t1:2')
    expect(parseAssignedSession('task:t1:2')).toEqual({ taskId: 't1', round: 2 })
    expect(parseAssignedSession('program:p:1')).toBeUndefined()
    expect(queueReason({ hold: true, workerProgram: true, active: 0, limit: 1 })).toBe('hold')
    expect(queueReason({ hold: false, workerProgram: true, active: 0, limit: 1 })).toBe('worker')
    expect(queueReason({ hold: false, workerProgram: false, active: 1, limit: 1 })).toBe('slot')
    expect(queueReason({ hold: false, workerProgram: false, active: 1, limit: 2 })).toBe('starting')
  })

  test('grants: empty is none, paths and connectors become allow rules', () => {
    expect(normalizeGrants(undefined)).toBeNull()
    expect(normalizeGrants({ tools: [' '], read: [] })).toBeNull()
    const g = normalizeGrants({
      tools: ['add_comment'],
      connectors: ['tracker'],
      write: ['/library/out/**'],
    })
    expect(g).toEqual({
      tools: ['add_comment'],
      connectors: ['tracker'],
      read: [],
      write: ['/library/out/**'],
    })
    const rules = taskGrantRules(g as never, [
      { name: 'tracker_list', connectorId: 'tracker', connectionIds: [] },
      { name: 'other_tool', connectorId: 'other', connectionIds: [] },
    ])
    expect(rules).toContain('add_comment')
    expect(rules).toContain('tracker_list')
    expect(rules).not.toContain('other_tool')
    expect(rules).toContain('Edit(/library/out/**)')
    expect(rules).toContain('Read(/library/out/**)')
  })

  test("review is the creator's choice", () => {
    const done = {
      status: 'done' as const,
      createdBy: 'client',
      acceptedAt: null,
      report: { status: 'done' as const, summary: 's', outputs: [] as string[] },
    }
    expect(inReview(done)).toBe(true)
    expect(inReview({ ...done, review: true })).toBe(true)
    expect(inReview({ ...done, review: false })).toBe(false)
  })

  test('the prompt carries the brief, the inputs, the grants and the feedback round, no worker tool', () => {
    const text = taskRunPrompt(
      task({
        round: 2,
        grants: { tools: ['add_comment'], connectors: [], read: [], write: ['/library/out/**'] },
      }),
    )
    expect(text).toContain('Write the note')
    expect(text).toContain('Make it short.')
    expect(text).toContain('/library/a.md')
    expect(text).toContain('add_comment')
    expect(text).toContain('read and write /library/out/**')
    expect(text).toContain('sent this task back')
    expect(text).not.toContain('complete_task')
  })
})

describe('assigning starts it', () => {
  test('a task for an agent without a worker program runs by itself and waits in Review', async () => {
    const { app, server, models } = fresh({ writer: [report('wrote the note')] })
    const t = await assign(app, {
      agentId: 'writer',
      title: 'Release note',
      brief: 'Write the note about pricing.',
    })
    expect(t.createdBy).toBe('client')
    expect(t.review).toBe(true)
    await until('the task ends', async () => settled(await getTask(app, t.id)))
    const done = await getTask(app, t.id)
    expect(done).toMatchObject({ status: 'done', origin: 'user', round: 1, acceptedAt: null })
    expect(done.sessionId).toBe(`task:${t.id}:1`)
    expect(done.report?.summary).toBe('wrote the note')
    expect(done.column).toBe('review')
    // the agent got the task, as a chat would give it: its normal tools, no worker tool
    expect(JSON.stringify(models.writer?.prompts[0])).toContain('Write the note about pricing.')
    const names = ((models.writer?.calls[0]?.tools ?? []) as Array<{ name: string }>).map(
      (x) => x.name,
    )
    expect(names).not.toContain('complete_task')
    expect(names).toContain('escalate')
    expect(server.deps.tasks.running(done.agentId)).toBe(0)

    // accept leaves Review
    expect((await post(app, `/tasks/${t.id}/accept`)).status).toBe(200)
    expect((await getTask(app, t.id)).column).toBe('done')
  })

  test('review:false goes straight to Done; an agent that assigns work does not ask for review by default', async () => {
    const { app, server } = fresh({
      lead: [call('create_task', { agent: 'writer', title: 'Draft' }), { text: 'assigned' }],
      writer: [report('drafted'), report('second')],
    })
    const own = await assign(app, { agentId: 'writer', title: 'No review', review: false })
    await until('first ends', async () => settled(await getTask(app, own.id)))
    expect((await getTask(app, own.id)).column).toBe('done')

    await (await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))).text()
    const lead = server.deps.agents.getBySlug('lead')
    const delegated = server.deps.tasks
      .list({ limit: 20 })
      .find((x) => x.createdBy === lead?.id) as Task
    expect(delegated.review).toBe(false)
    await until('delegated ends', async () => settled(await getTask(app, delegated.id)))
    expect((await getTask(app, delegated.id)).column).toBe('done')
  })
})

describe('concurrency', () => {
  test('one task at a time per agent by default: the next one waits for a slot and starts when the first ends', async () => {
    const { app } = fresh({ writer: [report('first', { delayMs: 300 }), report('second')] })
    const a = await assign(app, { agentId: 'writer', title: 'A' })
    const b = await assign(app, { agentId: 'writer', title: 'B' })
    expect((await getTask(app, a.id)).status).toBe('running')
    const waiting = await getTask(app, b.id)
    expect(waiting).toMatchObject({ status: 'queued', column: 'queued', queue: 'slot' })
    await until(
      'both end',
      async () => settled(await getTask(app, a.id)) && settled(await getTask(app, b.id)),
    )
    const first = await getTask(app, a.id)
    const second = await getTask(app, b.id)
    expect(second.status).toBe('done')
    // the second only started after the first had finished
    expect(second.startedAt).toBeGreaterThanOrEqual(first.endedAt as number)
  })

  test('the setting per agent raises it', async () => {
    const { app, server } = fresh({
      writer: [report('a', { delayMs: 300 }), report('b', { delayMs: 300 })],
    })
    const writer = server.deps.agents.getBySlug('writer')
    expect(writer?.taskConcurrency).toBe(1)
    expect(
      (await app.request(`/agents/${writer?.id}`, json('PATCH', { taskConcurrency: 9 }))).status,
    ).toBe(400)
    const saved = await app.request(`/agents/${writer?.id}`, json('PATCH', { taskConcurrency: 2 }))
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as { taskConcurrency: number }).taskConcurrency).toBe(2)
    const a = await assign(app, { agentId: 'writer', title: 'A' })
    const b = await assign(app, { agentId: 'writer', title: 'B' })
    expect((await getTask(app, a.id)).status).toBe('running')
    expect((await getTask(app, b.id)).status).toBe('running')
    await until(
      'both end',
      async () => settled(await getTask(app, a.id)) && settled(await getTask(app, b.id)),
    )
  })

  test('the team-wide spawn cap still applies across agents', async () => {
    const { app, server } = fresh({
      writer: [report('w', { delayMs: 300 })],
      researcher: [report('r')],
    })
    server.deps.settings.patch({ spawnCap: 1 }, Date.now())
    const a = await assign(app, { agentId: 'writer', title: 'A' })
    const b = await assign(app, { agentId: 'researcher', title: 'B' })
    expect((await getTask(app, a.id)).status).toBe('running')
    expect(await getTask(app, b.id)).toMatchObject({ status: 'queued', queue: 'slot' })
    await until(
      'both end',
      async () => settled(await getTask(app, a.id)) && settled(await getTask(app, b.id)),
    )
  })
})

describe('hold and start now', () => {
  test('a held task does not start; Start now and releasing it do', async () => {
    const { app } = fresh({ writer: [report('one'), report('two')] })
    const a = await assign(app, { agentId: 'writer', title: 'Held A', hold: true })
    const b = await assign(app, { agentId: 'writer', title: 'Held B', hold: true })
    await sleep(100)
    expect(await getTask(app, a.id)).toMatchObject({ status: 'queued', hold: true, queue: 'hold' })
    const started = await post(app, `/tasks/${a.id}/start`)
    expect(started.status).toBe(200)
    expect(((await started.json()) as Task).status).toBe('running')
    await until('A ends', async () => settled(await getTask(app, a.id)))
    expect((await post(app, `/tasks/${a.id}/start`)).status).toBe(409)
    const released = await app.request(`/tasks/${b.id}`, json('PATCH', { hold: false }))
    expect(released.status).toBe(200)
    await until('B ends', async () => settled(await getTask(app, b.id)))
    expect((await getTask(app, b.id)).status).toBe('done')
  })

  test('tasks queued before a restart start at the boot pass, held ones stay', async () => {
    const { app, server } = fresh({ writer: [report('late')] })
    const agent = server.deps.agents.getBySlug('writer')?.id as string
    const row = (title: string, hold: boolean) =>
      server.deps.tasks.enqueue({
        agentId: agent,
        title,
        brief: null,
        inputs: [],
        priority: 'normal',
        dueAt: null,
        createdBy: 'client',
        hold,
        now: Date.now(),
      })
    const waiting = row('Queued by the old version', false)
    const held = row('Held', true)
    expect(dispatchQueue(server.deps)).toBe(1)
    await until('it ends', async () => settled(await getTask(app, waiting.id)))
    expect((await getTask(app, held.id)).status).toBe('queued')
  })
})

describe('send back restarts the work', () => {
  test('the note reaches the agent in a fresh session, no manual run', async () => {
    const { app, models } = fresh({ writer: [report('v1'), report('v2')] })
    const t = await assign(app, { agentId: 'writer', title: 'Note', brief: 'Write it.' })
    await until('round 1 ends', async () => settled(await getTask(app, t.id)))
    const first = await getTask(app, t.id)
    const back = await post(app, `/tasks/${t.id}/send-back`, { note: 'Make it shorter.' })
    expect(back.status).toBe(200)
    const body = (await back.json()) as TaskView & { hint: string }
    expect(body.round).toBe(2)
    // it started at once: the hint says the agent works on it again (not "queued")
    expect(body.hint).toMatch(/working on it again with your feedback|starts the revision/)
    await until('round 2 ends', async () => {
      const x = await getTask(app, t.id)
      return x.round === 2 && settled(x)
    })
    const revised = await getTask(app, t.id)
    expect(revised).toMatchObject({ status: 'done', round: 2, acceptedAt: null })
    expect(revised.sessionId).toBe(`task:${t.id}:2`)
    expect(revised.history).toEqual([first.sessionId])
    expect(revised.report?.summary).toBe('v2')
    expect(JSON.stringify(models.writer?.prompts[1])).toContain('Make it shorter.')
    expect(revised.column).toBe('review')
  })
})

describe('worker programs keep owning their agent queue', () => {
  test('an active worker program leaves the task Queued; Start now runs it anyway', async () => {
    const { app } = fresh({ writer: [report('by hand')] })
    const res = await app.request(
      '/programs',
      json('POST', {
        agentId: 'writer',
        name: 'Script writer',
        brief: 'Take the task.',
        authority: { read: [], write: [] },
        gates: [],
        escalation: '',
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
        worker: { maxTasks: 1 },
      }),
    )
    expect(res.status).toBe(201)
    const t = await assign(app, { agentId: 'writer', title: 'For the worker' })
    await sleep(150)
    expect(await getTask(app, t.id)).toMatchObject({ status: 'queued', queue: 'worker' })
    expect((await post(app, `/tasks/${t.id}/start`)).status).toBe(200)
    await until('it ends', async () => settled(await getTask(app, t.id)))
    expect((await getTask(app, t.id)).sessionId).toBe(`task:${t.id}:1`)
  })
})

describe('task grants', () => {
  test('negative control: the same write without the grant asks first and writes nothing', async () => {
    const { app, server } = fresh({
      writer: [
        call('write_file', { path: '/library/out/note.md', content: 'hello' }),
        report('wrote it'),
      ],
    })
    askBeforeWriting(server, 'writer')
    const t = await assign(app, { agentId: 'writer', title: 'Write the note' })
    await until('it parks on the approval', async () => {
      const x = await getTask(app, t.id)
      return x.status === 'needs_action' && x.pendingKind === 'approval'
    })
    expect(await server.deps.library.read('/library/out/note.md')).toBeUndefined()
  })

  test('a write path granted with the task needs no approval', async () => {
    const { app, server } = fresh({
      writer: [
        call('write_file', { path: '/library/out/note.md', content: 'hello' }),
        report('wrote it'),
      ],
    })
    askBeforeWriting(server, 'writer')
    const t = await assign(app, {
      agentId: 'writer',
      title: 'Write the note',
      grants: { write: ['/library/out/**'] },
    })
    expect(t.grants).toEqual({ tools: [], connectors: [], read: [], write: ['/library/out/**'] })
    await until('it ends', async () => settled(await getTask(app, t.id)))
    const done = await getTask(app, t.id)
    expect(done.status).toBe('done')
    expect((await server.deps.library.read('/library/out/note.md'))?.text).toBe('hello')
    // bad paths are refused
    expect(() =>
      createTask(server.deps, { agentId: 'writer', title: 'x', grants: { write: ['library'] } }),
    ).toThrow()
  })
})

describe('hardening (P40 review pass)', () => {
  const enqueue = (server: Server, agentSlug: string, title: string, hold = false) => {
    const agent = server.deps.agents.getBySlug(agentSlug)
    if (agent === undefined) throw new Error('seed')
    return server.deps.tasks.enqueue({
      agentId: agent.id,
      title,
      brief: null,
      inputs: [],
      priority: 'normal',
      dueAt: null,
      createdBy: 'client',
      hold,
      now: Date.now(),
    })
  }

  test('a task claimed running whose process died before its first message goes back to the queue', async () => {
    const { app, server } = fresh({ writer: [report('after the restart')] })
    const row = enqueue(server, 'writer', 'Stranded')
    const claimed = server.deps.tasks.claimAssigned(row.agentId, 1, Date.now() - 600_000)
    expect(claimed?.status).toBe('running')
    // the session never got a message: the repair pass (the boot pass has no grace) puts it back
    const report_ = await server.team.reconcile()
    expect(report_.drift.some((d) => d.taskId === row.id && d.to === 'queued')).toBe(true)
    const back = await getTask(app, row.id)
    expect(back.status).toBe('queued')
    expect(back.sessionId).toBe(`queued:${row.id}`)
    // it starts again and finishes: the slot was not lost
    expect(dispatchQueue(server.deps)).toBe(1)
    await until('it ends', async () => settled(await getTask(app, row.id)))
    expect((await getTask(app, row.id)).status).toBe('done')
  })

  test('a task parked on an approval keeps its agent slot (and says so) but not a place under the team cap', async () => {
    const { app, server } = fresh({
      writer: [call('write_file', { path: '/library/out/a.md', content: 'x' }), report('done')],
      researcher: [report('researched')],
    })
    server.deps.settings.patch({ spawnCap: 1 }, Date.now())
    askBeforeWriting(server, 'writer')
    const parked = await assign(app, { agentId: 'writer', title: 'Needs approval' })
    await until('it parks', async () => (await getTask(app, parked.id)).status === 'needs_action')
    const same = await assign(app, { agentId: 'writer', title: 'Behind the approval' })
    const behind = await getTask(app, same.id)
    expect(behind).toMatchObject({ status: 'queued', queue: 'slot' })
    expect(JSON.stringify(behind)).toContain('Needs approval')
    expect(JSON.stringify(behind)).toContain('needs your approval')
    // another agent is not blocked by the parked task (cap 1): it starts and ends
    const other = await assign(app, { agentId: 'researcher', title: 'Free agent' })
    await until('the other agent works', async () => settled(await getTask(app, other.id)))
  })

  test('send back clears a hold left from a hand start and resolves the "ready for review" notice', async () => {
    const { app, server } = fresh({ writer: [report('v1'), report('v2')] })
    const t = await assign(app, { agentId: 'writer', title: 'Held first', hold: true })
    expect((await post(app, `/tasks/${t.id}/start`)).status).toBe(200)
    await until('round 1 ends', async () => settled(await getTask(app, t.id)))
    // the product posts this notice itself when round 1 reaches Review (keyed per round); post it
    // here only when this path did not, so the test holds either way
    const key = `review:${t.id}:1`
    const n =
      server.deps.notifications.byKey(key) ??
      server.deps.notifications.insert({
        id: 'n-review',
        kind: 'alert',
        key,
        title: 'Ready for review',
        body: 'x',
        link: null,
        agentId: t.agentId,
        createdAt: Date.now(),
      })
    expect(n).toBeDefined()
    const back = await post(app, `/tasks/${t.id}/send-back`, { note: 'Shorter.' })
    expect(back.status).toBe(200)
    const body = (await back.json()) as TaskView & { hint: string }
    expect(body.hold).toBe(false)
    expect(body.hint).not.toContain('hold')
    expect(server.deps.notifications.byKey(key)?.dismissedAt).not.toBeNull()
    expect(server.deps.notifications.byKey(key)?.dismissedAt).toBeDefined()
    await until('round 2 ends', async () => {
      const x = await getTask(app, t.id)
      return x.round === 2 && settled(x)
    })
  })
})
