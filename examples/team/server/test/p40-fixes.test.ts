/**
 * Fixes of the first real-model pass over the P40 programs (docs/plans/P40-team-autonomous-operations.md,
 * "Fixes of the first real-model pass"): file tools a program's authority grants although the Files
 * capability of its agent is off, the budget floor (a per-run output cap, a warning for a budget
 * below one model call), `propose_plan` needing an agent and not repeating itself, honest numbers in
 * the heartbeat and the digest, the cost in `list_tasks`, the board column of a run parked on a
 * decision, and the channel tools of an agent that is bound to no channel. Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { teamStatus } from '../src/app/heartbeat.ts'
import { createTask } from '../src/app/work-queue.ts'
import {
  boardLine,
  buildDigest,
  observe,
  parseBeatResult,
  periodStarts,
} from '../src/domain/heartbeat.ts'
import type { Program } from '../src/domain/programs.ts'
import {
  budgetWarnings,
  callReserveUsd,
  programMaxOutputTokens,
  runFileTools,
  toolWarnings,
} from '../src/domain/programs.ts'
import type { Task } from '../src/domain/tasks.ts'
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
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
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

function instance(
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: { catalog?: Record<string, unknown> } = {},
): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40fix-'))
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
type TaskView = Task & { column?: string }
type ProgramView = Program & {
  warnings?: Array<{ code: string; field: string; message: string }>
  triggerState?: { status: string; pausedReason: string | null } | null
}

const BASE = {
  agentId: 'researcher',
  name: 'Video scripts',
  brief: 'Write a script per title into /library/reports/.',
  authority: { read: ['/library/videos/**'], write: ['/library/reports/**'] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
async function createProgram(app: Server['app'], body: Record<string, unknown> = {}) {
  const res = await app.request('/programs', json('POST', { ...BASE, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as ProgramView
}
async function runNow(app: Server['app'], id: string) {
  const res = await app.request(`/programs/${id}/run`, json('POST'))
  return res
}
async function runs(app: Server['app'], programId: string): Promise<TaskView[]> {
  return ((await (await app.request(`/programs/${programId}/runs`)).json()) as { runs: TaskView[] })
    .runs
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
let seq = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `fix-${toolName}-${++seq}` }],
})
const toolNames = (m: ScriptedModel | undefined, at = 0): string[] =>
  ((m?.calls[at]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

async function turnOffFileEdit(server: Server, slug: string): Promise<void> {
  const def = server.deps.agents.getBySlug(slug)
  if (def === undefined) throw new Error('seed')
  const res = await server.app.request(
    `/agents/${def.id}/connectors`,
    json('PUT', { connections: { 'builtin:files': { capabilities: { edit: 'off' } } } }),
  )
  if (res.status !== 200) throw new Error(await res.text())
  await server.factory.prepare(def)
  expect(server.connectors.activated(def.id)?.rules.deny).toContain('write_file')
}

/** The verdict of each tool call in a stored session, in order (`name:state`). */
async function verdicts(app: Server['app'], sessionId: string): Promise<string[]> {
  const res = await app.request(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=100`)
  const body = (await res.json()) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
  return body.messages
    .flatMap((m) => m.parts)
    .filter((p) => String(p.type).startsWith('tool-') && p.type !== 'tool-final_answer')
    .map((p) => `${String(p.type).slice(5)}:${String(p.state)}`)
}

describe('finding 1: the file tools a program grants', () => {
  test('domain: what an authority grants of the file tools', () => {
    const none = { tools: [], connectors: [], read: [], write: [] }
    expect(runFileTools(none)).toEqual([])
    expect(runFileTools({ ...none, read: ['/library/in/**'] }).sort()).toEqual(
      ['glob', 'grep', 'list_files', 'read_file'].sort(),
    )
    expect(runFileTools({ ...none, write: ['/library/out/**'] })).toEqual(
      expect.arrayContaining(['write_file', 'edit_file', 'read_file']),
    )
    expect(runFileTools({ ...none, tools: ['write_file'] })).toEqual(['write_file'])
    expect(runFileTools({ ...none, tools: ['Edit(/library/x/**)'] })).toContain('edit_file')
    // deleting is never part of an authority
    expect(runFileTools({ ...none, write: ['/library/**'], tools: ['delete_file'] })).not.toContain(
      'delete_file',
    )
  })

  test('a run gets write_file for its paths although Files edit is off; chats still do not', async () => {
    const { app, server, models } = instance({
      researcher: [
        call('write_file', { path: '/library/reports/a.md', content: 'a' }),
        call('write_file', { path: '/library/elsewhere/b.md', content: 'b' }),
        finalReport({ status: 'done', summary: 'ok', outputs: ['/library/reports/a.md'] }),
        { text: 'chat answer' },
      ],
    })
    await turnOffFileEdit(server, 'researcher')

    const p = await createProgram(app)
    expect((await runNow(app, p.id)).status).toBe(202)
    const run = await firstRun(app, p.id)
    expect(run.status).toBe('done')
    // the tool existed in the run
    expect(toolNames(models.researcher, 0)).toContain('write_file')
    expect(toolNames(models.researcher, 0)).toContain('edit_file')
    // inside the granted path it ran; outside it, the authority refused it (not "no such tool")
    expect(await verdicts(app, run.sessionId)).toEqual([
      'write_file:output-available',
      'write_file:output-denied',
    ])
    const stored = await server.deps.library.read('/library/reports/a.md')
    expect(stored?.text).toBe('a')

    // a chat of the same agent still has the capability switched off
    const chat = await app.request(
      '/sessions/dm:researcher/chat',
      postAs('dm:researcher', userMessage('hi')),
    )
    await chat.text()
    const lastCall = (models.researcher?.calls.length ?? 1) - 1
    expect(toolNames(models.researcher, lastCall)).not.toContain('write_file')
    expect(toolNames(models.researcher, lastCall)).toContain('read_file')
  })

  test('a chat that is already open gets the tools of a connector change at its next message', async () => {
    const { app, server, models } = instance({
      researcher: [{ text: 'first' }, { text: 'second' }],
    })
    await turnOffFileEdit(server, 'researcher')
    const say = async (text: string) =>
      (
        await app.request(
          '/sessions/dm:researcher/chat',
          postAs('dm:researcher', userMessage(text)),
        )
      ).text()
    await say('one')
    const first = (models.researcher?.calls.length ?? 1) - 1
    expect(toolNames(models.researcher, first)).not.toContain('write_file')
    // switched on again while the session is open (a busy group chat is never idle-evicted)
    const def = server.deps.agents.getBySlug('researcher')
    const res = await app.request(
      `/agents/${def?.id}/connectors`,
      json('PUT', { connections: { 'builtin:files': { capabilities: { edit: 'allow' } } } }),
    )
    expect(res.status).toBe(200)
    await say('two')
    const second = (models.researcher?.calls.length ?? 1) - 1
    expect(second).toBeGreaterThan(first)
    expect(toolNames(models.researcher, second)).toContain('write_file')
    // the model is told once what changed (an earlier "I cannot" in the chat is outdated)
    const res2 = await app.request(
      `/sessions/${encodeURIComponent('dm:researcher')}/messages?limit=50`,
    )
    const body = JSON.stringify(await res2.json())
    expect(body).toContain('agent.tools.changed')
    expect(body).toContain('Now available: ')
    expect(body).toMatch(/Now available: [^.]*write_file/)
  })

  test('a session object held across a connector change is replaced by the new build', async () => {
    const { server } = instance({ researcher: [{ text: 'first' }, { text: 'second' }] })
    await turnOffFileEdit(server, 'researcher')
    const def = server.deps.agents.getBySlug('researcher')
    if (def === undefined) throw new Error('seed')
    // a channel chat keeps its session object between messages
    const held = server.factory.openSession(def, 'channel:test:held')
    await (await held.send({ text: 'one' } as never)).result
    await server.app.request(
      `/agents/${def.id}/connectors`,
      json('PUT', { connections: { 'builtin:files': { capabilities: { edit: 'allow' } } } }),
    )
    await server.factory.prepare(def)
    const next = server.factory.openSession(def, 'channel:test:held')
    expect(next).not.toBe(held)
    await (await next.send({ text: 'two' } as never)).result
    expect(server.connectors.activated(def.id)?.rules.deny ?? []).not.toContain('write_file')
  })

  test('a program with no write paths does not get the write tools', async () => {
    const { app, server, models } = instance({
      researcher: [finalReport({ status: 'done', summary: 'ok', outputs: [] })],
    })
    await turnOffFileEdit(server, 'researcher')
    const p = await createProgram(app, { authority: { read: ['/library/videos/**'], write: [] } })
    await runNow(app, p.id)
    await firstRun(app, p.id)
    expect(toolNames(models.researcher, 0)).toContain('read_file')
    expect(toolNames(models.researcher, 0)).not.toContain('write_file')
  })

  test('request_authority for a tool the agent can never have explains it instead of parking', async () => {
    const { app, models } = instance({
      researcher: [
        call('request_authority', { tools: ['no_such_tool'], why: 'I need it' }),
        finalReport({ status: 'needs_decision', summary: 'could not', outputs: [] }),
      ],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const run = await firstRun(app, p.id)
    // nothing parked, no decision was opened
    expect(run.status).not.toBe('needs_action')
    const open = (await (await app.request('/decisions?status=open&kind=amendment')).json()) as {
      decisions: unknown[]
    }
    expect(open.decisions).toEqual([])
    const seen = JSON.stringify(models.researcher?.prompts[1])
    expect(seen).toContain('no_such_tool')
    expect(seen).toContain('Asking for it cannot help')
  })
})

describe('finding 2: the budget floor', () => {
  // DeepSeek-like prices per million tokens; the agent-wide cap is 32k output tokens
  const info = { id: 'deepseek', pricing: { input: 0.27, output: 1.1 }, maxOutputTokens: 32_768 }

  test('domain: the output cap is sized from the budget, the floor is one worst-case call', () => {
    expect(callReserveUsd(info, 32_768)).toBeCloseTo(0.0414, 3)
    // no budget: the default cap, never above the model limit
    expect(programMaxOutputTokens({ perRunUsd: null, perDayUsd: null }, info)).toBe(16_384)
    expect(
      programMaxOutputTokens(
        { perRunUsd: null, perDayUsd: null },
        { ...info, maxOutputTokens: 4096 },
      ),
    ).toBe(4096)
    // a small budget gets a small cap, and one call then reserves at most about half of it
    const cap = programMaxOutputTokens({ perRunUsd: 0.02, perDayUsd: null }, info)
    expect(cap).toBeLessThan(16_384)
    expect(callReserveUsd(info, cap) as number).toBeLessThanOrEqual(0.0101)
    // an explicit cap wins
    expect(
      programMaxOutputTokens({ perRunUsd: 0.02, perDayUsd: null, maxOutputTokens: 9000 }, info),
    ).toBe(9000)
    // unpriced model: nothing to size, no warning
    expect(programMaxOutputTokens({ perRunUsd: 0.01, perDayUsd: null }, {})).toBe(16_384)
    expect(budgetWarnings({ perRunUsd: 0.0001, perDayUsd: null }, {})).toEqual([])
    // a budget below one call warns, with the minimum
    const warnings = budgetWarnings(
      { perRunUsd: 0.001, perDayUsd: 5, maxOutputTokens: 16_384 },
      info,
    )
    expect(warnings.map((w) => w.field)).toEqual(['budget.perRunUsd'])
    expect(warnings[0]?.message).toContain('deepseek')
  })

  test('a run with a small budget passes the sized cap to every model call and finishes', async () => {
    const catalog = {
      scripted: {
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        pricing: { input: 0.27, output: 1.1 },
      },
    }
    const { app, models } = instance(
      { researcher: [finalReport({ status: 'done', summary: 'ok', outputs: [] })] },
      { catalog },
    )
    // $0.02 per run: the 32k output reservation of the agent ($0.036) alone would not fit
    const p = await createProgram(app, { budget: { perRunUsd: 0.02, perDayUsd: null } })
    await runNow(app, p.id)
    const run = await firstRun(app, p.id)
    expect(run.status).toBe('done')
    const cap = models.researcher?.calls[0]?.maxOutputTokens as number
    expect(cap).toBeGreaterThanOrEqual(2048)
    expect(cap).toBeLessThan(16_384)
  })

  test('the check endpoint and the save answer warn about a budget below one call', async () => {
    const catalog = {
      scripted: {
        contextWindow: 200_000,
        maxOutputTokens: 32_768,
        pricing: { input: 0.27, output: 1.1 },
      },
    }
    const { app } = instance({}, { catalog })
    const res = await app.request(
      '/programs/check',
      json('POST', {
        agentId: 'researcher',
        budget: { perRunUsd: 0.001, maxOutputTokens: 16_384 },
      }),
    )
    expect(res.status).toBe(200)
    const { warnings } = (await res.json()) as { warnings: Array<{ code: string; field: string }> }
    expect(warnings).toEqual([
      expect.objectContaining({ code: 'budget-below-minimum', field: 'budget.perRunUsd' }),
    ])
    const saved = await createProgram(app, {
      budget: { perRunUsd: 0.001, perDayUsd: null, maxOutputTokens: 16_384 },
    })
    expect(saved.warnings?.map((w) => w.code)).toEqual(['budget-below-minimum'])
    expect(saved.budget.maxOutputTokens).toBe(16_384)
    // a budget that fits has no warning
    const fine = await createProgram(app, {
      name: 'fine',
      budget: { perRunUsd: 5, perDayUsd: null },
    })
    expect(fine.warnings).toEqual([])
  })

  test('the failure summary of a budget stop tells that nothing was necessarily spent', () => {
    const f = observe({
      now: 10_000_000,
      tasks: [],
      decisions: [],
      programs: [
        {
          program: { id: 'p', name: 'Reports', status: 'active', agentId: 'a' },
          trigger: null,
          runs: [
            {
              id: 't1',
              status: 'failed',
              endedAt: 9_999_000,
              summary: 'Stopped: the budget of this run was used up before it reported.',
              costUsd: 0,
            },
          ],
        },
      ],
      routines: [],
      connections: [],
      budget: null,
      requests: [],
      existing: [],
    })
    expect(f[0]?.detail).toContain('actually spent $0.0000')
  })
})

describe('finding 3: propose_plan', () => {
  const plan = (extra: Record<string, unknown>) =>
    call('propose_plan', {
      title: 'Weekly sales summary',
      name: 'Weekly sales summary',
      brief: 'Summarize the weekly sales numbers per region into /library/reports/sales/.',
      ...extra,
    })

  async function proposals(app: Server['app']) {
    const res = await app.request('/decisions?status=open&kind=proposal')
    return ((await res.json()) as { decisions: Array<{ id: string; agentId: string }> }).decisions
  }
  async function lastResult(app: Server['app'], sessionId: string): Promise<string[]> {
    const res = await app.request(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=50`)
    const body = (await res.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>
    }
    return body.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === 'tool-propose_plan')
      .map((p) => String(p.output ?? p.errorText))
  }

  test('an omitted agent is an error that lists the agents, and nothing is stored', async () => {
    const { app } = instance({ lead: [plan({}), { text: 'noted' }] })
    const res = await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))
    await res.text()
    expect(await proposals(app)).toEqual([])
    const [result] = await lastResult(app, 'dm:lead')
    expect(result).toContain('`agent` is required')
    expect(result).toContain('researcher')
    expect(result).toContain('writer')
  })

  test('an unknown agent is an error that lists the agents', async () => {
    const { app } = instance({ lead: [plan({ agent: 'nobody' }), { text: 'noted' }] })
    await (await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))).text()
    expect(await proposals(app)).toEqual([])
    expect((await lastResult(app, 'dm:lead'))[0]).toContain('no agent "nobody"')
  })

  test('near-identical open proposals of one agent are stored once and the model is told which one', async () => {
    const { app } = instance({
      lead: [
        plan({ agent: 'writer' }),
        plan({
          agent: 'writer',
          title: 'Weekly sales summary report',
          name: 'Sales summary, weekly',
          brief: 'Summarize weekly sales numbers for every region into /library/reports/sales/.',
        }),
        // another agent: not a duplicate
        plan({ agent: 'researcher' }),
        { text: 'done' },
      ],
    })
    await (await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('go')))).text()
    const open = await proposals(app)
    expect(open).toHaveLength(2)
    const results = await lastResult(app, 'dm:lead')
    expect(results[0]).toContain('is waiting for the client')
    expect(results[1]).toContain('already open')
    expect(results[1]).toContain(open.find((d) => results[1]?.includes(d.id))?.id as string)
    expect(results[2]).toContain('is waiting for the client')
  })
})

