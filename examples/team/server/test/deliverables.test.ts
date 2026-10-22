/**
 * Deliverables contract (docs/plans/P40-team-autonomous-operations.md, phase H): the domain checks
 * (tokens, headings, JSON schema) and the run end on the server: pass, one fix-up turn, partial +
 * decision, work items kept out of Review. Scripted models only.
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
import { columnsOf, createTask } from '../src/app/work-queue.ts'
import type { Decision } from '../src/domain/decisions.ts'
import {
  checkContent,
  checkDeliverables,
  type Deliverable,
  deliverablesPromptSection,
  markdownHeadings,
  resolvePath,
  slugify,
} from '../src/domain/deliverables.ts'
import type { Program } from '../src/domain/programs.ts'
import { boardColumn, inReview, type Task } from '../src/domain/tasks.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { installJsonSchemaValidator } from '../src/infra/json-schema.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

function fresh(script: Partial<Record<'lead' | 'writer', ScriptedStepInput[]>>) {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40h-'))
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
    instanceId: 'deliverables-test',
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'writer']) {
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

let seq = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStep => ({
  toolCalls: [{ toolName, input, toolCallId: `c-${toolName}-${++seq}` }],
})
const report = (status: string, outputs: string[] = []): ScriptedStep =>
  call('final_answer', { status, summary: `run ${status}`, outputs })
const write = (path: string, content: string): ScriptedStep => call('write_file', { path, content })

const PROGRAM = {
  agentId: 'writer',
  name: 'Weekly Brief',
  brief: 'Write the weekly brief to the path of the deliverable.',
  authority: { read: ['/library/**'], write: ['/library/reports/**'] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
const REPORT_MD: Deliverable = {
  path: '/library/reports/{slug}/{date}.md',
  kind: 'markdown',
  requiredSections: ['Summary', 'Findings'],
  minChars: 20,
}
const GOOD_MD =
  '# Weekly brief\n\n## Summary\nAll quiet this week, nothing to flag.\n\n## Findings\n- none\n'

async function createProgram(app: Server['app'], body: Record<string, unknown>): Promise<Program> {
  const res = await app.request('/programs', json('POST', { ...PROGRAM, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as Program
}
async function runNow(app: Server['app'], id: string): Promise<string> {
  const res = await app.request(`/programs/${id}/run`, json('POST'))
  if (res.status !== 202) throw new Error(await res.text())
  return ((await res.json()) as { sessionId: string }).sessionId
}
async function getTask(app: Server['app'], id: string): Promise<Task> {
  return ((await (await app.request(`/tasks/${id}`)).json()) as { task: Task }).task
}
async function runTask(server: Server, programId: string): Promise<Task> {
  const sessionId = await runNow(server.app, programId)
  await server.programs.idle()
  const task = server.deps.tasks.getBySession(sessionId)
  if (task === undefined) throw new Error('no task')
  return task
}
const decisionsOf = (server: Server, task: Task): Decision[] =>
  server.deps.decisions.list({ sessionId: task.sessionId, limit: 10 })

async function messageTexts(app: Server['app'], sessionId: string): Promise<string> {
  const res = await app.request(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=50`)
  return JSON.stringify(((await res.json()) as { messages: unknown[] }).messages)
}

describe('domain', () => {
  installJsonSchemaValidator()

  test('tokens resolve per run: date, slug, runId, program', () => {
    const ctx = { title: 'Weekly Brief: Q4!', programId: 'p1', runAt: Date.UTC(2026, 9, 12, 8) }
    expect(slugify('Weekly Brief: Q4!')).toBe('weekly-brief-q4')
    expect(resolvePath('/library/r/{slug}/{date}-{runId}-{program}.md', ctx)).toBe(
      `/library/r/weekly-brief-q4/2026-10-12-${ctx.runAt}-p1.md`,
    )
    expect(slugify('***')).toBe('untitled')
  })

  test('definitions are validated', () => {
    const ok: Deliverable = {
      path: '/library/a/{date}.json',
      kind: 'json',
      schema: { type: 'object' },
    }
    expect(() => checkDeliverables([ok, REPORT_MD])).not.toThrow()
    expect(() => checkDeliverables([{ path: 'library/x.md', kind: 'any' }])).toThrow(
      /starting with/,
    )
    expect(() => checkDeliverables([{ path: '/library/{when}.md', kind: 'any' }])).toThrow(
      /unknown token/,
    )
    expect(() => checkDeliverables([{ path: '/library/x.md', kind: 'png' as never }])).toThrow(
      /kind/,
    )
    expect(() =>
      checkDeliverables([{ path: '/library/x.json', kind: 'json', requiredSections: ['A'] }]),
    ).toThrow(/markdown/)
    expect(() =>
      checkDeliverables([{ path: '/library/x.md', kind: 'markdown', schema: { type: 'object' } }]),
    ).toThrow(/json/)
    expect(() =>
      checkDeliverables([{ path: '/library/x.json', kind: 'json', schema: { $ref: '#/nope' } }]),
    ).toThrow(/schema not usable/)
    expect(() => checkDeliverables([{ path: '/library/x.md', kind: 'any', minChars: 0 }])).toThrow()
  })

  test('markdown headings: any level, case-insensitive, code fences ignored', () => {
    const text = '# Title\n\n### summary:\n\n```\n## Findings\n```\n'
    expect(markdownHeadings(text)).toEqual(['title', 'summary'])
    expect(checkContent({ ...REPORT_MD, minChars: undefined }, text)).toEqual([
      'missing sections (markdown headings): "Findings"',
    ])
    expect(checkContent(REPORT_MD, '# Findings\n## Sum')[0]).toContain('too short')
    expect(checkContent(REPORT_MD, GOOD_MD)).toEqual([])
  })

  test('json: parses, and matches the schema', () => {
    const d: Deliverable = {
      path: '/library/x.json',
      kind: 'json',
      schema: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', items: { type: 'string' } } },
      },
    }
    expect(checkContent(d, '{"items":["a"]}')).toEqual([])
    expect(checkContent(d, 'nope')[0]).toContain('not valid JSON')
    expect(checkContent(d, '{"items":[1]}')[0]).toContain('does not match the schema at items.0')
    expect(checkContent(d, '{}')[0]).toContain('at items')
  })

  test('the run prompt names the files with the tokens filled in', () => {
    const lines = deliverablesPromptSection([REPORT_MD], {
      title: 'Weekly Brief',
      programId: 'p',
      runAt: Date.UTC(2026, 9, 12),
    }).join('\n')
    expect(lines).toContain('/library/reports/weekly-brief/2026-10-12.md')
    expect(lines).toContain('"Summary", "Findings"')
  })

  test('failing deliverables keep a work item out of Review', () => {
    const base = { createdBy: 'client', acceptedAt: null, status: 'done' } as const
    const rep = { status: 'partial' as const, summary: 's', outputs: [] }
    const fail = { status: 'fail' as const, attempts: 2, checkedAt: 1, checks: [] }
    expect(inReview({ ...base, report: rep, deliverables: null })).toBe(true)
    expect(inReview({ ...base, report: rep, deliverables: { ...fail, status: 'pass' } })).toBe(true)
    expect(inReview({ ...base, report: rep, deliverables: fail })).toBe(false)
    expect(boardColumn({ ...base, report: rep, deliverables: fail }, false)).toBe('done')
    expect(boardColumn({ ...base, report: rep, deliverables: fail }, true)).toBe('waiting')
  })
})

const today = (): string => new Date().toISOString().slice(0, 10)
/** The run's file, written when the model's turn gets there (the date token is the run's day). */
const reportPath = (): string => `/library/reports/weekly-brief/${today()}.md`
const writeReport =
  (content: string): ScriptedStepInput =>
  () =>
    write(reportPath(), content)

