/**
 * Telegram channels end to end on a fake Bot API: connect the bot through the connector flow,
 * bind it to an agent, discover chats, allow one, wake the agent by a mention, approvals with
 * inline buttons and a human summary, employee pairing, 401 -> needs-auth + bell, webhook, and the
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
      chatId: '-1001',
      title: 'Ops',
      kind: 'group',
      policy: null,
      effective: { allowed: false },
    })
    await sleep(150)
    expect(models.lead?.prompts.length ?? 0).toBe(0)
    expect(fake.callsOf('sendMessage')).toHaveLength(0)

    // allow it (mention wake is the default)
    const allowed = await call(server, 'PATCH', `/channels/connections/${id}/chats/-1001/policy`, {
      wake: 'mention',
      retentionDays: 7,
    })
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
    const removed = await call(server, 'DELETE', `/channels/connections/${id}/chats/-1001/policy`)
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
        (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items[0]?.topics
          .length === 1,
    )
    const chat = (await call(server, 'GET', `/channels/connections/${id}/chats`)).json.items[0]
    expect(chat).toMatchObject({
      forum: true,
      topics: [{ id: '30', name: 'Billing', policy: null }],
    })
    const set = await call(
      server,
      'PATCH',
      `/channels/connections/${id}/chats/-1002/policy?topic=30`,
      { wake: 'never' },
    )
    expect(set.status).toBe(200)
    expect(set.json.topics[0].policy).toMatchObject({ wake: 'never' })
    expect(
      (
        await call(server, 'PATCH', `/channels/connections/${id}/chats/-1002/policy?topic=99`, {
          wake: 'never',
        })
      ).status,
    ).toBe(404)
  })

  test('without a binding a policy change is a 409; unbind stops the transport', async () => {
    const { server, fake, leadId } = await boot([])
    const { id } = await connectBot(server, fake.token)
    server.telegram.known.see(id, { chatId: '-5', kind: 'group', title: 'X', forum: false, at: 1 })
    expect(
      (
        await call(server, 'PATCH', `/channels/connections/${id}/chats/-5/policy`, {
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

describe('pairing employees', () => {
  test('a link is issued, redeemed with /start in a DM, listed and revoked; a stranger is ignored', async () => {
    const { server, fake, leadId, models } = await boot([{ text: 'Hi Ana, I am here.' }])
    const { id } = await connectBot(server, fake.token)
    await call(server, 'PUT', `/channels/connections/${id}/binding`, { agentId: leadId })
    const issued = await call(server, 'POST', `/channels/connections/${id}/pairing`, {
      memberId: 'owner',
    })
    expect(issued.status).toBe(200)
    expect(issued.json.link).toStartWith('https://t.me/team_test_bot?start=')
    const token = issued.json.link.split('start=')[1] as string
    expect(token.length).toBeLessThanOrEqual(64)

    // a stranger's DM does nothing
    fake.push(
      tg.message({ chat: tg.dm(99, 'Eve'), from: tg.user(99, 'Eve'), id: 1, text: 'hello?' }),
    )
    await sleep(200)
    expect(models.lead?.prompts.length ?? 0).toBe(0)

    fake.push(
      tg.message({
        chat: tg.dm(42),
        from: tg.user(42),
        id: 2,
        text: `/start ${token}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      }),
    )
    await until(
      'linked',
      async () =>
        (await call(server, 'GET', `/channels/connections/${id}/links`)).json.items.length === 1,
    )
    const link = (await call(server, 'GET', `/channels/connections/${id}/links`)).json.items[0]
    expect(link).toMatchObject({ peerId: '42', memberId: 'owner', name: 'Ana' })
    expect(
      JSON.stringify((await call(server, 'GET', `/channels/connections/${id}/links`)).json),
    ).not.toContain(token)
    await until('welcome', () =>
      fake.callsOf('sendMessage').some((c) => String(c.params.text).includes('linked to the team')),
    )

    // the linked account can talk to the agent in a DM
    fake.push(tg.message({ chat: tg.dm(42), from: tg.user(42), id: 3, text: 'status please' }))
    await until('dm reply', () =>
      fake.callsOf('sendMessage').some((c) => String(c.params.text).includes('Hi Ana')),
    )

    expect((await call(server, 'DELETE', `/channels/connections/${id}/links/42`)).status).toBe(204)
    expect((await call(server, 'DELETE', `/channels/connections/${id}/links/42`)).status).toBe(404)
    expect((await view(server, id)).counts.linked).toBe(0)
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
    server.telegram.known.see(id, {
      chatId: '-1002',
      kind: 'channel',
      title: 'News',
      forum: false,
      at: 1,
    })
    server.telegram.known.see(id, {
      chatId: '-1001',
      kind: 'group',
      title: 'Ops',
      forum: false,
      at: 1,
    })
    await call(server, 'PATCH', `/channels/connections/${id}/chats/-1002/policy`, { wake: 'never' })
    await call(server, 'PATCH', `/channels/connections/${id}/chats/-1001/policy`, {
      wake: 'mention',
    })
    // Ana is the owner's account
    const issued = await call(server, 'POST', `/channels/connections/${id}/pairing`, {
      memberId: 'owner',
    })
    const token = issued.json.link.split('start=')[1]
    fake.push(
      tg.message({
        chat: tg.dm(42),
        from: tg.user(42),
        id: 1,
        text: `/start ${token}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      }),
    )
    await until('linked', async () => (await view(server, id)).counts.linked === 1)

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
