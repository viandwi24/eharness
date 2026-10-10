/**
 * Permission modes (Manual / Auto / Bypass) through `app.request()` with scripted models:
 * the API, a switch taking effect on the next tool call, children inheriting the delegating
 * chat's mode (and stricter agents staying stricter), and Auto with a mock classifier.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import type { AutoClassifier } from 'eharness/permissions'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { type ModelConfig, scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }

/** The scripted models of the last `start()`, by agent slug. */
let models: Record<string, ReturnType<typeof scriptedModel>> = {}

/** One scripted model per agent slug, named by the definition's `model` field (`m-<slug>`). */
function start(
  script: Partial<Record<'lead' | 'researcher', ScriptedStepInput[]>>,
  options: { classifier?: AutoClassifier } = {},
): Server {
  models = Object.fromEntries(
    Object.entries(script).map(([slug, steps]) => [slug, scriptedModel(steps)]),
  )
  const config: ModelConfig = {
    ...scriptedModelConfig(scriptedModel([]) as never),
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      const model = models[slug]
      if (model === undefined) {
        return scriptedModel([
          () => {
            throw new Error(`unexpected model call of ${slug}`)
          },
        ]) as never
      }
      return model as never
    },
  }
  const server = compose({
    dbFile: ':memory:',
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
  })
  servers.push(server)
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
  }
  return server
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const userMessage = (text: string) => ({
  messages: [{ id: 'c', role: 'user', parts: [{ type: 'text', text }] }],
})

interface ModeBody {
  mode: string
  source: string
  agentMode: string
  workspaceDefault: string
  available: string[]
  autoAvailable: boolean
  auto: { paused: boolean; consecutive: number; total: number }
}
const getMode = async (s: Server, agent: string): Promise<ModeBody> =>
  (await (await s.app.request(`/agents/${agent}/mode`)).json()) as ModeBody
const putMode = (s: Server, agent: string, mode: string) =>
  s.app.request(`/agents/${agent}/mode`, json('PUT', { mode }))

interface Approval {
  id: string
  toolName: string
  sessionId: string
}
const approvals = async (s: Server): Promise<Approval[]> =>
  ((await (await s.app.request('/approvals')).json()) as { approvals: Approval[] }).approvals
const events = async (s: Server) =>
  (
    (await (await s.app.request('/events?after=0&limit=500')).json()) as {
      events: Array<{ type: string; agentId: string | null; payload: Record<string, unknown> }>
    }
  ).events

const readOld = { toolName: 'read_file', input: { path: '/library/old.md' } }
const deleteOld = { toolName: 'delete_file', input: { path: '/library/old.md' } }
const fetchPage = (n = 1) => ({
  toolName: 'web_fetch',
  toolCallId: `fetch-${n}`,
  input: { url: 'http://127.0.0.1/page' },
})
const delegate = {
  toolName: 'agent',
  toolCallId: 'call-1',
  input: {
    subagent_type: 'researcher',
    description: 'Clean up',
    prompt: 'Remove old',
    name: 'c',
    run_in_background: false,
  },
}

async function chat(s: Server, agent: string, text: string): Promise<void> {
  const res = await s.app.request(`/agents/${agent}/chat`, json('POST', userMessage(text)))
  expect(res.status).toBe(200)
  await res.text()
}
const exists = async (s: Server, path: string) =>
  (await libraryFs(s.conn.sqlite).stat?.(path)) != null

