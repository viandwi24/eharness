/**
 * Fixes of the browser end-to-end pass over P40 (docs/plans/P40-team-autonomous-operations.md,
 * "Fixes of the end-to-end pass"). Scripted models only: a note on a declined call, program
 * authority over connector modes, rehearsal reads, proposal outcomes, notifications, fire times,
 * stale escalations, budget notices, spend numbers and the rest.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { sendBackHint } from '../src/app/work-queue.ts'
import { checklistPath } from '../src/domain/heartbeat.ts'
import type { NewModelCall } from '../src/domain/model-calls.ts'
import { programDayScope } from '../src/domain/programs.ts'
import { sqliteModelCallStore } from '../src/infra/db/model-calls-repo.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { type ModelConfig, splitInlineReasoning } from '../src/infra/eh/provider.ts'
import { setBudgetLimit } from '../src/infra/eh/storage.ts'
import { compose, type Server } from '../src/main.ts'
import { attn } from './support/attention.ts'
import { fakeMcp } from './support/fake-mcp.ts'
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

type Slug = 'lead' | 'researcher' | 'writer' | 'analyst' | 'ops'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}

function instance(
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: { catalog?: Record<string, unknown>; dir?: string; env?: Record<string, string> } = {},
): Instance {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'team-e2efix-'))
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
    models: config,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog as never }),
    ...(options.env === undefined ? {} : { env: options.env }),
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher', 'writer', 'analyst', 'ops']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) continue
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, app: server.app, models }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
let seq = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `e2e-${toolName}-${++seq}` }],
})
const chat = async (app: Server['app'], slug: string, text: string): Promise<void> => {
  await (
    await app.request(`/sessions/dm:${slug}/chat`, postAs(`dm:${slug}`, userMessage(text)))
  ).text()
}
interface Approval {
  id: string
  toolName: string
  sessionId: string
}
const approvals = async (app: Server['app']): Promise<Approval[]> =>
  ((await (await app.request('/approvals')).json()) as { approvals: Approval[] }).approvals
const dmText = async (app: Server['app'], slug: string): Promise<string> =>
  JSON.stringify(await (await app.request(`/sessions/dm:${slug}/messages?limit=100`)).json())

describe('D4: a note on a declined call is the own words of the user', () => {
  test('the model reads "The user declined this call and said: ..."', async () => {
    const { app, server, models } = instance({
      researcher: [
        call('delete_file', { path: '/library/old.md' }),
        { text: 'Understood, I keep the file.' },
      ],
    })
    await libraryFs(server.conn.sqlite).write('/library/old.md', 'old\n')
    await chat(app, 'researcher', 'Delete old.md')
    const [item] = await approvals(app)
    expect((await attn(app, item, { approved: false, note: 'use the word draft' })).status).toBe(
      200,
    )
    await until('answered', async () =>
      (await dmText(app, 'researcher')).includes('I keep the file'),
    )
    const wire = JSON.stringify(models.researcher?.prompts.at(-1))
    expect(wire).toContain('The user declined this call and said: use the word draft')
    expect(wire).not.toContain('untrusted')
    // an unnamed decline stays plain
  })
})

// --- programs -----------------------------------------------------------------------------------

const BASE = {
  agentId: 'researcher',
  name: 'Docs nagger',
  brief: 'Look something up and leave a note.',
  authority: { tools: [] as string[], read: [], write: [] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
type ProgramView = { id: string; warnings?: Array<{ code: string; message: string }> }
async function createProgram(app: Server['app'], body: Record<string, unknown> = {}) {
  const res = await app.request('/programs', json('POST', { ...BASE, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as ProgramView
}
type TaskView = { status: string; sessionId: string; report?: { status?: string } | null }
async function runsOf(app: Server['app'], id: string): Promise<TaskView[]> {
  return ((await (await app.request(`/programs/${id}/runs`)).json()) as { runs: TaskView[] }).runs
}
async function firstRun(app: Server['app'], id: string): Promise<TaskView> {
  await until('the run ends', async () => {
    const t = (await runsOf(app, id))[0]
    return t !== undefined && t.status !== 'running' && t.status !== 'needs_action'
  })
  return (await runsOf(app, id))[0] as TaskView
}
const finalReport = (status = 'done'): ScriptedStepInput =>
  call('final_answer', { status, summary: `run ${status}`, outputs: [] })

/** A custom MCP connector named "docs" (tools docs_lookup: read, docs_create_note: write). */
async function connectDocs(app: Server['app'], url: string): Promise<string> {
  const started = await app.request(
    '/connections/flows',
    json('POST', { definitionId: 'mcp-remote', label: 'docs', defaultEnabled: true }),
  )
  const flow = ((await started.json()) as { flow: { id: string; view: { viewId: string } } }).flow
  const done = await app.request(
    `/connections/flows/${flow.id}/act`,
    json('POST', {
      viewId: flow.view.viewId,
      action: 'submit',
      data: { url, authMode: 'none' },
    }),
  )
  expect(done.status).toBe(200)
  return ((await done.json()) as { connection: { id: string } }).connection.id
}
const ENV = {
  TEAM_SECRET_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  TEAM_ALLOW_PRIVATE_MCP: '1',
}
const setModes = async (
  app: Server['app'],
  slug: string,
  server: Server,
  id: string,
  caps: Record<string, string>,
) => {
  const def = server.deps.agents.getBySlug(slug)
  const res = await app.request(
    `/agents/${def?.id}/connectors`,
    json('PUT', { connections: { [id]: { capabilities: caps } } }),
  )
  expect(res.status).toBe(200)
}