describe('finding 4: honest numbers', () => {
  const task = (over: Partial<Task>): Task => ({
    id: 't',
    agentId: 'a',
    sessionId: 'program:p:1',
    parentSessionId: null,
    origin: 'program',
    title: 'Program run: P',
    status: 'done',
    pendingKind: null,
    startedAt: 0,
    endedAt: 1,
    summary: null,
    lastActivityAt: 1,
    costUsd: 0,
    tokens: 0,
    report: null,
    deliverables: null,
    brief: null,
    inputs: [],
    priority: 'normal',
    dueAt: null,
    createdBy: null,
    acceptedAt: null,
    round: 1,
    history: [],
    hold: false,
    review: true,
    grants: null,
    ...over,
  })

  test('the digest counts every run, lists the failed ones and the rest is on the board', () => {
    const runs = Array.from({ length: 19 }, (_, i) => ({
      programName: i < 3 ? 'Auditor' : 'Worker',
      report: (i === 0 ? 'digest' : 'task') as 'digest' | 'task',
      task: task({
        id: `t${i}`,
        status: i % 6 === 5 ? 'failed' : i === 18 ? 'running' : 'done',
        summary: i % 6 === 5 ? 'it broke' : null,
      }),
    }))
    const digest = buildDigest({
      since: 0,
      until: 3_600_000,
      runs,
      decisions: [],
      waiting: [],
      items: [],
      costUsd: 0.1,
      heartbeatCostUsd: 0,
    })
    // 19 runs in all, counted from their statuses
    expect(digest.text).toContain('19 runs: 15 done, 3 failed, 1 still running.')
    // the failed ones are named even though their program reports "task"
    expect(digest.text.match(/failed — it broke/g)).toHaveLength(3)
    // the one digest run is detailed, the rest is a count (19 - 1 detailed - 3 failed listed)
    expect(digest.text).toContain('15 more run(s) are on the board')
  })

  test('team_status states the spend from the ledger and the call log', async () => {
    const { server } = instance({})
    const lead = server.deps.agents.getBySlug('lead')
    const status = await teamStatus(server.deps, lead?.id as string)
    expect(status.text).toContain('Spend (from the model call log')
    expect(status.text).toContain('Task board (counted by the server, exact)')
    expect(status.text).toContain('today $0.0000')
    expect(status.text).toContain('says nothing about money spent')
  })
})