describe('the run end', () => {
  test('passing deliverables: the report stands, the checks are stored, no fix-up turn', async () => {
    const { server, app, models } = fresh({
      writer: [writeReport(GOOD_MD), () => report('done', [reportPath()])],
    })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    expect(program.deliverables).toEqual([REPORT_MD])
    const task = await runTask(server, program.id)
    expect(task.status).toBe('done')
    expect(task.report?.status).toBe('done')
    expect(task.deliverables).toMatchObject({
      status: 'pass',
      attempts: 1,
      checks: [{ pattern: REPORT_MD.path, path: reportPath(), ok: true, problems: [] }],
    })
    expect(decisionsOf(server, task)).toEqual([])
    expect(models.writer?.calls.length).toBe(2)
    // the run prompt names the file with the tokens filled in
    expect(JSON.stringify(models.writer?.prompts[0])).toContain(reportPath())
    // the API and a program without deliverables
    expect((await getTask(app, task.id)).deliverables?.status).toBe('pass')
  })

  test('a program without deliverables is not checked', async () => {
    const { server, app } = fresh({ writer: [report('done')] })
    const program = await createProgram(app, {})
    const task = await runTask(server, program.id)
    expect(task.deliverables).toBeNull()
    expect(task.report?.status).toBe('done')
  })

  test('a missing file: one fix-up turn with the exact failure, then it passes', async () => {
    const { server, app } = fresh({
      writer: [
        report('done'), // claims done, wrote nothing
        writeReport(GOOD_MD), // the fix-up turn
        () => report('done', [reportPath()]),
      ],
    })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const task = await runTask(server, program.id)
    expect(task.status).toBe('done')
    expect(task.report).toMatchObject({ status: 'done', outputs: [reportPath()] })
    expect(task.deliverables).toMatchObject({ status: 'pass', attempts: 2 })
    expect(decisionsOf(server, task)).toEqual([])
    // the fix-up turn is in the same session and names the file and the problem
    const text = await messageTexts(app, task.sessionId)
    expect(text).toContain('Verify: the server checked your deliverables')
    expect(text).toContain(`${reportPath()}`)
    expect(text).toContain('the file does not exist')
  })

  test('sections missing twice: partial, the failures on the task, a decision is open', async () => {
    const thin = '# Weekly brief\n\n## Summary\nAll quiet this week, nothing else.\n'
    const { server, app, models } = fresh({
      writer: [
        writeReport(thin),
        () => report('done', [reportPath()]),
        writeReport(thin), // the fix-up turn does not fix it
        () => report('done', [reportPath()]),
      ],
    })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const task = await runTask(server, program.id)
    expect(task.status).toBe('done')
    expect(task.report?.status).toBe('partial')
    expect(task.report?.summary).toContain('Deliverables not met')
    expect(task.report?.summary).toContain('missing sections (markdown headings): "Findings"')
    expect(task.deliverables).toMatchObject({
      status: 'fail',
      attempts: 2,
      checks: [{ ok: false, problems: ['missing sections (markdown headings): "Findings"'] }],
    })
    const [decision] = decisionsOf(server, task)
    expect(decision).toMatchObject({
      kind: 'escalation',
      status: 'open',
      programId: program.id,
      agentId: task.agentId,
      payload: { source: 'report' },
    })
    expect(decision?.body).toContain('Findings')
    // only one fix-up turn: the model was called four times, not more
    expect(models.writer?.calls.length).toBe(4)
  })

  test('approving the decision lets the agent try again, and the files are checked when it ends', async () => {
    const thin = '# Weekly brief\n\n## Summary\nAll quiet this week, nothing else.\n'
    const { server, app } = fresh({
      writer: [
        writeReport(thin),
        () => report('done', [reportPath()]),
        writeReport(thin),
        () => report('done', [reportPath()]),
        writeReport(GOOD_MD), // after the client approved
        () => report('done', [reportPath()]),
      ],
    })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const task = await runTask(server, program.id)
    const [decision] = decisionsOf(server, task)
    const res = await app.request(
      `/decisions/${decision?.id}/approve`,
      json('POST', { note: 'Add the findings.' }),
    )
    expect(res.status).toBe(200)
    await server.decisions.idle()
    const after = server.deps.tasks.getBySession(task.sessionId) as Task
    expect(after.deliverables).toMatchObject({ status: 'pass' })
    expect(after.report?.status).toBe('done')
    expect(decisionsOf(server, after).filter((d) => d.status === 'open')).toEqual([])
  })

  test('a run that parked on a decision is checked when the answer lets it finish', async () => {
    const thin = '# Weekly brief\n\n## Summary\nAll quiet this week, nothing else.\n'
    const { server, app } = fresh({
      writer: [
        call('escalate_wait', { title: 'Which tone?', question: 'Formal or casual?' }),
        writeReport(thin), // after the answer: the file lacks "Findings"
        () => report('done', [reportPath()]),
        writeReport(GOOD_MD), // the fix-up turn
        () => report('done', [reportPath()]),
      ],
    })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const parked = await runTask(server, program.id)
    expect(parked.deliverables).toBeNull()
    const [open] = decisionsOf(server, parked).filter((d) => d.status === 'open')
    const res = await app.request(
      `/decisions/${open?.id}/approve`,
      json('POST', { note: 'Casual.' }),
    )
    expect(res.status).toBe(200)
    await server.decisions.idle()
    const after = server.deps.tasks.getBySession(parked.sessionId) as Task
    // checked after the resume, and the fix-up turn ran (attempts 2) although the run had parked
    expect(after.deliverables).toMatchObject({ status: 'pass', attempts: 2 })
    expect(after.report?.status).toBe('done')
    expect(await messageTexts(app, after.sessionId)).toContain(
      'Verify: the server checked your deliverables',
    )
  })

  test('a JSON deliverable that does not match its schema fails with the exact path', async () => {
    const jsonPath = (): string => `/library/reports/data-${today()}.json`
    const spec: Deliverable = {
      path: '/library/reports/data-{date}.json',
      kind: 'json',
      schema: {
        type: 'object',
        required: ['findings'],
        properties: { findings: { type: 'array', items: { type: 'object', required: ['id'] } } },
      },
    }
    const bad = JSON.stringify({ findings: [{ id: 1 }, { note: 'no id' }] })
    const { server, app } = fresh({
      writer: [
        () => write(jsonPath(), bad),
        report('done'),
        () => write(jsonPath(), '{ not json'),
        report('done'),
      ],
    })
    const program = await createProgram(app, { deliverables: [spec] })
    const task = await runTask(server, program.id)
    const first = await messageTexts(app, task.sessionId)
    // the fix-up turn named the schema violation of the first attempt
    expect(first).toContain('does not match the schema at findings.1.id')
    // the second attempt was not JSON at all
    expect(task.deliverables?.status).toBe('fail')
    expect(task.deliverables?.checks[0]?.problems[0]).toContain('not valid JSON')
    expect(task.report?.status).toBe('partial')
  })

  test('a report that says failed is not checked: it already asks for attention', async () => {
    const { server, app } = fresh({ writer: [report('failed')] })
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const task = await runTask(server, program.id)
    expect(task.status).toBe('failed')
    expect(task.deliverables).toBeNull()
  })

  test('editing: the API validates the list, a patch replaces it, a proposal carries it', async () => {
    const { server, app } = fresh({})
    const bad = await app.request(
      '/programs',
      json('POST', { ...PROGRAM, deliverables: [{ path: 'x', kind: 'any' }] }),
    )
    expect(bad.status).toBe(400)
    const program = await createProgram(app, { deliverables: [REPORT_MD] })
    const patched = await app.request(
      `/programs/${program.id}`,
      json('PATCH', { deliverables: [{ path: '/library/reports/{slug}.json', kind: 'json' }] }),
    )
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as Program).deliverables).toEqual([
      { path: '/library/reports/{slug}.json', kind: 'json' },
    ])
    const cleared = await app.request(
      `/programs/${program.id}`,
      json('PATCH', { deliverables: [] }),
    )
    expect(((await cleared.json()) as Program).deliverables).toEqual([])

    // a proposal keeps them; the client edits them before approving
    const lead = server.deps.agents.getBySlug('lead')
    const { createProposal } = await import('../src/app/decisions.ts')
    const proposal = createProposal(server.deps, {
      agentId: (lead as { id: string }).id,
      sessionId: null,
      title: 'Weekly brief',
      runner: 'writer',
      runOnce: true,
      program: { name: 'Brief', brief: 'Write it.', deliverables: [REPORT_MD] },
    })
    expect(proposal.body).toContain('Deliverables it must leave')
    const approved = await app.request(
      `/decisions/${proposal.id}/approve`,
      json('POST', { edit: { runOnce: false, program: { deliverables: [] } } }),
    )
    expect(approved.status).toBe(200)
    const created = server.deps.programs.list({}).find((p) => p.name === 'Brief')
    expect(created?.deliverables).toEqual([])
  })
})