describe('D6: a program authority satisfies the "Ask first" of the connector it names', () => {
  test('a named write tool of a third-party connector runs; Off still wins and is warned about', async () => {
    const mcp = fakeMcp()
    try {
      const { app, server } = instance(
        {
          researcher: [
            call('docs_create_note', { q: 'overdue' }),
            finalReport(),
            call('docs_create_note', { q: 'again' }),
            finalReport('needs_decision'),
          ],
        },
        { env: ENV },
      )
      await server.connectorsReady
      const id = await connectDocs(app, mcp.url)
      const researcher = server.deps.agents.getBySlug('researcher')
      await setModes(app, 'researcher', server, id, { read: 'allow', write: 'ask' })
      const program = await createProgram(app, {
        authority: { tools: ['docs_create_note'], read: [], write: [] },
      })
      expect(program.warnings ?? []).toEqual([])
      expect((await app.request(`/programs/${program.id}/run`, json('POST'))).status).toBeLessThan(
        300,
      )
      expect((await firstRun(app, program.id)).status).toBe('done')
      expect(mcp.seen.calls).toEqual(['create_note'])

      // Off: the editor says so, the call is refused with what to change
      await setModes(app, 'researcher', server, id, { write: 'off' })
      await server.factory.prepare(researcher as never)
      const checked = await app.request(
        '/programs/check',
        json('POST', { ...BASE, authority: { tools: ['docs_create_note'], read: [], write: [] } }),
      )
      expect(JSON.stringify(await checked.json())).toContain('tool-off')
      await app.request(`/programs/${program.id}/run`, json('POST'))
      await until(
        'second run ends',
        async () =>
          (await runsOf(app, program.id)).length >= 2 &&
          (await runsOf(app, program.id)).every((t) => t.status !== 'running'),
      )
      expect(mcp.seen.calls).toEqual(['create_note'])
    } finally {
      mcp.server.stop(true)
    }
  })
})

