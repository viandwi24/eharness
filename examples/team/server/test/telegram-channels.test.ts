/**
 * Telegram channels end to end on a fake Bot API: connect the bot through the connector flow,
 * bind it to an agent, discover chats, allow one, wake the agent by a mention, approvals with
 * inline buttons and a human summary, linking people without links, 401 -> needs-auth + bell, webhook, and the
 * rule that the token is never part of any response. Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { summarizeToolInput } from '../src/infra/channels/policy.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { resolveWebUrl } from '../src/infra/web-static.ts'
import { compose, type Server } from '../src/main.ts'
import { type FakeTelegram, fakeTelegram, tg } from './support/fake-telegram.ts'

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON of the API under test
type Json = Record<string, any>
const servers: Server[] = []
const fakes: FakeTelegram[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const f of fakes.splice(0)) f.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}

let portCounter = 0
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

async function boot(script: ScriptedStepInput[], webEnv: Record<string, string> = {}) {
  const fake = fakeTelegram(4921 + (portCounter++ % 8))
  fakes.push(fake)
  const dir = mkdtempSync(join(tmpdir(), 'team-tg-'))
  dirs.push(dir)
  const models: Record<string, ScriptedModel> = { lead: scriptedModel(script) }
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
    instanceId: 'tg-test',
    models: config,
    env: { TEAM_SECRET_KEY: key, TEAM_TELEGRAM_API_ROOT: fake.url, ...webEnv },
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    changePollMs: 0,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    publicUrl: 'http://api.test',
    ...(Object.keys(webEnv).length === 0 ? { webUrl: 'http://web.test' } : {}),
    telegram: { pollTimeoutSec: 1, syncPollMs: 0, retryMs: 0 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(5)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
      outbound: { sleep: async (ms: number) => void (await sleep(Math.min(ms, 5))) },
    },
  })
  servers.push(server)
  await server.connectorsReady
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  return { server, fake, models, leadId: def.id }
}

/** The node id of a chat the bot knows (`chat` or `chat/topic`, as Telegram names it). */
const node = (server: Server, id: string, native: string): string => {
  const n = server.channels.nodes.byNative(id, native)
  if (n === undefined) throw new Error(`no node ${native}`)
  return n.id
}
/** A chat the bot has not seen yet, as a node (the page lists nodes). */
const know = (server: Server, id: string, native: string, title: string, broadcast = false) =>
  server.channels.settings.ensureNode(id, {
    nativeId: native,
    kind: 'room',
    title,
    traits: { multiUser: !broadcast, broadcast },
  }).id

const call = async (server: Server, method: string, path: string, body?: unknown) => {
  const res = await server.app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as Json }
}

/** Connect the bot through the connector flow (the form takes the token). */
async function connectBot(server: Server, token: string): Promise<{ id: string; flow: Json }> {
  const started = await call(server, 'POST', '/connections/flows', {
    definitionId: 'telegram-bot',
    label: 'Team bot',
  })
  expect(started.status).toBe(201)
  const done = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
    viewId: started.json.flow.view.viewId,
    action: 'submit',
    data: { token },
  })
  expect(done.status).toBe(200)
  return { id: done.json.connection?.id as string, flow: done.json }
}

const view = async (server: Server, id: string) =>
  (await call(server, 'GET', `/channels/connections/${id}`)).json
const runningState = async (server: Server, id: string) => (await view(server, id)).runtime.state

const mention = (text = '@team_test_bot hello there', id = 1, chat = tg.group()) =>
  tg.message({
    chat,
    id,
    text,
    entities: [{ type: 'mention', offset: text.indexOf('@'), length: 14 }],
  })