describe('work items', () => {
  test('a failing deliverable keeps the item out of Review until it is fixed', async () => {
    const thin = '## Summary\nShort but with a summary only, no findings.\n'
    const slugPath = '/library/scripts/the-island.md'
    const spec: Deliverable = {
      path: '/library/scripts/{slug}.md',
      kind: 'markdown',
      requiredSections: ['Hook', 'Script'],
    }
    const steps = (): ScriptedStepInput[] => [
      write(slugPath, thin),
      call('complete_task', { summary: 'drafted', outputs: [slugPath] }),
      report('done', [slugPath]),
      write(slugPath, thin), // the fix-up turn does not help
      report('done', [slugPath]),
    ]
    const { server, app } = fresh({ writer: steps() })
    const program = await createProgram(app, {
      name: 'Script writer',
      authority: { read: ['/library/**'], write: ['/library/scripts/**'] },
      worker: { maxTasks: 1 },
      deliverables: [spec],
    })
    // there is no owner-facing create route any more (P55): queue through the use case
    const task0 = createTask(server.deps, {
      agentId: 'writer',
      title: 'The island',
      brief: 'Draft the script.',
    })
    await runNow(app, program.id)
    await server.programs.idle()

    const task = await getTask(app, task0.id)
    // the title gave the {slug}
    expect(task.deliverables?.checks[0]?.path).toBe(slugPath)
    expect(task.deliverables?.status).toBe('fail')
    expect(task.report?.status).toBe('partial')
    expect(inReview(task)).toBe(false)
    // an open decision of its session: the client's turn
    const [decision] = decisionsOf(server, task)
    expect(decision?.status).toBe('open')
    expect(columnsOf(server.deps, [task]).get(task.id)).toBe('waiting')
    // it cannot be accepted
    expect((await app.request(`/tasks/${task.id}/accept`, json('POST'))).status).toBe(409)

    // the client (or the agent) repairs the file; checking again lets the item enter Review
    await server.deps.library.writeText(slugPath, '## Hook\nA lighthouse.\n\n## Script\nOnce.\n')
    const res = await app.request(`/tasks/${task.id}/deliverables/check`, json('POST'))
    expect(res.status).toBe(200)
    const fixed = (await res.json()) as Task
    expect(fixed.deliverables?.status).toBe('pass')
    expect(inReview(fixed)).toBe(true)
    expect((await app.request(`/tasks/${task.id}/accept`, json('POST'))).status).toBe(200)
  })
})