describe('D7: a rehearsal runs read tools for real and simulates writes', () => {
  test('docs_lookup (read) is called, docs_create_note (write) is only recorded', async () => {
    const mcp = fakeMcp()
    try {
      const { app, server } = instance(
        {
          researcher: [
            call('docs_lookup', { q: 'overdue' }),
            call('docs_create_note', { q: 'overdue' }),
            finalReport(),
          ],
        },
        { env: ENV },
      )
      await server.connectorsReady
      const id = await connectDocs(app, mcp.url)
      await setModes(app, 'researcher', server, id, { read: 'allow', write: 'allow' })
      const program = await createProgram(app, {
        authority: { tools: ['docs_lookup', 'docs_create_note'], read: [], write: [] },
      })
      const res = await app.request(`/programs/${program.id}/rehearsals`, json('POST', {}))
      expect(res.status).toBe(201)
      await server.rehearsals.idle()
      const list = (await (await app.request(`/programs/${program.id}/rehearsals`)).json()) as {
        rehearsals: Array<{ simulated: Array<{ tool: string }>; toolsCalled: string[] }>
      }
      const r = list.rehearsals[0]
      expect(r?.simulated.map((a) => a.tool)).toEqual(['docs_create_note'])
      expect(r?.toolsCalled).toEqual(['docs_lookup', 'docs_create_note'])
      expect(mcp.seen.calls).toEqual(['lookup'])
    } finally {
      mcp.server.stop(true)
    }
  })
})

describe('D8: the proposing agent hears how its proposal ended', () => {
  const PLAN = {
    title: 'Weekly board summary',
    agent: 'writer',
    name: 'Board summary',
    brief: 'Summarise the board every Monday.',
    authority: { read: ['/library/**'], write: ['/library/reports/**'] },
  }
  for (const outcome of ['reject', 'approve'] as const) {
    test(`${outcome}: an event with the note lands in the thread, no model call`, async () => {
      const { app, models } = instance({
        researcher: [call('propose_plan', PLAN), { text: 'Proposed.' }, { text: 'Understood.' }],
      })
      await chat(app, 'researcher', 'propose a plan')
      const { decisions } = (await (await app.request('/decisions?status=open')).json()) as {
        decisions: Array<{ id: string }>
      }
      const id = decisions[0]?.id
      const res = await app.request(
        `/decisions/${id}/${outcome}`,
        json('POST', { note: 'too broad, make it weekly' }),
      )
      expect(res.status).toBe(200)
      // no model call woke the agent
      expect(models.researcher?.calls).toHaveLength(2)
      const text = await dmText(app, 'researcher')
      expect(text).toContain(
        `The client ${outcome === 'reject' ? 'rejected' : 'approved'} your proposal`,
      )
      expect(text).toContain('too broad, make it weekly')
      // the agent reads it with the next message
      await chat(app, 'researcher', 'what happened to it?')
      expect(JSON.stringify(models.researcher?.prompts.at(-1))).toContain(
        'too broad, make it weekly',
      )
    })
  }
})

describe('D11: Review in the bell, and a send-back says who picks the task up', () => {
  test('a finished work item raises one bell notice; send-back names the worker that must run', async () => {
    const { app, server } = instance({
      writer: [
        call('write_file', { path: '/library/out/a.md', content: 'v1' }),
        call('complete_task', { summary: 'done', outputs: ['/library/out/a.md'] }),
        finalReport(),
      ],
    })
    const worker = await createProgram(app, {
      agentId: 'writer',
      worker: { maxTasks: 1 },
      authority: { tools: [], read: [], write: ['/library/out/**'] },
    })
    const queued = await app.request(
      '/tasks',
      json('POST', { agentId: 'writer', title: 'Write A', brief: 'Write /library/out/a.md' }),
    )
    const task = (await queued.json()) as { id: string }
    await app.request(`/programs/${worker.id}/run`, json('POST'))
    await until('the task is in review', async () => {
      const t = (await (await app.request(`/tasks/${task.id}`)).json()) as {
        task?: { column?: string }
        column?: string
      }
      return (t.task?.column ?? t.column) === 'review'
    })
    const bell = async () =>
      (
        (await (await app.request('/notifications')).json()) as {
          notifications: Array<{ title: string; link: string | null }>
        }
      ).notifications.filter((n) => n.title.startsWith('Ready for review'))
    await until('the bell shows it', async () => (await bell()).length === 1)
    expect((await bell())[0]?.link).toBe(`/tasks/${task.id}`)

    // manual worker: the client is told to run it
    const back = await app.request(
      `/tasks/${task.id}/send-back`,
      json('POST', { note: 'shorter please' }),
    )
    expect(back.status).toBe(200)
    expect(((await back.json()) as { hint: string }).hint).toContain('Run now')
    // a scheduled worker picks it up by itself
    const patched = await app.request(
      `/programs/${worker.id}`,
      json('PATCH', { trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } } }),
    )
    expect(patched.status).toBe(200)
    const row = server.deps.tasks.get(task.id)
    expect(row).toBeDefined()
    expect(sendBackHint(server.deps, row as never)).toContain('next scheduled run')
  })
})