describe('finding 5: the cost of a task in list_tasks', () => {
  test('rows show what the session spent, a program filter narrows, the total is last', async () => {
    const catalog = {
      scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } },
    }
    const { app, server } = instance(
      {
        researcher: [
          {
            toolCalls: [
              {
                toolName: 'final_answer',
                input: { status: 'done', summary: 'ok', outputs: [] },
              },
            ],
            usage: { inputTokens: 100_000, outputTokens: 50_000 },
          },
        ],
        lead: [call('list_tasks', { program: 'Video scripts' }), { text: 'seen' }],
      },
      { catalog },
    )
    const p = await createProgram(app)
    await runNow(app, p.id)
    const run = await firstRun(app, p.id)
    expect(run.costUsd).toBeGreaterThan(0)
    await (
      await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('cost?')))
    ).text()
    const res = await app.request('/sessions/dm%3Alead/messages?limit=50')
    const body = (await res.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>
    }
    const output = String(
      body.messages.flatMap((m) => m.parts).find((x) => x.type === 'tool-list_tasks')?.output,
    )
    expect(output).toContain(`cost $${run.costUsd.toFixed(4)}`)
    expect(output).toContain('Cost of these 1 task(s)')
    void server
  })
})

describe('finding 6: a run parked on a decision is waiting on the board', () => {
  test('GET /tasks tells column waiting while the status stays running', async () => {
    const { app } = instance({
      researcher: [
        call('escalate_wait', { title: 'Publish?', question: 'May I publish?' }),
        finalReport({ status: 'done', summary: 'ok', outputs: [] }),
      ],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    await until('the decision is open', async () => {
      const open = (await (await app.request('/decisions?status=open')).json()) as {
        decisions: unknown[]
      }
      return open.decisions.length === 1
    })
    const list = (await (await app.request('/tasks')).json()) as { tasks: TaskView[] }
    const parked = list.tasks.find((t) => t.origin === 'program')
    expect(parked?.status).toBe('running')
    expect(parked?.column).toBe('waiting')
    const detail = (await (await app.request(`/tasks/${parked?.id}`)).json()) as { task: TaskView }
    expect(detail.task.column).toBe('waiting')
  })

  test('the heartbeat does not call a parked run stuck, it waits for the client', () => {
    const parked = {
      id: 't',
      agentId: 'a',
      sessionId: 'program:p:1',
      title: 'Program run: P',
      status: 'running',
      lastActivityAt: 0,
    } as unknown as Task
    const base = {
      now: 10 * 3_600_000,
      tasks: [parked],
      decisions: [],
      programs: [],
      routines: [],
      connections: [],
      budget: null,
      requests: [],
      existing: [],
    }
    expect(observe(base).map((f) => f.kind)).toEqual(['task.stuck'])
    const f = observe({ ...base, waitingSessions: new Set(['program:p:1']) })
    expect(f.map((x) => x.kind)).toEqual(['task.waiting'])
    expect(f[0]?.detail).toContain('decision')
  })
})

describe('finding 7: channel tools of an agent bound to no channel', () => {
  test('domain: only tools the agent can have are fine', () => {
    const tools = {
      available: new Set(['web_fetch', 'read_file']),
      channelTools: ['channel_send', 'channel_manage'],
      channelsBound: false,
    }
    expect(
      toolWarnings({ tools: ['web_fetch', 'Read(/library/**)', 'WebFetch(domain:x.com)'] }, tools),
    ).toEqual([])
    const out = toolWarnings({ tools: ['channel_send', 'web_search(x)', 'web_fetch'] }, tools)
    expect(out.map((w) => [w.code, w.message.split(':')[0]])).toEqual([
      ['channel-not-bound', 'channel_send'],
      ['tool-unavailable', 'web_search'],
    ])
    expect(
      toolWarnings(
        { tools: ['channel_send'] },
        { ...tools, channelsBound: true, available: new Set(['channel_send']) },
      ),
    ).toEqual([])
  })

  test('the save and check warn; a run fails early with the reason and spends nothing', async () => {
    const { app, models } = instance({
      researcher: [finalReport({ status: 'done', summary: 'never', outputs: [] })],
    })
    const body = { authority: { tools: ['channel_send', 'channel_manage'], read: [], write: [] } }
    const check = (await (
      await app.request('/programs/check', json('POST', { agentId: 'researcher', ...body }))
    ).json()) as { warnings: Array<{ code: string }> }
    expect(check.warnings.map((w) => w.code)).toEqual(['channel-not-bound', 'channel-not-bound'])
    const p = await createProgram(app, body)
    expect(p.warnings?.map((w) => w.code)).toEqual(['channel-not-bound', 'channel-not-bound'])

    const res = await runNow(app, p.id)
    expect(res.status).toBe(409)
    const refusal = ((await res.json()) as { error: { code: string; message: string } }).error
    expect(refusal).toMatchObject({ code: 'PROGRAM_UNRUNNABLE' })
    expect(refusal.message).toContain('not bound to any channel connection')
    // a refused start is not a run: no task, so it is never a failed run in the digest or the beat
    expect(await runs(app, p.id)).toEqual([])
    expect(models.researcher?.calls).toHaveLength(0)
  })
})

describe('manager, worker and auditor programs with Files edit off (real client use)', () => {
  test('the worker writes its script and completes its task; the auditor stays read only; the manager reads the cost', async () => {
    const catalog = { scripted: { contextWindow: 200_000, pricing: { input: 1, output: 2 } } }
    const { app, server, models } = instance(
      {
        writer: [
          call('write_file', { path: '/library/scripts/island.md', content: 'script' }),
          call('complete_task', {
            summary: 'drafted',
            outputs: ['/library/scripts/island.md'],
          }),
          {
            toolCalls: [
              {
                toolName: 'final_answer',
                input: {
                  status: 'done',
                  summary: 'drafted',
                  outputs: ['/library/scripts/island.md'],
                },
              },
            ],
            usage: { inputTokens: 10_000, outputTokens: 1_000 },
          },
        ],
        researcher: [
          call('write_file', { path: '/library/reports/audit.md', content: 'x' }),
          finalReport({ status: 'done', summary: 'audited', outputs: [] }),
        ],
        lead: [call('list_tasks', {}), { text: 'cost read' }],
      },
      { catalog },
    )
    await turnOffFileEdit(server, 'writer')
    await turnOffFileEdit(server, 'researcher')

    const worker = await createProgram(app, {
      agentId: 'writer',
      name: 'Script writer',
      brief: 'Write the script of the task.',
      authority: { read: ['/library/scripts/**'], write: ['/library/scripts/**'] },
      worker: { maxTasks: 1 },
    })
    expect(worker.warnings).toEqual([])
    createTask(server.deps, { agentId: 'writer', title: 'Script: the island', brief: 'Write it.' })
    await runNow(app, worker.id)
    const run = await firstRun(app, worker.id)
    expect(run.status).toBe('done')
    expect((await server.deps.library.read('/library/scripts/island.md'))?.text).toBe('script')
    expect(toolNames(models.writer, 0)).toContain('write_file')

    // the auditor has read paths only: no write tool exists for it
    const auditor = await createProgram(app, {
      agentId: 'researcher',
      name: 'Auditor',
      brief: 'Read and report.',
      authority: { read: ['/library/scripts/**'], write: [] },
    })
    await runNow(app, auditor.id)
    const audit = await firstRun(app, auditor.id)
    expect(toolNames(models.researcher, 0)).not.toContain('write_file')
    expect(audit.status).toBe('done')
    expect(await server.deps.library.read('/library/reports/audit.md')).toBeUndefined()

    // the manager reads what the runs cost
    await (
      await app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage('costs?')))
    ).text()
    const res = await app.request('/sessions/dm%3Alead/messages?limit=50')
    const body = (await res.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>
    }
    const output = String(
      body.messages.flatMap((m) => m.parts).find((x) => x.type === 'tool-list_tasks')?.output,
    )
    expect(output).toContain('Script: the island')
    expect(output).toContain('cost $0.0120')
  })
})

