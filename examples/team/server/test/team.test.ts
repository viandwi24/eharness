/**
 * Lead, role agents, tasks and approvals (plan M4) through `app.request()` with scripted models.
 * Every agent has its own scripted model (the definition's `model` names it), and two `compose()`
 * calls on one database file stand for two server instances: the first one parks the lead, the
 * second one answers, and everything completes there.
 */

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import type { Task } from '../src/domain/tasks.ts'
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

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 4000) {
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

/** One instance: a scripted model per agent slug, named by the definition's `model` field. */
function instance(
  dir: string,
  script: Script,
  options: { first?: boolean; reconcile?: boolean } = {},
): Instance {
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      // agents without a script exist (the roster builds them all) but must never be called
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
    reconcile: { onBoot: options.reconcile ?? !options.first, everyMs: 0 },
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

/** Run SQL on the database file between two instances (a "manual operator" edit). */
function sql(dir: string, statement: string): void {
  const db = new Database(join(dir, 'team.db'))
  db.run(statement)
  db.close()
}

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'team-m4-'))
  dirs.push(dir)
  return dir
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const userMessage = (text: string) => ({
  messages: [{ id: 'c', role: 'user', parts: [{ type: 'text', text }] }],
})

const delegate = (name: string, toolCallId: string, prompt = 'Remove /library/old.md') => ({
  toolName: 'agent',
  toolCallId,
  input: { subagent_type: 'researcher', description: 'Clean up', prompt, name },
})
const deleteOld = { toolName: 'delete_file', input: { path: '/library/old.md' } }