describe('D12: a program is not fired before its slot', () => {
  test('a slot inside the lookahead waits; the tick at the slot fires it', async () => {
    const { app, server } = instance({ researcher: [finalReport()] })
    const program = await createProgram(app, {
      trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
    })
    const slot = Date.now() + 2_000
    server.conn.sqlite.run('UPDATE routines SET next_fire_at = ? WHERE program_id = ?', [
      slot,
      program.id,
    ])
    // two seconds early, inside the default lookahead: nothing is claimed
    const early = await server.routines.tick(slot - 2_000)
    expect(early.fired).toHaveLength(0)
    expect(await runsOf(app, program.id)).toHaveLength(0)
    // at the slot it fires, and the run records the slot as its fire time
    const onTime = await server.routines.tick(slot)
    expect(onTime.fired).toHaveLength(1)
    expect(onTime.fired[0]?.firedAt).toBeGreaterThanOrEqual(slot)
    expect((await firstRun(app, program.id)).status).toBe('done')
  })
})

describe('stale escalation: an old finished run is not revived', () => {
  test('answering the escalation of a run a newer run replaced is refused and the decision closes', async () => {
    const { app, models } = instance({
      researcher: [finalReport('needs_decision'), finalReport('done')],
    })
    const p = await createProgram(app)
    await app.request(`/programs/${p.id}/run`, json('POST'))
    await until(
      'first run ends',
      async () =>
        (await runsOf(app, p.id)).length === 1 &&
        (await runsOf(app, p.id))[0]?.status !== 'running',
    )
    const open = (await (await app.request('/decisions?status=open')).json()) as {
      decisions: Array<{ id: string }>
    }
    const id = open.decisions[0]?.id
    expect(id).toBeDefined()
    await sleep(5)
    await app.request(`/programs/${p.id}/run`, json('POST'))
    await until(
      'second run ends',
      async () =>
        (await runsOf(app, p.id)).length === 2 &&
        (await runsOf(app, p.id)).every((t) => t.status !== 'running'),
    )
    const res = await app.request(`/decisions/${id}/approve`, json('POST', { note: 'go on' }))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('DECISION_EXPIRED')
    expect(body.error.message).toContain('already finished')
    const after = (await (await app.request(`/decisions/${id}`)).json()) as { status: string }
    expect(after.status).toBe('expired')
    // nothing woke the old run
    expect(models.researcher?.calls).toHaveLength(2)
  })
})

