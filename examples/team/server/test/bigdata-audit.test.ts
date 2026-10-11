/**
 * The community auditor on a 5 000-message day (docs/plans/P40-team-autonomous-operations.md,
 * phase D, acceptance "Auditor processes a 5 000-message fixture in chunks"): a program with a
 * narrow authority, the Data work connector (run_code, manifest tools) and the `chunked-audit`
 * skill. The scripted model plays the auditor: it never reads the raw data, it pre-filters with
 * run_code, judges one small chunk at a time, writes findings per chunk, merges with code and
 * writes one report. Then a run that dies in the middle resumes from the manifest.
 * Scripted models only, no network.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ScriptedCallOptions,
  type ScriptedModel,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { builtinId, enablementFromTools } from '../src/domain/connectors.ts'
import { type Manifest, manifestPath, progressOf } from '../src/domain/manifest.ts'
import { communityFixture } from '../src/infra/bigdata/fixture-collector.ts'
import { ingestSource } from '../src/infra/bigdata/ingest.ts'
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
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(25)
  }
}

const DAY = '2026-10-11'
const RUN = `community-audit-${DAY}`
const fixture = communityFixture({ day: DAY })
const truth = fixture.truth()

// --- the server -------------------------------------------------------------------------------

interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}

/** A server (on `dir`) whose auditor runs the given scripted model. */
function instance(dir: string, steps: ScriptedStepInput[]): Instance {
  const model = scriptedModel(steps)
  const models = { auditor: model }
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => model,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    bigData: { collectors: [fixture] },
  })
  servers.push(server)
  return { server, app: server.app, models }
}

