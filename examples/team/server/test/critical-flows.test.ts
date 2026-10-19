/**
 * The critical flows: every flow where a result must reach a person, as one table. Each row has a
 * setup, an action and the expected delivery (what the owner or requester actually receives,
 * where, and how many times). Scripted models and the mock channel adapter, generic names, no
 * network. Narrow behaviour lives in the topic tests; this file is the "does anyone get told"
 * matrix (docs/plans P50-P54).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { deliverAlarms, openAlarms, sweepAlarms } from '../src/app/alarms.ts'
import { consistencyFindings } from '../src/app/consistency.ts'
import { forgetConsistency } from '../src/app/consistency-cache.ts'
import { approveDecision, getDecision, proposeFromAgent } from '../src/app/decisions.ts'
import { setHeartbeat } from '../src/app/heartbeat.ts'
import { GONE_REMOVE } from '../src/app/order-care.ts'
import type { Deps } from '../src/app/ports.ts'
import { createProgram } from '../src/app/programs.ts'
import { createRoutine } from '../src/app/routines.ts'
import { addOrder, listOrders } from '../src/app/standing-orders.ts'
import { askOwner } from '../src/app/supervisor.ts'
import type { Decision } from '../src/domain/decisions.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}

type Slug = 'lead' | 'researcher' | 'writer'
const call = (toolName: string, input: Record<string, unknown>, id = 't1'): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})
const text = (t: string): ScriptedStepInput => ({ text: t })
const report = (r: Record<string, unknown>): ScriptedStepInput => call('final_answer', r, 'fa')
const wire = (m: ScriptedModel | undefined): string => JSON.stringify(m?.prompts ?? [])

const OWNER = { id: '9001', name: 'Olive Owner', username: 'olive' }
const ADMIN = { id: '9002', name: 'Adam Admin', username: 'adam' }
const PERSON = { id: '9003', name: 'Pat Person', username: 'pat' }

interface RigOptions {
  /** The agent that owns the chat connection (default lead). */
  bind?: Slug
  groups?: Record<string, Record<string, unknown>>
  /** channel_send asks for approval (default: allowed by rule). */
  ask?: boolean
  buttons?: boolean
  timezone?: string
  /** The owner of the directory exists and can be reached by direct chat (default true). */
  owner?: boolean
}
interface Rig {
  server: Server
  deps: Deps
  app: Server['app']
  mock: MockAdapter
  models: Record<string, ScriptedModel>
  ids: Record<Slug, string>
  /** What the owner received in their direct chat. */
  toOwner: () => string[]
  /** The bell entries (notifications) still open. */
  bell: () => Array<{ title: string; body: string }>
}