describe('connect, bind, discover, wake', () => {
  test('the connector test reports the bot and explains privacy mode; the token is never returned', async () => {
    const { server, fake } = await boot([])
    const { id, flow } = await connectBot(server, fake.token)
    expect(flow.connection).toMatchObject({
      definitionId: 'telegram-bot',
      status: 'connected',
      accountLabel: '@team_test_bot',
    })
    const tested = await call(server, 'POST', `/connections/${id}/test`)
    expect(tested.json).toMatchObject({ ok: true, accountLabel: '@team_test_bot' })
    expect(tested.json.message).toContain('Privacy mode is on')
    expect(tested.text).not.toContain(fake.token)
    fake.setBot({ can_read_all_group_messages: true })
    expect((await call(server, 'POST', `/connections/${id}/test`)).json.message).toContain(
      'can read all messages',
    )
    const all = [
      JSON.stringify(flow),
      (await call(server, 'GET', '/connections')).text,
      tested.text,
      (await call(server, 'GET', '/channels/connections')).text,
      (await call(server, 'GET', `/channels/connections/${id}`)).text,
    ].join('\n')
    expect(all).not.toContain(fake.token)
    expect(all).not.toContain('FAKE_TOKEN')
  })

  test('a token Telegram rejects fails the test with guidance (no secret in the message)', async () => {
    const { server, fake } = await boot([])
    fake.revoke()
    const started = await call(server, 'POST', '/connections/flows', {
      definitionId: 'telegram-bot',
      label: 'x',
    })
    const done = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
      viewId: started.json.flow.view.viewId,
      action: 'submit',
      data: { token: fake.token },
    })
    expect(JSON.stringify(done.json)).toContain('Telegram rejected the token')
    expect(done.text).not.toContain(fake.token)
    const bad = await call(server, 'POST', `/connections/flows/${started.json.flow.id}/act`, {
      viewId: done.json.flow.view?.viewId ?? 'x',
      action: 'submit',
      data: { token: 'not-a-token' },
    })
    expect(bad.text).not.toContain('not-a-token-secret')
  })

  test('unbound -> bound starts polling; chats are discovered; allowing one wakes the agent on a mention', async () => {
    const { server, fake, leadId, models } = await boot([{ text: 'Hello from the lead' }])
    const { id } = await connectBot(server, fake.token)
    expect(await runningState(server, id)).toBe('unbound')
    expect(fake.callsOf('getUpdates')).toHaveLength(0)

    const bound = await call(server, 'PUT', `/channels/connections/${id}/binding`, {
      agentId: leadId,
    })
    expect(bound.status).toBe(200)
    expect(bound.json.binding).toMatchObject({
      agentId: leadId,
      groupPolicy: 'allowlist',
      dm: 'pairing',
    })
    expect(bound.json.runtime.state).toBe('running')
    expect(bound.json.bot).toMatchObject({
      username: 'team_test_bot',
      canReadAllGroupMessages: false,
    })
    expect(bound.json.bot.guidance).toContain('Privacy mode is on')

    // a chat the agent may not use yet: discovered, nothing wakes
    fake.push(mention())
    await until(
      'chat discovered',
      async () =>
        (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items.length === 1,
    )
    const chats = (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items
    expect(chats[0]).toMatchObject({
      nativeId: '-1001',
      title: 'Ops',
      kind: 'room',
      chatKind: 'group',
      policy: null,
      effective: { allowed: false },
    })
    await sleep(150)
    expect(models.lead?.prompts.length ?? 0).toBe(0)
    expect(fake.callsOf('sendMessage')).toHaveLength(0)

    // allow it (mention wake is the default)
    const allowed = await call(
      server,
      'PATCH',
      `/channels/connections/${id}/chats/${node(server, id, '-1001')}/policy`,
      { wake: 'mention', retentionDays: 7 },
    )
    expect(allowed.status).toBe(200)
    expect(allowed.json).toMatchObject({
      policy: { enabled: true, wake: 'mention', retentionDays: 7 },
      effective: { allowed: true, wake: 'mention', retentionDays: 7 },
    })
    fake.push(mention('@team_test_bot are you there?', 2))
    await until('the reply', () =>
      fake
        .callsOf('sendMessage')
        .some((c) => String(c.params.text).includes('Hello from the lead')),
    )
    const reply = fake
      .callsOf('sendMessage')
      .find((c) => String(c.params.text).includes('Hello from the lead'))
    expect(reply?.params).toMatchObject({ chat_id: -1001, reply_parameters: { message_id: 2 } })
    // the ack reaction went out
    await until('ack', () => fake.callsOf('setMessageReaction').length > 0)

    // taking it out of the allowlist
    const removed = await call(
      server,
      'DELETE',
      `/channels/connections/${id}/chats/${node(server, id, '-1001')}/policy`,
    )
    expect(removed.json.effective.allowed).toBe(false)
    const counts = (await view(server, id)).counts
    expect(counts.chats).toBe(1)
    expect(counts.outboxFailed).toBe(0)
  })

  test('forum topics are listed with their names and carry their own policy', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    const g = tg.group(-1002, 'Forum', { is_forum: true })
    fake.push(
      tg.message({
        chat: g,
        id: 40,
        text: 'hi',
        extra: {
          message_thread_id: 30,
          is_topic_message: true,
          reply_to_message: {
            message_id: 30,
            date: 1,
            chat: g,
            from: tg.user(1, 'Owner'),
            forum_topic_created: { name: 'Billing', icon_color: 1 },
          },
        },
      }),
    )
    await until(
      'topic seen',
      async () =>
        (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items.length === 2,
    )
    const items = (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items
    const forum = items.find((c: Json) => c.nativeId === '-1002')
    const topic = items.find((c: Json) => c.nativeId === '-1002/30')
    // a forum is a container that holds no messages of its own; its topics are its children
    expect(forum).toMatchObject({ kind: 'room', container: true, postable: false })
    expect(topic).toMatchObject({
      kind: 'thread',
      title: 'Billing',
      parentId: forum.id,
      policy: null,
    })
    // switch the forum on: the topic inherits it, and says where it comes from
    await call(server, 'PATCH', `/channels/connections/${id}/chats/${forum.id}/policy`, {
      wake: 'always',
    })
    const inherited = (
      await call(server, 'GET', `/channels/connections/${id}/chats`)
    ).json.items.find((c: Json) => c.id === topic.id)
    expect(inherited.effective).toMatchObject({ allowed: true, wake: 'always' })
    expect(inherited.inherited.wake).toEqual({ from: 'ancestor', nodeId: forum.id })
    // the topic differs on its own and the forum is untouched
    const set = await call(
      server,
      'PATCH',
      `/channels/connections/${id}/chats/${topic.id}/policy`,
      { wake: 'never' },
    )
    expect(set.status).toBe(200)
    expect(set.json.policy).toMatchObject({ wake: 'never' })
    expect(set.json.effective).toMatchObject({ wake: 'never', allowed: true })
    expect(set.json.inherited.wake).toEqual({ from: 'node', nodeId: topic.id })
    expect(
      (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items.find(
        (c: Json) => c.id === forum.id,
      ).effective.wake,
    ).toBe('always')
    // clearing it inherits again
    const cleared = await call(
      server,
      'DELETE',
      `/channels/connections/${id}/chats/${topic.id}/policy`,
    )
    expect(cleared.json.effective.wake).toBe('always')
    expect(
      (
        await call(server, 'PATCH', `/channels/connections/${id}/chats/no-such-node/policy`, {
          wake: 'never',
        })
      ).status,
    ).toBe(404)
  })

  test('without a binding a policy change is a 409; unbind stops the transport', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    const x = know(server, id, '-5', 'X')
    expect(
      (
        await call(server, 'PATCH', `/channels/connections/${id}/chats/${x}/policy`, {
          wake: 'always',
        })
      ).status,
    ).toBe(409)
    expect(
      (await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: 'nope' }))
        .status,
    ).toBe(400)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    expect(await runningState(server, id)).toBe('running')
    const off = await call(server, 'DELETE', `/channels/connections/${id}/binding`)
    expect(off.json.runtime.state).toBe('unbound')
    expect(off.json.binding).toBeNull()
  })
})