/** The auditor agent: files + planning + the Data work connector, and the chunked-audit skill. */
function ensureAuditor(server: Server): void {
  if (server.deps.agents.getBySlug('auditor') !== undefined) return
  const def = createAgent(server.deps, {
    slug: 'auditor',
    name: 'Community auditor',
    role: 'custom',
    instructions: 'You audit the community chat for the client.',
    skills: ['chunked-audit'],
    model: 'm-auditor',
    connectors: {
      ...enablementFromTools(['library_read', 'library_write', 'todos'], {
        id: 'pending',
        role: 'custom',
      }),
      [builtinId('bigdata')]: { enabled: 'on' },
    },
  })
  // the agent id is known now: its own memory connection key was built from a placeholder
  updateAgent(server.deps, def.id, { model: 'm-auditor' })
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

type TaskView = {
  id: string
  status: string
  summary: string | null
  report: null | { status: string; summary: string; outputs: string[] }
}

const AUDIT_PROGRAM = {
  agentId: 'auditor',
  name: 'Community audit',
  brief:
    'Audit the community chat of the day in /library/data/community/. Follow the chunked-audit skill: ' +
    'pre-filter with run_code, judge one chunk at a time, merge, and write the report to ' +
    '/library/reports/community/<date>.md.',
  authority: {
    connectors: ['bigdata'],
    read: ['/library/data/community/**'],
    write: ['/library/work/**', '/library/reports/community/**'],
  },
  gates: [],
  escalation: 'Stop and ask when a moderator or an admin did something serious.',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}

async function createProgram(app: Server['app'], body: Record<string, unknown> = {}) {
  const res = await app.request('/programs', json('POST', { ...AUDIT_PROGRAM, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as { id: string }
}
async function runNow(app: Server['app'], id: string): Promise<string> {
  const res = await app.request(`/programs/${id}/run`, json('POST'))
  if (res.status !== 202) throw new Error(await res.text())
  return ((await res.json()) as { sessionId: string }).sessionId
}
async function runs(app: Server['app'], id: string): Promise<TaskView[]> {
  const res = await app.request(`/programs/${id}/runs`)
  return ((await res.json()) as { runs: TaskView[] }).runs
}
const ended = (t: TaskView | undefined) =>
  t !== undefined && t.status !== 'running' && t.status !== 'needs_action'
async function lastRun(app: Server['app'], id: string, count = 1): Promise<TaskView> {
  await until('the run ends', async () => {
    const list = await runs(app, id)
    return list.length >= count && ended(list[0])
  })
  return (await runs(app, id))[0] as TaskView
}

// --- the scripted auditor -----------------------------------------------------------------------

const PREFILTER = `
const GOOD = new Set(['github.com','developer.mozilla.org','www.typescriptlang.org','stackoverflow.com','docs.docker.com','news.ycombinator.com','en.wikipedia.org','youtu.be'])
const rows = readJsonlDir('/library/data/community/', '.jsonl')
rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
const flagged = new Map()
const flag = (r, why) => {
  const f = flagged.get(r.id) ?? { ...r, why: [] }
  if (!f.why.includes(why)) f.why.push(why)
  flagged.set(r.id, f)
}
const domain = (t) => { const m = /https?:\\/\\/([^\\s\\/?#]+)/i.exec(t ?? ''); return m ? m[1].toLowerCase() : null }
for (const r of rows) { const d = domain(r.text); if (d && !GOOD.has(d)) flag(r, 'link:' + d) }
const WINDOW = 5 * 60 * 1000
const burst = (list, min, why) => {
  for (let i = 0, j = 0; i < list.length; i++) {
    while (list[i].at - list[j].at > WINDOW) j++
    if (i - j + 1 >= min) for (let k = j; k <= i; k++) flag(list[k], why)
  }
}
const group = (kind, key) => {
  const m = new Map()
  for (const r of rows) if (r.kind === kind) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r) }
  return m
}
for (const list of group('message', 'author').values()) burst(list, 8, 'burst')
const joins = rows.filter((r) => r.kind === 'join')
burst(joins, 10, 'join-wave')
const waveAccounts = new Set(joins.filter((j) => flagged.has(j.id)).map((j) => j.author))
for (const r of rows) if (r.kind === 'message' && waveAccounts.has(r.author)) flag(r, 'post-after-join-wave')
const INSULT = /clueless|dumb|idiot|useless|get lost|because of you|quit|waste of space|deleting your/i
for (const r of rows) {
  if (r.kind === 'delete') flag(r, 'mod-delete')
  if (r.kind === 'admin') flag(r, 'admin:' + r.action)
  if (r.kind === 'message' && r.authorRole === 'mod' && INSULT.test(r.text ?? '')) flag(r, 'mod-insult')
}
const candidates = [...flagged.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
const chunks = chunkBySize(candidates, 6000)
chunks.forEach((c, i) => writeJsonl('/library/work/${RUN}/chunks/' + String(i + 1).padStart(3, '0') + '.jsonl', c))
const byKind = {}
for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
writeJson('/library/work/${RUN}/stats.json', { total: rows.length, byKind, flagged: candidates.length, chunks: chunks.length })
print({ total: rows.length, flagged: candidates.length, chunks: chunks.length })
`

const REDUCE = `
const files = list('/library/work/${RUN}/findings/').filter((p) => p.endsWith('.json'))
const all = files.flatMap((p) => readJson(p).findings.map((f) => ({ ...f, chunk: readJson(p).chunk })))
const bySeverity = {}
const byKind = {}
const actors = {}
for (const f of all) {
  bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1
  byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
  for (const a of f.actors) actors[a] = (actors[a] ?? 0) + f.evidence.length
}
writeJson('/library/work/${RUN}/merged.json', { chunks: files.length, findings: all })
const topActors = Object.entries(actors).sort((a, b) => b[1] - a[1]).slice(0, 6)
print({ chunks: files.length, findings: all.length, bySeverity, byKind, topActors, high: all.filter((f) => f.severity === 'high').map((f) => f.summary).slice(0, 12) })
`

interface BrainOptions {
  /** Die (throw) once this many chunks of THIS run are marked done. */
  dieAfterChunks?: number
  /** Chunks per manifest_next. */
  batch?: number
}

interface Brain {
  steps: ScriptedStepInput[]
  /** Chunk ids this run read with read_file, in order. */
  read: string[]
  /** Chunk ids this run marked done. */
  marked: string[]
  skillText: () => string
}

const text = (output: unknown): string => {
  const o = output as { type: string; value: unknown }
  return typeof o.value === 'string' ? o.value : JSON.stringify(o.value)
}

function lastResults(
  call: ScriptedCallOptions,
): Array<{ id: string; toolName: string; text: string }> {
  const msgs = call.prompt as Array<{ role: string; content: unknown }>
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role: string; content: Array<Record<string, unknown>> }
    if (m.role !== 'tool') continue
    return m.content
      .filter((p) => p.type === 'tool-result')
      .map((p) => ({
        id: String(p.toolCallId),
        toolName: String(p.toolName),
        text: text(p.output),
      }))
  }
  return []
}

/** What the scripted "model" concludes from the flagged items of one chunk. */
function judge(
  chunk: string,
  lines: string,
): { chunk: string; findings: unknown[]; notes: string } {
  const items = lines
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .filter((l) => l.startsWith('{'))
    .map(
      (l) =>
        JSON.parse(l) as Record<string, unknown> & { why: string[]; id: string; author: string },
    )
  const groups = new Map<string, typeof items>()
  const add = (key: string, item: (typeof items)[number]) => {
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  for (const it of items) {
    if (it.why.includes('mod-insult')) add(`moderator|high|${it.author}|insulted a member`, it)
    else if (it.why.includes('mod-delete'))
      add(`moderator|medium|${it.author}|deleted a member's messages`, it)
    else if (
      it.why.some((w) => w === 'admin:role_change') &&
      String(it.target).startsWith('newacct')
    )
      add(`admin|high|${it.author}|gave a role to a brand-new account (${String(it.target)})`, it)
    else if (it.why.includes('join-wave') || it.why.includes('post-after-join-wave'))
      add(`raid|high|${it.author.startsWith('newacct') ? 'newacct-wave' : it.author}|join raid`, it)
    else if (it.why.includes('burst')) add(`spam|high|${it.author}|burst posting`, it)
    else if (it.why.some((w) => w.startsWith('link:')))
      add(`link|medium|${it.author}|shared an unusual link`, it)
    else if (it.why.some((w) => w.startsWith('admin:')))
      add(`admin|low|${it.author}|admin action`, it)
  }
  const findings = [...groups.entries()].map(([key, list]) => {
    const [kind, severity, actor, summary] = key.split('|')
    return {
      severity,
      kind,
      summary: `${actor}: ${summary} (${list.length} items)`,
      evidence: list.map((i) => i.id),
      actors: [actor === 'newacct-wave' ? 'newacct-wave' : actor],
    }
  })
  return { chunk, findings, notes: '' }
}

function auditorBrain(options: BrainOptions = {}): Brain {
  const batchSize = options.batch ?? 3
  let phase = 'start'
  let batch: Array<{ id: string; path: string }> = []
  let judged: Array<{ id: string; json: unknown }> = []
  let skillText = ''
  const read: string[] = []
  const marked: string[] = []
  let n = 0
  const calls = (items: Array<{ toolName: string; input: unknown }>): ScriptedStep => {
    n++
    return { toolCalls: items.map((c, i) => ({ ...c, toolCallId: `c${n}-${i}` })) }
  }
  const next = (): ScriptedStep => {
    phase = 'next'
    return calls([{ toolName: 'manifest_next', input: { run: RUN, limit: batchSize } }])
  }

  const decide = (call: ScriptedCallOptions): ScriptedStep => {
    const results = lastResults(call)
    const first = results[0]?.text ?? ''
    switch (phase) {
      case 'start':
        phase = 'skill'
        return calls([{ toolName: 'load_skill', input: { name: 'chunked-audit' } }])
      case 'skill':
        skillText = first
        phase = 'status'
        return calls([{ toolName: 'manifest_status', input: { run: RUN } }])
      case 'status':
        if (first.startsWith('ERROR: no manifest')) {
          phase = 'prefiltered'
          return calls([
            {
              toolName: 'run_code',
              input: { code: PREFILTER, reads: ['/library/data/community/**/*.jsonl'] },
            },
          ])
        }
        return next()
      case 'prefiltered':
        phase = 'created'
        return calls([
          {
            toolName: 'manifest_create',
            input: { run: RUN, purpose: `audit ${DAY}`, fromFiles: `/library/work/${RUN}/chunks/` },
          },
        ])
      case 'created':
        return next()
      case 'next': {
        if (first.includes('Nothing left to process')) {
          phase = 'reduced'
          return calls([
            {
              toolName: 'run_code',
              input: { code: REDUCE, reads: [`/library/work/${RUN}/findings/`] },
            },
          ])
        }
        batch = [...first.matchAll(/^- (\S+).*\| files: (\S+?)(?:,|$)/gm)].map((m) => ({
          id: m[1] as string,
          path: m[2] as string,
        }))
        phase = 'read'
        return calls(batch.map((b) => ({ toolName: 'read_file', input: { path: b.path } })))
      }
      case 'read': {
        judged = batch.map((b, i) => {
          read.push(b.id)
          return { id: b.id, json: judge(b.id, results[i]?.text ?? '') }
        })
        phase = 'wrote'
        return calls(
          judged.map((j) => ({
            toolName: 'write_file',
            input: {
              path: `/library/work/${RUN}/findings/${j.id}.json`,
              content: JSON.stringify(j.json, null, 1),
            },
          })),
        )
      }
      case 'wrote':
        phase = 'marked'
        return calls(
          judged.map((j) => ({
            toolName: 'manifest_mark',
            input: { run: RUN, chunk: j.id, status: 'done' },
          })),
        )
      case 'marked':
        for (const j of judged) marked.push(j.id)
        if (options.dieAfterChunks !== undefined && marked.length >= options.dieAfterChunks) {
          return { throws: new Error('the process was killed') }
        }
        return next()
      case 'reduced': {
        const out = first.slice(first.indexOf('{'))
        const sum = JSON.parse(out.slice(0, out.lastIndexOf('}') + 1)) as {
          chunks: number
          findings: number
          bySeverity: Record<string, number>
          topActors: Array<[string, number]>
          high: string[]
        }
        phase = 'reported'
        return calls([
          {
            toolName: 'write_file',
            input: {
              path: `/library/reports/community/${DAY}.md`,
              content: [
                `# Community audit ${DAY}`,
                '',
                `Scanned 5000 items in ${sum.chunks} chunks of candidates; ${sum.findings} findings.`,
                `Severity: ${JSON.stringify(sum.bySeverity)}`,
                '',
                '## Needs attention',
                ...sum.topActors.map(([a, c]) => `- ${a}: ${c} items`),
                '',
                '## High severity',
                ...sum.high.map((h) => `- ${h}`),
              ].join('\n'),
            },
          },
        ])
      }
      case 'reported':
        phase = 'final'
        return calls([
          {
            toolName: 'final_answer',
            input: {
              status: 'done',
              summary: `Audited ${DAY}: 5000 items, chunked, report written.`,
              outputs: [`/library/reports/community/${DAY}.md`],
            },
          },
        ])
      default:
        throw new Error(`brain: unexpected phase ${phase}`)
    }
  }
  return {
    steps: Array.from({ length: 160 }, () => decide),
    read,
    marked,
    skillText: () => skillText,
  }
}

// --- measuring what the model saw ----------------------------------------------------------------

function seen(model: ScriptedModel) {
  const sizes = model.prompts.map((p) => JSON.stringify(p).length)
  let biggestResult = 0
  const ids = new Set<string>()
  for (const prompt of model.prompts) {
    for (const m of prompt as Array<{ role: string; content: unknown }>) {
      if (m.role !== 'tool') continue
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part.type !== 'tool-result') continue
        const t = text(part.output)
        biggestResult = Math.max(biggestResult, t.length)
        for (const id of t.matchAll(/"id":"(m\d{6})"/g)) ids.add(id[1] as string)
      }
    }
  }
  return {
    biggestPrompt: Math.max(...sizes),
    biggestResult,
    rawItemsSeen: ids.size,
    calls: sizes.length,
  }
}

const RAW_BYTES = JSON.stringify(fixture.items()).length

async function ingestDay(server: Server): Promise<void> {
  // the deterministic ingest step (what a scheduled job or an ingest program does): no model
  await ingestSource(libraryFs(server.conn.sqlite), fixture)
}

async function readLibrary(server: Server, path: string): Promise<string | undefined> {
  return (await libraryFs(server.conn.sqlite).read(path))?.content
}

// --- tests --------------------------------------------------------------------------------------

describe('community auditor on a 5 000-message day', () => {
  test('pre-filters with code, judges one chunk at a time, merges and reports; the model never sees the raw day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40d-'))
    dirs.push(dir)
    const brain = auditorBrain()
    const { server, app, models } = instance(dir, brain.steps)
    await server.connectorsReady
    ensureAuditor(server)
    await ingestDay(server)
    const program = await createProgram(app)
    await runNow(app, program.id)
    const run = await lastRun(app, program.id)
    expect(run.status).toBe('done')
    expect(run.report).toMatchObject({
      status: 'done',
      outputs: [`/library/reports/community/${DAY}.md`],
    })

    // the skill was loaded from the library by the run
    expect(brain.skillText()).toContain('manifest_status')
    expect(brain.skillText()).toContain('Never open the raw files')

    // the manifest: every chunk done, each with a saved findings file
    const manifest = JSON.parse(
      (await readLibrary(server, manifestPath(RUN))) as string,
    ) as Manifest
    expect(manifest.chunks.length).toBeGreaterThanOrEqual(6)
    expect(progressOf(manifest)).toMatchObject({ complete: true, done: manifest.chunks.length })
    for (const c of manifest.chunks) {
      expect(c.status).toBe('done')
      expect(await readLibrary(server, c.findings as string)).toBeDefined()
    }
    expect(brain.read).toEqual(manifest.chunks.map((c) => c.id)) // each chunk read exactly once

    // the merge found what was planted
    const stats = JSON.parse(
      (await readLibrary(server, `/library/work/${RUN}/stats.json`)) as string,
    )
    expect(stats.total).toBe(5000)
    expect(stats.flagged).toBeLessThan(500)
    const merged = JSON.parse(
      (await readLibrary(server, `/library/work/${RUN}/merged.json`)) as string,
    ) as {
      findings: Array<{ evidence: string[]; kind: string; severity: string }>
    }
    const evidence = new Set(merged.findings.flatMap((f) => f.evidence))
    const found = (ids: string[]) => ids.filter((id) => !evidence.has(id))
    for (const burst of truth.spamBursts) expect(found(burst.ids)).toEqual([])
    expect(found(truth.raid.postIds)).toEqual([])
    expect(found(truth.raid.joinIds)).toEqual([])
    expect(found(truth.modAbuse.bullyIds)).toEqual([])
    expect(found(truth.modAbuse.deleteIds)).toEqual([])
    expect(found(truth.shadyLinkIds)).toEqual([])
    expect(found([truth.suspiciousRoleChangeId])).toEqual([])
    // organic chatter is not accused: far fewer evidence items than messages
    expect(evidence.size).toBeLessThan(400)

    // one merged report
    const report = (await readLibrary(server, `/library/reports/community/${DAY}.md`)) as string
    expect(report).toContain('Scanned 5000 items')
    expect(report).toContain('mod_dave')
    expect(report).toContain('newacct_9f3a')
    expect(report).toContain('promo_')

    // the proof of chunking: the model saw a small fraction of the day, one small chunk at a time
    const s = seen(models.auditor as ScriptedModel)
    expect(RAW_BYTES).toBeGreaterThan(700_000)
    expect(s.biggestResult).toBeLessThan(16 * 1024)
    expect(s.biggestPrompt).toBeLessThan(RAW_BYTES / 4)
    expect(s.rawItemsSeen).toBeLessThan(500) // of 5 000
    expect(s.rawItemsSeen).toBeGreaterThan(100) // and it did read the candidates
    expect(s.calls).toBeGreaterThan(10)
  })

  test('a run that dies in the middle resumes from the manifest on a restarted instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40d-'))
    dirs.push(dir)

    // run 1 is killed after two batches (6 chunks)
    const first = auditorBrain({ dieAfterChunks: 6 })
    const a = instance(dir, first.steps)
    await a.server.connectorsReady
    ensureAuditor(a.server)
    await ingestDay(a.server)
    const program = await createProgram(a.app)
    await runNow(a.app, program.id)
    const run1 = await lastRun(a.app, program.id)
    expect(run1.status).not.toBe('done')
    expect(first.marked).toHaveLength(6)
    const partial = JSON.parse(
      (await readLibrary(a.server, manifestPath(RUN))) as string,
    ) as Manifest
    expect(progressOf(partial)).toMatchObject({ done: 6, complete: false })
    const total = partial.chunks.length
    expect(total).toBeGreaterThan(6)
    expect(await readLibrary(a.server, `/library/reports/community/${DAY}.md`)).toBeUndefined()
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    // the restarted instance runs the program again: same data, same manifest
    const second = auditorBrain()
    const b = instance(dir, second.steps)
    await b.server.connectorsReady
    await sleep(5)
    const before = (await runs(b.app, program.id)).length
    await runNow(b.app, program.id)
    const run2 = await lastRun(b.app, program.id, before + 1)
    expect(run2.status).toBe('done')

    // resumed: it read only the chunks that were not done, none twice
    expect(second.read).toEqual(partial.chunks.slice(6).map((c) => c.id))
    expect(new Set([...first.read, ...second.read]).size).toBe(total)
    expect(second.read.some((id) => first.read.includes(id))).toBe(false)
    // and it did not plan again (no second prefilter): the manifest has the same chunks
    const done = JSON.parse((await readLibrary(b.server, manifestPath(RUN))) as string) as Manifest
    expect(done.createdAt).toBe(partial.createdAt)
    expect(progressOf(done)).toMatchObject({ complete: true, done: total })
    expect(await readLibrary(b.server, `/library/reports/community/${DAY}.md`)).toContain(
      'mod_dave',
    )
    const prompts2 = JSON.stringify((b.models.auditor as ScriptedModel).prompts[0])
    expect(prompts2).toContain('Audit the community chat')
    const lastPrompt = (b.models.auditor as ScriptedModel).prompts.at(-1) as unknown as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    const codeCalls = lastPrompt
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.content)
      .filter((p) => p.type === 'tool-call' && p.toolName === 'run_code')
    expect(codeCalls).toHaveLength(1) // only the reduce: the day was not planned again
  })
})