describe('D15: a budget stop says which limit in the chat and the sidebar', () => {
  test('monthly: a readable notice is stored in the chat and is the sidebar preview', async () => {
    const { app, server } = instance({ lead: [{ text: 'never reached' }] })
    expect((await app.request('/settings', json('PATCH', { budgetUsd: 0.5 }))).status).toBe(200)
    server.conn.sqlite.run(
      "UPDATE eh_budget_scope SET spent_usd = '0.75' WHERE scope LIKE 'workspace:%'",
    )
    await chat(app, 'lead', 'Say hello')
    const text = await dmText(app, 'lead')
    expect(text).toContain('The monthly budget of the workspace is used up')
    expect(text).toContain('Settings > General > Monthly budget')
    const agent = server.deps.agents.getBySlug('lead')
    const feed = (await (await app.request('/activity?after=0&limit=500')).json()) as {
      events: Array<{ type: string; agentId: string | null; payload: { preview?: string } }>
    }
    const previews = feed.events
      .filter((e) => e.type === 'message-added' && e.agentId === agent?.id)
      .map((e) => e.payload.preview)
    expect(previews.at(-1)).toContain('monthly budget of the workspace')
    expect(previews.join(' ')).not.toContain('(cost-cap)')
  })

  test('day: a program run that hits its day budget names the day budget', async () => {
    const { app, server } = instance({ researcher: [finalReport()] })
    const p = await createProgram(app, { budget: { perRunUsd: null, perDayUsd: 0.01 } })
    const scope = programDayScope(p.id, Date.now())
    setBudgetLimit(server.conn.sqlite, scope, 0.01)
    server.conn.sqlite.run('UPDATE eh_budget_scope SET spent_usd = ? WHERE scope = ?', [
      '0.02',
      scope,
    ])
    await app.request(`/programs/${p.id}/run`, json('POST'))
    const run = await firstRun(app, p.id)
    const detail = (await (await app.request(`/programs/${p.id}/runs`)).json()) as {
      runs: Array<{ summary: string | null }>
    }
    expect(run.status).toBe('failed')
    expect(detail.runs[0]?.summary).toContain('day budget of program')
  })
})

describe('D14: one source of truth for spend', () => {
  test('Usage counts every source from the call log, the same rows and totals as Logs', async () => {
    const { app, server } = instance({})
    const lead = server.deps.agents.getBySlug('lead')
    const store = sqliteModelCallStore(server.conn.sqlite)
    const base = Date.now() - 1000
    const row = (id: string, sessionId: string, costUsd: number): NewModelCall => ({
      id,
      createdAt: base,
      kind: 'step',
      agentId: lead?.id ?? null,
      sessionId,
      turnId: `turn-${id}`,
      stepIndex: 0,
      messageId: null,
      taskId: null,
      provider: 'p',
      modelId: 'm',
      status: 'ok',
      finishReason: 'stop',
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: null,
      cachedTokens: null,
      costUsd,
      startedAt: base,
      firstChunkMs: 1,
      durationMs: 1,
      errorName: null,
      errorMessage: null,
      requestOptions: null,
      requestBody: null,
      response: null,
      output: null,
      providerMetadata: undefined,
      usageRaw: null,
    })
    const id = lead?.id ?? ''
    store.insert(row('c1', `dm:${id}`, 0.1), base)
    store.insert(row('c2', `dm:${id}`, 0.1), base) // same turn id? no: two turns of the chat
    store.insert(row('h1', `heartbeat:${id}`, 0.0156), base)
    store.insert(row('p1', 'program:pp:1', 0.02), base)
    store.insert(row('r1', 'rehearsal:pp:1', 0.03), base)
    store.insert(row('d1', `dm:${id}:agent:call_1`, 0.04), base)
    const usage = (await (await app.request('/usage')).json()) as {
      since: number | null
      total: { costUsd: number; calls: number; count: number }
      bySource: Array<{ source: string; costUsd: number; calls: number; count: number }>
    }
    const logs = (await (
      await app.request(`/logs/stats?from=${base - 1}&to=${base + 5000}`)
    ).json()) as {
      totals: { costUsd: number; count: number }
    }
    expect(usage.total.costUsd).toBeCloseTo(logs.totals.costUsd, 6)
    expect(usage.total.calls).toBe(logs.totals.count)
    const by = Object.fromEntries(usage.bySource.map((s) => [s.source, s]))
    expect(by.heartbeat?.costUsd).toBeCloseTo(0.0156, 6)
    expect(by.chat).toMatchObject({ calls: 2, count: 2 })
    expect(by.rehearsal?.costUsd).toBeCloseTo(0.03, 6)
    expect(by.delegated?.costUsd).toBeCloseTo(0.04, 6)
    expect(by.program?.count).toBe(1)
    expect(usage.since).toBe(base)
  })
})