describe('linking people without links', () => {
  test('a stranger DM is silent and shows under "not linked yet"; link it, talk, unlink; link by id; ignore; the inbox and the activity tell the story', async () => {
    const { server, fake, leadId } = await boot([{ text: 'Hi Ana, I am here.' }])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    // the removed pairing route is gone
    expect((await call(server, 'POST', `/channels/connections/${id}/pairing`, {})).status).toBe(404)

    // a stranger's DM (and an old deep link) does nothing: no reply, no model call
    fake.push(tg.message({ chat: tg.dm(42), from: tg.user(42), id: 1, text: 'hello? SECRET-TEXT' }))
    fake.push(
      tg.message({
        chat: tg.dm(42),
        from: tg.user(42),
        id: 2,
        text: '/start oldtoken',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      }),
    )
    await until(
      'recorded',
      async () =>
        (await call(server, 'GET', `/channels/connections/${id}/unlinked`)).json.items[0]
          ?.messageCount === 2,
    )
    expect(fake.callsOf('sendMessage')).toHaveLength(0)
    const people = (await call(server, 'GET', `/channels/connections/${id}/unlinked`)).json.items
    expect(people).toMatchObject([{ peerId: '42', name: 'Ana', messageCount: 2, ignored: false }])
    expect(JSON.stringify(people)).not.toContain('SECRET')
    expect((await view(server, id)).counts).toMatchObject({ linked: 0, unlinked: 1 })

    // the owner links the account to a member
    const members = (await call(server, 'GET', `/channels/connections/${id}/members`)).json.items
    expect(members.map((m: Json) => m.id)).toContain('owner')
    const linked = await call(server, 'POST', `/channels/connections/${id}/links`, {
      peerId: '42',
      memberId: 'owner',
    })
    expect(linked.status).toBe(200)
    expect(linked.json).toMatchObject({ peerId: '42', memberId: 'owner', name: 'Ana' })
    expect((await call(server, 'GET', `/channels/connections/${id}/unlinked`)).json.items).toEqual(
      [],
    )
    // a bad id is refused by the schema
    expect(
      (
        await call(server, 'POST', `/channels/connections/${id}/links`, {
          peerId: 'abc',
          memberId: 'owner',
        })
      ).status,
    ).toBe(400)

    // the linked account can talk to the agent in a DM
    fake.push(tg.message({ chat: tg.dm(42), from: tg.user(42), id: 3, text: 'status please' }))
    await until('dm reply', () =>
      fake.callsOf('sendMessage').some((c) => String(c.params.text).includes('Hi Ana')),
    )

    // link by id for somebody we never saw; ignore another stranger
    expect(
      (
        await call(server, 'POST', `/channels/connections/${id}/links`, {
          peerId: '555',
          memberId: 'owner',
          name: 'Zed',
        })
      ).json,
    ).toMatchObject({ peerId: '555', name: 'Zed' })
    fake.push(tg.message({ chat: tg.dm(99, 'Eve'), from: tg.user(99, 'Eve'), id: 4, text: 'psst' }))
    await until(
      'eve seen',
      async () =>
        (await call(server, 'GET', `/channels/connections/${id}/unlinked`)).json.items.length === 1,
    )
    expect(
      (
        await call(server, 'PUT', `/channels/connections/${id}/unlinked/99/ignored`, {
          ignored: true,
        })
      ).status,
    ).toBe(204)
    expect(
      (
        await call(server, 'PUT', `/channels/connections/${id}/unlinked/1234/ignored`, {
          ignored: true,
        })
      ).status,
    ).toBe(404)
    expect((await call(server, 'GET', `/channels/connections/${id}/unlinked`)).json.items).toEqual(
      [],
    )
    expect(
      (await call(server, 'GET', `/channels/connections/${id}/unlinked?includeIgnored=true`)).json
        .items,
    ).toHaveLength(1)

    // the inbox: the DM with Ana (woke) and Eve's DM (dropped, not allowed to be answered)
    const inbox = (await call(server, 'GET', `/channels/connections/${id}/inbox`)).json
    const ana = inbox.items.find((c: Json) => c.conversationId === node(server, id, '42'))
    expect(ana).toMatchObject({ kind: 'dm', woke: 1, dropped: 2, agentId: leadId })
    expect(ana.threadId).toBeString()
    expect(ana.preview.text).toContain('Hi Ana')
    const log = (
      await call(
        server,
        'GET',
        `/channels/connections/${id}/inbox/messages?conversationId=${node(server, id, '42')}`,
      )
    ).json
    expect(log.items.map((m: Json) => [m.text, m.self])).toEqual([
      ['status please', false],
      ['Hi Ana, I am here.', true],
    ])
    expect(
      (await call(server, 'GET', `/channels/connections/${id}/inbox/messages?conversationId=nope`))
        .status,
    ).toBe(404)
    // the activity says what happened, without any message text
    const act = (await call(server, 'GET', `/channels/connections/${id}/activity?limit=50`)).json
    const types = act.items.map((e: Json) => e.type)
    expect(types).toContain('woke')
    expect(types).toContain('reply-sent')
    expect(act.items.filter((e: Json) => e.type === 'dropped').map((e: Json) => e.reason)).toEqual([
      'unlinked-sender',
      'unlinked-sender',
      'unlinked-sender',
    ])
    expect(JSON.stringify(act)).not.toContain('SECRET')
    expect(
      (await call(server, 'GET', `/channels/connections/${id}/activity?type=woke`)).json.items,
    ).toHaveLength(1)
    expect(
      (await call(server, 'GET', `/channels/connections/${id}/activity?type=bogus`)).status,
    ).toBe(400)

    expect((await call(server, 'DELETE', `/channels/connections/${id}/links/42`)).status).toBe(204)
    expect((await call(server, 'DELETE', `/channels/connections/${id}/links/42`)).status).toBe(404)
    // an unknown connection
    expect((await call(server, 'GET', '/channels/connections/nope/inbox')).status).toBe(404)
  })

  test('"reply to unknown people" is a per-connection switch (off by default)', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    const bound = await call(server, 'PUT', `/channels/connections/${id}/binding`, {
      agentId: leadId,
    })
    expect(bound.json.binding.replyToUnknown).toBe(false)
    fake.push(tg.message({ chat: tg.dm(7, 'Gus'), from: tg.user(7, 'Gus'), id: 1, text: 'hi' }))
    await until('seen', async () => (await view(server, id)).counts.unlinked === 1)
    expect(fake.callsOf('sendMessage')).toHaveLength(0)
    const on = await call(server, 'PUT', `/channels/connections/${id}/binding`, {
      agentId: leadId,
      replyToUnknown: true,
    })
    expect(on.json.binding.replyToUnknown).toBe(true)
    fake.push(tg.message({ chat: tg.dm(8, 'Hal'), from: tg.user(8, 'Hal'), id: 2, text: 'hello' }))
    await until('neutral reply', () => fake.callsOf('sendMessage').length === 1)
    expect(String(fake.callsOf('sendMessage')[0]?.params.text)).toContain("can't chat")
  })
})

