/**
 * Automatic retry of turns that failed with a transient error (`domain/turn-retry.ts`,
 * `infra/eh/turn-retry-service.ts`): classification, the retry of a program run, a routine run and
 * a decision hand-back turn, exhaustion with one bell notice, a non-retryable error, a restart
 * while a retry waits, cancellation by a new message and the manual Retry route. Scripted models.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APICallError } from 'ai'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import type { Decision } from '../src/domain/decisions.ts'
import type { Program } from '../src/domain/programs.ts'
import {
  classifyFailure,
  MAX_RETRY_ATTEMPTS,
  RETRY_DELAYS_MS,
  retryDelayMs,
  willRetryText,
} from '../src/domain/turn-retry.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  prefix = 'a'
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = {
  streams: { flushMs: 5, pollMs: 20 },
  inbox: { pollMs: 30 },
  abortPollMs: 40,
  modelMaxRetries: 0,
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

// a scripted instance numbers its calls per step: a restarted one gets its own prefix
let prefix = 'a'
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `${prefix}-${toolName}-${Math.random()}` }],
})
const done = (summary = 'done'): ScriptedStepInput =>
  call('final_answer', { status: 'done', summary, outputs: [] })
/** The provider fails the call the way a gateway can (a 502 `provider_unavailable`). */
const unavailable = (): ScriptedStepInput => ({
  throws: new APICallError({
    message: 'Upstream error from Sail Research: no capacity available for this model right now',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 502,
    isRetryable: true,
  }),
})
const rejected = (): ScriptedStepInput => ({
  throws: new APICallError({
    message: 'invalid request',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  }),
})

interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}
function instance(dir: string, script: Record<string, ScriptedStepInput[]>): Instance {
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
    instanceId: 'turn-retry-test',
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    // the test ticks by hand; every attempt is due at once
    turnRetry: { tickMs: 0, delayMs: () => 0 },
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher', 'writer']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def !== undefined) updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return { server, app: server.app, models }
}
function fresh(script: Record<string, ScriptedStepInput[]>): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-retry-'))
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
  status: string
  summary: string | null
  retry?: { attempt: number; max: number; nextAt: number } | null
  report: null | { status: string; summary: string }
}
const BASE = {
  agentId: 'researcher',
  name: 'Audit channel',
  brief: 'Write the audit into /library/reports/.',
  authority: { read: [], write: ['/library/reports/**'] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
async function startRun(app: Server['app']): Promise<{ program: Program; sessionId: string }> {
  const created = await app.request('/programs', json('POST', BASE))
  if (created.status !== 201) throw new Error(await created.text())
  const program = (await created.json()) as Program
  const res = await app.request(`/programs/${program.id}/run`, json('POST'))
  if (res.status !== 202) throw new Error(await res.text())
  return { program, sessionId: ((await res.json()) as { sessionId: string }).sessionId }
}
async function taskOf(app: Server['app'], sessionId: string): Promise<TaskView | undefined> {
  const list = (await (await app.request('/tasks?limit=100')).json()) as { tasks: TaskView[] }
  return list.tasks.find((t) => t.sessionId === sessionId)
}
const statusIs = (app: Server['app'], sessionId: string, status: string) => async () =>
  (await taskOf(app, sessionId))?.status === status
/** Tick the retry service until the retry has run and its turn ended. */
async function runRetries(server: Server): Promise<number> {
  const started = await server.turnRetry.tick(Date.now() + 1)
  await server.turnRetry.idle()
  return started
}
const notices = (server: Server) =>
  server.deps.notifications
    .list({ open: true, limit: 50 })
    .filter((n) => n.title.includes('automatic retries'))

describe('classification and policy', () => {
  const fail = (code: string, message: string) => ({ stop: 'error', error: { code, message } })
  test('transient failures are retried', () => {
    for (const message of [
      'Provider unavailable: Upstream error from Sail Research: no capacity available',
      'Rate limited: too many requests',
      'Provider unavailable: HTTP 503',
    ]) {
      expect(classifyFailure(fail('EH_PROVIDER', message))).toBe('transient')
    }
    expect(classifyFailure(fail('EH_LOCK_UNAVAILABLE', 'lock service down'))).toBe('transient')
    expect(classifyFailure(fail('EH_RUN_FAILED', 'fetch failed: ECONNRESET'))).toBe('transient')
    // "Unexpected error" could be a network reset or a bug: fewer attempts
    expect(classifyFailure(fail('EH_RUN_FAILED', 'Unexpected error (see server logs)'))).toBe(
      'unknown',
    )
  })
  test('aborts, budget stops, auth, bad requests, content filters and overflow are never retried', () => {
    expect(classifyFailure({ stop: 'aborted' })).toBeUndefined()
    expect(classifyFailure({ stop: 'cost-cap' })).toBeUndefined()
    expect(classifyFailure({ stop: 'complete' })).toBeUndefined()
    expect(
      classifyFailure({ stop: 'timeout', error: { code: 'EH_PROVIDER', message: 'timeout' } }),
    ).toBeUndefined()
    for (const [code, message] of [
      ['EH_PROVIDER_AUTH', 'Provider rejected the request: bad key.'],
      ['EH_PROVIDER', 'Provider rejected the request: invalid request'],
      ['EH_PROVIDER', 'Provider rejected the request: content policy violation'],
      ['EH_PROVIDER', 'Provider rejected the request: insufficient credit'],
      ['EH_CONTEXT_OVERFLOW', 'context too long'],
    ] as const) {
      expect(classifyFailure(fail(code, message))).toBeUndefined()
    }
  })
  test('four attempts at 30 s, 2 min, 10 min and 30 min, with jitter', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(4)
    expect([...RETRY_DELAYS_MS]).toEqual([30_000, 120_000, 600_000, 1_800_000])
    for (const [i, base] of RETRY_DELAYS_MS.entries()) {
      expect(retryDelayMs(i + 1, () => 0.5)).toBe(base)
      expect(retryDelayMs(i + 1, () => 0)).toBe(Math.round(base * 0.8))
      expect(retryDelayMs(i + 1, () => 0.999)).toBeLessThanOrEqual(Math.round(base * 1.2))
    }
    expect(willRetryText({ attempt: 2, max: 4, nextAt: Date.UTC(2026, 9, 15, 14, 5) })).toBe(
      'will retry at 14:05 UTC (attempt 2 of 4)',
    )
  })
})

describe('a failed run is retried', () => {
  test('a provider outage then success: retrying while it waits, done after', async () => {
    const { app, server, models } = fresh({
      researcher: [unavailable(), done('finished after the retry')],
    })
    const { sessionId } = await startRun(app)
    await until('the run waits for its retry', statusIs(app, sessionId, 'retrying'))
    const waiting = (await taskOf(app, sessionId)) as TaskView
    expect(waiting.retry).toMatchObject({ attempt: 1, max: 4 })
    expect(waiting.summary).toContain('Retrying (attempt 1 of 4)')
    expect(waiting.summary).toContain('no capacity available')
    expect(server.turnRetry.pending(sessionId)?.attempt).toBe(1)
    // a waiting retry is not a bell notice
    expect(notices(server)).toHaveLength(0)

    expect(await runRetries(server)).toBe(1)
    await until('the run is done', statusIs(app, sessionId, 'done'))
    const finished = (await taskOf(app, sessionId)) as TaskView
    expect(finished.report?.summary).toBe('finished after the retry')
    expect(server.turnRetry.pending(sessionId)).toBeUndefined()
    expect(models.researcher?.calls).toHaveLength(2)
    expect(notices(server)).toHaveLength(0)
  })

  test('a failure that keeps happening ends failed after the last attempt, with one bell notice', async () => {
    const { app, server } = fresh({
      researcher: [unavailable(), unavailable(), unavailable(), unavailable(), unavailable()],
    })
    const { sessionId } = await startRun(app)
    await until('waiting', statusIs(app, sessionId, 'retrying'))
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(server.turnRetry.pending(sessionId)?.attempt).toBe(attempt)
      expect(await runRetries(server)).toBe(1)
      if (attempt < 4) {
        await until(
          `attempt ${attempt + 1} waits`,
          async () =>
            server.turnRetry.pending(sessionId)?.attempt === attempt + 1 &&
            (await taskOf(app, sessionId))?.status === 'retrying',
        )
      }
    }
    await until('failed', statusIs(app, sessionId, 'failed'))
    const failed = (await taskOf(app, sessionId)) as TaskView
    expect(failed.retry ?? null).toBeNull()
    expect(failed.summary).toContain('4 automatic retries did not help')
    expect(server.turnRetry.pending(sessionId)).toBeUndefined()
    expect(server.turnRetry.gaveUp(sessionId)).toBe(true)
    // nothing more is started
    expect(await runRetries(server)).toBe(0)
    const rung = notices(server)
    expect(rung).toHaveLength(1)
    expect(rung[0]).toMatchObject({ link: `/tasks/${failed.id}` })
    expect(rung[0]?.title).toContain('failed after 4 automatic retries')
    expect(rung[0]?.body).toContain('Retry')
  })

  test('a request the provider rejects (400) is failed at once and never retried', async () => {
    const { app, server } = fresh({ researcher: [rejected(), done()] })
    const { sessionId } = await startRun(app)
    await until('failed', statusIs(app, sessionId, 'failed'))
    expect(server.turnRetry.pending(sessionId)).toBeUndefined()
    expect(server.turnRetry.gaveUp(sessionId)).toBe(false)
    expect(await runRetries(server)).toBe(0)
    expect(notices(server)).toHaveLength(0)
  })

  test('the Retry route continues a failed run by hand', async () => {
    const { app, server } = fresh({ researcher: [rejected(), done('continued by hand')] })
    const { sessionId } = await startRun(app)
    await until('failed', statusIs(app, sessionId, 'failed'))
    const task = (await taskOf(app, sessionId)) as TaskView
    const res = await app.request(`/tasks/${task.id}/retry`, json('POST'))
    expect(res.status).toBe(202)
    await server.turnRetry.idle()
    await until('done', statusIs(app, sessionId, 'done'))
    expect(((await taskOf(app, sessionId)) as TaskView).report?.summary).toBe('continued by hand')
    // a finished task cannot be retried
    expect((await app.request(`/tasks/${task.id}/retry`, json('POST'))).status).toBe(409)
    expect((await app.request('/tasks/nope/retry', json('POST'))).status).toBe(404)
  })

  test('Retry now on a waiting retry starts it at once and cancels the schedule', async () => {
    const { app, server } = fresh({ researcher: [unavailable(), done('by hand')] })
    const { sessionId } = await startRun(app)
    await until('waiting', statusIs(app, sessionId, 'retrying'))
    const task = (await taskOf(app, sessionId)) as TaskView
    expect((await app.request(`/tasks/${task.id}/retry`, json('POST'))).status).toBe(202)
    await server.turnRetry.idle()
    await until('done', statusIs(app, sessionId, 'done'))
    expect(await runRetries(server)).toBe(0)
  })
})

