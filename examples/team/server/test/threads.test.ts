/**
 * Chat threads, briefings and the bell (docs/plans/P40-team-autonomous-operations.md, phase M):
 * thread CRUD (all threads equal), the migration of a single DM into the first thread, replies and
 * delegations that stay in their thread, the daily digest as a Briefing page, alerts in the bell
 * and "Discuss in chat" seeding. `app.request()` with scripted models only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { postAlerts, postDigest } from '../src/app/briefings.ts'
import { createProposal } from '../src/app/decisions.ts'
import type { Task } from '../src/domain/tasks.ts'
import type { Thread } from '../src/domain/threads.ts'
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
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'team-p40m-'))
  dirs.push(dir)
  return dir
}

type Slug = 'lead' | 'researcher'
interface Instance {
  server: Server
  app: Server['app']
  models: Record<string, ScriptedModel>
  leadId: string
}

function instance(
  dir: string,
  script: Partial<Record<Slug, ScriptedStepInput[]>>,
  options: { first?: boolean } = {},
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
    models: config,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
  })
  servers.push(server)
  if (options.first !== false) {
    for (const slug of ['lead', 'researcher']) {
      const def = server.deps.agents.getBySlug(slug)
      if (def === undefined) throw new Error('seed missing')
      updateAgent(server.deps, def.id, { model: `m-${slug}` })
    }
  }
  const leadId = server.deps.agents.getBySlug('lead')?.id as string
  return { server, app: server.app, models, leadId }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function threadsOf(i: Instance, query = ''): Promise<Thread[]> {
  const res = await i.app.request(`/agents/${i.leadId}/threads${query}`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: Thread[] }).threads
}
async function newThread(i: Instance, title?: string): Promise<Thread> {
  const res = await i.app.request(
    `/agents/${i.leadId}/threads`,
    json('POST', title === undefined ? {} : { title }),
  )
  expect(res.status).toBe(201)
  return (await res.json()) as Thread
}
async function say(i: Instance, sessionId: string, text: string): Promise<Response> {
  const res = await i.app.request(
    `/sessions/${sessionId}/chat`,
    postAs(sessionId, userMessage(text)),
  )
  await res.text()
  return res
}
async function messagesOf(i: Instance, sessionId: string): Promise<string> {
  const res = await i.app.request(`/sessions/${sessionId}/messages?limit=100`)
  expect(res.status).toBe(200)
  return JSON.stringify(((await res.json()) as { messages: unknown[] }).messages)
}

describe('thread CRUD: all threads are equal', () => {
  test('an agent starts with one thread; new chats are equal, named by their first message, renamed and archived', async () => {
    const i = instance(tmp(), { lead: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] })
    const first = await threadsOf(i)
    expect(first).toHaveLength(1)
    // the first thread has no special status: only its session id is the old one
    expect(first[0]).toMatchObject({
      sessionId: `dm:${i.leadId}`,
      source: 'web',
      sourceLabel: null,
      seed: null,
      archivedAt: null,
    })

    const a = await newThread(i)
    const b = await newThread(i, '  Q3   plan ')
    expect(a.sessionId).toBe(`chat:${i.leadId}:${a.id}`)
    expect(a.title).toBeNull() // named by its first message
    expect(b.title).toBe('Q3 plan')

    expect(
      (await say(i, a.sessionId, 'Where are the scripts for the October videos?')).status,
    ).toBe(200)
    await until('thread named', async () => {
      const t = (await threadsOf(i)).find((x) => x.id === a.id)
      return t?.title !== null && t?.preview !== null
    })
    const named = (await threadsOf(i)).find((x) => x.id === a.id) as Thread
    expect(named.title).toBe('Where are the scripts for the October videos?')
    expect(named.lastMessageAt).not.toBeNull()
    // the newest activity is first
    expect((await threadsOf(i))[0]?.id).toBe(a.id)

    // rename
    const renamed = await i.app.request(
      `/agents/${i.leadId}/threads/${b.id}`,
      json('PATCH', { title: 'Budget review' }),
    )
    expect(((await renamed.json()) as Thread).title).toBe('Budget review')
    expect(
      (await i.app.request(`/agents/${i.leadId}/threads/${b.id}`, json('PATCH', { title: '   ' })))
        .status,
    ).toBe(400)

    // the first thread archives like any other; a thread of another agent or an unknown id is a 404
    const archive = await i.app.request(
      `/agents/${i.leadId}/threads/${first[0]?.id}/archive`,
      json('POST'),
    )
    expect(((await archive.json()) as Thread).archivedAt).not.toBeNull()
    expect((await threadsOf(i)).map((t) => t.id)).not.toContain(first[0]?.id)
    const all = await threadsOf(i, '?archived=true')
    expect(all.at(-1)?.id).toBe(first[0]?.id) // archived ones come last
    const researcher = i.server.deps.agents.getBySlug('researcher')?.id
    expect(
      (await i.app.request(`/agents/${researcher}/threads/${b.id}`, json('PATCH', { title: 'x' })))
        .status,
    ).toBe(404)
    expect(
      (await i.app.request(`/agents/${i.leadId}/threads/nope/archive`, json('POST'))).status,
    ).toBe(404)

    // an archived thread keeps its history readable but takes no new message until restored
    const refused = await i.app.request(
      `/sessions/dm:${i.leadId}/chat`,
      postAs(`dm:${i.leadId}`, userMessage('hello?')),
    )
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'THREAD_ARCHIVED',
    )
    expect((await i.app.request(`/sessions/dm:${i.leadId}/messages`)).status).toBe(200)
    await i.app.request(`/agents/${i.leadId}/threads/${first[0]?.id}/restore`, json('POST'))
    expect((await threadsOf(i)).map((t) => t.id)).toContain(first[0]?.id as string)
  })

  test('threads keep separate histories, stats, tools and modes; a chat id without a thread is not a session', async () => {
    const i = instance(tmp(), { lead: [{ text: 'Alpha reply' }, { text: 'Beta reply' }] })
    const a = await newThread(i)
    const b = await newThread(i)
    await say(i, a.sessionId, 'alpha question')
    await say(i, b.sessionId, 'beta question')
    expect(await messagesOf(i, a.sessionId)).toContain('Alpha reply')
    expect(await messagesOf(i, a.sessionId)).not.toContain('Beta reply')
    expect(await messagesOf(i, b.sessionId)).toContain('beta question')

    // per-chat routes take the thread
    const statsA = (await (
      await i.app.request(`/agents/${i.leadId}/stats?thread=${a.id}`)
    ).json()) as { context: { messages: number } }
    const statsNew = (await (
      await i.app.request(`/agents/${i.leadId}/stats?thread=${(await newThread(i)).id}`)
    ).json()) as { context: { messages: number } }
    expect(statsA.context.messages).toBeGreaterThan(statsNew.context.messages)
    const put = await i.app.request(
      `/agents/${i.leadId}/mode?thread=${a.id}`,
      json('PUT', { mode: 'bypass' }),
    )
    expect(put.status).toBe(200)
    const modeA = (await (
      await i.app.request(`/agents/${i.leadId}/mode?thread=${a.id}`)
    ).json()) as {
      mode: string
    }
    const modeB = (await (
      await i.app.request(`/agents/${i.leadId}/mode?thread=${b.id}`)
    ).json()) as {
      mode: string
    }
    expect(modeA.mode).toBe('bypass')
    expect(modeB.mode).not.toBe('bypass')
    expect((await i.app.request(`/agents/${i.leadId}/stats?thread=missing`)).status).toBe(404)

    const ghost = await i.app.request(
      `/sessions/chat:${i.leadId}:ghost/chat`,
      postAs(`chat:${i.leadId}:ghost`, userMessage('hi')),
    )
    expect(ghost.status).toBe(404)
  })
})

describe('the first thread is named by its first message', () => {
  test('"Chat" gives way to the first words once, and a later message does not rename it', async () => {
    const i = instance(tmp(), { lead: [{ text: 'One' }, { text: 'Two' }] })
    const first = (await threadsOf(i))[0] as Thread
    expect(first.title).toBe('Chat')
    expect((await say(i, first.sessionId, 'Summarize your recent work')).status).toBe(200)
    await until('first thread named', async () => (await threadsOf(i))[0]?.title !== 'Chat')
    expect((await threadsOf(i))[0]?.title).toBe('Summarize your recent work')
    expect((await say(i, first.sessionId, 'Something else entirely')).status).toBe(200)
    await until(
      'second message stored',
      async () => (await threadsOf(i))[0]?.preview !== 'Summarize your recent work',
    )
    expect((await threadsOf(i))[0]?.title).toBe('Summarize your recent work')
  })
})

describe('workspace usage', () => {
  test('GET /usage counts chat turns from every thread and lists every source', async () => {
    const i = instance(tmp(), { lead: [{ text: 'One' }, { text: 'Two' }] })
    const other = await newThread(i)
    const first = (await threadsOf(i)).find((t) => t.id !== other.id) as Thread
    expect((await say(i, first.sessionId, 'first thread')).status).toBe(200)
    expect((await say(i, other.sessionId, 'second thread')).status).toBe(200)
    await until('both turns counted', async () => {
      const r = await i.app.request('/usage')
      const u = (await r.json()) as { bySource: Array<{ source: string; count: number }> }
      return (u.bySource.find((s) => s.source === 'chat')?.count ?? 0) >= 2
    })
    const u = (await (await i.app.request('/usage')).json()) as {
      bySource: Array<{ source: string }>
      agents: Array<{ id: string; bySource: unknown[] }>
    }
    expect(u.bySource.map((s) => s.source)).toEqual([
      'chat',
      'task',
      'delegated',
      'routine',
      'program',
      'heartbeat',
      'rehearsal',
      'other',
    ])
    expect(u.agents.find((a) => a.id === i.leadId)?.bySource).toHaveLength(8)
  })
})

describe('migration of the single DM', () => {
  test('a DM from before threads becomes the first thread; its history stays', async () => {
    const dir = tmp()
    const a = instance(dir, { lead: [{ text: 'Old answer' }] })
    expect((await say(a, `dm:${a.leadId}`, 'An old question')).status).toBe(200)
    await a.server.close()
    servers.splice(servers.indexOf(a.server), 1)

    // the database as it was before this phase: no thread tables, migration 0020 not applied
    const db = new Database(join(dir, 'team.db'))
    // (and the tables of the migrations after it: they would be created again by the replay)
    // Migrations after 0020 that ALTER a table (a column added to `agents`, `tasks`, ...) cannot be
    // undone by dropping tables: replaying them would fail with "duplicate column name". Their
    // columns are dropped first, newest migration first, so the replay starts from the 0019 shape.
    const migrations = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    const from = migrations.entries.findIndex((e) => e.tag.startsWith('0020_'))
    for (const entry of migrations.entries.slice(from).reverse()) {
      const sql = readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')
      const added = [...sql.matchAll(/ALTER TABLE `(\w+)` ADD (?:COLUMN )?`(\w+)`/g)].reverse()
      for (const [, table, column] of added) {
        const columns = db.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{
          name: string
        }>
        if (!columns.some((c) => c.name === column)) continue
        // SQLite refuses to drop a column an index still uses: drop those indexes first
        // (the replay of the migrations creates them again)
        const indexes = db.query(`PRAGMA index_list(\`${table}\`)`).all() as Array<{
          name: string
          origin: string
        }>
        for (const index of indexes) {
          if (index.origin !== 'c') continue
          const used = db.query(`PRAGMA index_info(\`${index.name}\`)`).all() as Array<{
            name: string
          }>
          if (used.some((u) => u.name === column)) db.run(`DROP INDEX \`${index.name}\``)
        }
        db.run(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``)
      }
    }
    for (const table of [
      'chat_threads',
      'notifications',
      'briefings',
      'channel_connections',
      'channel_conversations',
      'channel_messages',
      'channel_identities',
      'channel_pairing_tokens',
      'channel_outbox',
      'channel_approvals',
      'channel_known_chats',
      'channel_unlinked',
      'channel_inbox',
      'channel_events',
      'tgu_chats',
      'tgu_counters',
      'tgu_leases',
      'tgu_settings',
      'ch_meta',
      'ch_nodes',
      'ch_node_links',
      'ch_node_access',
      'ch_node_settings',
      'ch_identities',
      'ch_identity_aliases',
      'ch_identity_profiles',
      'ch_memberships',
      'ch_messages',
      'ch_message_revisions',
      'ch_reactions',
      'ch_events',
      'ch_node_sessions',
      'ch_people',
      'ch_reminders',
      'ch_proactive',
      'ch_people_notes',
      'agent_persona_versions',
      'agent_persona_proposals',
      'people_link_codes',
      'people_events',
      'people_accounts',
      'people',
      'artifact_events',
      'artifact_versions',
      'artifact_blobs',
      'artifacts',
      'browser_profiles',
      'turn_retries',
      'alarms',
      'api_agents',
      'api_keys',
      'api_conversations',
      'api_requests',
      'api_calls',
      'library_moves',
    ])
      db.run(`DROP TABLE IF EXISTS ${table}`)
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> }
    const since = journal.entries.find((e) => e.tag.startsWith('0020_'))?.when as number
    db.run('DELETE FROM __drizzle_migrations WHERE created_at >= ?', [since])
    db.close()

    const b = instance(dir, { lead: [{ text: 'New answer' }] }, { first: false })
    await b.server.ready
    const list = await threadsOf(b)
    expect(list).toHaveLength(1)
    expect(list[0]?.sessionId).toBe(`dm:${b.leadId}`)
    // nothing moved or copied: the old messages are readable, and the thread keeps working
    const old = await messagesOf(b, list[0]?.sessionId as string)
    expect(old).toContain('An old question')
    expect(old).toContain('Old answer')
    expect((await say(b, list[0]?.sessionId as string, 'A new question')).status).toBe(200)
    expect(await messagesOf(b, list[0]?.sessionId as string)).toContain('New answer')

    // a second pass changes nothing (idempotent), and a new chat is created beside it
    expect(await threadsOf(b)).toHaveLength(1)
    await newThread(b)
    expect(await threadsOf(b)).toHaveLength(2)
  })

  test('every agent (the roster too) gets its first thread at boot', async () => {
    const i = instance(tmp(), {})
    for (const agent of i.server.deps.agents.list({ includeArchived: true })) {
      expect(i.server.deps.threads.list(agent.id).map((t) => t.sessionId)).toEqual([
        `dm:${agent.id}`,
      ])
    }
  })
})

describe('work started from a thread', () => {
  test('a delegation from a thread reports back to that thread, not to another', async () => {
    const dir = tmp()
    const delegateBg = {
      toolName: 'agent',
      toolCallId: 'call-1',
      input: {
        subagent_type: 'researcher',
        description: 'Clean up',
        prompt: 'Remove /library/old.md',
        name: 'cleaner',
      },
    }
    const i = instance(dir, {
      lead: [
        { toolCalls: [delegateBg] },
        { text: 'Delegated.' },
        // the child parking on the person's answer is a stored notice (`onPark: 'notice'`, spec 20
        // §3.5), not a model call: the lead wakes once, when the child's report arrives
        { text: 'Report received.' },
      ],
      researcher: [
        { toolCalls: [{ toolName: 'delete_file', input: { path: '/library/old.md' } }] },
        { text: 'Done: handled old.md.' },
      ],
    })
    await libraryFs(i.server.conn.sqlite).write('/library/old.md', 'old\n')
    const other = await newThread(i, 'Another conversation')
    const t = await newThread(i, 'Library cleanup')
    await say(i, t.sessionId, 'Clean up the library')
    await until('delegated', async () => (await messagesOf(i, t.sessionId)).includes('Delegated.'))

    // the child session hangs under the thread; its approval is listed (the thread is an attention root)
    let waiting: Task[] = []
    await until('task waiting', async () => {
      waiting = (
        (await (await i.app.request('/tasks?status=needs_action')).json()) as { tasks: Task[] }
      ).tasks
      return waiting.length === 1
    })
    const task = waiting[0] as Task
    expect(task.parentSessionId).toBe(t.sessionId)
    expect(task.sessionId).toBe(`${t.sessionId}:agent:call-1`)
    const listed = (
      (await (await i.app.request('/approvals')).json()) as {
        approvals: Array<{ id: string; sessionId: string; parentSessionId: string | null }>
      }
    ).approvals
    expect(listed).toHaveLength(1)
    expect(listed[0]?.parentSessionId).toBe(t.sessionId)
    // the thread's panel lists it as delegated; the other thread's does not
    const mine = (await (
      await i.app.request(`/agents/${i.leadId}/sessions?thread=${t.id}`)
    ).json()) as {
      delegated: Task[]
    }
    const theirs = (await (
      await i.app.request(`/agents/${i.leadId}/sessions?thread=${other.id}`)
    ).json()) as {
      delegated: Task[]
    }
    expect(mine.delegated.map((x) => x.id)).toEqual([task.id])
    expect(theirs.delegated).toEqual([])

    const answered = await attn(i.app, listed[0] as never, { approved: true })
    expect(answered.status).toBe(200)
    await until('lead woke in its thread', async () =>
      (await messagesOf(i, t.sessionId)).includes('Report received.'),
    )
    expect(i.models.lead?.calls).toHaveLength(3)
    // the notice is in the thread (visible), the model read it together with the report
    expect(await messagesOf(i, t.sessionId)).toContain('is waiting for the user')
    expect(await messagesOf(i, other.sessionId)).not.toContain('Report received.')
    expect(await messagesOf(i, `dm:${i.leadId}`)).not.toContain('Report received.')
  })
})

describe('the daily digest and the bell', () => {
  test('the digest is one bell notification per day with the whole text', async () => {
    const i = instance(tmp(), {})
    const deps = i.server.deps
    expect(
      postDigest(deps, { day: '2026-10-12', body: '**Daily digest**\n- Video scripts', at: 1000 }),
    ).toBe(true)
    // idempotent per day
    expect(postDigest(deps, { day: '2026-10-12', body: 'again', at: 2000 })).toBe(false)
    const bell = (await (await i.app.request('/notifications')).json()) as {
      notifications: Array<{ id: string; kind: string; link: string | null; body: string }>
      open: number
    }
    expect(bell.open).toBe(1)
    expect(bell.notifications[0]).toMatchObject({ kind: 'briefing', link: null })
    expect(bell.notifications[0]?.body).toContain('Video scripts')
    // the page and its routes are gone
    expect((await i.app.request('/briefings')).status).toBe(404)
    const id = bell.notifications[0]?.id
    expect((await i.app.request(`/notifications/${id}/dismiss`, json('POST'))).status).toBe(200)
    expect(((await (await i.app.request('/notifications')).json()) as { open: number }).open).toBe(
      0,
    )
  })

  test('urgent findings are alerts, one each, once; dismiss one or all', async () => {
    const i = instance(tmp(), {})
    const deps = i.server.deps
    const beat = (title: string) => ({
      kind: 'budget.near',
      title,
      detail: 'Runs stop at the limit.',
      links: ['/settings'],
      urgent: true,
      fingerprint: `f-${title}`,
    })
    expect(
      postAlerts(deps, {
        agentId: i.leadId,
        beatId: 'b1',
        items: [beat('Budget 96%'), beat('Key expires')],
        at: 10,
      }),
    ).toBe(2)
    expect(
      postAlerts(deps, { agentId: i.leadId, beatId: 'b1', items: [beat('Budget 96%')], at: 11 }),
    ).toBe(0)
    const read = async () =>
      (await (await i.app.request('/notifications')).json()) as {
        notifications: Array<{ id: string; title: string }>
        open: number
      }
    const first = await read()
    expect(first.notifications.map((n) => n.title).sort()).toEqual(['Budget 96%', 'Key expires'])
    const one = first.notifications[0] as { id: string }
    expect((await i.app.request(`/notifications/${one.id}/dismiss`, json('POST'))).status).toBe(200)
    expect((await read()).open).toBe(1)
    const all = (await (
      await i.app.request('/notifications/dismiss-all', json('POST'))
    ).json()) as { dismissed: number }
    expect(all.dismissed).toBe(1)
    expect((await read()).open).toBe(0)
    expect((await i.app.request('/notifications/nope/dismiss', json('POST'))).status).toBe(404)
  })
})

describe('Discuss in chat', () => {
  const discuss = (i: Instance, body: Record<string, unknown>) =>
    i.app.request('/threads/discuss', json('POST', body))

  test('an alert and a run each open a NEW thread seeded with that context', async () => {
    const i = instance(tmp(), {})
    const deps = i.server.deps
    postAlerts(deps, {
      agentId: i.leadId,
      beatId: 'b1',
      items: [
        {
          kind: 'budget.near',
          title: 'Budget 96% used',
          detail: 'Runs stop at the limit.',
          links: ['/settings'],
          urgent: true,
          fingerprint: 'f1',
        },
      ],
      at: 1001,
    })
    const alert = deps.notifications.list({ open: true, limit: 10 }).find((n) => n.kind === 'alert')
    const before = (await threadsOf(i)).length

    const fromAlert = (await (await discuss(i, { kind: 'alert', ref: alert?.id })).json()) as Thread
    expect(await messagesOf(i, fromAlert.sessionId)).toContain('Runs stop at the limit.')

    // a run: its own session stays where it is; the thread only carries the context and a link
    createProposal(deps, {
      agentId: i.leadId,
      sessionId: null,
      title: 'x',
      runOnce: false,
      program: { name: 'p', brief: 'b' },
    })
    const queued = deps.tasks.enqueue({
      agentId: i.leadId,
      title: 'Write the October scripts',
      brief: 'b',
      inputs: [],
      priority: 'normal',
      dueAt: null,
      createdBy: 'client',
      now: 5,
    })
    const fromRun = (await (await discuss(i, { kind: 'run', ref: queued.id })).json()) as Thread
    const runText = await messagesOf(i, fromRun.sessionId)
    expect(runText).toContain('Write the October scripts')
    expect(runText).toContain(`/tasks/${queued.id}`)

    // always a new thread: the same alert again is another one, and nothing is created by events
    const again = (await (await discuss(i, { kind: 'alert', ref: alert?.id })).json()) as Thread
    expect(again.id).not.toBe(fromAlert.id)
    expect(await threadsOf(i)).toHaveLength(before + 3)

    expect((await discuss(i, { kind: 'alert', ref: 'missing' })).status).toBe(404)
  })

  test('creating a digest or an alert opens no thread by itself', async () => {
    const i = instance(tmp(), {})
    const before = (await threadsOf(i)).length
    postDigest(i.server.deps, { day: '2026-10-13', body: 'x', at: 1 })
    postAlerts(i.server.deps, {
      agentId: i.leadId,
      beatId: 'b',
      items: [{ kind: 'k', title: 't', detail: 'd', links: [], urgent: true, fingerprint: 'f' }],
      at: 2,
    })
    expect(await threadsOf(i)).toHaveLength(before)
  })
})
