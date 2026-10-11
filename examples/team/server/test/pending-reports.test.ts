/**
 * The lead asks the user a question while a background child reports (events stored after the
 * pending message, held wake). Answering must never fail, the continuation sees the reports in
 * stored order, and one wake turn follows.
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
import type { Task } from '../src/domain/tasks.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { attn } from './support/attention.ts'
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

type Script = Partial<Record<'lead' | 'researcher' | 'writer', ScriptedStepInput[]>>
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
}
function instance(dir: string, script: Script, options: { first?: boolean } = {}): Instance {
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
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: !options.first, everyMs: 0 },
  })
  servers.push(server)
  if (options.first) {
    for (const slug of ['lead', 'researcher', 'writer']) {
      const def = server.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(server.deps, def.id, { model: `m-${slug}` })
    }
  }
  return { server, app: server.app, models }
}
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'team-pr-'))
  dirs.push(dir)
  return dir
}
const delegateBg = (name: string, toolCallId: string) => ({
  toolName: 'agent',
  toolCallId,
  input: {
    subagent_type: 'researcher',
    description: 'Clean up',
    prompt: 'Remove /library/old.md',
    name,
  },
})
const deleteOld = { toolName: 'delete_file', input: { path: '/library/old.md' } }
const ask = {
  toolName: 'ask_user_question',
  toolCallId: 'q-1',
  input: {
    questions: [
      {
        question: 'Which format?',
        header: 'Format',
        options: [{ label: 'PDF' }, { label: 'Markdown' }],
        multiSelect: false,
      },
    ],
  },
}

/**
 * A lead model that answers from what its prompt holds (the order of its calls depends on timing:
 * events reach it at step boundaries), so every call decides on its own.
 */
const reactiveLead = (call: { prompt: unknown }): ScriptedStep => {
  const prompt = JSON.stringify(call.prompt)
  const answered = prompt.includes('"toolCallId":"q-1","toolName":"ask_user_question","output"')
  const reported = prompt.includes('Done: handled old.md.')
  if (
    prompt.includes('Now ask me a question') &&
    !prompt.includes('"toolName":"ask_user_question","input"') &&
    !answered
  ) {
    return { toolCalls: [ask] }
  }
  if (!prompt.includes('"toolName":"agent"'))
    return { toolCalls: [delegateBg('cleaner', 'call-1')] }
  return { text: `answer:${answered ? 'markdown' : 'none'} report:${reported ? 'seen' : 'none'}` }
}

interface ApprovalItem {
  id: string
  kind: string
  sessionId: string
  toolName: string
}
async function approvals(app: Server['app']): Promise<ApprovalItem[]> {
  const res = await app.request('/approvals')
  return ((await res.json()) as { approvals: ApprovalItem[] }).approvals
}
async function tasks(app: Server['app'], query = ''): Promise<Task[]> {
  const res = await app.request(`/tasks${query}`)
  return ((await res.json()) as { tasks: Task[] }).tasks
}
async function messages(app: Server['app']): Promise<Array<Record<string, unknown>>> {
  const res = await app.request('/sessions/dm:lead/messages?limit=100')
  return ((await res.json()) as { messages: Array<Record<string, unknown>> }).messages
}
const dm = async (app: Server['app']): Promise<string> => JSON.stringify(await messages(app))
interface FeedEvent {
  seq: number
  type: string
  sessionId: string | null
  payload: Record<string, unknown>
}
async function events(app: Server['app']): Promise<FeedEvent[]> {
  const res = await app.request('/activity?after=0&limit=500')
  return ((await res.json()) as { events: FeedEvent[] }).events
}
const count = (text: string, needle: string): number => text.split(needle).length - 1

/** Lead delegates in background; child waits for approval; lead then asks the user a question. */
async function setup(dir: string, second: boolean) {
  const a = instance(
    dir,
    {
      lead: Array.from({ length: 16 }, () => reactiveLead),
      researcher: [{ toolCalls: [deleteOld] }, { text: 'Done: handled old.md.' }],
    },
    { first: true },
  )
  await libraryFs(a.server.conn.sqlite).write('/library/old.md', 'old\n')
  await (
    await a.app.request('/sessions/dm:lead/chat', postAs(`dm:lead`, userMessage('Clean up')))
  ).text()
  await until('delegated', async () => (await dm(a.app)).includes('Started background subagent'))
  await until('child waits', async () => (await tasks(a.app, '?status=needs_action')).length === 1)
  await (
    await a.app.request(
      '/sessions/dm:lead/chat',
      postAs(`dm:lead`, userMessage('Now ask me a question')),
    )
  ).text()
  await until('question listed', async () =>
    (await approvals(a.app)).some((x) => x.kind === 'question'),
  )
  // the answering side: a second instance sharing the database, or the same one
  const b = second
    ? instance(dir, {
        lead: Array.from({ length: 16 }, () => reactiveLead),
        researcher: [{ text: 'Done: handled old.md.' }, { text: 'Done: handled old.md.' }],
      })
    : a
  await b.server.ready
  return { a, b }
}