describe('mode API', () => {
  test('defaults to Manual; Auto is offered only with a classifier; a pick emits mode-changed', async () => {
    const s = start({})
    const initial = await getMode(s, 'researcher')
    expect(initial).toMatchObject({
      mode: 'manual',
      source: 'workspace',
      agentMode: 'inherit',
      workspaceDefault: 'manual',
      available: ['manual', 'bypass'],
      autoAvailable: false,
      auto: { paused: false, consecutive: 0, total: 0 },
    })
    const refused = await putMode(s, 'researcher', 'auto')
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'MODE_NOT_ALLOWED',
    )
    expect((await putMode(s, 'researcher', 'bypass')).status).toBe(200)
    expect(await getMode(s, 'researcher')).toMatchObject({ mode: 'bypass', source: 'chat' })
    // other chats are not affected
    expect(await getMode(s, 'writer')).toMatchObject({ mode: 'manual', source: 'workspace' })
    expect((await putMode(s, 'researcher', 'nope')).status).toBe(400)
    const changed = (await events(s)).filter((e) => e.type === 'mode-changed')
    expect(changed).toHaveLength(1)
    expect(changed[0]?.payload).toMatchObject({ mode: 'bypass', autoPaused: false })
  })

  test('the workspace default and the agent own mode feed the initial mode; legacy values map', async () => {
    const s = start({}, { classifier: () => ({ decision: 'allow' }) })
    expect(await getMode(s, 'researcher')).toMatchObject({
      available: ['manual', 'auto', 'bypass'],
      autoAvailable: true,
    })
    await s.app.request('/settings', json('PATCH', { defaultPermissionMode: 'auto' }))
    expect(await getMode(s, 'researcher')).toMatchObject({ mode: 'auto', source: 'workspace' })
    // legacy settings values are stored as Manual
    const patched = await s.app.request(
      '/settings',
      json('PATCH', { defaultPermissionMode: 'plan' }),
    )
    expect(
      ((await patched.json()) as { defaultPermissionMode: string }).defaultPermissionMode,
    ).toBe('default')
    // the agent's own mode wins over the workspace default, and is its ceiling
    const researcher = s.deps.agents.getBySlug('researcher')
    updateAgent(s.deps, researcher?.id as string, { permissionMode: 'auto' })
    expect(await getMode(s, 'researcher')).toMatchObject({
      mode: 'auto',
      source: 'agent',
      agentMode: 'auto',
      available: ['manual', 'auto'],
    })
    expect((await putMode(s, 'researcher', 'bypass')).status).toBe(409)
    // a legacy stored value shows as Manual and pins Manual
    updateAgent(s.deps, researcher?.id as string, { permissionMode: 'acceptEdits' })
    expect(await getMode(s, 'researcher')).toMatchObject({
      mode: 'manual',
      agentMode: 'manual',
      available: ['manual'],
    })
  })
})

describe('mode switch', () => {
  test('takes effect on the next tool call', async () => {
    const s = start({
      researcher: [
        { toolCalls: [readOld] },
        { toolCalls: [deleteOld] },
        { text: 'Denied, fine.' },
        { toolCalls: [deleteOld] },
        { text: 'Deleted.' },
      ],
    })
    await libraryFs(s.conn.sqlite).write('/library/old.md', 'old\n')
    // Manual: delete_file asks
    await chat(s, 'researcher', 'Delete old.md')
    const pending = await approvals(s)
    expect(pending.map((a) => a.toolName)).toEqual(['delete_file'])
    expect(await exists(s, '/library/old.md')).toBe(true)
    const denied = await s.app.request(
      `/approvals/${pending[0]?.id}`,
      json('POST', { approved: false }),
    )
    expect(denied.status).toBe(202)
    await until('turn finished', async () => (await approvals(s)).length === 0)
    await until('denied turn ended', async () => {
      const res = await s.app.request('/agents/researcher/messages?limit=50')
      return JSON.stringify(await res.json()).includes('Denied, fine.')
    })

    // Bypass: the same call runs without asking
    expect((await putMode(s, 'researcher', 'bypass')).status).toBe(200)
    await chat(s, 'researcher', 'Delete old.md again')
    expect(await approvals(s)).toEqual([])
    expect(await exists(s, '/library/old.md')).toBe(false)
  })
})