describe('the tables of the Channels pages (HTTP)', () => {
  test('chats, people, inbox, activity and reminders come as { items, total, page, limit } with SQL filters, sort and paging', async () => {
    const { server, fake, leadId } = await boot([{ text: 'ok' }])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    const api = (path: string) => call(server, 'GET', `/channels/connections/${id}${path}`)

    // chats: a few places, one allowed, and a forum with two topics
    know(server, id, '-2001', 'Alpha')
    know(server, id, '-2002', 'Beta')
    know(server, id, '-2003', 'News', true)
    // a forum is a container: the adapter says so with its traits
    const forum = server.channels.settings.ensureNode(id, {
      nativeId: '-2004',
      kind: 'room',
      title: 'Forum',
      traits: { multiUser: true, container: true, threadsOnly: true, postable: false },
    }).id
    for (const [n, t] of [
      ['1', 'Produksi'],
      ['2', 'Sales'],
    ] as const)
      server.channels.settings.ensureNode(
        id,
        { nativeId: `-2004/${n}`, kind: 'thread', title: t },
        '-2004',
      )
    await call(
      server,
      'PATCH',
      `/channels/connections/${id}/chats/${node(server, id, '-2001')}/policy`,
      {
        wake: 'always',
      },
    )

    const chats = await api('/chats/table?sort=title&order=asc&limit=3')
    expect(chats.status).toBe(200)
    expect(chats.json).toMatchObject({ total: 4, page: 1, limit: 3 })
    expect(chats.json.items.map((c: Json) => c.title)).toEqual(['Alpha', 'Beta', 'Forum'])
    expect((await api('/chats/table?sort=title&order=asc&limit=3&page=2')).json.items).toHaveLength(
      1,
    )
    expect((await api('/chats/table?allowed=yes')).json.items.map((c: Json) => c.title)).toEqual([
      'Alpha',
    ])
    expect((await api('/chats/table?kind=channel')).json.items.map((c: Json) => c.title)).toEqual([
      'News',
    ])
    expect((await api('/chats/table?q=ALP')).json.total).toBe(1)
    const topics = await api(`/chats/table?level=topic&parentId=${forum}`)
    expect(topics.json.items.map((c: Json) => c.title).sort()).toEqual(['Produksi', 'Sales'])
    expect(topics.json.items[0]).toMatchObject({ kind: 'thread' })
    expect((await api('/chats/table?level=all')).json.total).toBe(6)
    // a forum says how many topics it has; one chat has its own address
    const forumView = await api(`/chats/${forum}`)
    expect(forumView.status).toBe(200)
    expect(forumView.json).toMatchObject({ title: 'Forum', container: true, topics: 2 })
    expect((await api('/chats/no-such-node')).status).toBe(404)
    // the schema refuses a bad sort or a page size over 100
    expect((await api('/chats/table?sort=title;drop')).status).toBe(400)
    expect((await api('/chats/table?limit=101')).status).toBe(400)

    // people: three strangers write directly
    for (const [n, name] of [
      [11, 'Cora'],
      [12, 'Budi'],
      [13, 'Ana'],
    ] as const)
      fake.push(
        tg.message({ chat: tg.dm(n), from: tg.user(n, name), id: n, text: `hello ${name}` }),
      )
    await until('three people', async () => (await api('/people/table')).json.total === 3)
    const people = await api('/people/table?sort=name&order=asc&limit=2')
    expect(people.json).toMatchObject({ total: 3, page: 1, limit: 2 })
    expect(people.json.items.map((p: Json) => p.name)).toEqual(['Ana', 'Budi'])
    expect(people.json.items[0]).toMatchObject({ peerId: '13', directMessages: 1, ignored: false })
    expect((await api('/people/table?linked=no')).json.total).toBe(3)
    await call(server, 'POST', `/channels/connections/${id}/links`, {
      peerId: '12',
      memberId: 'owner',
    })
    expect((await api('/people/table?linked=yes')).json.items.map((p: Json) => p.peerId)).toEqual([
      '12',
    ])
    await call(server, 'PUT', `/channels/connections/${id}/people/11/role`, { role: 'admin' })
    expect((await api('/people/table?role=admin')).json.items.map((p: Json) => p.peerId)).toEqual([
      '11',
    ])
    expect((await api('/people/table?q=%40cora')).json.total).toBe(1)
    expect((await api('/people/11')).json).toMatchObject({
      peerId: '11',
      role: 'admin',
      explicit: true,
    })
    expect((await api('/people/999')).status).toBe(404)

    // inbox and activity: the DMs are conversations with events
    await until('three conversations', async () => (await api('/inbox/table')).json.total === 3)
    const inbox = await api('/inbox/table?kind=dm&sort=title&order=asc&limit=2')
    expect(inbox.json).toMatchObject({ total: 3, page: 1, limit: 2 })
    expect(inbox.json.items).toHaveLength(2)
    expect((await api('/inbox/table?kind=group')).json.total).toBe(0)
    expect((await api('/inbox/table?q=zzzz')).json.total).toBe(0)
    const activity = await api('/activity/table?limit=2')
    expect(activity.json.total).toBeGreaterThanOrEqual(3)
    expect(activity.json.items).toHaveLength(2)
    expect(
      (await api('/activity/table?peerId=11&type=dropped')).json.items.every(
        (e: Json) => e.peerId === '11' && e.type === 'dropped',
      ),
    ).toBe(true)
    expect(JSON.stringify(activity.json)).not.toContain('hello')

    // reminders: none yet; an unknown connection is a 404
    expect((await api('/reminders/table')).json).toMatchObject({ items: [], total: 0, page: 1 })
    expect((await call(server, 'GET', '/channels/connections/nope/people/table')).status).toBe(404)
  })
})