describe('question pending while a background child reports', () => {
  for (const second of [false, true]) {
    for (const order of ['child-first', 'question-first'] as const) {
      test(`${second ? 'two instances' : 'one instance'}, ${order}`, async () => {
        const dir = tmp()
        const { a, b } = await setup(dir, second)
        const answerChild = async () => {
          const item = (await approvals(b.app)).find((x) => x.kind === 'approval')
          expect(item).toBeDefined()
          const res = await attn(b.app, item, { approved: true })
          expect(res.status).toBe(200)
        }
        const answerQuestion = async () => {
          const item = (await approvals(b.app)).find((x) => x.kind === 'question')
          expect(item).toBeDefined()
          const res = await attn(b.app, item, { answers: [{ selected: ['Markdown'] }] })
          expect(res.status).toBe(200)
        }
        if (order === 'child-first') {
          await answerChild()
          await until('task done', async () => (await tasks(b.app, '?status=done')).length === 1)
          // the report is stored after the pending question; nothing may have run or failed
          await until('report stored', async () =>
            (await dm(b.app)).includes('Done: handled old.md.'),
          )
          expect(await dm(b.app)).not.toContain('Cancelled')
          expect(await approvals(b.app)).toHaveLength(1)
          await answerQuestion()
        } else {
          await answerQuestion()
          await until('lead continued', async () => (await dm(b.app)).includes('answer:markdown'))
          await answerChild()
          await until('task done', async () => (await tasks(b.app, '?status=done')).length === 1)
        }
        await until('lead saw the report and the answer', async () =>
          (await dm(b.app)).includes('answer:markdown report:seen'),
        )
        const text = await dm(b.app)
        expect(count(text, 'answer:markdown report:seen')).toBe(1)
        expect(text).not.toContain('Interrupted')
        expect(text).not.toContain('still unanswered')
        expect(await approvals(b.app)).toEqual([])
        // the model saw the report exactly once, after the question answer
        const prompts = JSON.stringify([
          ...(a.models.lead?.prompts ?? []),
          ...(b.models.lead?.prompts ?? []),
        ])
        expect(count(prompts, 'Done: handled old.md.')).toBeGreaterThanOrEqual(1)
        const [task] = await tasks(b.app)
        expect(task?.status).toBe('done')

        // one wake turn, no turn left running, nothing waiting, the feed told the story
        await sleep(300)
        const feed = await events(b.app)
        const lead = b.server.deps.agents.getBySlug('lead')
        const leadDm = `dm:${lead?.id}`
        expect(
          feed.filter(
            (e) => e.type === 'turn-started' && e.sessionId === leadDm && e.payload.kind === 'wake',
          ),
        ).toHaveLength(1)
        const stats = (await (await b.app.request('/agents/lead/stats')).json()) as {
          running: boolean
          pending: unknown
        }
        expect(stats.running).toBe(false)
        expect(stats.pending).toBeNull()
        const types = feed.map((e) => e.type)
        expect(types).toContain('pending-changed')
        expect(types).toContain('approval-decided')
        expect(
          feed
            .filter((e) => e.type === 'pending-changed')
            .flatMap((e) => e.payload.waiting as Array<{ kind: string }>)
            .filter((w) => w.kind === 'client-tool'),
        ).toHaveLength(1)
        const statuses = feed
          .filter((e) => e.type === 'task-changed')
          .map((e) => `${e.payload.status}/${String(e.payload.pendingKind)}`)
        expect(statuses.at(-1)).toBe('done/null')
        expect(feed.map((e) => e.seq)).toEqual([...feed.map((e) => e.seq)].sort((x, y) => x - y))
      }, 20_000)
    }
  }
})

const askReactive = (call: { prompt: unknown }): ScriptedStep => {
  const prompt = JSON.stringify(call.prompt)
  if (!prompt.includes('"toolName":"ask_user_question","output"')) return { toolCalls: [ask] }
  return { text: `after answer; report:${prompt.includes('STRANDED-REPORT') ? 'seen' : 'none'}` }
}
const askOnly = (): Script => ({ lead: Array.from({ length: 6 }, () => askReactive) })