describe('P40 follow-ups: honest board counts, refused runs, one calendar for spend', () => {
  test('periodStarts: the day lies inside the month across a boundary and a timezone', () => {
    // 2026-02-01 02:00 UTC is Feb 1 09:00 in Jakarta, but still Jan 31 in Los Angeles
    const at = Date.UTC(2026, 1, 1, 2, 0)
    expect(periodStarts(at, 'Asia/Jakarta')).toEqual({
      dayStart: Date.UTC(2026, 0, 31, 17, 0),
      monthStart: Date.UTC(2026, 0, 31, 17, 0),
    })
    expect(periodStarts(at, 'America/Los_Angeles')).toEqual({
      dayStart: Date.UTC(2026, 0, 31, 8, 0),
      monthStart: Date.UTC(2026, 0, 1, 8, 0),
    })
    // UTC itself, and a DST change inside the month (Los Angeles moved to PDT on Mar 8)
    expect(periodStarts(Date.UTC(2026, 2, 9, 12, 0), 'UTC').monthStart).toBe(Date.UTC(2026, 2, 1))
    expect(periodStarts(Date.UTC(2026, 2, 9, 12, 0), 'America/Los_Angeles')).toEqual({
      dayStart: Date.UTC(2026, 2, 9, 7, 0),
      monthStart: Date.UTC(2026, 2, 1, 8, 0),
    })
  })

  test('team_status: today never exceeds the month, whatever the ledger says', async () => {
    const { server } = instance({})
    const lead = server.deps.agents.getBySlug('lead') as { id: string }
    // 2026-02-01 02:00 UTC; the team timezone decides which calls are "today"
    const now = Date.UTC(2026, 1, 1, 2, 0)
    const calls = [
      { at: Date.UTC(2026, 0, 20, 10, 0), usd: 0.05 },
      { at: Date.UTC(2026, 0, 31, 20, 0), usd: 0.03 }, // Feb 1 03:00 in Jakarta
      { at: now, usd: 0.0486 }, // exactly now: inclusive end
    ]
    const stats = (q: { from: number; to: number }) => ({
      totals: {
        costUsd: calls.filter((c) => c.at >= q.from && c.at <= q.to).reduce((n, c) => n + c.usd, 0),
      },
    })
    const deps = {
      ...server.deps,
      modelCalls: { ...server.deps.modelCalls, stats } as never,
      // the ledger lags the log (it only counts charged calls): it must not decide the month
      heartbeat: {
        ...server.deps.heartbeat,
        budget: async () => ({ spentUsd: 0.001, limitUsd: 10 }),
      },
    }
    for (const timezone of ['Asia/Jakarta', 'America/Los_Angeles', 'UTC']) {
      const withTz = {
        ...deps,
        settings: {
          ...server.deps.settings,
          get: () => ({ ...server.deps.settings.get(), timezone }),
        },
      } as typeof server.deps
      const { text } = await teamStatus(withTz, lead.id, now)
      const month = Number(/this month \$([0-9]+\.[0-9]+)/.exec(text)?.[1])
      const today = Number(/today \$([0-9]+\.[0-9]+)/.exec(text)?.[1])
      expect(today).toBeLessThanOrEqual(month)
      if (timezone === 'Asia/Jakarta') {
        // the month began Jan 31 17:00 UTC: it holds the Jan 31 20:00 call, not the Jan 20 one
        expect(month).toBeCloseTo(0.0786, 4)
        expect(today).toBeCloseTo(0.0786, 4)
      }
      if (timezone === 'UTC') {
        expect(month).toBeCloseTo(0.0486, 4) // Feb 1 only
        expect(today).toBeCloseTo(0.0486, 4)
      }
      expect(text).toContain('of $10.00')
    }
  })

  test('the board is counted by the server and a model item restating counts is dropped', () => {
    const t = (status: Task['status']) => ({ status, report: null })
    const line = boardLine([
      t('done'),
      t('done'),
      t('failed'),
      t('failed'),
      t('needs_action'),
      t('queued'),
    ])
    expect(line).toContain(
      '6 task(s): 2 done, 2 failed, 1 waiting for the client, 0 running, 1 queued',
    )
    expect(line).toContain('Never restate')
    const parsed = parseBeatResult({
      status: 'attention',
      items: [
        {
          kind: 'note',
          title: 'Task board: 6 tasks done, none failed or waiting',
          detail: 'All good.',
        },
        { kind: 'board', title: 'Board', detail: 'x' },
        { kind: 'note', title: 'Overview', detail: '6 tasks done and nothing failed' },
        { kind: 'program.failing', title: 'Audit run failed', detail: 'No access to the channel' },
      ],
    })
    expect(parsed?.items.map((i) => i.title)).toEqual(['Audit run failed'])
  })

  test('a scheduled program that cannot run pauses its schedule at the first refusal', async () => {
    const { app, server } = instance({})
    const p = await createProgram(app, {
      authority: { tools: ['channel_send'], read: [], write: [] },
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    const owned = server.deps.routines.getByProgram(p.id)
    const now = Date.now()
    const due = (at: number) =>
      server.conn.sqlite
        .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
        .run(at, owned?.id as string)
    due(now - 1000)
    await server.routines.tick(now)
    const row = server.deps.routines.getByProgram(p.id)
    expect(row).toMatchObject({ status: 'paused', pausedReason: 'unrunnable', failures: 0 })
    expect(row?.lastStatus).toContain('paused: ')
    expect(row?.lastStatus).toContain('not bound to any channel connection')
    expect(await runs(app, p.id)).toEqual([])
    const view = (await (await app.request(`/programs/${p.id}`)).json()) as ProgramView
    expect(view.triggerState).toMatchObject({ status: 'paused', pausedReason: 'unrunnable' })
    const bell = (await (await app.request('/notifications')).json()) as {
      notifications: Array<{ body: string }>
    }
    expect(bell.notifications).toHaveLength(1)
    expect(bell.notifications[0]?.body).toContain('schedule is paused')
    // a later tick does not fire it again
    await server.routines.tick(now + 7_200_000)
    expect(server.deps.routines.getByProgram(p.id)?.failures).toBe(0)
    expect(
      ((await (await app.request('/notifications')).json()) as { notifications: unknown[] })
        .notifications,
    ).toHaveLength(1)
    // fixed: resuming works
    await app.request(
      `/programs/${p.id}`,
      json('PATCH', { authority: { tools: [], read: [], write: [] } }),
    )
    const resumed = (await (
      await app.request(`/programs/${p.id}/resume`, json('POST'))
    ).json()) as ProgramView
    expect(resumed.triggerState).toMatchObject({ status: 'active', pausedReason: null })
  })

  test('a scheduled refusal leaves no task and posts no notice of its own', async () => {
    const { app, server } = instance({})
    const p = await createProgram(app, {
      authority: { tools: ['channel_send'], read: [], write: [] },
    })
    const program = server.deps.programs.get(p.id) as never
    for (const runAt of [1_000, 2_000, 3_000]) {
      await expect(
        server.deps.programRunner.start(program, { runAt, scheduled: true }),
      ).rejects.toMatchObject({ code: 'PROGRAM_UNRUNNABLE' })
    }
    expect(await runs(app, p.id)).toEqual([])
    const bell = (await (await app.request('/notifications')).json()) as {
      notifications: Array<{ title: string; link: string | null }>
    }
    // the refusal itself tells nobody: the routine that started it pauses and raises one alarm
    // (the previous test), so the owner is not told twice
    expect(bell.notifications).toHaveLength(0)
    // a manual start does not notify either (the caller got the 409)
    await runNow(app, p.id)
    const after = (await (await app.request('/notifications')).json()) as {
      notifications: unknown[]
    }
    expect(after.notifications).toHaveLength(0)
  })
})