describe('approvals in a Telegram chat', () => {
  const post: ScriptedStepInput = {
    toolCalls: [
      {
        toolName: 'channel_send',
        input: {
          action: 'send',
          conversation: '-1002',
          text: 'Release notes are live.',
          token: 'sk-SECRETSECRETSECRET1234',
        },
        toolCallId: 'a1',
      },
    ],
  }

  test('the request shows a short summary (no raw JSON, no secrets) with Approve/Deny buttons; pressing approves', async () => {
    const { server, fake, leadId } = await boot([post, { text: 'Posted it.' }])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    // the news channel (observe only) and the ops group, both known
    const news = know(server, id, '-1002', 'News', true)
    const ops = know(server, id, '-1001', 'Ops')
    await call(server, 'PATCH', `/channels/connections/${id}/chats/${news}/policy`, {
      wake: 'never',
    })
    await call(server, 'PATCH', `/channels/connections/${id}/chats/${ops}/policy`, {
      wake: 'mention',
    })
    // Ana is the owner's account
    await call(server, 'POST', `/channels/connections/${id}/links`, {
      peerId: '42',
      memberId: 'owner',
    })

    fake.push(mention('@team_test_bot publish the notes', 7))
    await until('the request', () =>
      fake.callsOf('sendMessage').some((c) => c.params.reply_markup !== undefined),
    )
    const ask = fake.callsOf('sendMessage').find((c) => c.params.reply_markup !== undefined) as {
      params: Json
    }
    const text = String(ask.params.text)
    expect(text).toContain('channel_send')
    expect(text).toContain('conversation: -1002')
    expect(text).toContain('text: Release notes are live.')
    expect(text).not.toContain('{"')
    expect(text).not.toContain('SECRET')
    const approve = (ask.params.reply_markup.inline_keyboard[0] as Json[])[0] as Json
    expect(approve.callback_data).toStartWith('approve:')
    expect(approve.callback_data.length).toBeLessThanOrEqual(64)
    expect(fake.callsOf('sendMessage').some((c) => c.params.chat_id === -1002)).toBe(false)

    fake.push({
      callback_query: {
        id: 'cb-1',
        from: tg.user(42),
        chat_instance: 'c',
        data: approve.callback_data,
        message: {
          message_id: 600,
          date: 9,
          chat: tg.group(),
          from: { id: 777, is_bot: true, first_name: 'Team Bot' },
        },
      },
    })
    await until('callback answered', () =>
      fake.callsOf('answerCallbackQuery').some((c) => c.params.callback_query_id === 'cb-1'),
    )
    await until('the post', () =>
      fake.callsOf('sendMessage').some((c) => c.params.chat_id === -1002),
    )
    await until('final reply', () =>
      fake.callsOf('sendMessage').some((c) => String(c.params.text) === 'Posted it.'),
    )
    // the request is edited to say how it ended
    await until('edited', () => fake.callsOf('editMessageText').length === 1)
    expect(String(fake.callsOf('editMessageText')[0]?.params.text)).toContain('Approved')
  })
})