describe('children inherit the delegating chat mode', () => {
  const lead = [
    { toolCalls: [delegate] },
    { text: 'The researcher is done.' },
  ] as ScriptedStepInput[]

  test('Manual lead: the child asks; Bypass lead: the child runs', async () => {
    const s = start({
      lead,
      researcher: [{ toolCalls: [readOld] }, { toolCalls: [deleteOld] }, { text: 'Done.' }],
    })
    await libraryFs(s.conn.sqlite).write('/library/old.md', 'old\n')
    await chat(s, 'lead', 'Clean up')
    const pending = await approvals(s)
    expect(pending.map((a) => a.toolName)).toEqual(['delete_file'])
    expect(pending[0]?.sessionId).toContain(':agent:call-1')

    const b = start({
      lead,
      researcher: [{ toolCalls: [readOld] }, { toolCalls: [deleteOld] }, { text: 'Done.' }],
    })
    await libraryFs(b.conn.sqlite).write('/library/old.md', 'old\n')
    await putMode(b, 'lead', 'bypass')
    await chat(b, 'lead', 'Clean up')
    await until('child deleted the file', async () => !(await exists(b, '/library/old.md')))
    expect(await approvals(b)).toEqual([])
  })

  test('an agent pinned to Manual stays Manual under a Bypass lead', async () => {
    const s = start({
      lead,
      researcher: [{ toolCalls: [readOld] }, { toolCalls: [deleteOld] }, { text: 'Done.' }],
    })
    await libraryFs(s.conn.sqlite).write('/library/old.md', 'old\n')
    const researcher = s.deps.agents.getBySlug('researcher')
    updateAgent(s.deps, researcher?.id as string, { permissionMode: 'manual' })
    await putMode(s, 'lead', 'bypass')
    await chat(s, 'lead', 'Clean up')
    expect((await approvals(s)).map((a) => a.toolName)).toEqual(['delete_file'])
    expect(await exists(s, '/library/old.md')).toBe(true)
  })
})

describe('auto mode', () => {
  test('the classifier allows or blocks; a block reaches the model as the tool result', async () => {
    const calls: string[] = []
    const classifier: AutoClassifier = (action) => {
      calls.push(action.toolName)
      return calls.length === 1
        ? { decision: 'block', reason: 'not on the list' }
        : { decision: 'allow' }
    }
    const s = start(
      {
        researcher: [
          { toolCalls: [fetchPage(1)] },
          { toolCalls: [fetchPage(2)] },
          { text: 'Done.' },
        ],
      },
      { classifier },
    )
    await putMode(s, 'researcher', 'auto')
    await chat(s, 'researcher', 'Read the page')
    // nobody was asked: the first call was blocked, the second allowed
    expect(await approvals(s)).toEqual([])
    expect(calls).toEqual(['web_fetch', 'web_fetch'])
    expect(JSON.stringify(models.researcher?.prompts)).toContain('Auto mode blocked this action')
    expect(JSON.stringify(models.researcher?.prompts)).toContain('not on the list')
    expect(await getMode(s, 'researcher')).toMatchObject({
      mode: 'auto',
      auto: { paused: false, consecutive: 0, total: 1 },
    })
  })

  test('3 blocks in a row pause Auto: the next call asks, and an approval resumes it', async () => {
    const classifier: AutoClassifier = () => ({ decision: 'block', reason: 'no' })
    const s = start(
      {
        researcher: [
          { toolCalls: [fetchPage(1)] },
          { toolCalls: [fetchPage(2)] },
          { toolCalls: [fetchPage(3)] },
          { toolCalls: [fetchPage(4)] },
          { text: 'Done.' },
        ],
      },
      { classifier },
    )
    await putMode(s, 'researcher', 'auto')
    await chat(s, 'researcher', 'Read the page')
    expect(await getMode(s, 'researcher')).toMatchObject({
      mode: 'auto',
      auto: { paused: true, consecutive: 3, total: 3 },
    })
    const pending = await approvals(s)
    expect(pending.map((a) => a.toolName)).toEqual(['web_fetch'])
    const paused = (await events(s)).filter(
      (e) => e.type === 'mode-changed' && e.payload.autoPaused === true,
    )
    expect(paused.length).toBeGreaterThan(0)

    // another chat of the same agent definition is not paused by this one
    expect(await getMode(s, 'writer')).toMatchObject({ auto: { paused: false } })

    // a person approves: Auto resumes
    const answered = await s.app.request(
      `/approvals/${pending[0]?.id}`,
      json('POST', { approved: true }),
    )
    expect(answered.status).toBe(202)
    await until('auto resumed', async () => !(await getMode(s, 'researcher')).auto.paused)
  })
})
