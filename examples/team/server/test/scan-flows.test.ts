/**
 * Flows of the chat that were not covered end to end: new input while an approval is pending,
 * a dismissed question, provider errors surfacing as a stopped turn with a code.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { attn } from './support/attention.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function single(steps: ScriptedStepInput[]) {
  const dir = mkdtempSync(join(tmpdir(), 'team-scan-'))
  dirs.push(dir)
  const model = scriptedModel(steps)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: scriptedModelConfig(model as never),
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 40 }, abortPollMs: 40 },
  })
  servers.push(server)
  return { server, app: server.app, model }
}

type Stored = {
  id: string
  role: string
  parts: Array<Record<string, unknown>>
  metadata?: {
    eharness?: { stop?: string; pending?: unknown; kind?: string; error?: { code?: string } }
  }
}
async function messages(app: Server['app']): Promise<Stored[]> {
  const res = await app.request('/sessions/dm:researcher/messages')
  return ((await res.json()) as { messages: Stored[] }).messages
}
const send = (app: Server['app'], text: string) =>
  app.request('/sessions/dm:researcher/chat', postAs('dm:researcher', userMessage(text)))

type Approval = { id: string; sessionId: string; kind: string }
async function approvals(app: Server['app']): Promise<Approval[]> {
  const res = await app.request('/approvals')
  return ((await res.json()) as { approvals: Approval[] }).approvals
}

describe('new input while an approval is pending', () => {
  test("onNewInput 'deny': the call is denied, the queue empties, a stale answer is a quiet 409", async () => {
    const a = single([
      { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old.txt' } }] },
      { text: 'Okay, leaving it.' },
    ])
    await libraryFs(a.server.conn.sqlite).write('/library/old.txt', 'old')
    await (await send(a.app, 'delete the old file')).text()
    const waiting = await approvals(a.app)
    expect(waiting).toHaveLength(1)
    const item = waiting[0] as Approval

    const res = await send(a.app, 'never mind')
    expect(res.status).toBe(200)
    await res.text()

    expect(await libraryFs(a.server.conn.sqlite).read('/library/old.txt')).not.toBeNull()
    expect(await approvals(a.app)).toHaveLength(0)
    const all = await messages(a.app)
    const first = all.find((m) => m.role === 'assistant') as Stored
    const part = first.parts.find((p) => p.type === 'tool-delete_file') as Record<string, unknown>
    expect(part.state).toBe('output-denied')
    expect((part.approval as { approved: boolean }).approved).toBe(false)
    expect(first.metadata?.eharness?.pending ?? null).toBeNull()

    const stale = await attn(a.app, item, { approved: true })
    expect([200, 404, 409]).toContain(stale.status)
    expect(await libraryFs(a.server.conn.sqlite).read('/library/old.txt')).not.toBeNull()
    const stats = (await (await a.app.request('/agents/researcher/stats')).json()) as {
      pending: unknown
      running: boolean
    }
    expect(stats.pending).toBeNull()
    expect(stats.running).toBe(false)
  })
})

describe('errors surface as a stopped turn', () => {
  test('a provider auth failure ends the turn with stop error and a code, stored and idle', async () => {
    const err = Object.assign(new Error('Incorrect API key provided'), { statusCode: 401 })
    const a = single([{ throws: err }, { text: 'ok' }])
    const res = await send(a.app, 'hello')
    const text = await res.text()
    expect(text).toContain('"type":"error"')
    const all = await messages(a.app)
    const last = all.findLast(
      (m) => m.role === 'assistant' && m.metadata?.eharness?.kind === undefined,
    ) as Stored
    expect(last.metadata?.eharness?.stop).toBe('error')
    expect(last.metadata?.eharness?.error?.code).toBe('EH_PROVIDER_AUTH')
    const stats = (await (await a.app.request('/agents/researcher/stats')).json()) as {
      running: boolean
      activeTurn: unknown
    }
    expect(stats.running).toBe(false)
    expect(stats.activeTurn).toBeNull()
    // the chat is usable again
    const again = await send(a.app, 'again')
    expect(again.status).toBe(200)
    await again.text()
  })
})

describe('a message to a delegated task that waits for approval', () => {
  test('the message is held behind the approval (never denies it), runs after the answer, and the task ends done', async () => {
    const { updateAgent } = await import('../src/app/agents.ts')
    const dir = mkdtempSync(join(tmpdir(), 'team-scan-task-'))
    dirs.push(dir)
    const models: Record<string, ReturnType<typeof scriptedModel>> = {
      lead: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'agent',
              toolCallId: 'call-1',
              input: {
                subagent_type: 'researcher',
                description: 'Clean up',
                prompt: 'Remove it',
                name: 'cleaner',
              },
            },
          ],
        },
        { text: 'Delegated.' },
        { text: 'Noted the report.' },
        { text: 'Noted the second report.' },
      ]),
      researcher: scriptedModel([
        { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old.md' } }] },
        { text: 'Not deleted.' },
        { text: 'Understood, I leave it alone.' },
      ]),
    }
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: {
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
          return model as never
        },
      },
      tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
      reconcile: { onBoot: false, everyMs: 0 },
    })
    servers.push(server)
    for (const slug of ['lead', 'researcher']) {
      const def = server.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(server.deps, def.id, { model: `m-${slug}` })
    }
    const app = server.app
    await libraryFs(server.conn.sqlite).write('/library/old.md', 'old\n')
    const first = await app.request(
      '/sessions/dm:lead/chat',
      postAs('dm:lead', userMessage('Clean up')),
    )
    expect(first.status).toBe(200)
    await first.text()
    const until = async (what: string, cond: () => Promise<boolean>) => {
      const end = Date.now() + 5000
      while (!(await cond())) {
        if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
        await new Promise((r) => setTimeout(r, 15))
      }
    }
    type T = { id: string; sessionId: string; status: string }
    const tasks = async (): Promise<T[]> =>
      ((await (await app.request('/tasks')).json()) as { tasks: T[] }).tasks
    await until('task waits', async () => (await tasks()).some((t) => t.status === 'needs_action'))
    const task = (await tasks())[0] as T
    const sent = await app.request(`/tasks/${task.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Never mind, leave it.' }),
    })
    expect(sent.status).toBe(202)
    // held: the approval is still there and the task still needs the person
    await new Promise((r) => setTimeout(r, 300))
    expect((await tasks())[0]?.status).toBe('needs_action')
    const items = await approvals(app)
    expect(items).toHaveLength(1)

    const answered = await attn(app, items[0], { approved: false, reason: 'no' })
    expect(answered.status).toBe(200)
    // the queued message runs after the answer: the child's third scripted reply
    await until('the held message ran', async () => models.researcher?.prompts.length === 3)
    await until('task done', async () => (await tasks()).some((t) => t.status === 'done'))
    expect(await approvals(app)).toHaveLength(0)
    expect(await libraryFs(server.conn.sqlite).read('/library/old.md')).not.toBeNull()
    const childText = JSON.stringify(await server.factory.peek(task.sessionId).messages())
    expect(childText).toContain('Never mind, leave it.')
    expect(childText).toContain('Understood, I leave it alone.')
  }, 20_000)
})