// --- authority ----------------------------------------------------------------------------------

/** All tool results of a scripted model's last prompt, by tool name. */
function resultsOf(model: ScriptedModel): Array<{ toolName: string; text: string }> {
  const prompt = model.prompts.at(-1) as unknown as Array<{
    role: string
    content: Array<Record<string, unknown>>
  }>
  return prompt
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content)
    .filter((p) => p.type === 'tool-result')
    .map((p) => ({ toolName: String(p.toolName), text: text(p.output) }))
}

const finish = (summary: string): ScriptedStep => ({
  toolCalls: [{ toolName: 'final_answer', input: { status: 'done', summary, outputs: [] } }],
})

describe('the toolkit under a narrow authority', () => {
  test('run_code copies in only what the program may read and saves back only where it may write; manifests need write authority', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40d-'))
    dirs.push(dir)
    const steps: ScriptedStepInput[] = [
      {
        toolCalls: [
          {
            toolName: 'run_code',
            toolCallId: 'a1',
            input: {
              reads: ['/library/data/community/**/*.jsonl'],
              code: `
                const files = list('/library/data/community/')
                const channels = [...new Set(files.map((f) => f.split('/')[4]))]
                writeJson('/library/work/x/ok.json', { channels })
                writeText('/library/reports/nope.txt', 'outside')
                print({ files: files.length, channels })
              `,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: 'run_code',
            toolCallId: 'a2',
            input: {
              reads: ['/library/data/community/help/2026-10-11/09.jsonl'],
              code: 'print(1)',
            },
          },
          {
            toolName: 'manifest_create',
            toolCallId: 'a3',
            input: { run: 'r1', chunks: [{ id: 'c1' }] },
          },
          { toolName: 'ingest_source', toolCallId: 'a4', input: { source: 'community' } },
          { toolName: 'ingest_source', toolCallId: 'a5', input: { source: 'nope' } },
          {
            toolName: 'run_code',
            toolCallId: 'a6',
            input: { code: 'while (true) {}', timeoutSeconds: 1 },
          },
          { toolName: 'run_code', toolCallId: 'a7', input: { code: 'throw new Error("boom")' } },
        ],
      },
      finish('probed the authority'),
    ]
    const { server, app, models } = instance(dir, steps)
    await server.connectorsReady
    ensureAuditor(server)
    await ingestDay(server)
    const program = await createProgram(app, {
      authority: {
        connectors: ['bigdata'],
        read: ['/library/data/community/general/**'],
        write: ['/library/work/x/**'],
      },
    })
    await runNow(app, program.id)
    expect((await lastRun(app, program.id)).status).toBe('done')

    const results = resultsOf(models.auditor as ScriptedModel)
    const outputs = results.map((r) => r.text)
    // 1: only the general channel was readable; the rest was skipped and said so
    const first = outputs.find((t) => t.startsWith('Ran ok')) as string
    expect(first).toContain('"channels": [')
    expect(first).toContain('"general"')
    expect(first).not.toContain('"help"')
    expect(first).toMatch(/\d+ more matched files were skipped \(outside your read authority\)/)
    expect(first).toContain('/library/work/x/ok.json')
    expect(first).toContain('NOT saved: /library/reports/nope.txt (outside your write authority)')
    expect(await readLibrary(server, '/library/work/x/ok.json')).toContain('general')
    expect(await readLibrary(server, '/library/reports/nope.txt')).toBeUndefined()
    // an explicit path outside the authority is an error, not a silent skip
    expect(
      outputs.some((t) =>
        t.startsWith('ERROR: not granted to read: /library/data/community/help/'),
      ),
    ).toBe(true)
    // the manifest of run r1 would live in /library/work/r1/: not writable here
    expect(
      outputs.some((t) =>
        t.startsWith('ERROR: not granted to write /library/work/r1/manifest.json'),
      ),
    ).toBe(true)
    // ingest needs write authority on the source directory
    expect(
      outputs.some((t) => t.startsWith('ERROR: not granted to write /library/data/community/')),
    ).toBe(true)
    expect(
      outputs.some((t) => t.startsWith('ERROR: unknown source "nope". Available: community')),
    ).toBe(true)
    // a runaway program and a failing one: clear errors, nothing saved
    expect(outputs.some((t) => t.startsWith('ERROR: the code ran over its time limit'))).toBe(true)
    expect(
      outputs.some((t) => t.startsWith('ERROR: the code exited with code') && t.includes('boom')),
    ).toBe(true)
  })

  test('an ingest program pulls the source into the library under write authority, then has nothing new', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-p40d-'))
    dirs.push(dir)
    const steps: ScriptedStepInput[] = [
      {
        toolCalls: [
          {
            toolName: 'ingest_source',
            toolCallId: 'i1',
            input: { source: 'community', maxItems: 2000 },
          },
        ],
      },
      {
        toolCalls: [
          { toolName: 'ingest_source', toolCallId: 'i2', input: { source: 'community' } },
        ],
      },
      {
        toolCalls: [
          { toolName: 'ingest_source', toolCallId: 'i3', input: { source: 'community' } },
        ],
      },
      finish('ingested'),
    ]
    const { server, app, models } = instance(dir, steps)
    await server.connectorsReady
    ensureAuditor(server)
    const program = await createProgram(app, {
      name: 'Community ingest',
      authority: {
        tools: ['ingest_source'],
        connectors: [],
        read: [],
        write: ['/library/data/community/**'],
      },
    })
    await runNow(app, program.id)
    expect((await lastRun(app, program.id)).status).toBe('done')
    const out = resultsOf(models.auditor as ScriptedModel).map((r) => r.text)
    expect(out[0]).toContain('Ingested 2000 new items')
    expect(out[0]).toContain('call ingest_source again to continue')
    expect(out[1]).toContain('Ingested 3000 new items')
    expect(out[1]).toContain('nothing more for now')
    expect(out[2]).toContain('Nothing new from source community')
    const stored = await libraryFs(server.conn.sqlite).list('/library/data/community/')
    expect(stored.some((f) => f.path.endsWith('_cursor.json'))).toBe(true)
    expect(stored.filter((f) => f.path.endsWith('.jsonl')).length).toBeGreaterThan(50)
  })
})