describe('failures', () => {
  test('a revoked token while running: needs-auth on the connection, a bell, the transport stops', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    expect(await runningState(server, id)).toBe('running')
    fake.revoke()
    await until('needs-auth', async () => (await runningState(server, id)) === 'needs-auth', 10_000)
    const conn = (await call(server, 'GET', '/connections')).json.connections.find(
      (c: Json) => c.id === id,
    )
    expect(conn?.status).toBe('needs-auth')
    const bell = server.deps.notifications.list({ open: true, limit: 50 })
    expect(JSON.stringify(bell)).toContain('needs a new token')
    expect(JSON.stringify(bell)).not.toContain(fake.token)
    expect(server.channels.connections().find((c) => c.connectionId === id)?.connected).toBe(false)
  })

  test('a webhook blocks polling until the admin removes it', async () => {
    const { server, fake, leadId } = await boot([])
    fake.setWebhook('https://example.com/hook')
    const { id } = await connectBot(server, fake.token)
    const bound = await call(server, 'PUT', `/channels/connections/${id}/binding`, {
      agentId: leadId,
    })
    expect(bound.json.runtime.state).toBe('webhook')
    expect(bound.json.webhookUrl).toBe('https://example.com/hook')
    expect(fake.callsOf('deleteWebhook')).toHaveLength(0)
    const fixed = await call(server, 'POST', `/channels/connections/${id}/webhook/delete`)
    expect(fixed.json.runtime.state).toBe('running')
    expect(fake.callsOf('deleteWebhook')).toHaveLength(1)
  })

  test('the outbound breaker can be closed by hand and the outbox counts show', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    const v = await view(server, id)
    expect(v.counts).toMatchObject({ outboxPending: 0, outboxFailed: 0 })
    expect(v.breaker).toBeUndefined()
    expect((await call(server, 'POST', `/channels/connections/${id}/breaker/reset`)).status).toBe(
      200,
    )
    expect(
      (await call(server, 'POST', `/channels/connections/${id}/restart`)).json.runtime.state,
    ).toBe('running')
    expect((await call(server, 'GET', '/channels/connections/nope')).status).toBe(404)
  })

  test('messages that need a look: list, send again, dismiss', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    const base = `/channels/connections/${id}/outbox`
    expect((await call(server, 'GET', `${base}/attention`)).json).toEqual({ items: [] })
    const [lost, again] = await server.channels.outbox.enqueue(
      ['lost', 'again'].map((text, i) => ({
        connectionId: id,
        conversationId: `n${i}`,
        kind: 'reply' as const,
        triggerId: text,
        chunkIndex: 0,
        chunkCount: 1,
        text,
      })),
      Date.now(),
    )
    server.channels.outbox.markFailed(lost as string, 'boom', Date.now())
    server.channels.outbox.markFailed(again as string, 'boom', Date.now())
    const list = await call(server, 'GET', `${base}/attention?limit=1`)
    expect(list.json.items).toHaveLength(1)
    expect(list.json.next).toBeDefined()
    expect((await view(server, id)).counts).toMatchObject({ outboxFailed: 2, outboxHeld: 0 })
    expect((await call(server, 'POST', `${base}/${lost}/dismiss`)).status).toBe(204)
    expect((await call(server, 'POST', `${base}/${lost}/dismiss`)).status).toBe(409)
    expect((await call(server, 'POST', `${base}/nope/retry`)).status).toBe(404)
    expect((await call(server, 'POST', `${base}/${again}/retry`)).status).toBe(204)
  })
})