async function rig(
  script: Partial<Record<Slug, ScriptedStepInput[]>> = {},
  options: RigOptions = {},
): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'team-critical-'))
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
    instanceId: 'critical-flows',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0 },
    heartbeat: { activitySettleMs: 20 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(7)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  } as never)
  servers.push(server)
  const { deps } = server
  const ids = {} as Record<Slug, string>
  for (const slug of ['lead', 'researcher', 'writer'] as const) {
    const def = deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    ids[slug] = def.id
    const bound = slug === (options.bind ?? 'lead')
    updateAgent(deps, def.id, {
      model: `m-${slug}`,
      ...(bound && options.ask !== true
        ? { rules: { ...def.rules, allow: [...def.rules.allow, 'channel_send'] } }
        : {}),
    })
  }
  if (options.timezone !== undefined)
    deps.settings.patch({ timezone: options.timezone }, Date.now())

  const gw = server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: ids[options.bind ?? 'lead'],
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  for (const [native, raw] of Object.entries(
    options.groups ?? { room: { label: 'Ops', ack: false } },
  )) {
    const { topics, kind, title, ...policy } = raw as {
      topics?: Record<string, Record<string, unknown>>
      kind?: 'room' | 'direct'
      title?: string
    } & Record<string, unknown>
    const room = gw.settings.ensureNode('c1', {
      nativeId: native,
      kind: kind ?? 'room',
      ...(title === undefined ? {} : { title }),
    })
    gw.settings.set(room.id, { enabled: true, ...policy } as never)
    for (const t of Object.keys(topics ?? {}))
      gw.settings.ensureNode('c1', { nativeId: `${native}/${t}`, kind: 'thread', title: t }, native)
  }
  const mock = createMockAdapter({
    connectionId: 'c1',
    ...(options.buttons === true ? { capabilities: { buttons: true } } : {}),
  })
  await gw.register(mock)
  if (options.owner !== false) gw.people.setRole('c1', OWNER.id, { role: 'owner' }, 'owner')
  return {
    server,
    deps,
    app: server.app,
    mock,
    models,
    ids,
    toOwner: () =>
      mock.sent.filter((s) => s.conversationId === OWNER.id).map((s) => s.message.text),
    bell: () =>
      deps.notifications
        .list({ open: true, limit: 100 })
        .map((n) => ({ title: n.title, body: n.body })),
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const NEVER_SENT = 150

/** The authority of a program with one more tool granted. */
function withTool(deps: Deps, programId: string, tool: string) {
  const program = deps.programs.get(programId)
  if (program === undefined) throw new Error(`no program ${programId}`)
  return { ...program.authority, tools: [...program.authority.tools, tool] }
}

const PROGRAM = {
  agentId: 'researcher',
  name: 'Nightly digest',
  brief: 'Summarise the library and report.',
  authority: { read: ['/library/videos/**'], write: ['/library/reports/**'] },
  gates: [],
  escalation: '',
  forbidden: [],
  budget: { perRunUsd: null, perDayUsd: null },
}
interface RunView {
  id: string
  sessionId: string
  status: string
  summary: string | null
}
async function createProgramHttp(app: Server['app'], body: Record<string, unknown> = {}) {
  const res = await app.request('/programs', json('POST', { ...PROGRAM, ...body }))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as { id: string }
}
const runsOf = async (app: Server['app'], id: string): Promise<RunView[]> =>
  ((await (await app.request(`/programs/${id}/runs`)).json()) as { runs: RunView[] }).runs
const runEnded = (r: RunView | undefined): boolean =>
  r !== undefined && r.status !== 'running' && r.status !== 'needs_action'

/** Make the owned routine of a schedule program due and tick the scheduler. */
async function fireSchedule(i: Rig, programId: string): Promise<void> {
  const owned = i.deps.routines.getByProgram(programId)
  const now = Date.now()
  i.server.conn.sqlite
    .query('UPDATE routines SET next_fire_at = ? WHERE id = ?')
    .run(now - 1000, owned?.id as string)
  await i.server.routines.tick(now)
}

// -------------------------------------------------------------------------------------------------

interface Row {
  n: number
  name: string
  run: () => Promise<void>
}

const rows: Row[] = [
  {
    n: 1,
    name: 'a scheduled program run fails: the owner gets one alarm; the next success clears it',
    async run() {
      const i = await rig({
        researcher: [
          report({ status: 'failed', summary: 'could not reach the source', outputs: [] }),
          report({ status: 'done', summary: 'all good', outputs: [] }),
        ],
      })
      const p = await createProgramHttp(i.app, {
        trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
      })
      await fireSchedule(i, p.id)
      await until('the run failed', async () => runEnded((await runsOf(i.app, p.id))[0]))
      expect((await runsOf(i.app, p.id))[0]?.status).toBe('failed')

      expect((await sweepAlarms(i.deps)).failedRuns).toBe(1)
      // sweeps repeat every minute: the same incident is never raised or sent again
      expect((await sweepAlarms(i.deps)).failedRuns).toBe(0)
      await deliverAlarms(i.deps)
      await deliverAlarms(i.deps)
      await until('the owner is told', () => i.toOwner().length === 1)
      expect(i.toOwner()[0]).toContain('Nightly digest')
      expect(i.toOwner()[0]).toContain('could not reach the source')
      expect(i.bell()).toEqual([])
      expect(openAlarms(i.deps)).toHaveLength(1)

      // the next run succeeds: the alarm clears by itself, nobody is bothered again
      const run = await i.app.request(`/programs/${p.id}/run`, json('POST'))
      expect(run.status).toBe(202)
      await until('the second run ended', async () => {
        const r = await runsOf(i.app, p.id)
        return r.length === 2 && r.every(runEnded)
      })
      await sweepAlarms(i.deps)
      expect(openAlarms(i.deps)).toHaveLength(0)
      await deliverAlarms(i.deps)
      await sleep(40)
      expect(i.toOwner()).toHaveLength(1)
    },
  },
  {
    n: 2,
    name: 'a routine that cannot run pauses itself: one alarm to the owner, no extra bell entry',
    async run() {
      // the writer is not bound to any chat, so a program that names channel_send cannot run
      const i = await rig({})
      const p = await createProgramHttp(i.app, {
        agentId: 'writer',
        authority: { tools: ['channel_send'], read: [], write: [] },
        trigger: { kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } },
      })
      await fireSchedule(i, p.id)
      expect(i.deps.routines.getByProgram(p.id)).toMatchObject({
        status: 'paused',
        pausedReason: 'unrunnable',
      })
      await deliverAlarms(i.deps)
      await until('the owner is told', () => i.toOwner().length === 1)
      expect(i.toOwner()[0]).toContain('Nightly digest')
      expect(i.toOwner()[0]).toContain('not bound to any channel connection')
      // the chat got it, so the bell did not get a second copy
      expect(i.bell()).toEqual([])
      // a later tick and later sweeps tell nobody again
      await i.server.routines.tick(Date.now() + 7_200_000)
      await sweepAlarms(i.deps)
      await deliverAlarms(i.deps)
      await sleep(NEVER_SENT)
      expect(i.toOwner()).toHaveLength(1)
      expect(openAlarms(i.deps).filter((a) => a.kind === 'routine-paused')).toHaveLength(1)
    },
  },
  {
    n: 3,
    name: 'an approval nobody answers expires: the owner gets one alarm and the run is told it was declined',
    async run() {
      const i = await rig(
        {
          lead: [
            call('channel_send', { action: 'send', conversation: 'news', text: 'Release notes.' }),
            text('It was not approved, so I did not post.'),
          ],
        },
        {
          ask: true,
          buttons: true,
          groups: { room: { label: 'Ops', ack: false }, news: { wake: 'never' } },
        },
      )
      i.server.channels.people.setRole('c1', ADMIN.id, { role: 'admin' }, 'owner')
      await i.mock.say({ from: ADMIN, text: '@team_bot publish', id: 'w1', mentionSelf: true })
      await until('the request', () => i.mock.sent.some((s) => s.message.buttons !== undefined))
      expect(await i.server.channels.expireApprovals(Date.now() + 25 * 3_600_000)).toBe(1)
      // the run is told: declined, not answered; the requester reads the outcome in the chat
      await until('the reply', () =>
        i.mock.sent.some((s) => s.message.text.startsWith('It was not approved')),
      )
      expect(wire(i.models.lead)).toContain('not answered')
      expect(i.mock.sent.some((s) => s.conversationId === 'news')).toBe(false)
      // the owner: exactly one alarm, in their direct chat
      await deliverAlarms(i.deps)
      await until('the owner is told', () => i.toOwner().length === 1)
      expect(i.toOwner()[0]).toContain('channel_send')
      expect(i.toOwner()[0]).toContain('nobody answered')
      expect(i.bell().filter((b) => b.title.includes('nobody answered'))).toEqual([])
      expect(await i.server.channels.expireApprovals(Date.now() + 26 * 3_600_000)).toBe(0)
      await deliverAlarms(i.deps)
      await sleep(NEVER_SENT)
      expect(i.toOwner()).toHaveLength(1)
    },
  },
  {
    n: 4,
    name: 'a tool granted and forbidden: refused at proposal, flagged by consistency, a change proposal un-forbids it',
    async run() {
      const i = await rig({})
      const { deps } = i
      const agentId = i.ids.researcher
      const propose = (
        input: Partial<Parameters<typeof proposeFromAgent>[1]> & { title: string },
      ) =>
        proposeFromAgent(deps, {
          agentId,
          sessionId: null,
          runner: 'researcher',
          runOnce: false,
          program: {},
          ...input,
        })
      // refused at proposal: nothing is stored, the agent reads why
      expect(() =>
        propose({
          title: 'Poster',
          program: {
            name: 'Poster',
            brief: 'Post.',
            authority: { tools: ['channel_send'] },
            forbidden: ['channel_send'],
          },
        }),
      ).toThrow(/forbidden wins/)
      expect(deps.decisions.list({ status: 'open', limit: 50 })).toHaveLength(0)

      // a program that got into that state anyway is flagged
      const program = createProgram(deps, {
        agentId,
        name: 'Weekly review',
        brief: 'Review.',
        authority: { read: ['/library/**'], tools: ['channel_send'] },
      })
      deps.programs.update(program.id, { forbidden: ['channel_send'] }, deps.clock.now())
      const flagged = (await consistencyFindings(deps)).filter(
        (f) => f.kind === 'program-needs-tool' && f.explanation.includes('grants and forbids'),
      )
      expect(flagged).toHaveLength(1)

      // the change proposal that grants it takes it out of forbidden
      const { decision } = propose({
        title: 'Let it post',
        target: program.id,
        addAuthority: { tools: ['channel_send'] },
      })
      const d = decision as Extract<Decision, { kind: 'change' }>
      expect(d.payload.diff.map((l) => l.field)).toContain('forbidden')
      await approveDecision(deps, d.id, { note: 'ok' })
      expect(deps.programs.get(program.id)?.forbidden).toEqual([])
      expect(deps.programs.get(program.id)?.authority.tools).toContain('channel_send')
      expect(
        (await consistencyFindings(deps)).filter(
          (f) => f.kind === 'program-needs-tool' && f.explanation.includes('grants and forbids'),
        ),
      ).toHaveLength(0)
    },
  },
  {
    n: 5,
    name: 'change proposals for one program reach the owner as one merged card',
    async run() {
      const i = await rig({})
      const { deps } = i
      const agentId = i.ids.researcher
      const program = createProgram(deps, {
        agentId,
        name: 'Weekly review',
        brief: 'Review the library.',
        authority: { read: ['/library/**'] },
      })
      const propose = (title: string, tools: string[]) =>
        proposeFromAgent(deps, {
          agentId,
          sessionId: null,
          runner: 'researcher',
          runOnce: false,
          program: {},
          title,
          target: program.id,
          addAuthority: { tools },
        })
      const first = propose('Add web', ['web_fetch'])
      const second = propose('Also send', ['channel_send'])
      expect(second.merged).toEqual([first.decision.id])
      // what the owner sees in the decision list: one open card, the first one closed
      const listed = (await (await i.app.request('/decisions?status=open')).json()) as {
        decisions: Array<{ id: string; kind: string; programId?: string }>
      }
      const cards = listed.decisions.filter((d) => d.kind === 'change')
      expect(cards.map((d) => d.id)).toEqual([second.decision.id])
      expect(getDecision(deps, first.decision.id)?.status).toBe('expired')
      expect(second.decision.body).toContain('web_fetch')
      expect(second.decision.body).toContain('channel_send')
      // approving the one card applies both
      await approveDecision(deps, second.decision.id, {})
      expect([...(deps.programs.get(program.id)?.authority.tools ?? [])].sort()).toEqual([
        'channel_send',
        'web_fetch',
      ])
    },
  },
  {
    n: 6,
    name: 'a reminder request is one reminder, a similar second is refused unless series; it posts once',
    async run() {
      const msg = (day: string) =>
        `Reminder: prepare the company dashboard before the Tuesday meeting, ${day}: content reach, sales ratio and support volume`
      const i = await rig(
        {
          lead: [
            call('reminder', { action: 'create', message: msg('saturday'), inMinutes: 60 }, 's1'),
            call('reminder', { action: 'create', message: msg('monday'), inMinutes: 120 }, 's2'),
            call(
              'reminder',
              { action: 'create', message: msg('tuesday'), inMinutes: 600, series: true },
              's3',
            ),
            text('Set.'),
          ],
        },
        { timezone: 'UTC', groups: { forum: { topics: { general: {} } } } },
      )
      i.server.channels.people.setRole('c1', ADMIN.id, { role: 'admin' }, 'owner')
      await i.mock.say({ from: PERSON, text: 'i exist', id: 'p0', chat: 'forum', topic: 'general' })
      await i.mock.say({
        chat: 'forum',
        topic: 'general',
        from: ADMIN,
        text: '@team_bot remind me',
        id: 'a1',
        mentionSelf: true,
      })
      await until('confirmed', () => i.mock.sent.some((s) => s.message.text === 'Set.'))
      expect(wire(i.models.lead)).toContain(
        'Not created: a reminder about the same thing is already set',
      )
      const stored = i.server.channels.reminders.list('c1')
      expect(stored.map((r) => r.body.includes('monday'))).not.toContain(true)
      expect(stored).toHaveLength(2) // the first, and the explicit series
      // an hour passes: the first one posts once, in the topic, with no model call
      const calls = i.models.lead?.prompts.length
      await i.server.routines.tick(Date.now() + 61 * 60_000)
      await until('posted', () => i.mock.sent.some((s) => s.message.text.includes('saturday')))
      await i.server.routines.tick(Date.now() + 62 * 60_000)
      await sleep(NEVER_SENT)
      const posts = i.mock.sent.filter((s) => s.message.text.includes('Reminder:'))
      expect(posts).toHaveLength(1)
      expect(posts[0]?.conversationId).toBe('forum/general')
      expect(i.models.lead?.prompts.length).toBe(calls)
    },
  },
  {
    n: 7,
    name: 'a background worker stopped while finishing: its final answer reaches the lead and the lead chat',
    async run() {
      const spawn = {
        toolName: 'agent',
        toolCallId: 'sp1',
        input: {
          subagent_type: 'researcher',
          description: 'Review',
          prompt: 'Review it',
          name: 'rev',
        },
      }
      const lead = (c: { prompt: unknown }): ScriptedStepInput => {
        const p = JSON.stringify(c.prompt)
        if (!p.includes('"toolName":"agent"')) return { toolCalls: [spawn] }
        if (!p.includes('"toolName":"agent_stop"'))
          return {
            toolCalls: [{ toolName: 'agent_stop', toolCallId: 'st1', input: { id: 'rev' } }],
          }
        return { text: `lead: ${p.includes('FINAL FINDINGS') ? 'has findings' : 'no findings'}` }
      }
      const i = await rig({
        lead: Array.from({ length: 12 }, () => lead as unknown as ScriptedStepInput),
        researcher: [text('FINAL FINDINGS')],
      })
      const res = await i.app.request(
        '/sessions/dm:lead/chat',
        postAs('dm:lead', userMessage('Review it in the background, then stop it')),
      )
      await res.text()
      const chat = async (): Promise<string> =>
        JSON.stringify(
          (await (await i.app.request('/sessions/dm:lead/messages?limit=100')).json()) as unknown,
        )
      // the lead's chat holds the final answer, and the lead acted on it
      await until('the lead chat has the answer', async () =>
        (await chat()).includes('lead: has findings'),
      )
      expect(await chat()).toContain('FINAL FINDINGS')
      expect(wire(i.models.lead)).toContain('FINAL FINDINGS')
      // the worker's task ended with its answer, not an error
      const tasks = (await (await i.app.request('/tasks')).json()) as {
        tasks: Array<{ status: string; summary: string | null }>
      }
      expect(tasks.tasks).toHaveLength(1)
      expect(tasks.tasks[0]?.summary ?? '').toContain('FINAL FINDINGS')
      // one report event only
      const events = (
        (await (await i.app.request('/sessions/dm:lead/messages?limit=100')).json()) as {
          messages: Array<{ parts: Array<{ type: string }> }>
        }
      ).messages.flatMap((m) => m.parts.filter((p) => p.type === 'data-eh.event'))
      expect(events).toHaveLength(1)
    },
  },
  {
    n: 8,
    name: 'a worker in a group asks approval twice for one tool: one message; "ya semua" approves the rest',
    async run() {
      const del = (path: string, id: string) => ({
        toolName: 'delete_file',
        toolCallId: id,
        input: { path },
      })
      const i = await rig(
        {
          lead: [
            call('agent', {
              subagent_type: 'researcher',
              description: 'Clean up',
              prompt: 'Remove the old files',
            }),
            text('Cleaned up.'),
          ],
          researcher: [
            // a file is read before it is deleted
            {
              toolCalls: ['a', 'b', 'c'].map((f) => ({
                toolName: 'read_file',
                toolCallId: `r-${f}`,
                input: { path: `/library/old-${f}.md` },
              })),
            },
            { toolCalls: [del('/library/old-a.md', 'd1'), del('/library/old-b.md', 'd2')] },
            // the session grant applies from the step after the continuation's first one
            call('read_file', { path: '/library/old-c.md' }, 'rf'),
            { toolCalls: [del('/library/old-c.md', 'd3')] },
            text('All three removed.'),
          ],
        },
        { ask: true, buttons: true },
      )
      i.server.channels.people.setRole('c1', ADMIN.id, { role: 'admin' }, 'owner')
      for (const f of ['a', 'b', 'c']) await i.deps.library.writeText(`/library/old-${f}.md`, 'x\n')
      await i.mock.say({ from: ADMIN, text: '@team_bot clean up', id: 'w1', mentionSelf: true })
      const requests = () => i.mock.sent.filter((s) => s.message.buttons !== undefined)
      await until('the request', () => requests().length >= 1)
      await sleep(NEVER_SENT)
      // two calls of one tool: one message in the group, not a pile
      expect(requests()).toHaveLength(1)
      const ask = requests()[0] as NonNullable<ReturnType<typeof requests>[number]>
      expect(ask.conversationId).toBe('room')
      expect(ask.message.text).toContain('delete_file')
      await i.mock.say({
        from: ADMIN,
        text: 'ya semua',
        id: 'w2',
        mentionSelf: true,
        replyTo: { messageId: ask.messageId },
      })
      await until('the lead reports back', () =>
        i.mock.sent.some((s) => s.message.text === 'Cleaned up.'),
      )
      // every call went through and nobody was asked a second time
      expect(requests()).toHaveLength(1)
      for (const f of ['a', 'b', 'c'])
        expect(await i.deps.library.read(`/library/old-${f}.md`)).toBeUndefined()
    },
  },
  {
    n: 9,
    name: 'a standing order whose chat is gone is paused and asked once; answering "remove" removes it',
    async run() {
      const final = (id: string) => call('final_answer', { status: 'ok', items: [] }, id)
      const i = await rig(
        { lead: [final('f1'), final('f2')] },
        { groups: { 'group-1': { ack: false, proactive: { allowed: true, digest: false } } } },
      )
      const { deps } = i
      const agentId = i.ids.lead
      await setHeartbeat(deps, agentId, { activeFrom: '00:00', activeTo: '00:00' })
      const group = i.server.channels.nodes.byNative('c1', 'group-1')?.id as string
      const given = (nodeId: string, over: Record<string, unknown> = {}) => ({
        text: 'Keep an eye on the community and report anything strange to the team',
        by: 'web:owner',
        name: 'Owner',
        role: 'owner' as const,
        report: { kind: 'chat' as const, connectionId: 'c1', nodeId },
        mention: false,
        ...over,
      })
      const added = await addOrder(deps, agentId, given('gone-node'))
      await addOrder(deps, agentId, given(group, { text: 'Watch the other thing' }))
      const goneCards = () =>
        deps.decisions
          .list({ status: 'open', agentId, limit: 20 })
          .filter((d) => d.title.includes('is gone'))
      await i.server.heartbeats.heartbeat(agentId, { slot: Date.now() })
      await i.server.heartbeats.idle()
      const gone = (await listOrders(deps, agentId)).find((o) => o.id === added.order.id)
      expect(gone).toMatchObject({ active: false })
      expect(goneCards()).toHaveLength(1)
      // the next beat does not ask again
      await i.server.heartbeats.heartbeat(agentId, { slot: Date.now() + 1 })
      await i.server.heartbeats.idle()
      expect(goneCards()).toHaveLength(1)
      const card = goneCards()[0] as NonNullable<ReturnType<typeof goneCards>[number]>
      const done = await approveDecision(deps, card.id, { choice: GONE_REMOVE })
      expect(done.outcome?.effect).toContain('Removed order')
      expect((await listOrders(deps, agentId)).map((o) => o.id)).not.toContain(added.order.id)
      expect(goneCards()).toHaveLength(0)
    },
  },
  {
    n: 10,
    name: 'a heartbeat that read a DM and then tries to post to a group is refused',
    async run() {
      const final = call('final_answer', { status: 'ok', items: [] }, 'f1')
      const i = await rig(
        {
          lead: [
            call(
              'chat_history',
              { connection: 'c1', chat: 'Private With Sam', window: 'today' },
              'h1',
            ),
            call(
              'channel_send',
              { action: 'send', connection: 'c1', conversation: 'Team Room', text: 'hello team' },
              'h2',
            ),
            final,
          ],
        },
        {
          groups: {
            'group-1': {
              title: 'Team Room',
              ack: false,
              proactive: { allowed: true, digest: false },
            },
            'dm-1': { kind: 'direct', title: 'Private With Sam', ack: false },
          },
        },
      )
      const { deps } = i
      const agentId = i.ids.lead
      await setHeartbeat(deps, agentId, { activeFrom: '00:00', activeTo: '00:00' })
      const group = i.server.channels.nodes.byNative('c1', 'group-1')?.id as string
      await addOrder(deps, agentId, {
        text: 'Keep an eye on the community and report anything strange to the team',
        by: 'web:owner',
        name: 'Owner',
        role: 'owner',
        report: { kind: 'chat', connectionId: 'c1', nodeId: group },
        mention: false,
      })
      expect((await i.server.heartbeats.heartbeat(agentId, { slot: Date.now() })).started).toBe(
        true,
      )
      await i.server.heartbeats.idle()
      await until('the beat ran its steps', () => (i.models.lead?.calls.length ?? 0) >= 3)
      // the post was refused with a reason the model can read, and nothing reached the group
      expect(wire(i.models.lead)).toContain('never to a group')
      expect(i.mock.sent.filter((s) => s.conversationId === 'group-1')).toEqual([])
      expect(i.mock.sent.some((s) => s.message.text === 'hello team')).toBe(false)
    },
  },
  {
    n: 11,
    name: 'a program daily summary with channel_send granted is posted once to its chat',
    async run() {
      const i = await rig(
        {
          researcher: [
            call('channel_send', {
              action: 'send',
              conversation: 'news',
              text: 'Daily summary: 3 videos scripted.',
            }),
            report({ status: 'done', summary: 'Posted the daily summary.', outputs: [] }),
          ],
        },
        { bind: 'researcher', groups: { news: { wake: 'never', ack: false } } },
      )
      const p = await createProgramHttp(i.app, {
        name: 'Daily summary',
        authority: { tools: ['channel_send'], read: [], write: [] },
      })
      expect((await i.app.request(`/programs/${p.id}/run`, json('POST'))).status).toBe(202)
      await until('the run ended', async () => runEnded((await runsOf(i.app, p.id))[0]))
      expect((await runsOf(i.app, p.id))[0]?.status).toBe('done')
      await until('posted', () => i.mock.sent.length >= 1)
      await sleep(NEVER_SENT)
      const posts = i.mock.sent.filter((s) => s.conversationId === 'news')
      expect(posts).toHaveLength(1)
      expect(posts[0]?.message.text).toBe('Daily summary: 3 videos scripted.')
      // nobody else was messaged, and no alarm is open
      expect(i.mock.sent).toHaveLength(1)
      expect(openAlarms(i.deps)).toHaveLength(0)
    },
  },
  {
    n: 12,
    name: 'a long task session: the task row is small without messages, a messages page with clip is bounded',
    async run() {
      const steps: ScriptedStepInput[] = Array.from({ length: 25 }, (_, k) =>
        call('read_file', { path: `/library/videos/big-${k}.md` }, `r${k}`),
      )
      steps.push(report({ status: 'done', summary: 'Read it all.', outputs: [] }))
      const i = await rig({ researcher: steps })
      for (let k = 0; k < 25; k++)
        await i.deps.library.writeText(
          `/library/videos/big-${k}.md`,
          `file ${k}: ${'lorem ipsum dolor '.repeat(1000)}\n`,
        )
      const p = await createProgramHttp(i.app, { name: 'Long reader' })
      expect((await i.app.request(`/programs/${p.id}/run`, json('POST'))).status).toBe(202)
      await until('the run ended', async () => runEnded((await runsOf(i.app, p.id))[0]), 10_000)
      const run = (await runsOf(i.app, p.id))[0] as RunView

      const sizeOf = async (url: string): Promise<number> =>
        (await (await i.app.request(url)).text()).length
      const full = await sizeOf(`/tasks/${run.id}`)
      const slim = await sizeOf(`/tasks/${run.id}?messages=none`)
      const slimBody = (await (await i.app.request(`/tasks/${run.id}?messages=none`)).json()) as {
        task: { id: string }
        messages: unknown[]
      }
      expect(slimBody.task.id).toBe(run.id)
      expect(slimBody.messages).toEqual([])
      expect(slim).toBeLessThan(8_000)
      expect(full).toBeGreaterThan(slim * 20)

      const raw = await sizeOf(`/sessions/${encodeURIComponent(run.sessionId)}/messages?limit=20`)
      const clipped = await sizeOf(
        `/sessions/${encodeURIComponent(run.sessionId)}/messages?limit=20&clip=1000`,
      )
      expect(raw).toBeGreaterThan(clipped * 5)
      expect(clipped).toBeLessThan(40_000)
      const page = (await (
        await i.app.request(
          `/sessions/${encodeURIComponent(run.sessionId)}/messages?limit=20&clip=1000`,
        )
      ).json()) as { messages: unknown[] }
      expect(page.messages.length).toBeLessThanOrEqual(20)
      expect(JSON.stringify(page)).toContain('eharnessClipped')
    },
  },

  {
    n: 13,
    name: "a member's private order is never carried into another chat: a post names its order and goes only there",
    async run() {
      const ref = { owner: '', member: '' }
      const sentTo = (i: Rig, chat: string) =>
        i.mock.sent.filter((s) => s.conversationId === chat).map((s) => s.message.text)
      // the order ids exist only after the orders are added: the steps read them late
      const send = (
        id: string,
        conversation: string,
        order: () => string | undefined,
        body: string,
      ): ScriptedStepInput =>
        (() =>
          call(
            'channel_send',
            {
              action: 'send',
              connection: 'c1',
              conversation,
              ...(order() === undefined ? {} : { order: order() }),
              text: body,
            },
            id,
          )) as never
      const i = await rig(
        {
          lead: [
            // no order named while a member's order is live: refused
            send('p1', 'Team Room', () => undefined, 'Weekly status is fine'),
            // names the owner's order but repeats the member's words: refused
            send(
              'p2',
              'Team Room',
              () => ref.owner,
              'FYI every morning about my private dentist appointment schedule',
            ),
            // the member's order may not go to the group
            send('p3', 'Team Room', () => ref.member, 'Dentist at nine'),
            // clean post for the owner's order: goes
            send('p4', 'Team Room', () => ref.owner, 'Weekly status is fine'),
            // the member's order goes to its own chat
            send('p5', 'Sam DM', () => ref.member, 'Your dentist reminder: nine tomorrow'),
            call('final_answer', { status: 'ok', items: [] }, 'f1'),
          ],
        },
        {
          groups: {
            'group-1': {
              title: 'Team Room',
              ack: false,
              proactive: { allowed: true, digest: false },
            },
            'dm-1': {
              kind: 'direct',
              title: 'Sam DM',
              ack: false,
              proactive: { allowed: true, digest: false },
            },
          },
        },
      )
      const { deps } = i
      const agentId = i.ids.lead
      await setHeartbeat(deps, agentId, { activeFrom: '00:00', activeTo: '00:00' })
      const group = i.server.channels.nodes.byNative('c1', 'group-1')?.id as string
      const dm = i.server.channels.nodes.byNative('c1', 'dm-1')?.id as string
      ref.owner = (
        await addOrder(deps, agentId, {
          text: 'Report weekly status of the team',
          by: 'web:owner',
          name: 'Owner',
          role: 'owner',
          report: { kind: 'chat', connectionId: 'c1', nodeId: group },
          mention: false,
        })
      ).order.id
      ref.member = (
        await addOrder(deps, agentId, {
          text: 'Remind me every morning about my private dentist appointment schedule',
          by: 'person-sam',
          name: 'Sam',
          role: 'member',
          report: { kind: 'chat', connectionId: 'c1', nodeId: dm },
          mention: false,
        })
      ).order.id
      await i.server.heartbeats.heartbeat(agentId, { slot: Date.now() })
      await i.server.heartbeats.idle()
      await until('the beat ran its steps', () => (i.models.lead?.calls.length ?? 0) >= 6)
      await until('both allowed posts sent', () => i.mock.sent.length >= 2)
      await sleep(NEVER_SENT)
      const w = wire(i.models.lead)
      expect(w).toContain('must name the order it is for')
      expect(w).toContain('repeats what a member')
      expect(w).toContain('reports to Sam DM')
      expect(sentTo(i, 'group-1')).toEqual(['Weekly status is fine'])
      expect(sentTo(i, 'dm-1')).toEqual(['Your dentist reminder: nine tomorrow'])
      expect(i.mock.sent).toHaveLength(2)
    },
  },
  {
    n: 14,
    name: 'what a beat read in one group goes into another group only through an order that names both',
    async run() {
      const groups = {
        'group-1': { title: 'Team Room', ack: false, proactive: { allowed: true, digest: false } },
        'group-2': { title: 'Community Hub', ack: false },
      }
      const script = (): ScriptedStepInput[] => [
        call('chat_history', { connection: 'c1', chat: 'Community Hub', window: 'today' }, 'h1'),
        call(
          'channel_send',
          { action: 'send', connection: 'c1', conversation: 'Team Room', text: 'Spam wave seen' },
          'h2',
        ),
        call('final_answer', { status: 'ok', items: [] }, 'f1'),
      ]
      const run = async (orderText: string): Promise<{ sent: string[]; wire: string }> => {
        const i = await rig({ lead: script() }, { groups })
        const agentId = i.ids.lead
        await setHeartbeat(i.deps, agentId, { activeFrom: '00:00', activeTo: '00:00' })
        const group = i.server.channels.nodes.byNative('c1', 'group-1')?.id as string
        await addOrder(i.deps, agentId, {
          text: orderText,
          by: 'web:owner',
          name: 'Owner',
          role: 'owner',
          report: { kind: 'chat', connectionId: 'c1', nodeId: group },
          mention: false,
        })
        await i.server.heartbeats.heartbeat(agentId, { slot: Date.now() })
        await i.server.heartbeats.idle()
        await until('the beat ran its steps', () => (i.models.lead?.calls.length ?? 0) >= 3)
        await sleep(NEVER_SENT)
        return {
          sent: i.mock.sent
            .filter((s) => s.conversationId === 'group-1')
            .map((s) => s.message.text),
          wire: wire(i.models.lead),
        }
      }
      // the order reports to Team Room but never names the group it reads: refused, readable
      const open = await run('Report anything strange you notice to the team')
      expect(open.sent).toEqual([])
      expect(open.wire).toContain('names \\"Community Hub\\" as a place to watch')
      // the order names Community Hub as a place to watch and Team Room as its report chat: sent
      const named = await run('Watch Community Hub and report spam to the team')
      expect(named.sent).toEqual(['Spam wave seen'])
    },
  },
  {
    n: 15,
    name: "the supervisor's question carries an executable option: the answer does it and the outcome is recorded",
    async run() {
      const i = await rig({
        researcher: [
          report({ status: 'failed', summary: 'could not reach the source', outputs: [] }),
          report({ status: 'done', summary: 'all good', outputs: [] }),
        ],
      })
      const { deps } = i
      const agentId = i.ids.researcher
      const now = Date.now()
      const ask = async (title: string, action: Record<string, unknown>) =>
        askOwner(deps, agentId, { title, diagnosis: 'd', fix: 'f', action: action as never }, now)
      const openCard = (needle: string) =>
        deps.decisions
          .list({ status: 'open', agentId, limit: 50 })
          .find((d) => d.title.includes(needle)) as Decision
      const answer = async (needle: string, label: RegExp) => {
        const d = openCard(needle)
        const options = (d.payload as { options: string[] }).options
        expect(options).toHaveLength(2)
        const picked = options.find((o) => label.test(o)) as string
        return (await approveDecision(deps, d.id, { choice: picked })).outcome?.effect as string
      }

      // an action the server cannot do now is refused with a reason, nothing is raised
      expect(await ask('Nothing there', { kind: 'retry-run', target: 'no-such-run' })).toContain(
        'Not asked',
      )
      expect(deps.decisions.list({ status: 'open', agentId, limit: 50 })).toHaveLength(0)

      // retry a failed run
      const p = await createProgramHttp(i.app)
      expect((await i.app.request(`/programs/${p.id}/run`, json('POST'))).status).toBe(202)
      await until('the run failed', async () => runEnded((await runsOf(i.app, p.id))[0]))
      const failed = (await runsOf(i.app, p.id))[0] as RunView
      expect(await ask('Retry the digest', { kind: 'retry-run', target: failed.id })).toContain(
        'Asked',
      )
      expect(await answer('Retry the digest', /^Retry/)).toContain('Retried')
      await until('the retry ran', () => (i.models.researcher?.calls.length ?? 0) >= 2)

      // pause a routine
      const routine = createRoutine(deps, {
        agentId,
        name: 'Noisy check',
        prompt: 'Check the thing',
        schedule: { kind: 'every', everyMs: 3_600_000 },
      })
      await ask('Pause the noisy check', { kind: 'pause-routine', target: routine.id })
      expect(await answer('Pause the noisy', /^Pause/)).toContain('Paused routine')
      expect(deps.routines.get(routine.id)?.status).toBe('paused')

      // remove a standing order
      const added = await addOrder(deps, agentId, {
        text: 'Watch the old channel',
        by: 'web:owner',
        name: 'Owner',
        role: 'owner',
        report: { kind: 'web', sessionId: `dm:${agentId}` },
        mention: false,
      })
      await ask('Remove the old order', { kind: 'remove-order', target: added.order.id })
      expect(await answer('Remove the old order', /^Remove/)).toContain('Removed order')
      expect((await listOrders(deps, agentId)).map((o) => o.id)).not.toContain(added.order.id)

      // propose a program change: the answer creates the change card
      await ask('Add a tool', { kind: 'propose-program-tool', target: p.id, tool: 'list_tasks' })
      expect(await answer('Add a tool', /^Propose/)).toContain('Created the change card')
      const card = deps.decisions.list({ status: 'open', kind: 'change', limit: 20 })[0]
      expect(card?.payload).toMatchObject({ programId: p.id })

      // the one-click fix of a consistency finding, asked by its fingerprint
      deps.programs.update(
        p.id,
        {
          authority: withTool(deps, p.id, 'list_tasks'),
          forbidden: ['list_tasks'],
        },
        Date.now(),
      )
      const found = (await consistencyFindings(deps, { agentId })).find((f) =>
        f.fingerprint.includes(':forbidden:'),
      )
      await ask('Allow the tool', {
        kind: 'fix-finding',
        target: `supervisor:consistency:${found?.fingerprint}`,
      })
      expect(await answer('Allow the tool', /Allow/)).toContain('Forbidden')
      expect(deps.programs.get(p.id)?.forbidden).toEqual([])

      // "Leave it" changes nothing (another agent: the cap is five questions a day per agent)
      const another = createRoutine(deps, {
        agentId: i.ids.writer,
        name: 'Second check',
        prompt: 'Check another thing',
        schedule: { kind: 'every', everyMs: 3_600_000 },
      })
      await askOwner(
        deps,
        i.ids.writer,
        {
          title: 'Pause again',
          diagnosis: 'd',
          fix: 'f',
          action: { kind: 'pause-routine', target: another.id },
        },
        now,
      )
      const leave = deps.decisions.list({
        status: 'open',
        agentId: i.ids.writer,
        limit: 5,
      })[0] as Decision
      const left = await approveDecision(deps, leave.id, { choice: 'Leave it' })
      expect(left.outcome?.effect).toBe('Nothing was changed.')
      expect(deps.routines.get(another.id)?.status).toBe('active')
    },
  },
  {
    n: 16,
    name: 'the Health page offers a one-click fix only where it is unambiguous, and the fix needs a confirmation',
    async run() {
      const i = await rig({ researcher: [] })
      const { deps, app } = i
      const agentId = i.ids.researcher
      const list = async () => {
        // the page reuses a scan for minutes: this test changes the workspace between reads
        forgetConsistency(deps)
        return (
          (await (await app.request('/agent-health/findings?kind=consistency')).json()) as {
            findings: Array<{
              fingerprint: string
              consistency: { kind: string }
              fixAction?: { kind: string; label: string; confirm: string } | null
            }>
          }
        ).findings
      }
      const fixOf = async (kind: string) => (await list()).find((f) => f.consistency.kind === kind)
      const fix = (fp: string, body: unknown) =>
        app.request(`/agent-health/findings/${encodeURIComponent(fp)}/fix`, json('POST', body))

      // granted and forbidden: take it out of Forbidden
      const both = await createProgramHttp(app, { name: 'Report builder' })
      deps.programs.update(
        both.id,
        {
          authority: withTool(deps, both.id, 'list_tasks'),
          forbidden: ['list_tasks'],
        },
        Date.now(),
      )
      const f1 = (await fixOf('program-needs-tool')) ?? (await list())[0]
      expect(f1?.fixAction).toMatchObject({ kind: 'unforbid' })
      expect(f1?.fixAction?.confirm).toContain('list_tasks')
      // no confirmation, no change
      expect((await fix(f1?.fingerprint ?? '', {})).status).toBe(400)
      expect(deps.programs.get(both.id)?.forbidden).toEqual(['list_tasks'])
      const done = await fix(f1?.fingerprint ?? '', { confirm: true })
      expect(done.status).toBe(200)
      expect(((await done.json()) as { outcome: string }).outcome).toContain('Forbidden')
      expect(deps.programs.get(both.id)?.forbidden).toEqual([])
      expect((await list()).some((f) => f.fingerprint === f1?.fingerprint)).toBe(false)
      deps.programs.delete(both.id)

      // two copies of a program: the one without runs goes, the other stays
      const brief = 'Summarise the library every morning and report what changed to the team'
      const keep = await createProgramHttp(app, { name: 'Morning summary', brief })
      const copy = await createProgramHttp(app, { name: 'Morning summary', brief })
      expect(deps.tasks.ofProgram(keep.id, 1)).toHaveLength(0)
      // both without runs and identical: the newer one is the copy
      const dup = await fixOf('program-duplicate')
      expect(dup?.fixAction).toMatchObject({ kind: 'delete-program' })
      expect((await fix(dup?.fingerprint ?? '', { confirm: true })).status).toBe(200)
      const left = deps.programs.list({}).filter((p) => p.name === 'Morning summary')
      expect(left).toHaveLength(1)
      expect([keep.id, copy.id]).toContain(left[0]?.id as string)

      // an order that says what a program note says
      const note = 'Send the weekly invoice reminders every Monday morning'
      const survivor = deps.programs.list({}).find((p) => p.name === 'Morning summary')
      if (survivor === undefined) throw new Error('no program left')
      const order = await addOrder(deps, agentId, {
        text: note,
        by: 'web:owner',
        name: 'Owner',
        role: 'owner',
        report: { kind: 'web', sessionId: `dm:${agentId}` },
        mention: false,
      })
      // the note arrives after the order (saving it first would be refused as a duplicate)
      deps.programs.update(survivor.id, { notes: [note] }, Date.now())
      const dupe = await fixOf('order-duplicates-note')
      expect(dupe?.fixAction).toMatchObject({ kind: 'remove-order' })
      expect((await fix(dupe?.fingerprint ?? '', { confirm: true })).status).toBe(200)
      expect((await listOrders(deps, agentId)).map((o) => o.id)).not.toContain(order.order.id)

      // two routines on one schedule with one prompt: the newer copy goes
      const spec = { kind: 'every', everyMs: 3_600_000 } as const
      createRoutine(deps, {
        agentId,
        name: 'Daily check',
        prompt: 'Check the video queue and report stuck items',
        schedule: spec,
      })
      createRoutine(deps, {
        agentId,
        name: 'Daily check again',
        prompt: 'Check the video queue and report stuck items',
        schedule: spec,
      })
      const rd = await fixOf('routine-duplicate')
      expect(rd?.fixAction).toMatchObject({ kind: 'delete-routine' })
      expect((await fix(rd?.fingerprint ?? '', { confirm: true })).status).toBe(200)
      expect(
        deps.routines.list({ agentId }).filter((r) => r.name.startsWith('Daily check')),
      ).toHaveLength(1)

      // both copies already fired: no safe choice, so no button and the click is refused
      const slow = { kind: 'every', everyMs: 7_200_000 } as const
      for (const name of ['Hourly sweep', 'Hourly sweep again']) {
        const r = createRoutine(deps, {
          agentId,
          name,
          prompt: 'Sweep the inbox and list new requests',
          schedule: slow,
        })
        i.server.conn.sqlite.query('UPDATE routines SET fire_count = 3 WHERE id = ?').run(r.id)
      }
      const both2 = await fixOf('routine-duplicate')
      expect(both2).toBeDefined()
      expect(both2?.fixAction ?? null).toBeNull()
      expect((await fix(both2?.fingerprint ?? '', { confirm: true })).status).toBe(409)
      expect((await fix('consistency:program-needs-tool:-:nope', { confirm: true })).status).toBe(
        404,
      )
    },
  },
]

describe('critical flows: a result must reach a person', () => {
  for (const row of rows) test(`${row.n}. ${row.name}`, row.run, 20_000)
})