describe('D18: a connector that went down stops showing Connected', () => {
  test('listing the connections checks reachability in the background', async () => {
    const mcp = fakeMcp()
    const { app, server } = instance({}, { env: { ...ENV, TEAM_CONNECTOR_HEALTH_TTL_MS: '0' } })
    await server.connectorsReady
    const id = await connectDocs(app, mcp.url)
    const statusOf = async (): Promise<string | undefined> =>
      (
        (await (await app.request('/connections')).json()) as {
          connections: Array<{ id: string; status: string }>
        }
      ).connections.find((c) => c.id === id)?.status
    expect(await statusOf()).toBe('connected')
    mcp.server.stop(true)
    await until('the status turns to error', async () => (await statusOf()) === 'error')
  })
})

describe('D18: a beat follows the checklist into connected services (reads only)', () => {
  test('a read tool of a third-party connector runs in a beat, a write is refused', async () => {
    const mcp = fakeMcp()
    try {
      const { app, server, models } = instance(
        {
          lead: [
            call('docs_lookup', { q: 'overdue' }),
            call('docs_create_note', { q: 'nag' }),
            call('final_answer', { status: 'ok', items: [] }),
          ],
        },
        { env: ENV },
      )
      await server.connectorsReady
      const id = await connectDocs(app, mcp.url)
      const lead = server.deps.agents.getBySlug('lead')
      await setModes(app, 'lead', server, id, { read: 'allow', write: 'allow' })
      await app.request(
        `/agents/${lead?.id}/heartbeat`,
        json('PATCH', { activeFrom: '00:00', activeTo: '00:00' }),
      )
      await server.deps.library.writeText(
        checklistPath(lead?.id as string),
        '- look up overdue items in the docs service',
      )
      await server.heartbeats.heartbeat(lead?.id as string, { slot: Date.now() + 1 })
      await server.heartbeats.idle()
      expect(mcp.seen.calls).toEqual(['lookup'])
      expect(JSON.stringify(models.lead?.prompts.at(-1))).toContain('Not available in a heartbeat')
    } finally {
      mcp.server.stop(true)
    }
  })
})

describe('D3: Always allow answers the sibling approvals of the same tool', () => {
  const three: ScriptedStepInput = {
    toolCalls: ['a', 'b', 'c'].map((n) => ({
      toolName: 'delete_file',
      input: { path: `/library/${n}.md` },
      toolCallId: `del-${n}`,
    })),
  }
  test('one click answers every waiting call of the tool; the turn resumes once', async () => {
    const { app, server } = instance({ researcher: [three, { text: 'All three deleted.' }] })
    for (const n of ['a', 'b', 'c'])
      await libraryFs(server.conn.sqlite).write(`/library/${n}.md`, n)
    await chat(app, 'researcher', 'delete a, b and c')
    const pending = await approvals(app)
    expect(pending).toHaveLength(3)
    const res = await attn(app, pending[0], { approved: true, remember: 'session' })
    expect(res.status).toBe(200)
    await until('the turn resumed and ended', async () =>
      (await dmText(app, 'researcher')).includes('All three deleted.'),
    )
    expect(await approvals(app)).toEqual([])
    // all three ran (the tool answers that a file must be read before it is deleted)
    const text = await dmText(app, 'researcher')
    expect(text.match(/before deleting it/g)).toHaveLength(3)
    expect(text).not.toContain('output-denied')
  })

  test('scope agent saves a rule on the agent, scope all on every agent', async () => {
    const { app, server } = instance({ researcher: [three, { text: 'done' }] })
    for (const n of ['a', 'b', 'c'])
      await libraryFs(server.conn.sqlite).write(`/library/${n}.md`, n)
    await chat(app, 'researcher', 'delete a, b and c')
    const [first] = await approvals(app)
    expect((await attn(app, first, { approved: true, scope: 'all' })).status).toBe(200)
    await until('resumed', async () => (await dmText(app, 'researcher')).includes('done'))
    for (const agent of server.deps.agents.list()) {
      expect(agent.rules.allow).toContain('delete_file')
    }
    expect(
      (await attn(app, first, { approved: true, scope: 'nowhere' })).status,
    ).toBeGreaterThanOrEqual(400)
  })
})

