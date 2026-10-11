/**
 * The Decision Center (docs/plans/P40-team-autonomous-operations.md, phase B): proposals that
 * create programs, escalations and amendments that park a run on an external wait and resume the
 * same session when the client decides, the report-made escalation, restarts and the reject paths.
 * Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import type { Decision } from '../src/domain/decisions.ts'
import {
  authorityLines,
  followUpText,
  mergeAuthority,
  programOfProposal,
} from '../src/domain/decisions.ts'
import type { Program } from '../src/domain/programs.ts'
import { outsideAuthorityReason, programRunPrompt } from '../src/domain/programs.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
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

type Slug = 'lead' | 'researcher' | 'writer'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}

/** A server on `dir` whose agents run scripted models. */
function instance(
  dir: string,
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: { seed?: boolean } = {},
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
    instanceId: 'decisions-test',
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    ...(options.seed === false ? { seed: false } : {}),
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher', 'writer']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, app: server.app, models }
}
function fresh(script: Partial<Record<Slug, ScriptedStepInput[]>>): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40b-'))
  dirs.push(dir)
  return instance(dir, script)
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

type TaskView = {
  id: string
  sessionId: string
  origin: string
  status: string
  summary: string | null
  report: null | { status: string; summary: string; outputs: string[] }
}
type ProgramView = Program & { triggerState: unknown }

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
  if (res.status !== 202) throw new Error(await res.text())
  return (await res.json()) as { sessionId: string }
}
async function runs(app: Server['app'], programId: string): Promise<TaskView[]> {
  return ((await (await app.request(`/programs/${programId}/runs`)).json()) as { runs: TaskView[] })
    .runs
}
const ended = (t: TaskView | undefined) =>
  t !== undefined && t.status !== 'running' && t.status !== 'needs_action'
async function decisions(
  app: Server['app'],
  query = '',
): Promise<{ decisions: Decision[]; open: number }> {
  const res = await app.request(`/decisions${query}`)
  expect(res.status).toBe(200)
  return (await res.json()) as { decisions: Decision[]; open: number }
}
async function firstOpen(app: Server['app'], kind?: string): Promise<Decision> {
  let found: Decision | undefined
  await until('an open decision', async () => {
    found = (await decisions(app, `?status=open${kind === undefined ? '' : `&kind=${kind}`}`))
      .decisions[0]
    return found !== undefined
  })
  return found as Decision
}
// no body at all is a valid answer (`curl -X POST .../approve`)
const answer = (body?: unknown): RequestInit =>
  body === undefined ? { method: 'POST' } : json('POST', body)
const approve = (app: Server['app'], id: string, body?: unknown) =>
  app.request(`/decisions/${id}/approve`, answer(body))
const reject = (app: Server['app'], id: string, body?: unknown) =>
  app.request(`/decisions/${id}/reject`, answer(body))
