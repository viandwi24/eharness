/**
 * Rehearsals (docs/plans/P40-team-autonomous-operations.md, phase K): a program runs on sample
 * data in a safe mode. The overlay never touches the real library, external writes are simulated
 * and recorded, decisions are recorded as "would ask", deliverables are checked against the
 * overlay, the budget cap is its own, and saved test cases re-run after an edit. Scripted models
 * only, an in-process fake MCP server for the external tool.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inMemoryFs } from 'eharness/filesystem/memory'
import {
  type ScriptedModel,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { runDigest } from '../src/app/heartbeat.ts'
import type { Deliverable } from '../src/domain/deliverables.ts'
import type { Program } from '../src/domain/programs.ts'
import {
  evaluateExpect,
  isSimulatedCall,
  normalizeExpect,
  normalizeSample,
  parseRehearsalSession,
  programFingerprint,
  type Rehearsal,
  rehearsalSessionId,
  summarizeTests,
  type TestCase,
} from '../src/domain/rehearsal.ts'
import { originOfSession, profileOfSession } from '../src/domain/run-profiles.ts'
import { overlayFs } from '../src/infra/eh/overlay-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { fileSystemOfSession } from '../src/infra/eh/rehearsal-registry.ts'
import { installJsonSchemaValidator } from '../src/infra/json-schema.ts'
import { compose, type Server } from '../src/main.ts'
import { fakeMcp } from './support/fake-mcp.ts'

installJsonSchemaValidator()

const servers: Server[] = []
const dirs: string[] = []
const stops: Array<() => void> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const stop of stops.splice(0)) stop()
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

function fresh(
  script: Partial<Record<'lead' | 'writer', ScriptedStepInput[]>>,
  options: { catalog?: Record<string, unknown> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40k-'))
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
    instanceId: 'rehearsal-test',
    models: config,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog as never }),
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
const report = (status = 'done', outputs: string[] = []): ScriptedStep =>
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
const slugPath = '/library/reports/weekly-brief'

async function createProgram(
  app: Server['app'],
  body: Record<string, unknown> = {},
): Promise<Program> {
  const res = await app.request('/programs', json('POST', { ...PROGRAM, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as Program
}

async function rehearse(
  server: Server,
  programId: string,
  body: Record<string, unknown> = {},
): Promise<Rehearsal> {
  const res = await server.app.request(`/programs/${programId}/rehearsals`, json('POST', body))
  if (res.status !== 201) throw new Error(await res.text())
  const started = (await res.json()) as Rehearsal
  await server.rehearsals.idle()
  return getRehearsal(server, started.id)
}
async function getRehearsal(server: Server, id: string): Promise<Rehearsal> {
  const res = await server.app.request(`/rehearsals/${id}`)
  if (res.status !== 200) throw new Error(await res.text())
  return (await res.json()) as Rehearsal
}
async function messagesText(server: Server, id: string): Promise<string> {
  const res = await server.app.request(`/rehearsals/${id}/messages`)
  return JSON.stringify(((await res.json()) as { messages: unknown[] }).messages)
}
const realFile = async (server: Server, path: string) =>
  (await server.deps.library.read(path))?.text
const realCount = (server: Server, like: string): number =>
  (
    server.conn.sqlite
      .query<{ n: number }, [string]>('SELECT count(*) AS n FROM library_files WHERE path LIKE ?')
      .get(like) as { n: number }
  ).n

// --- units --------------------------------------------------------------------------------------

describe('domain', () => {
  test('session ids, simulated calls, samples and expectations', () => {
    const id = rehearsalSessionId('p1', 1760000000000)
    expect(id).toBe('rehearsal:p1:1760000000000')
    expect(parseRehearsalSession(id)).toEqual({ programId: 'p1', runAt: 1760000000000 })
    expect(parseRehearsalSession('program:p1:1')).toBeUndefined()
    expect(originOfSession(id)).toBe('rehearsal')
    // not a task, no program budget: nothing of a rehearsal reaches the board or a program's scopes
    expect(profileOfSession(id).task).toBeNull()
    expect(profileOfSession(id).budget).toBe('workspace')

    expect(isSimulatedCall({ connectorId: 'github', risk: 'write' })).toBe(true)
    expect(isSimulatedCall({ connectorId: 'mcp-remote', risk: undefined })).toBe(true)
    expect(isSimulatedCall({ connectorId: 'mcp-remote', risk: 'read' })).toBe(false)
    expect(isSimulatedCall({ connectorId: 'files', risk: 'write' })).toBe(false)
    expect(isSimulatedCall({ connectorId: undefined, risk: 'write' })).toBe(false)

    expect(() => normalizeSample({ copy: ['relative'] })).toThrow(/library path/)
    expect(() => normalizeSample({ copy: ['/a/../b'] })).toThrow(/\.\./)
    expect(() => normalizeSample({ task: { title: '', brief: '', inputs: [] } })).toThrow(/title/)
    expect(normalizeSample(undefined)).toEqual({
      copy: [],
      files: [],
      task: null,
      reads: 'library',
    })
    expect(() => normalizeExpect({ mustNotCall: ['bad name'] })).toThrow(/tool name/)
    expect(normalizeExpect({})).toEqual({
      deliverablesPass: true,
      mustNotCall: [],
      reportStatus: null,
    })
  })

  test('expectations judge a finished rehearsal; the summary counts stale results', () => {
    const run = {
      status: 'done',
      error: null,
      report: { status: 'done', summary: 's', outputs: [] },
      deliverables: null,
      toolsCalled: ['read_file', 'github_create_issue'],
    } as unknown as Rehearsal
    const base = { deliverablesPass: true, mustNotCall: [], reportStatus: null }
    expect(evaluateExpect(base, run, true)).toMatchObject({
      status: 'fail',
      failures: ['the deliverables were not checked'],
    })
    expect(evaluateExpect(base, run, false).status).toBe('pass')
    expect(evaluateExpect({ ...base, mustNotCall: ['github_*'] }, run, false).failures).toEqual([
      'called github_create_issue, which the test forbids',
    ])
    expect(evaluateExpect({ ...base, reportStatus: 'partial' }, run, false).failures[0]).toContain(
      'expected partial',
    )
    expect(
      evaluateExpect(base, { ...run, status: 'failed', error: 'cost cap' }, false),
    ).toMatchObject({
      status: 'error',
    })
    const result = (status: 'pass' | 'fail', v: string) => ({
      status,
      rehearsalId: 'r',
      programFingerprint: v,
      failures: [],
      at: 1,
    })
    const cases = [
      { lastResult: result('pass', 'now') },
      { lastResult: result('fail', 'now') },
      { lastResult: result('pass', 'before') },
      { lastResult: null },
    ] as unknown as TestCase[]
    expect(summarizeTests(cases, 'now')).toEqual({
      total: 4,
      passing: 1,
      failing: 1,
      stale: 2,
      running: 0,
    })
  })
})

describe('overlay file system', () => {
  test('writes, deletes and moves stay in the scratch; the base is only read', async () => {
    const base = inMemoryFs({ seed: { '/a.md': 'base a', '/dir/b.md': 'base b' } })
    const overlay = overlayFs({ base, scratch: inMemoryFs() })

    expect((await overlay.read('/a.md'))?.content).toBe('base a')
    const cur = await overlay.stat('/a.md')
    // a stale edit loses, as in the real library
    expect(await overlay.write('/a.md', 'x', { ifVersion: 'nope' })).toMatchObject({ ok: false })
    expect(await overlay.write('/a.md', 'new a', { ifVersion: cur?.version })).toMatchObject({
      ok: true,
    })
    expect(await overlay.write('/a.md', 'again', { ifVersion: null })).toMatchObject({
      ok: false,
      reason: 'exists',
    })
    expect((await overlay.read('/a.md'))?.content).toBe('new a')
    expect((await base.read('/a.md'))?.content).toBe('base a')

    expect(await overlay.delete('/dir/b.md')).toEqual({ ok: true })
    expect(await overlay.read('/dir/b.md')).toBeNull()
    expect((await base.read('/dir/b.md'))?.content).toBe('base b')
    expect(overlay.deletedPaths()).toEqual(['/dir/b.md'])
    expect((await overlay.list('/')).map((m) => m.path)).toEqual(['/a.md'])

    expect(await overlay.move?.('/a.md', '/c.md')).toEqual({ ok: true })
    expect((await overlay.list('/')).map((m) => m.path)).toEqual(['/c.md'])
    expect(await base.read('/c.md')).toBeNull()
    expect((await overlay.grep?.(/new/))?.map((h) => h.path)).toEqual(['/c.md'])
    expect((await overlay.glob?.('*.md', { prefix: '/', limit: 10 }))?.map((m) => m.path)).toEqual([
      '/c.md',
    ])
  })

  test('only the sample is visible without a base; an ended rehearsal session is read only', async () => {
    const overlay = overlayFs({ base: null, scratch: inMemoryFs({ seed: { '/s.md': 'sample' } }) })
    expect((await overlay.list('/')).map((m) => m.path)).toEqual(['/s.md'])
    const base = inMemoryFs({ seed: { '/a.md': 'a' } })
    // a rehearsal session id that is not running must never get the real, writable library
    const view = fileSystemOfSession('rehearsal:gone:1', base)
    expect((await view.read('/a.md'))?.content).toBe('a')
    expect(() => view.write('/a.md', 'x')).toThrow(/read-only/)
    expect(fileSystemOfSession('dm:someone', base)).toBe(base)
  })
})

// --- the server ---------------------------------------------------------------------------------

describe('safe mode', () => {
  test('files go to the overlay, the real library is untouched, reads see it, no run history', async () => {
    const { server, app } = fresh({
      writer: [
        call('read_file', { path: '/library/data/in.md' }),
        write('/library/reports/new.md', 'a new report from the rehearsal'),
        call('read_file', { path: '/library/reports/old.md' }),
        call('delete_file', { path: '/library/reports/old.md' }),
        report('done', ['/library/reports/new.md']),
      ],
    })
    await server.deps.library.writeText('/library/data/in.md', 'REAL INPUT LINE')
    await server.deps.library.writeText('/library/reports/old.md', 'old report')
    const p = await createProgram(app)
    const before = realCount(server, '/library/%')

    const r = await rehearse(server, p.id)
    expect(r).toMatchObject({ status: 'done', stop: 'complete', programId: p.id, testId: null })
    expect(r.sessionId).toMatch(new RegExp(`^rehearsal:${p.id}:\\d+$`))
    expect(r.report).toMatchObject({ status: 'done', outputs: ['/library/reports/new.md'] })

    // produced files come from the overlay; the deletion is recorded, not made
    expect(r.files.map((f) => f.path)).toEqual(['/library/reports/new.md'])
    expect(r.files[0]?.text).toBe('a new report from the rehearsal')
    expect(r.deleted).toEqual(['/library/reports/old.md'])
    expect(r.toolsCalled).toEqual(['read_file', 'write_file', 'read_file', 'delete_file'])
    expect(await realFile(server, '/library/reports/new.md')).toBeUndefined()
    expect(await realFile(server, '/library/reports/old.md')).toBe('old report')
    expect(realCount(server, '/library/%')).toBe(before)
    // reads of the real library go through
    expect(await messagesText(server, r.id)).toContain('REAL INPUT LINE')
    // the produced file downloads
    const dl = await app.request(`/rehearsals/${r.id}/file?path=/library/reports/new.md`)
    expect(await dl.text()).toBe('a new report from the rehearsal')
    expect(dl.headers.get('content-disposition')).toContain('attachment')

    // not a task: no run history, no board entry
    const runs = (await (await app.request(`/programs/${p.id}/runs`)).json()) as { runs: unknown[] }
    expect(runs.runs).toEqual([])
    expect(server.deps.tasks.getBySession(r.sessionId)).toBeUndefined()
    const board = (await (await app.request('/tasks?limit=100')).json()) as {
      tasks: Array<{ sessionId: string }>
    }
    expect(board.tasks.some((t) => t.sessionId.startsWith('rehearsal:'))).toBe(false)
    // listed under the program, without file content
    const list = (await (await app.request(`/programs/${p.id}/rehearsals`)).json()) as {
      rehearsals: Rehearsal[]
    }
    expect(list.rehearsals.map((x) => x.id)).toEqual([r.id])
    expect(list.rehearsals[0]?.files[0]).toMatchObject({
      path: '/library/reports/new.md',
      text: null,
    })
    // the model spent from its own scope; the program's budget scopes are not touched
    const scopes = server.conn.sqlite
      .query<{ scope: string; limit_usd: string | null }, []>(
        'SELECT scope, limit_usd FROM eh_budget_scope',
      )
      .all()
    expect(
      scopes.some((s) => s.scope === `rehearsal:${r.sessionId}` && Number(s.limit_usd) === 0.5),
    ).toBe(true)
    expect(scopes.some((s) => s.scope.startsWith('program'))).toBe(false)
  })

  test('sample files are copied or attached; reads: sample hides the rest of the library', async () => {
    const { server, app, models } = fresh({
      writer: [
        call('read_file', { path: '/library/data/in.md' }),
        call('read_file', { path: '/library/inputs/attached.md' }),
        call('read_file', { path: '/library/secret.md' }),
        report(),
      ],
    })
    await server.deps.library.writeText('/library/data/in.md', 'COPIED CONTENT')
    await server.deps.library.writeText('/library/secret.md', 'NOT PART OF THE SAMPLE')
    const p = await createProgram(app)
    const r = await rehearse(server, p.id, {
      sample: {
        copy: ['/library/data/'],
        files: [{ path: '/library/inputs/attached.md', content: 'ATTACHED CONTENT' }],
        reads: 'sample',
      },
    })
    expect(r.status).toBe('done')
    const text = await messagesText(server, r.id)
    expect(text).toContain('COPIED CONTENT')
    expect(text).toContain('ATTACHED CONTENT')
    expect(text).not.toContain('NOT PART OF THE SAMPLE')
    // the sample files themselves are not "produced"
    expect(r.files).toEqual([])
    expect(models.writer?.calls.length).toBe(4)
    // a sample that copies nothing is refused before a rehearsal is made
    const bad = await app.request(
      `/programs/${p.id}/rehearsals`,
      json('POST', { sample: { copy: ['/library/nothing-here/'] } }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SAMPLE')
  })

  test('an external write tool is simulated and recorded; a real run calls it', async () => {
    const mcp = fakeMcp()
    stops.push(() => mcp.server.stop(true))
    const { server, app } = fresh({
      writer: [
        call('docs_create_note', { q: 'rehearsal note' }),
        report(),
        call('docs_create_note', { q: 'real note' }),
        report(),
      ],
    })
    await server.connectorsReady
    const flow = await app.request(
      '/connections/flows',
      json('POST', { definitionId: 'mcp-remote', label: 'docs', defaultEnabled: true }),
    )
    const started = (await flow.json()) as { flow: { id: string; view: { viewId: string } } }
    const done = await app.request(
      `/connections/flows/${started.flow.id}/act`,
      json('POST', {
        viewId: started.flow.view.viewId,
        action: 'submit',
        data: { url: mcp.url, authMode: 'none' },
      }),
    )
    const connection = ((await done.json()) as { connection: { id: string } }).connection.id
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await app.request(
      `/agents/${writer.id}/connectors`,
      json('PUT', {
        connections: { [connection]: { capabilities: { read: 'allow', write: 'allow' } } },
      }),
    )
    const p = await createProgram(app, {
      authority: {
        read: ['/library/**'],
        write: ['/library/reports/**'],
        connectors: [connection],
      },
    })

    const r = await rehearse(server, p.id)
    expect(r.status).toBe('done')
    expect(mcp.seen.calls).toEqual([]) // nothing was sent
    expect(r.simulated).toHaveLength(1)
    expect(r.simulated[0]).toMatchObject({
      tool: 'docs_create_note',
      input: { q: 'rehearsal note' },
    })
    expect(r.toolsCalled).toContain('docs_create_note')
    expect(await messagesText(server, r.id)).toContain(
      'SIMULATED: would call docs_create_note with {\\"q\\":\\"rehearsal note\\"}',
    )

    // the same call in a real run is made: the simulation is the only thing that stopped it
    const run = await app.request(`/programs/${p.id}/run`, json('POST'))
    expect(run.status).toBe(202)
    await server.programs.idle()
    expect(mcp.seen.calls).toEqual(['create_note'])
  })

  test('decisions the run would raise are recorded as would-ask, none reaches the Decision Center', async () => {
    const { server, app } = fresh({
      writer: [
        call('escalate', {
          title: 'Publish the brief?',
          question: 'May I publish it to the website?',
          options: ['publish', 'hold'],
        }),
        call('request_authority', { tools: ['web_fetch'], why: 'need the source page' }),
        report('needs_decision'),
      ],
    })
    const p = await createProgram(app)
    const r = await rehearse(server, p.id)
    // the run did not park: it carried on and ended
    expect(r).toMatchObject({ status: 'done', stop: 'complete' })
    expect(r.wouldAsk.map((a) => a.kind)).toEqual(['escalation', 'amendment', 'report'])
    expect(r.wouldAsk[0]).toMatchObject({
      title: 'Publish the brief?',
      options: ['publish', 'hold'],
    })
    expect(r.wouldAsk[1]?.details).toContain('web_fetch')
    expect(server.deps.decisions.list({ limit: 50 })).toEqual([])
    expect(server.deps.decisions.countOpen()).toBe(0)
  })

  test('deliverables are checked against the overlay files, with the one fix-up turn', async () => {
    const path = `${slugPath}/${new Date().toISOString().slice(0, 10)}.md`
    const { server, app, models } = fresh({
      writer: [
        write(path, '# Only a title that is long enough'),
        report('done', [path]),
        write(path, GOOD_MD),
        report('done', [path]),
      ],
    })
    const p = await createProgram(app, { deliverables: [REPORT_MD] })
    const r = await rehearse(server, p.id)
    expect(r.deliverables).toMatchObject({ status: 'pass', attempts: 2 })
    expect(r.deliverables?.checks[0]).toMatchObject({ path, ok: true })
    expect(models.writer?.calls.length).toBe(4)
    expect(r.files.map((f) => f.path)).toEqual([path])
    // nothing of it is in the real library, and the real run machinery left no decision behind
    expect(await realFile(server, path)).toBeUndefined()
    expect(server.deps.decisions.list({ limit: 10 })).toEqual([])

    // still failing after the fix-up: the rehearsal shows it (no decision, no partial task)
    const bad = fresh({
      writer: [
        write(path, '# Only a title that is long enough'),
        report('done', [path]),
        report('done', [path]),
      ],
    })
    const p2 = await createProgram(bad.app, { deliverables: [REPORT_MD] })
    const r2 = await rehearse(bad.server, p2.id)
    expect(r2.status).toBe('done')
    expect(r2.deliverables).toMatchObject({ status: 'fail', attempts: 2 })
    expect(r2.deliverables?.checks[0]?.problems[0]).toContain('missing sections')
    expect(bad.server.deps.decisions.list({ limit: 10 })).toEqual([])
  })

  test('a worker program needs a sample task and works it without touching the board', async () => {
    const { server, app } = fresh({
      writer: [
        write('/library/reports/draft.md', 'draft for the sample task'),
        call('complete_task', { summary: 'drafted', outputs: ['/library/reports/draft.md'] }),
        report('done', ['/library/reports/draft.md']),
      ],
    })
    const p = await createProgram(app, { worker: { maxTasks: 1 } })
    const refused = await app.request(`/programs/${p.id}/rehearsals`, json('POST', {}))
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_SAMPLE',
    )

    const r = await rehearse(server, p.id, {
      sample: { task: { title: 'Script for episode 7', brief: 'Make it short.', inputs: [] } },
    })
    expect(r.status).toBe('done')
    expect(await messagesText(server, r.id)).toContain('Script for episode 7')
    expect(r.simulated.map((a) => a.tool)).toEqual(['complete_task'])
    expect(server.deps.tasks.list({ limit: 50 })).toEqual([])
  })

  test('a rehearsal has a budget cap of its own', async () => {
    // pricing is per million tokens: one step of 1M in + 1M out costs 3 USD
    const catalog = { scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } } }
    const { server, app, models } = fresh(
      {
        writer: [
          {
            toolCalls: [
              { toolName: 'write_file', input: { path: '/library/reports/a.md', content: 'a' } },
            ],
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          },
          report(),
        ],
      },
      { catalog },
    )
    const p = await createProgram(app)
    const r = await rehearse(server, p.id, { budgetUsd: 1 })
    expect(r.status).toBe('failed')
    expect(r.stop).toBe('cost-cap')
    expect(r.error).toContain('budget cap of $1')
    expect(models.writer?.calls).toHaveLength(1) // the second step was refused
    expect(r.costUsd).toBeGreaterThan(0)
    const tooBig = await app.request(
      `/programs/${p.id}/rehearsals`,
      json('POST', { budgetUsd: 50 }),
    )
    expect(tooBig.status).toBe(400)
  })

  test('rehearsals stay out of the digest and the program history; deleting a program removes them', async () => {
    // one step of 1M in + 1M out costs 3 USD: the rehearsal really spends, the digest does not show it
    const catalog = { scripted: { contextWindow: 100_000_000, pricing: { input: 1, output: 2 } } }
    const { server, app } = fresh(
      {
        writer: [
          {
            toolCalls: [
              { toolName: 'write_file', input: { path: '/library/reports/x.md', content: 'x' } },
            ],
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          },
          report('done', ['/library/reports/x.md']),
        ],
      },
      { catalog },
    )
    const p = await createProgram(app, { report: 'digest' })
    const r = await rehearse(server, p.id, { budgetUsd: 5 })
    expect(r.status).toBe('done')
    expect(r.costUsd).toBeGreaterThan(0)
    expect(
      server.deps.modelCalls.stats({ from: 0, to: Date.now() + 1000 }).totals.costUsd,
    ).toBeGreaterThan(0)
    // a day with only a rehearsal is a quiet day: the digest sends nothing
    expect(await runDigest(server.deps)).toBe('empty')
    expect(server.deps.tasks.ofProgram(p.id, 10)).toEqual([])

    expect((await app.request(`/rehearsals/${r.id}`, json('DELETE'))).status).toBe(200)
    expect((await app.request(`/rehearsals/${r.id}`)).status).toBe(404)
    await app.request(`/programs/${p.id}`, json('DELETE'))
    expect(server.deps.rehearsals.list(p.id, 10)).toEqual([])
  })
})

describe('test cases', () => {
  test('a saved case passes, then fails after a program edit that breaks it; the summary warns', async () => {
    const path = `${slugPath}/${new Date().toISOString().slice(0, 10)}.md`
    const { server, app } = fresh({
      writer: [
        // rehearsal 1 (the one saved as a case)
        write(path, GOOD_MD),
        report('done', [path]),
        // run all tests, after the program was edited to need a section the agent never writes
        write(path, GOOD_MD),
        report('done', [path]),
        report('done', [path]),
      ],
    })
    const p = await createProgram(app, { deliverables: [REPORT_MD] })
    const first = await rehearse(server, p.id, {
      sample: { files: [{ path: '/library/inputs/week.md', content: 'sample week' }] },
    })
    expect(first.deliverables?.status).toBe('pass')

    const saved = await app.request(
      `/programs/${p.id}/tests`,
      json('POST', {
        name: 'quiet week',
        rehearsalId: first.id,
        expect: { deliverablesPass: true, mustNotCall: ['docs_*'], reportStatus: 'done' },
      }),
    )
    expect(saved.status).toBe(201)
    const testCase = (await saved.json()) as TestCase
    expect(testCase.sample.files[0]?.path).toBe('/library/inputs/week.md')
    // judged against the run it was saved from
    expect(testCase.lastResult).toMatchObject({
      status: 'pass',
      rehearsalId: first.id,
      programFingerprint: programFingerprint(p),
    })
    const list = async () =>
      (await (await app.request(`/programs/${p.id}/tests`)).json()) as {
        cases: Array<TestCase & { stale: boolean }>
        summary: ReturnType<typeof summarizeTests>
      }
    expect((await list()).summary).toEqual({
      total: 1,
      passing: 1,
      failing: 0,
      stale: 0,
      running: 0,
    })

    // an edit of the program: the result is stale until the tests run again
    const edited = await app.request(
      `/programs/${p.id}`,
      json('PATCH', {
        version: p.version,
        deliverables: [{ ...REPORT_MD, requiredSections: ['Summary', 'Findings', 'Risks'] }],
      }),
    )
    expect(edited.status).toBe(200)
    const editedProgram = (await edited.json()) as Program
    expect((await list()).summary).toMatchObject({ passing: 0, failing: 0, stale: 1 })
    expect((await list()).cases[0]?.stale).toBe(true)

    const run = await app.request(`/programs/${p.id}/tests/run`, json('POST', {}))
    expect(run.status).toBe(202)
    expect(((await run.json()) as { started: number }).started).toBe(1)
    await server.rehearsals.idle()
    const after = await list()
    expect(after.summary).toMatchObject({ failing: 1, passing: 0, stale: 0 })
    const result = after.cases[0]?.lastResult
    expect(result?.status).toBe('fail')
    expect(result?.programFingerprint).toBe(programFingerprint(editedProgram))
    expect(result?.failures.join('\n')).toContain('Risks')
    // pausing and resuming is not an edit that matters: the failing result still counts
    await app.request(`/programs/${p.id}/pause`, json('POST'))
    await app.request(`/programs/${p.id}/resume`, json('POST'))
    expect((await list()).summary).toMatchObject({ failing: 1, stale: 0 })
    expect((await list()).cases[0]?.stale).toBe(false)
    // the second rehearsal of the case is a rehearsal of its own, linked to the case
    const second = await getRehearsal(server, result?.rehearsalId as string)
    expect(second.testId).toBe(testCase.id)
    expect(second.sample.files[0]?.path).toBe('/library/inputs/week.md')
    // none of it is in the real library
    expect(await realFile(server, path)).toBeUndefined()
  })

  test('forbidden tools and report status are judged; cases can be edited and deleted', async () => {
    const { server, app } = fresh({
      writer: [write('/library/reports/a.md', 'a'), report('partial', ['/library/reports/a.md'])],
    })
    const p = await createProgram(app)
    const r = await rehearse(server, p.id)
    const made = await app.request(
      `/programs/${p.id}/tests`,
      json('POST', {
        name: 'must not write',
        rehearsalId: r.id,
        expect: { deliverablesPass: false, mustNotCall: ['write_file'], reportStatus: 'done' },
      }),
    )
    const testCase = (await made.json()) as TestCase
    expect(testCase.lastResult?.status).toBe('fail')
    expect(testCase.lastResult?.failures).toEqual([
      'called write_file, which the test forbids',
      'the report status is partial, expected done',
    ])
    // an edit clears the result
    const patched = await app.request(
      `/program-tests/${testCase.id}`,
      json('PATCH', { name: 'renamed', expect: { mustNotCall: [], reportStatus: 'partial' } }),
    )
    const next = (await patched.json()) as TestCase
    expect(next).toMatchObject({ name: 'renamed', lastResult: null })
    expect(next.expect).toEqual({
      deliverablesPass: false,
      mustNotCall: [],
      reportStatus: 'partial',
    })
    expect((await app.request(`/program-tests/${testCase.id}`, json('DELETE'))).status).toBe(200)
    expect((await app.request(`/program-tests/${testCase.id}`, json('DELETE'))).status).toBe(404)
    // a worker program needs a sample task in its cases
    const w = await createProgram(app, { name: 'Worker', worker: { maxTasks: 1 } })
    const noTask = await app.request(`/programs/${w.id}/tests`, json('POST', { name: 'x' }))
    expect(noTask.status).toBe(400)
    void server
  })
})