describe('D2: inline thinking of open reasoning models is split from the answer', () => {
  const streamOf = async (modelId: string) => {
    const model = splitInlineReasoning(
      scriptedModel([{ text: '<think>Let me weigh this.</think>The answer is 42.' }]) as never,
      modelId,
    ) as unknown as {
      doStream(o: unknown): Promise<{ stream: ReadableStream<{ type: string; delta?: string }> }>
    }
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })
    const parts: Array<{ type: string; delta?: string }> = []
    const reader = stream.getReader()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }
    return parts
  }
  test('a deepseek model: the tagged text becomes reasoning, the answer stays text', async () => {
    const parts = await streamOf('deepseek/deepseek-v4.1-flash')
    const reasoning = parts
      .filter((p) => p.type === 'reasoning-delta')
      .map((p) => p.delta)
      .join('')
    const text = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => p.delta)
      .join('')
    expect(reasoning).toContain('Let me weigh this.')
    expect(text).toContain('The answer is 42.')
    expect(text).not.toContain('think')
  })
  test('another model is left alone', async () => {
    const parts = await streamOf('anthropic/claude-sonnet-5.5')
    expect(parts.some((p) => p.type === 'reasoning-delta')).toBe(false)
  })
})

describe('D13 seeds: Allowed means allowed', () => {
  test('the seeded researcher reads the web in Manual mode without being asked', async () => {
    const { app } = instance({
      researcher: [
        call('web_fetch', { url: 'http://127.0.0.1/page' }),
        call('web_fetch', { url: 'http://127.0.0.1/other' }),
        { text: 'Read both.' },
      ],
    })
    await chat(app, 'researcher', 'Read the pages')
    expect(await approvals(app)).toEqual([])
    expect(await dmText(app, 'researcher')).toContain('Read both.')
  })
})

describe('a run parked on a decision stays parked across a restart', () => {
  test('its task is in Waiting for you on both instances and the drift pass leaves it alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-e2efix-restart-'))
    dirs.push(dir)
    const a = instance(
      { researcher: [call('escalate', { title: 'Restart?', question: 'Does it survive?' })] },
      { dir },
    )
    const p = await createProgram(a.app)
    await a.app.request(`/programs/${p.id}/run`, json('POST'))
    await until('the decision is open', async () => {
      const open = (await (await a.app.request('/decisions?status=open')).json()) as {
        decisions: unknown[]
      }
      return open.decisions.length === 1
    })
    const columnOf = async (app: Server['app']): Promise<string | undefined> =>
      (
        (await (await app.request('/tasks')).json()) as {
          tasks: Array<{ column?: string }>
        }
      ).tasks[0]?.column
    expect(await columnOf(a.app)).toBe('waiting')
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    const b = instance({}, { dir })
    await b.server.ready
    // the process that parked is gone; the recovery pass must not turn the parked run into
    // something else (it is neither finished nor interrupted: it waits for the client)
    await b.server.reconcile()
    expect(await columnOf(b.app)).toBe('waiting')
    const run = (await runsOf(b.app, p.id))[0]
    expect(run?.status).toBe('running')
  })
})