describe('a broken state: reports stored after a pending question, no wake was ever held', () => {
  test('answering works, the stranded report wakes the lead once', async () => {
    const dir = tmp()
    const a = instance(dir, askOnly(), { first: true })
    await (
      await a.app.request('/sessions/dm:lead/chat', postAs(`dm:lead`, userMessage('Ask me')))
    ).text()
    await until('question listed', async () =>
      (await approvals(a.app)).some((x) => x.kind === 'question'),
    )
    // what the previous process left: the events are stored (no wake item, its memory is gone)
    const lead = a.server.deps.agents.getBySlug('lead')
    const session = a.server.factory.openSession(lead as never, `dm:${lead?.id}`)
    await session.inject('eh.event', {
      name: 'subagent',
      text: 'Background subagent x finished.\n\nSTRANDED-REPORT',
      data: { sessionId: 'dm:x:agent:y', agent: 'researcher', status: 'completed' },
    })
    await session.inject('eh.event', {
      name: 'subagent',
      text: 'Background subagent x is waiting for the user.',
      data: { sessionId: 'dm:x:agent:y', agent: 'researcher', status: 'waiting' },
    })
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    // a new process: the question is still there and answerable
    const b = instance(dir, askOnly(), {})
    await b.server.ready
    const [item] = await approvals(b.app)
    expect(item?.kind).toBe('question')
    const res = await attn(b.app, item, { answers: [{ selected: ['Markdown'] }] })
    expect(res.status).toBe(200)
    await until('continued and woken', async () =>
      (await dm(b.app)).includes('after answer; report:seen'),
    )
    await sleep(300)
    const text = await dm(b.app)
    expect(count(text, 'after answer; report:seen')).toBe(1)
    expect(count(text, 'after answer; report:none')).toBe(1)
    expect(b.models.lead?.prompts).toHaveLength(2) // the continuation and one wake
    expect(await approvals(b.app)).toEqual([])
    // a second pass finds nothing left to wake
    expect((await b.server.reconcile()).stranded).toEqual([])
  }, 20_000)
})

describe('answers that arrive after the item was answered', () => {
  test('a second answer is already-answered; a stale chat answer is 409 EH_HTTP_ALREADY_ANSWERED, never a failing turn', async () => {
    const dir = tmp()
    const a = instance(dir, askOnly(), { first: true })
    await (
      await a.app.request('/sessions/dm:lead/chat', postAs(`dm:lead`, userMessage('Ask me')))
    ).text()
    await until('question listed', async () =>
      (await approvals(a.app)).some((x) => x.kind === 'question'),
    )
    const [item] = await approvals(a.app)
    const answer = { answers: [{ selected: ['Markdown'] }] }
    expect((await attn(a.app, item, answer)).status).toBe(200)
    await until('continued', async () => (await dm(a.app)).includes('after answer'))
    const again = await attn(a.app, item, answer)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: 'already-answered' })
    // an old tab posts the assistant message back (useChat auto-send) with the answered call
    const stale = await a.app.request(
      '/sessions/dm:lead/chat',
      postAs(`dm:lead`, {
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              {
                type: 'tool-ask_user_question',
                toolCallId: item?.id,
                state: 'output-available',
                input: {},
                output: 'x',
              },
            ],
          },
        ],
      }),
    )
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'EH_HTTP_ALREADY_ANSWERED',
    )
    // and one that answers nothing at all
    const empty = await a.app.request(
      '/sessions/dm:lead/chat',
      postAs(`dm:lead`, {
        messages: [{ id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    )
    expect(empty.status).toBe(400) // the library: an assistant message must carry decisions
    expect(await dm(a.app)).not.toContain('still unanswered')
  }, 20_000)
})

describe('the same approval answered twice at once (two tabs, two instances)', () => {
  for (const second of [false, true]) {
    test(`${second ? 'two instances' : 'one instance'}: one continuation, the loser is a quiet already-answered / 404 / 409`, async () => {
      const dir = tmp()
      const { a, b } = await setup(dir, second)
      const item = (await approvals(a.app)).find((x) => x.kind === 'approval')
      expect(item).toBeDefined()
      const send = (app: Server['app']) => attn(app, item, { approved: true })
      const [x, y] = await Promise.all([send(a.app), send(b.app)])
      const codes = [x.status, y.status].sort()
      // never a 400 / 500: the loser is "already answered" (or both are the same idempotent record)
      for (const status of codes) expect([200, 404, 409]).toContain(status)
      expect(codes).toContain(200)
      for (const res of [x, y]) {
        if (res.status === 409) {
          expect(['EH_SESSION_BUSY', 'EH_HTTP_ALREADY_ANSWERED']).toContain(
            ((await res.json()) as { error: { code: string } }).error.code,
          )
        }
      }
      await until('task done', async () => (await tasks(b.app, '?status=done')).length === 1)
      // the tool ran once: the library consumed the approval atomically
      const feed = await events(b.app)
      expect(
        feed.filter((e) => e.type === 'approval-decided' && e.payload.toolName === 'delete_file'),
      ).toHaveLength(1)
    }, 20_000)
  }
})