describe('part A: approval summary and the web link', () => {
  test('summarizeToolInput: what and where first, long values clipped, secrets never shown', () => {
    const text = summarizeToolInput({
      text: 'x'.repeat(500),
      conversation: '-1002',
      apiKey: 'abc',
      note: 'token sk-ABCDEFGHIJKLMNOPQRSTUV and 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      nested: { a: 1 },
      list: [1, 2],
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('conversation: -1002')
    expect(lines[1]).toMatch(/^text: x{100,}…$/)
    expect(text).not.toContain('abc')
    expect(text).not.toContain('sk-ABC')
    expect(text).not.toContain('AAAAAAAAAA')
    expect(text).toContain('[hidden]')
    expect(text).toContain('nested: (details in the web app)')
    expect(text).toContain('list: 2 items')
    expect(text).toContain('not shown')
    expect(summarizeToolInput({})).toBe('')
    expect(summarizeToolInput(undefined)).toBe('')
  })

  test('the web url: explicit, TEAM_WEB_URL, the server itself with TEAM_WEB_DIR, else the dev server', () => {
    const publicUrl = 'https://team.example.com'
    expect(resolveWebUrl({ env: {}, publicUrl })).toBe('http://localhost:5173')
    expect(resolveWebUrl({ env: { TEAM_WEB_URL: 'https://app.example.com/' }, publicUrl })).toBe(
      'https://app.example.com',
    )
    expect(resolveWebUrl({ env: { TEAM_WEB_DIR: '/srv/web' }, publicUrl })).toBe(publicUrl)
    // the image's TEAM_PUBLIC_URL names the API: the web is the same host without /api
    expect(
      resolveWebUrl({
        env: { TEAM_WEB_DIR: '/srv/web' },
        publicUrl: 'https://team.example.com/api',
      }),
    ).toBe('https://team.example.com')
    expect(
      resolveWebUrl({
        env: { TEAM_WEB_DIR: '/srv/web', TEAM_WEB_URL: 'https://other' },
        publicUrl,
      }),
    ).toBe('https://other')
    expect(
      resolveWebUrl({ configured: 'http://web.test/', env: { TEAM_WEB_DIR: '/x' }, publicUrl }),
    ).toBe('http://web.test')
  })

  test('with TEAM_WEB_DIR the web app is on the server origin: that is the link in channel messages', async () => {
    const { server } = await boot([], { TEAM_WEB_DIR: '/nonexistent-but-set' })
    expect(server.deps.webUrl).toBe('http://api.test')
    const other = await boot([], { TEAM_WEB_URL: 'https://app.example.com' })
    expect(other.server.deps.webUrl).toBe('https://app.example.com')
  })
})