describe('restart and cancellation', () => {
  test('a retry that waits survives a restart and runs on the next instance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-retry-restart-'))
    dirs.push(dir)
    const a = instance(dir, { researcher: [unavailable()] })
    const { sessionId } = await startRun(a.app)
    await until('waiting', statusIs(a.app, sessionId, 'retrying'))
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    prefix = 'b'
    const b = instance(dir, { researcher: [done('after the restart')] })
    expect(b.server.turnRetry.pending(sessionId)?.attempt).toBe(1)
    expect((await taskOf(b.app, sessionId))?.status).toBe('retrying')
    expect(await runRetries(b.server)).toBe(1)
    await until('done', statusIs(b.app, sessionId, 'done'))
    expect(((await taskOf(b.app, sessionId)) as TaskView).report?.summary).toBe('after the restart')
  })

  test('a new message cancels the waiting retry (the message continues the session)', async () => {
    const { app, server } = fresh({
      researcher: [unavailable(), { text: 'answered the new message' }],
    })
    const { sessionId } = await startRun(app)
    await until('waiting', statusIs(app, sessionId, 'retrying'))
    const task = (await taskOf(app, sessionId)) as TaskView
    const sent = await app.request(
      `/tasks/${task.id}/messages`,
      json('POST', { text: 'Skip the old plan, just report.' }),
    )
    expect(sent.status).toBe(202)
    await until('done', statusIs(app, sessionId, 'done'))
    // the retry was cancelled by the new turn: nothing is due any more
    expect(server.turnRetry.pending(sessionId)).toBeUndefined()
    expect(await runRetries(server)).toBe(0)
  })

  test('a retry whose agent was archived is dropped and the task does not stay retrying', async () => {
    const { app, server } = fresh({ researcher: [unavailable(), done()] })
    const { sessionId } = await startRun(app)
    await until('waiting', statusIs(app, sessionId, 'retrying'))
    const def = server.deps.agents.getBySlug('researcher')
    server.conn.sqlite
      .query('UPDATE agents SET archived_at = ? WHERE id = ?')
      .run(Date.now(), def?.id ?? '')
    expect(await runRetries(server)).toBe(1)
    await until('failed', statusIs(app, sessionId, 'failed'))
    expect(((await taskOf(app, sessionId)) as TaskView).summary).toContain('Not retried')
    expect(server.turnRetry.pending(sessionId)).toBeUndefined()
  })
})