// a scripted instance numbers its calls `call-<step>-<i>`: a restarted instance gets its own prefix,
// as a real model's ids are unique
let prefix = 'a'
const finalReport = (r: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [
    { toolName: 'final_answer', input: r, toolCallId: `${prefix}-final-${Math.random()}` },
  ],
})
const done = (summary = 'done'): ScriptedStepInput =>
  finalReport({ status: 'done', summary, outputs: [] })
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `${prefix}-${toolName}-${Math.random()}` }],
})
const toolNames = (m: ScriptedModel | undefined, call = 0): string[] =>
  ((m?.calls[call]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

/** The parts of the tool of a stored session, by tool name. */
async function toolParts(app: Server['app'], sessionId: string, tool: string) {
  const res = await app.request(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=50`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { messages: Array<{ parts: Array<Record<string, unknown>> }> }
  return body.messages.flatMap((m) => m.parts).filter((p) => p.type === `tool-${tool}`)
}

describe('domain', () => {
  const authority = { tools: ['web_fetch'], connectors: [], read: ['/library/a/**'], write: [] }
  test('authority lines and merge', () => {
    expect(authorityLines(authority)).toEqual(['use web_fetch', 'read /library/a/**'])
    expect(
      mergeAuthority(authority, {
        tools: ['web_fetch', 'x'],
        connectors: [],
        read: [],
        write: ['/library/b/**'],
      }),
    ).toEqual({
      tools: ['web_fetch', 'x'],
      connectors: [],
      read: ['/library/a/**'],
      write: ['/library/b/**'],
    })
  })
  test('a one-off plan is created with a manual trigger', () => {
    const program = {
      agentId: 'a',
      name: 'n',
      brief: 'b',
      authority,
      gates: [],
      escalation: '',
      forbidden: [],
      budget: { perRunUsd: null, perDayUsd: null },
      trigger: { kind: 'schedule' as const, spec: { kind: 'every' as const, everyMs: 60_000 } },
      report: 'task' as const,
    }
    expect(programOfProposal({ program, runOnce: true }).trigger).toEqual({ kind: 'manual' })
    expect(programOfProposal({ program, runOnce: false }).trigger.kind).toBe('schedule')
  })
  test('the refusal and the run prompt tell the agent to ask', () => {
    expect(outsideAuthorityReason('P', 'delete_file')).toContain('request_authority')
    const prompt = programRunPrompt({
      ...BASE,
      authority: { tools: [], connectors: [], read: [], write: [] },
      id: 'p',
      trigger: { kind: 'manual' },
      report: 'task',
    } as unknown as Program)
    expect(prompt).toContain('call escalate')
    expect(prompt).toContain('request_authority')
  })
})

describe('proposals', () => {
  test('propose_plan stores a proposal (no park); approving with edits creates the program and runs a one-off', async () => {
    const { app, server, models } = fresh({
      researcher: [
        call('propose_plan', {
          title: 'Draft scripts for new titles',
          body: '## Goal\nOne script per title.\n\nEvidence: /library/videos/titles.md',
          agent: 'writer',
          name: 'Scripts',
          brief: 'Write a script per title into /library/reports/.',
          authority: {
            read: ['/library/videos/**'],
            write: ['/library/reports/**', '/library/extra/**'],
          },
          runOnce: true,
        }),
        { text: 'I proposed a plan.' },
      ],
      writer: [
        call('write_file', { path: '/library/reports/s1.md', content: 'script' }),
        finalReport({ status: 'done', summary: 'wrote it', outputs: ['/library/reports/s1.md'] }),
      ],
    })
    // a DM chat of the researcher proposes; the chat is not parked: the turn completes
    const res = await app.request(
      '/sessions/dm:researcher/chat',
      postAs('dm:researcher', userMessage('please propose a plan')),
    )
    expect(res.status).toBe(200)
    await res.text()
    // the DM has propose_plan, not the run tools
    expect(toolNames(models.researcher)).toContain('propose_plan')
    expect(toolNames(models.researcher)).not.toContain('escalate')
    expect(toolNames(models.researcher)).not.toContain('request_authority')
    const toolPart = await toolParts(app, 'dm:researcher', 'propose_plan')
    expect(toolPart[0]?.state).toBe('output-available')
    expect(String(toolPart[0]?.output)).toContain('waiting for the client')

    const open = await decisions(app, '?status=open')
    expect(open.open).toBe(1)
    const d = open.decisions[0] as Extract<Decision, { kind: 'proposal' }>
    expect(d).toMatchObject({
      kind: 'proposal',
      status: 'open',
      title: 'Draft scripts for new titles',
      sessionId: `dm:${server.deps.agents.getBySlug('researcher')?.id}`,
      waitId: null,
    })
    expect(d.body).toContain('Evidence')
    expect(d.payload.runOnce).toBe(true)
    expect(d.payload.program.agentId).toBe(server.deps.agents.getBySlug('writer')?.id as string)
    // nothing exists yet
    expect(
      ((await (await app.request('/programs')).json()) as { programs: unknown[] }).programs,
    ).toHaveLength(0)

    // approve, editing the authority: the extra write path is dropped
    const approved = await approve(app, d.id, {
      note: 'ok, but keep it small',
      edit: {
        program: {
          authority: { read: ['/library/videos/**'], write: ['/library/reports/**'] },
          name: 'Scripts (client)',
        },
      },
    })
    expect(approved.status).toBe(200)
    const decided = (await approved.json()) as Extract<Decision, { kind: 'proposal' }>
    expect(decided).toMatchObject({
      status: 'approved',
      decidedBy: 'client',
      decisionNote: 'ok, but keep it small',
    })
    expect(decided.payload.program.authority.write).toEqual(['/library/reports/**'])
    const programId = decided.outcome?.programId as string
    expect(decided.programId).toBe(programId)
    const program = (await (await app.request(`/programs/${programId}`)).json()) as ProgramView
    expect(program).toMatchObject({
      name: 'Scripts (client)',
      agentId: server.deps.agents.getBySlug('writer')?.id,
      createdBy: server.deps.agents.getBySlug('researcher')?.id,
      trigger: { kind: 'manual' },
      authority: {
        read: ['/library/videos/**'],
        write: ['/library/reports/**'],
        tools: [],
        connectors: [],
      },
    })
    // the one-off ran once, with exactly that authority
    expect(decided.outcome?.runSessionId).toMatch(/^program:/)
    await until('the run ends', async () => ended((await runs(app, programId))[0]))
    const run = (await runs(app, programId))[0] as TaskView
    expect(run).toMatchObject({ status: 'done', origin: 'program' })
    expect(run.report?.summary).toBe('wrote it')
    expect(await libraryFs(server.conn.sqlite).read('/library/reports/s1.md')).not.toBeNull()
    // writer has no propose_plan inside a program run
    expect(toolNames(models.writer)).not.toContain('propose_plan')
    expect(toolNames(models.writer)).toContain('escalate')

    // decided: a second answer is refused
    expect((await approve(app, d.id)).status).toBe(409)
    expect((await reject(app, d.id)).status).toBe(409)
    expect((await decisions(app, '?status=open')).open).toBe(0)
  })

  test('a standing proposal with a schedule creates an active scheduled program; a rejected one creates nothing', async () => {
    const { app, server } = fresh({
      researcher: [
        call('propose_plan', {
          title: 'Weekly review',
          name: 'Weekly review',
          brief: 'Review the library.',
          authority: { read: ['/library/**'] },
          schedule: { everyMinutes: 60 },
        }),
        call('propose_plan', {
          title: 'Other',
          name: 'Other',
          brief: 'Nope.',
        }),
        { text: 'done' },
      ],
    })
    const res = await app.request(
      '/sessions/dm:researcher/chat',
      postAs('dm:researcher', userMessage('go')),
    )
    await res.text()
    const open = (await decisions(app, '?status=open&kind=proposal')).decisions
    expect(open).toHaveLength(2)
    const weekly = open.find((d) => d.title === 'Weekly review') as Decision
    const other = open.find((d) => d.title === 'Other') as Decision
    // a generated body when the agent gave none
    expect(other.body).toContain('A standing program.')
    const approved = (await (await approve(app, weekly.id)).json()) as Decision
    const program = (await (
      await app.request(`/programs/${approved.programId}`)
    ).json()) as ProgramView & {
      triggerState: { status: string; nextFireAt: number } | null
    }
    expect(program.trigger).toEqual({
      kind: 'schedule',
      spec: { kind: 'every', everyMs: 3_600_000 },
    })
    expect(program.triggerState?.status).toBe('active')
    expect(approved.outcome?.runSessionId).toBeUndefined()

    const rejected = await reject(app, other.id, { note: 'not now' })
    expect(rejected.status).toBe(200)
    expect(await rejected.json()).toMatchObject({ status: 'rejected', decisionNote: 'not now' })
    expect(server.deps.programs.list({})).toHaveLength(1)
  })

  test('an invalid edit is refused before anything is decided', async () => {
    const { app } = fresh({
      researcher: [call('propose_plan', { title: 'T', name: 'N', brief: 'B' }), { text: 'ok' }],
    })
    await (
      await app.request('/sessions/dm:researcher/chat', postAs('dm:researcher', userMessage('go')))
    ).text()
    const d = await firstOpen(app)
    const bad = await approve(app, d.id, { edit: { program: { authority: { read: ['nope'] } } } })
    expect(bad.status).toBe(400)
    expect((await decisions(app, '?status=open')).open).toBe(1)
    expect(
      ((await (await app.request('/programs')).json()) as { programs: unknown[] }).programs,
    ).toHaveLength(0)
  })
})

describe('escalation', () => {
  test('the answer to a report-made decision tells the agent not to ask again', () => {
    for (const decision of ['approved', 'rejected'] as const) {
      const text = followUpText({ title: 'T' }, { decision, note: 'n' })
      expect(text).toContain("do not report 'needs_decision' about this again")
    }
  })

  test('the continuation of a parked run keeps the program step limit, not the agent default', async () => {
    // more steps after the answer than the agent default (a chunked job is many small steps)
    const steps: ScriptedStepInput[] = [
      call('escalate', { title: 'Go?', question: 'Start the long job?' }),
      ...Array.from({ length: 45 }, (_, i) =>
        call('write_file', { path: `/library/reports/step-${i}.md`, content: `step ${i}` }),
      ),
      finalReport({ status: 'done', summary: 'long job finished', outputs: [] }),
    ]
    const { app } = fresh({ researcher: steps })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app, 'escalation')
    expect((await approve(app, d.id, { note: 'go' })).status).toBe(200)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]), 20_000)
    const [run] = await runs(app, p.id)
    expect(run).toMatchObject({ status: 'done' })
    expect(run?.report?.summary).toBe('long job finished')
  })

  test('parks the run on an external wait; approving resumes the SAME session with the decision as the tool output', async () => {
    const { app, server, models } = fresh({
      researcher: [
        call('escalate', {
          title: 'Publish the draft?',
          question: 'Publish /library/reports/a.md to the channel?',
          details: 'Evidence: /library/reports/a.md',
        }),
        finalReport({ status: 'done', summary: 'published after approval', outputs: [] }),
      ],
    })
    const p = await createProgram(app)
    const started = await runNow(app, p.id)

    const d = (await firstOpen(app, 'escalation')) as Extract<Decision, { kind: 'escalation' }>
    expect(d).toMatchObject({
      status: 'open',
      title: 'Publish the draft?',
      sessionId: started.sessionId,
      programId: p.id,
      agentId: server.deps.agents.getBySlug('researcher')?.id,
    })
    expect(d.waitId).toMatch(/^w_/)
    expect(d.payload).toEqual({
      question: 'Publish /library/reports/a.md to the channel?',
      options: [],
      source: 'agent',
    })
    expect(d.body).toContain('Evidence')

    // the run is parked: no model call after the escalation, the session says so
    await until(
      'the turn parked',
      async () =>
        ((await server.factory.peek(started.sessionId).pending())?.externals?.length ?? 0) === 1,
    )
    const peek = await server.factory.peek(started.sessionId).pending()
    expect(peek?.externals?.map((e) => e.waitId)).toEqual([d.waitId as string])
    expect(models.researcher?.calls).toHaveLength(1)
    expect((await runs(app, p.id))[0]?.status).toBe('running')
    // asking is not a tool approval: nothing in the approvals queue
    expect(
      ((await (await app.request('/approvals')).json()) as { approvals: unknown[] }).approvals,
    ).toHaveLength(0)

    const res = await approve(app, d.id, { note: 'go ahead' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'approved',
      outcome: { decision: 'approved' },
    })

    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    const all = await runs(app, p.id)
    expect(all).toHaveLength(1) // the same session, no second run
    expect(all[0]).toMatchObject({ sessionId: started.sessionId, status: 'done' })
    expect(all[0]?.report?.summary).toBe('published after approval')
    // the decision is the tool output, in the same message
    const parts = await toolParts(app, started.sessionId, 'escalate')
    expect(parts).toHaveLength(1)
    expect(parts[0]?.state).toBe('output-available')
    expect(parts[0]?.output).toEqual({ decision: 'approved', note: 'go ahead' })
    // and the model saw it
    expect(JSON.stringify(models.researcher?.prompts[1])).toContain('go ahead')
    expect(models.researcher?.calls).toHaveLength(2)
  })

  test('options: the client picks one; the pick is the decision; a wrong pick is refused', async () => {
    const { app, models } = fresh({
      researcher: [
        call('escalate', {
          title: 'Which source?',
          question: 'Which source first?',
          options: ['Telegram', 'Slack'],
        }),
        done('used the pick'),
      ],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app, 'escalation')
    expect((await approve(app, d.id)).status).toBe(400) // options: pick one
    expect((await approve(app, d.id, { choice: 'Email' })).status).toBe(400)
    expect((await approve(app, d.id, { choice: 'Slack' })).status).toBe(200)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    expect(JSON.stringify(models.researcher?.prompts[1])).toContain('Slack')
  })

  test('reject resumes the run with the refusal and the note', async () => {
    const { app } = fresh({
      researcher: [
        call('escalate', { title: 'Delete it?', question: 'Delete the old reports?' }),
        done('left them alone'),
      ],
    })
    const p = await createProgram(app)
    const started = await runNow(app, p.id)
    const d = await firstOpen(app, 'escalation')
    const res = await reject(app, d.id, { note: 'keep them' })
    expect(await res.json()).toMatchObject({ status: 'rejected', decisionNote: 'keep them' })
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    const parts = await toolParts(app, started.sessionId, 'escalate')
    expect(parts[0]?.output).toEqual({ decision: 'rejected', note: 'keep them' })
  })

  test('a decision whose run no longer waits expires (409) instead of pretending', async () => {
    const { app, server } = fresh({})
    const researcher = server.deps.agents.getBySlug('researcher')
    const d = server.deps.decisions.insert({
      id: 'dec-ghost',
      kind: 'escalation',
      title: 'Ghost',
      body: '',
      agentId: researcher?.id as string,
      sessionId: 'program:ghost:1',
      programId: null,
      payload: { question: 'q', options: [], source: 'agent' },
      waitId: 'w_nothing',
      createdAt: Date.now(),
    })
    const res = await approve(app, d.id)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('DECISION_EXPIRED')
    const after = (await (await app.request(`/decisions/${d.id}`)).json()) as Decision
    expect(after.status).toBe('expired')
  })
})

describe('request_authority', () => {
  const needing = (): ScriptedStepInput[] => [
    // outside the authority: refused with the hint to ask
    call('write_file', { path: '/library/other/x.md', content: 'x' }),
    call('request_authority', {
      write: ['/library/other/**'],
      why: 'The notes belong in /library/other.',
    }),
    // after the answer: the same call again
    call('write_file', { path: '/library/other/x.md', content: 'x' }),
  ]

  test('approve adds the authority to the program and to the parked run, which then uses it', async () => {
    const { app, server, models } = fresh({
      researcher: [...needing(), done('wrote it after the grant')],
    })
    const p = await createProgram(app)
    const started = await runNow(app, p.id)
    const d = (await firstOpen(app, 'amendment')) as Extract<Decision, { kind: 'amendment' }>
    expect(d).toMatchObject({
      programId: p.id,
      sessionId: started.sessionId,
      title: 'More authority for Video scripts',
    })
    expect(d.payload.authority.write).toEqual(['/library/other/**'])
    expect(d.body).toContain('The notes belong in /library/other.')
    // the refusal told the agent what to do
    expect(JSON.stringify(models.researcher?.prompts[1])).toContain('request_authority')
    const fs = libraryFs(server.conn.sqlite)
    expect(await fs.read('/library/other/x.md')).toBeNull()

    const res = await approve(app, d.id, { note: 'fine' })
    expect(res.status).toBe(200)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    const run = (await runs(app, p.id))[0] as TaskView
    expect(run).toMatchObject({ status: 'done', sessionId: started.sessionId })
    expect(await fs.read('/library/other/x.md')).not.toBeNull()
    const program = (await (await app.request(`/programs/${p.id}`)).json()) as ProgramView
    expect(program.authority.write).toEqual(['/library/reports/**', '/library/other/**'])
    expect(program.authority.read).toEqual(['/library/videos/**'])
    const writes = await toolParts(app, started.sessionId, 'write_file')
    expect(writes.map((w) => w.state)).toEqual(['output-denied', 'output-available'])
  })

  test('the client may grant less than asked', async () => {
    const { app } = fresh({
      researcher: [
        call('request_authority', {
          write: ['/library/a/**', '/library/b/**'],
          tools: ['web_fetch'],
          why: 'research',
        }),
        done('ok'),
      ],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app, 'amendment')
    await approve(app, d.id, { authority: { write: ['/library/a/**'] } })
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    const program = (await (await app.request(`/programs/${p.id}`)).json()) as ProgramView
    expect(program.authority.write).toEqual(['/library/reports/**', '/library/a/**'])
    expect(program.authority.tools).toEqual([])
  })

  test('reject resumes the run with the refusal: the call stays refused and the run continues', async () => {
    const { app, server } = fresh({
      researcher: [...needing(), done('finished without it')],
    })
    const p = await createProgram(app)
    const started = await runNow(app, p.id)
    const d = await firstOpen(app, 'amendment')
    expect((await reject(app, d.id, { note: 'no' })).status).toBe(200)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    expect((await runs(app, p.id))[0]?.status).toBe('done')
    expect(await libraryFs(server.conn.sqlite).read('/library/other/x.md')).toBeNull()
    const parts = await toolParts(app, started.sessionId, 'request_authority')
    expect(parts[0]?.output).toEqual({ decision: 'rejected', note: 'no' })
    const writes = await toolParts(app, started.sessionId, 'write_file')
    expect(writes.map((w) => w.state)).toEqual(['output-denied', 'output-denied'])
    const program = (await (await app.request(`/programs/${p.id}`)).json()) as ProgramView
    expect(program.authority.write).toEqual(['/library/reports/**'])
  })

  test('approving when the program was deleted is a conflict; rejecting still works', async () => {
    const { app } = fresh({
      researcher: [call('request_authority', { read: ['/library/x/**'], why: 'w' }), done('ok')],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app, 'amendment')
    await app.request(`/programs/${p.id}`, { method: 'DELETE' })
    const res = await approve(app, d.id)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PROGRAM_DELETED')
    expect((await reject(app, d.id)).status).toBe(200)
  })
})

describe('needs_decision reports', () => {
  test('a report that says needs_decision becomes an escalation; approving sends the answer to the same session', async () => {
    const { app, models } = fresh({
      researcher: [
        finalReport({
          status: 'needs_decision',
          summary: 'Two titles look harmful; I stopped before writing them.',
          outputs: ['/library/reports/1.md'],
          notes: 'titles 4 and 7',
        }),
        done('skipped the harmful titles'),
      ],
    })
    const p = await createProgram(app)
    const started = await runNow(app, p.id)
    await until('the first turn ends', async () => ended((await runs(app, p.id))[0]))
    const d = (await firstOpen(app, 'escalation')) as Extract<Decision, { kind: 'escalation' }>
    expect(d).toMatchObject({ sessionId: started.sessionId, programId: p.id, waitId: null })
    expect(d.payload.source).toBe('report')
    expect(d.title).toBe('Video scripts needs a decision')
    expect(d.body).toContain('Two titles look harmful')
    expect(d.body).toContain('titles 4 and 7')

    await approve(app, d.id, { note: 'skip them' })
    await until(
      'the follow-up run ends',
      async () => (await runs(app, p.id))[0]?.summary === 'skipped the harmful titles',
    )
    expect(JSON.stringify(models.researcher?.prompts[1])).toContain('skip them')
    // one decision, answered; the second report was done
    expect((await decisions(app, '?status=open')).open).toBe(0)
    expect(await runs(app, p.id)).toHaveLength(1)
  })

  test('a run that escalated by itself and reports done creates no extra decision', async () => {
    const { app } = fresh({
      researcher: [call('escalate', { title: 'T', question: 'q' }), done('fine')],
    })
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app)
    await approve(app, d.id)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    expect((await decisions(app)).decisions).toHaveLength(1)
  })
})

describe('decisions survive a restart', () => {
  test('park, close the server, reopen the database, resolve: the same session resumes and finishes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40b-restart-'))
    dirs.push(dir)
    const a = instance(dir, {
      researcher: [call('escalate', { title: 'Restart?', question: 'Survives a restart?' })],
    })
    const p = await createProgram(a.app)
    const started = await runNow(a.app, p.id)
    const d = await firstOpen(a.app, 'escalation')
    // the first instance goes away
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    // the second one only knows the database; its model has just the step after the answer
    prefix = 'b'
    const b = instance(dir, { researcher: [done('finished after the restart')] }, { seed: false })
    const listed = await decisions(b.app, '?status=open')
    expect(listed.decisions.map((x) => x.id)).toEqual([d.id])
    expect((await runs(b.app, p.id))[0]?.status).toBe('running')
    const res = await approve(b.app, d.id, { note: 'after restart' })
    expect(res.status).toBe(200)
    await until('the run ends', async () => ended((await runs(b.app, p.id))[0]))
    const run = (await runs(b.app, p.id))[0] as TaskView
    expect(run).toMatchObject({ sessionId: started.sessionId, status: 'done' })
    expect(run.report?.summary).toBe('finished after the restart')
    const parts = await toolParts(b.app, started.sessionId, 'escalate')
    expect(parts[0]?.output).toEqual({ decision: 'approved', note: 'after restart' })
  })

  test('an approved amendment is read by a restarted instance: the resumed run can use it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40b-restart2-'))
    dirs.push(dir)
    const a = instance(dir, {
      researcher: [call('request_authority', { write: ['/library/other/**'], why: 'w' })],
    })
    const p = await createProgram(a.app)
    const started = await runNow(a.app, p.id)
    const d = await firstOpen(a.app, 'amendment')
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)
    prefix = 'b'
    const b = instance(
      dir,
      {
        researcher: [call('write_file', { path: '/library/other/y.md', content: 'y' }), done('ok')],
      },
      { seed: false },
    )
    expect((await approve(b.app, d.id)).status).toBe(200)
    await until('the run ends', async () => ended((await runs(b.app, p.id))[0]))
    expect(await libraryFs(b.server.conn.sqlite).read('/library/other/y.md')).not.toBeNull()
    expect((await runs(b.app, p.id))[0]?.sessionId).toBe(started.sessionId)
  })
})

describe('API', () => {
  test('filters, unknown ids, events and the open count', async () => {
    const { app } = fresh({
      researcher: [call('escalate', { title: 'One', question: 'q' }), done('ok')],
    })
    expect((await app.request('/decisions/nope')).status).toBe(404)
    expect((await app.request('/decisions?agentId=ghost')).status).toBe(404)
    expect((await app.request('/decisions?status=weird')).status).toBe(400)
    const p = await createProgram(app)
    await runNow(app, p.id)
    const d = await firstOpen(app)
    expect((await decisions(app, '?kind=proposal')).decisions).toHaveLength(0)
    expect((await decisions(app, '?agentId=researcher')).decisions).toHaveLength(1)
    expect((await decisions(app, '?agentId=writer')).decisions).toHaveLength(0)
    // an answer without a body works
    expect((await approve(app, d.id)).status).toBe(200)
    await until('the run ends', async () => ended((await runs(app, p.id))[0]))
    const events = (await (await app.request('/activity?limit=200')).json()) as {
      events: Array<{ type: string; payload: Record<string, unknown> }>
    }
    const changes = events.events.filter((e) => e.type === 'decision-changed')
    expect(changes.map((e) => e.payload.change)).toEqual(
      expect.arrayContaining(['created', 'decided']),
    )
    expect(changes.find((e) => e.payload.change === 'created')?.payload).toMatchObject({
      decisionId: d.id,
      kind: 'escalation',
      open: 1,
    })
  })
})