interface ApprovalItem {
  id: string
  kind: string
  sessionId: string
  parentSessionId: string | null
  agentId: string
  agentName: string
  taskId: string | null
  toolName: string
}
async function approvals(app: Server['app']): Promise<ApprovalItem[]> {
  const res = await app.request('/approvals')
  expect(res.status).toBe(200)
  return ((await res.json()) as { approvals: ApprovalItem[] }).approvals
}
async function tasks(app: Server['app'], query = ''): Promise<Task[]> {
  const res = await app.request(`/tasks${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { tasks: Task[] }).tasks
}
interface FeedEvent {
  seq: number
  type: string
  agentId: string | null
  sessionId: string | null
  payload: Record<string, unknown>
}
async function events(app: Server['app'], after = 0): Promise<FeedEvent[]> {
  const res = await app.request(`/events?after=${after}&limit=500`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { events: FeedEvent[] }).events
}
async function dmText(app: Server['app'], agent = 'lead'): Promise<string> {
  const res = await app.request(`/agents/${agent}/messages?limit=100`)
  return JSON.stringify(((await res.json()) as { messages: unknown[] }).messages)
}

/** Instance A parks the lead on a researcher that waits for approval of `delete_file`. */
async function parkLead(a: Instance): Promise<void> {
  await libraryFs(a.server.conn.sqlite).write('/library/old.md', 'old\n')
  const res = await a.app.request('/agents/lead/chat', post(userMessage('Clean up the library')))
  if (res.status !== 200) throw new Error(await res.clone().text())
  expect(res.status).toBe(200)
  await res.text()
}

describe('delegation with park', () => {
  test('approval listed, answered from a second instance; the child continues and the lead resumes', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }],
        researcher: [{ toolCalls: [deleteOld] }],
      },
      { first: true },
    )
    await parkLead(a)

    // the board: one task owned by the researcher, waiting for a person
    const waiting = await tasks(a.app, '?status=needs_action')
    expect(waiting).toHaveLength(1)
    const task = waiting[0] as Task
    expect(task.pendingKind).toBe('approval')
    expect(task.title).toBe('Remove /library/old.md')
    const researcher = a.server.deps.agents.getBySlug('researcher')
    const lead = a.server.deps.agents.getBySlug('lead')
    expect(task.agentId).toBe(researcher?.id as string)
    expect(task.parentSessionId).toBe(`dm:${lead?.id}`)
    expect(task.sessionId).toBe(`dm:${lead?.id}:agent:call-1`)

    // the second instance sees and answers it
    const b = instance(
      dir,
      {
        lead: [{ text: 'The researcher cleaned up.' }],
        researcher: [{ text: 'Done: handled old.md.' }],
      },
      {},
    )
    await b.server.ready
    const pending = await approvals(b.app)
    expect(pending).toHaveLength(1)
    const item = pending[0] as ApprovalItem
    expect(item).toMatchObject({
      kind: 'approval',
      toolName: 'delete_file',
      sessionId: task.sessionId,
      parentSessionId: `dm:${lead?.id}`,
      agentName: 'Researcher',
      taskId: task.id,
    })

    // GET /tasks/{id} carries the child transcript and what it waits for
    const detail = (await (await b.app.request(`/tasks/${task.id}`)).json()) as {
      task: Task
      messages: Array<{ role: string }>
      approvals: ApprovalItem[]
    }
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(detail.approvals.map((x) => x.id)).toEqual([item.id])

    const answered = await b.app.request(
      `/approvals/${item.id}`,
      post({ approved: true, note: 'go ahead, but be quick' }),
    )
    expect(answered.status).toBe(202)

    // child finishes on B, the lead's wait resolves and the lead's turn continues by itself
    await until('lead finished', async () =>
      (await dmText(b.app)).includes('The researcher cleaned up.'),
    )
    await until('task done', async () => (await tasks(b.app, '?status=done')).length === 1)
    const done = (await tasks(b.app))[0] as Task
    expect(done.status).toBe('done')
    expect(done.summary).toBe('Done: handled old.md.')
    expect(done.endedAt).not.toBeNull()
    expect(await approvals(b.app)).toEqual([])
    // the note reached the model after the tool result
    expect(JSON.stringify(b.models.researcher?.prompts)).toContain('go ahead, but be quick')

    // the same item is gone now
    const again = await b.app.request(`/approvals/${item.id}`, post({ approved: true }))
    expect(again.status).toBe(404)
    // wrong kind of body
    const feed = await events(b.app)
    const types = feed.map((e) => e.type)
    expect(types).toContain('approval-needed')
    expect(types).toContain('approval-decided')
    const statuses = feed
      .filter((e) => e.type === 'task-changed')
      .map((e) => `${e.payload.status}/${String(e.payload.pendingKind)}`)
    expect(statuses).toEqual(['running/null', 'needs_action/approval', 'running/null', 'done/null'])
    // seq is strictly increasing across both instances
    expect(feed.map((e) => e.seq)).toEqual([...feed.map((e) => e.seq)].sort((x, y) => x - y))
    // lead DM events: the user message and the assistant messages (parked, then final)
    const leadMessages = feed.filter(
      (e) => e.type === 'message-added' && e.agentId === (lead?.id as string),
    )
    expect(leadMessages.map((e) => e.payload.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(leadMessages[1]?.payload.preview).toBe('Waiting for a delegated task')
    expect(leadMessages[2]?.payload.preview).toBe('The researcher cleaned up.')

    // sessions of an agent: its DM and its tasks; the lead sees the delegation
    const leadSessions = (await (await b.app.request('/agents/lead/sessions')).json()) as {
      dm: { sessionId: string; unread: number; pending: number }
      tasks: Task[]
      delegated: Task[]
    }
    expect(leadSessions.dm.sessionId).toBe(`dm:${lead?.id}`)
    expect(leadSessions.dm.pending).toBe(0)
    expect(leadSessions.delegated.map((t) => t.id)).toEqual([task.id])
    const researcherSessions = (await (
      await b.app.request('/agents/researcher/sessions')
    ).json()) as {
      tasks: Task[]
    }
    expect(researcherSessions.tasks.map((t) => t.id)).toEqual([task.id])
  })

  test('sidebar data: last activity, preview and unread, cleared by POST /agents/{id}/read', async () => {
    const dir = tmp()
    const a = instance(dir, { lead: [{ text: 'Hello from the lead' }] }, { first: true })
    const before = (await (await a.app.request('/agents')).json()) as {
      agents: Array<{
        slug: string
        lastActivity: { lastMessageAt: number | null; unread: number; preview: string | null }
      }>
    }
    expect(before.agents.find((x) => x.slug === 'lead')?.lastActivity).toEqual({
      lastMessageAt: null,
      preview: null,
      unread: 0,
    })
    await (await a.app.request('/agents/lead/chat', post(userMessage('hi')))).text()
    const after = (await (await a.app.request('/agents')).json()) as typeof before
    const lead = after.agents.find((x) => x.slug === 'lead')
    expect(lead?.lastActivity.preview).toBe('Hello from the lead')
    expect(lead?.lastActivity.unread).toBe(1)
    expect(after.agents.find((x) => x.slug === 'writer')?.lastActivity.unread).toBe(0)

    const read = await a.app.request('/agents/lead/read', { method: 'POST' })
    expect(read.status).toBe(200)
    const cleared = (await (await a.app.request('/agents')).json()) as typeof before
    expect(cleared.agents.find((x) => x.slug === 'lead')?.lastActivity.unread).toBe(0)
    expect(cleared.agents.find((x) => x.slug === 'lead')?.lastActivity.preview).toBe(
      'Hello from the lead',
    )
    expect((await a.app.request('/agents/nobody/read', { method: 'POST' })).status).toBe(404)
  })

  test('send_message from the lead resumes a finished role agent; its report wakes the lead', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [
          { toolCalls: [delegate('cleaner', 'call-1', 'List the library')] },
          { text: 'First report received.' },
          {
            toolCalls: [
              {
                toolName: 'send_message',
                input: { to: 'cleaner', message: 'Also count the files.' },
              },
            ],
          },
          { text: 'Asked the cleaner to count.' },
          { text: 'The cleaner counted the files.' },
        ],
        researcher: [{ text: 'Listed: 0 files.' }, { text: 'Counted: 0 files.' }],
      },
      { first: true },
    )
    await (await a.app.request('/agents/lead/chat', post(userMessage('Check the library')))).text()
    await until('first report', async () =>
      (await dmText(a.app)).includes('First report received.'),
    )
    const [task] = await tasks(a.app)
    expect(task?.status).toBe('done')
    const doneAt = task?.endedAt

    await (
      await a.app.request('/agents/lead/chat', post(userMessage('Ask for a count too')))
    ).text()
    // the child ran a second turn on the SAME session; its report woke the lead
    await until('lead saw the report', async () =>
      (await dmText(a.app)).includes('The cleaner counted the files.'),
    )
    await until('task done again', async () => {
      const [t] = await tasks(a.app)
      return t?.status === 'done' && t.summary === 'Counted: 0 files.'
    })
    const all = await tasks(a.app)
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe(task?.id as string)
    expect(all[0]?.endedAt as number).toBeGreaterThanOrEqual(doneAt as number)
    const detail = (await (await a.app.request(`/tasks/${task?.id}`)).json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>
    }
    const users = detail.messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[1]?.parts[0]?.text).toContain('Also count the files.')
    expect(detail.messages.filter((m) => m.role === 'assistant')).toHaveLength(2)

    const feed = await events(a.app)
    const sent = feed.find((e) => e.type === 'agent-message')
    expect(sent?.payload).toMatchObject({
      from: 'lead',
      to: 'cleaner',
      preview: 'Also count the files.',
    })
    // task row went running again for the resumed turn
    const flips = feed.filter((e) => e.type === 'task-changed').map((e) => String(e.payload.status))
    expect(flips).toEqual(['running', 'done', 'running', 'done'])
  })

  test('restart: instance A is closed between park and answer; B answers and everything completes', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }],
        researcher: [{ toolCalls: [deleteOld] }],
      },
      { first: true },
    )
    await parkLead(a)
    expect(await tasks(a.app, '?status=needs_action')).toHaveLength(1)
    // "kill" A: nothing of the park lived only in its memory
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    const b = instance(
      dir,
      {
        lead: [{ text: 'Cleanup complete after the restart.' }],
        researcher: [{ text: 'Handled it.' }],
      },
      {},
    )
    await b.server.ready
    const report = await b.server.reconcile()
    // the child still waits for a person: nothing to resolve, nothing drifted
    expect(report.waits.every((w) => w.status === 'skipped')).toBe(true)
    expect(report.drift).toEqual([])
    const [item] = await approvals(b.app)
    expect(item?.toolName).toBe('delete_file')
    expect((await b.app.request(`/approvals/${item?.id}`, post({ approved: true }))).status).toBe(
      202,
    )
    await until('lead finished after restart', async () =>
      (await dmText(b.app)).includes('Cleanup complete after the restart.'),
    )
    expect((await tasks(b.app))[0]?.status).toBe('done')
  })

  test('crash gap: the child finished but its hook could not resolve the wait; reconcile heals it', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }],
        researcher: [{ toolCalls: [deleteOld] }],
      },
      { first: true },
    )
    await parkLead(a)
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    // instance B has no lead definition (archived), so the child's hook cannot reach the parent:
    // it answers and finishes the child, but the lead's wait stays parked ("died before resolveWait")
    sql(dir, "UPDATE agents SET archived_at = 1 WHERE slug = 'lead'")
    const raw = instance(dir, { researcher: [{ text: 'Handled it.' }] }, { reconcile: false })
    // answer through the child session only: the lead DM is never opened here, so no other path
    // (the lead's own reconcile on open) can resolve its wait either
    const [waiting] = await tasks(raw.app, '?status=needs_action')
    // (the id comes from the feed: listing all approvals would open the lead DM)
    const needed = (await events(raw.app)).find((e) => e.type === 'approval-needed')
    expect(needed?.payload.toolName).toBe('delete_file')
    await raw.app.request(
      `/approvals/${needed?.payload.id}`,
      post({ approved: true, sessionId: waiting?.sessionId }),
    )
    await until('child done', async () => (await tasks(raw.app))[0]?.status === 'done')
    await sleep(100)
    // (reading through the app would open the lead DM, whose own reconcile would heal the wait)
    const parked = raw.server.conn.sqlite
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM eh_messages WHERE session_id LIKE 'dm:%' AND session_id NOT LIKE '%:agent:%' AND role = 'assistant'",
      )
      .get()
    expect(parked?.n).toBe(1) // only the parked assistant message: the lead never continued
    await raw.server.close()
    servers.splice(servers.indexOf(raw.server), 1)

    // a healthy instance: boot reconcile resolves the wait from the child's stored result
    sql(dir, "UPDATE agents SET archived_at = NULL WHERE slug = 'lead'")
    const c = instance(dir, { lead: [{ text: 'Cleanup healed.' }] }, {})
    await c.server.ready
    const report = await c.server.reconcile()
    await until('lead resumed', async () => (await dmText(c.app)).includes('Cleanup healed.'))
    // the first pass (boot) may already have resolved it: either way a later pass finds nothing
    expect(report.waits.every((w) => w.status !== 'busy')).toBe(true)
    const again = await c.server.reconcile()
    expect(again.waits.filter((w) => w.status === 'resolved')).toEqual([])
  })

  test('drift pass: a task row left running by a crashed instance is repaired', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1', 'Say hi')] }, { text: 'ok' }],
        researcher: [{ text: 'hi' }],
      },
      { first: true },
    )
    await (await a.app.request('/agents/lead/chat', post(userMessage('go')))).text()
    await until('done', async () => (await tasks(a.app))[0]?.status === 'done')
    a.server.conn.sqlite.run("UPDATE tasks SET state = 'running', ended_at = NULL")
    expect((await tasks(a.app))[0]?.status).toBe('running')
    const report = await a.server.reconcile()
    expect(report.drift.map((d) => `${d.from}->${d.to}`)).toEqual(['running->done'])
    expect((await tasks(a.app))[0]?.status).toBe('done')
    const repaired = (await events(a.app)).filter((e) => e.payload.reason === 'reconcile')
    expect(repaired).toHaveLength(1)
  })

  test('denying with a reason lets the child carry on', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }, { text: 'It was not deleted.' }],
        researcher: [{ toolCalls: [deleteOld] }, { text: 'Skipped the delete as told.' }],
      },
      { first: true },
    )
    await parkLead(a)
    const [item] = await approvals(a.app)
    const res = await a.app.request(
      `/approvals/${item?.id}`,
      post({ approved: false, reason: 'Keep old.md' }),
    )
    expect(res.status).toBe(202)
    await until('lead finished', async () => (await dmText(a.app)).includes('It was not deleted.'))
    expect(JSON.stringify(a.models.researcher?.prompts)).toContain('Keep old.md')
    const denied = (await events(a.app)).find(
      (e) => e.type === 'approval-decided' && e.payload.approved === false,
    )
    expect(denied?.payload.actor).toBe('owner')
  })

  test('two parallel approvals are answered one by one, from two instances', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }],
        researcher: [
          {
            toolCalls: [
              deleteOld,
              { toolName: 'delete_file', input: { path: '/library/old2.md' } },
            ],
          },
        ],
      },
      { first: true },
    )
    await parkLead(a)
    const pending = await approvals(a.app)
    expect(pending).toHaveLength(2)
    expect((pending[0] as ApprovalItem & { answeredWaiting: number }).answeredWaiting).toBe(0)

    const b = instance(
      dir,
      {
        lead: [{ text: 'Both handled.' }],
        researcher: [{ text: 'Done with both.' }],
      },
      {},
    )
    await b.server.ready
    const first = await a.app.request(`/approvals/${pending[0]?.id}`, post({ approved: true }))
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({ status: 'recorded', remaining: 1 })
    // the answered one is hidden, the other shows how many wait for it
    const rest = (await approvals(b.app)) as Array<ApprovalItem & { answeredWaiting: number }>
    expect(rest.map((x) => x.id)).toEqual([pending[1]?.id as string])
    expect(rest[0]?.answeredWaiting).toBe(1)
    // answering the same one again is a no-op for the library but the item is gone from the list
    expect(
      (await b.app.request(`/approvals/${pending[0]?.id}`, post({ approved: true }))).status,
    ).toBe(404)

    const second = await b.app.request(`/approvals/${pending[1]?.id}`, post({ approved: false }))
    expect(second.status).toBe(202)
    expect(await second.json()).toMatchObject({ status: 'resumed', remaining: 0 })
    await until('lead finished', async () => (await dmText(b.app)).includes('Both handled.'))
    expect(await approvals(b.app)).toEqual([])
  })

  test("remember: 'session' grants the tool: the next call of it in the continuation asks nothing", async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }, { text: 'Grant used.' }],
        researcher: [
          { toolCalls: [deleteOld] },
          // the grant applies from the step after the continuation's first one
          { toolCalls: [{ toolName: 'read_file', input: { path: '/library/old.md' } }] },
          { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old2.md' } }] },
          { text: 'Both gone.' },
        ],
      },
      { first: true },
    )
    await parkLead(a)
    const [item] = await approvals(a.app)
    const res = await a.app.request(
      `/approvals/${item?.id}`,
      post({ approved: true, remember: 'session' }),
    )
    expect(res.status).toBe(202)
    await until('lead finished', async () => (await dmText(a.app)).includes('Grant used.'))
    expect(await approvals(a.app)).toEqual([])
    // a bad scope is rejected
    expect((await a.app.request('/approvals/x', post({ approved: true, remember: 'forever' }))).status).toBe(400)
  })

  test('answer validation: unknown id and wrong body kind', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [{ toolCalls: [delegate('cleaner', 'call-1')] }],
        researcher: [{ toolCalls: [deleteOld] }],
      },
      { first: true },
    )
    await parkLead(a)
    expect((await a.app.request('/approvals/nope', post({ approved: true }))).status).toBe(404)
    const [item] = await approvals(a.app)
    const wrong = await a.app.request(`/approvals/${item?.id}`, post({ answers: null }))
    expect(wrong.status).toBe(400)
    const tooLong = await a.app.request(
      `/approvals/${item?.id}`,
      post({ approved: true, note: 'x'.repeat(4001) }),
    )
    expect(tooLong.status).toBe(400)
    expect((await a.app.request('/tasks/nope')).status).toBe(404)
    expect((await a.app.request('/tasks?status=bogus')).status).toBe(400)
  })
})

describe('questions', () => {
  test('a question of the lead DM is listed and answered through /approvals', async () => {
    const dir = tmp()
    const a = instance(
      dir,
      {
        lead: [
          {
            toolCalls: [
              {
                toolName: 'ask_user_question',
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
              },
            ],
          },
          { text: 'Going with Markdown.' },
        ],
      },
      { first: true },
    )
    await (await a.app.request('/agents/lead/chat', post(userMessage('Write the report')))).text()
    const [item] = await approvals(a.app)
    expect(item).toMatchObject({
      kind: 'question',
      toolName: 'ask_user_question',
      parentSessionId: null,
    })
    const lead = a.server.deps.agents.getBySlug('lead')
    expect(item?.sessionId).toBe(`dm:${lead?.id}`)
    // an approval body does not fit a question
    expect((await a.app.request(`/approvals/${item?.id}`, post({ approved: true }))).status).toBe(
      400,
    )
    const res = await a.app.request(
      `/approvals/${item?.id}`,
      post({ answers: [{ selected: ['Markdown'] }] }),
    )
    expect(res.status).toBe(202)
    await until('lead continued', async () =>
      (await dmText(a.app)).includes('Going with Markdown.'),
    )
    expect(JSON.stringify(a.models.lead?.prompts)).toContain('Format: Markdown')
    expect(await approvals(a.app)).toEqual([])
  })
})

describe('events feed', () => {
  test('SSE on instance B carries what instance A did', async () => {
    const dir = tmp()
    const a = instance(dir, { lead: [{ text: 'Streamed hello' }] }, { first: true })
    const b = instance(dir, {}, {})
    await b.server.ready

    const res = await b.app.request('/events/stream')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const read = async (until: (t: string) => boolean): Promise<void> => {
      const end = Date.now() + 8000
      while (!until(text) && Date.now() < end) {
        const chunk = await Promise.race([reader.read(), sleep(200).then(() => undefined)])
        if (chunk !== undefined && !chunk.done) text += decoder.decode(chunk.value)
      }
    }
    await (await a.app.request('/agents/lead/chat', post(userMessage('hello')))).text()
    await read((t) => t.includes('Streamed hello'))
    await reader.cancel()
    expect(text).toContain('event: message-added')
    expect(text).toMatch(/\nid: \d+\n/)
    expect(text).toContain('Streamed hello')

    // `after` replays from a cursor
    const replay = await events(b.app, 0)
    expect(replay.length).toBeGreaterThanOrEqual(2)
    const tail = await events(b.app, replay[0]?.seq as number)
    expect(tail.map((e) => e.seq)).toEqual(replay.slice(1).map((e) => e.seq))
  })
})