describe('the hand-back turn of a decision', () => {
  test('a provider outage after the client answered an escalation: the run ends done and the decision is carried out', async () => {
    const { app, server, models } = fresh({
      researcher: [
        call('escalate_wait', { title: 'Send the summary?', question: 'Send it to the owner?' }),
        // the hand-back turn: one tool runs, then the provider fails
        call('write_file', { path: '/library/reports/summary.md', content: 'the summary' }),
        unavailable(),
        // the retry continues from the stored state
        done('summary sent as decided'),
      ],
    })
    const { sessionId } = await startRun(app)
    let decision: Decision | undefined
    await until('an open escalation', async () => {
      const body = (await (await app.request('/decisions?status=open&kind=escalation')).json()) as {
        decisions: Decision[]
      }
      decision = body.decisions[0]
      return decision !== undefined
    })
    const answered = await app.request(
      `/decisions/${(decision as Decision).id}/approve`,
      json('POST', { note: 'send it' }),
    )
    expect(answered.status).toBe(200)
    await until('the run waits for its retry', statusIs(app, sessionId, 'retrying'))
    // the tool of the hand-back turn ran once, and the run is not failed
    expect(models.researcher?.calls).toHaveLength(3)
    expect((await taskOf(app, sessionId))?.retry).toMatchObject({ attempt: 1 })

    await runRetries(server)
    await until('done', statusIs(app, sessionId, 'done'))
    const finished = (await taskOf(app, sessionId)) as TaskView
    expect(finished.report?.summary).toBe('summary sent as decided')
    // nothing was done twice: the file tool was not called again, the model saw its result
    expect(models.researcher?.calls).toHaveLength(4)
    const last = JSON.stringify(models.researcher?.prompts.at(-1))
    expect(last).toContain('summary.md')
    expect(last).toContain('send it')
  })
})

describe('a routine run', () => {
  test('the run shows retrying, then succeeded after the retry', async () => {
    const { app, server } = fresh({
      researcher: [
        unavailable(),
        call('write_file', { path: '/library/reports/r.md', content: 'x' }),
        { text: 'all done' },
      ],
    })
    const created = await app.request(
      '/routines',
      json('POST', {
        agentId: 'researcher',
        name: 'Daily audit',
        prompt: 'Audit the channel.',
        sessionMode: 'task',
        schedule: { kind: 'every', everyMs: 3_600_000 },
      }),
    )
    const routine = (await created.json()) as { id: string }
    const res = await app.request(`/routines/${routine.id}/run`, { method: 'POST' })
    expect(res.status).toBe(202)
    const runs = async () =>
      (
        (await (await app.request(`/routines/${routine.id}/runs`)).json()) as {
          runs: Array<{ status: string; reason: string | null; sessionId: string }>
        }
      ).runs
    await until('the run is retrying', async () => (await runs())[0]?.status === 'retrying')
    expect((await runs())[0]?.reason).toContain('will retry at')
    await runRetries(server)
    await until('the run succeeded', async () => (await runs())[0]?.status === 'succeeded')
    const routineRow = (await (await app.request(`/routines/${routine.id}`)).json()) as {
      failures: number
    }
    expect(routineRow.failures).toBe(0)
  })
})
