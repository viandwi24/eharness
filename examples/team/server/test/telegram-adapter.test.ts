/**
 * The Telegram Bot API adapter against a fake Bot API on a local port (polling under Bun through
 * grammY + the runner, normalization, outbound, rate limits, 401, webhook, file cap, privacy).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mentionToken } from '../src/infra/channels/mentions.ts'
import { traitsOf } from '../src/infra/channels/model.ts'
import type {
  AdapterHost,
  ChannelError,
  ChannelNode,
  RemoteEvent,
} from '../src/infra/channels/types.ts'
import {
  ALLOWED_UPDATES,
  createTelegramAdapter,
  mapTelegramError,
  nativeActions,
  scrubToken,
  type TelegramAdapter,
  type TelegramAdapterOptions,
  TelegramSetupError,
} from '../src/infra/telegram/adapter.ts'
import { escapeHtml, htmlChunks, toTelegramHtml } from '../src/infra/telegram/format.ts'
import { type FakeTelegram, fakeTelegram, tg } from './support/fake-telegram.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(10)
  }
}

/** What the gateway offers an adapter: everything allowed, nothing stored. */
const host: AdapterHost = { isAllowed: () => true, locate: () => [], isOwn: () => false }

let nextPort = 0
const fakes: FakeTelegram[] = []
const adapters: TelegramAdapter[] = []
afterEach(async () => {
  for (const a of adapters.splice(0)) await a.stop()
  for (const f of fakes.splice(0)) f.stop()
})

function setup(options: Partial<TelegramAdapterOptions> = {}) {
  const fake = fakeTelegram(4921 + (nextPort++ % 8))
  fakes.push(fake)
  const adapter = createTelegramAdapter({
    connectionId: 'tg1',
    token: fake.token,
    apiRoot: fake.url,
    pollTimeoutSec: 1,
    ...options,
  })
  adapters.push(adapter)
  const events: RemoteEvent[] = []
  const start = () => adapter.start(async (e) => void events.push(e), host)
  return { fake, adapter, events, start }
}

describe('format', () => {
  test('the escaper covers & < > and nothing else', () => {
    expect(escapeHtml('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; "d"')
  })
  test('markdown becomes the Telegram HTML subset; everything else is escaped', () => {
    expect(toTelegramHtml('**bold** and *it* and `x<y` and ~~gone~~')).toBe(
      '<b>bold</b> and <i>it</i> and <code>x&lt;y</code> and <s>gone</s>',
    )
    expect(toTelegramHtml('```ts\nconst a = 1 < 2\n```')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>',
    )
    expect(toTelegramHtml('[docs](https://example.com/a?b=1&c=2)')).toContain(
      '<a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    )
    // a javascript: link is not a link
    expect(toTelegramHtml('[x](javascript:alert(1))')).not.toContain('<a')
    // markup inside code is not interpreted; raw tags never survive
    expect(toTelegramHtml('`**no**` <script>alert(1)</script>')).toBe(
      '<code>**no**</code> &lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(toTelegramHtml('snake_case_name and 2*3*4')).toBe('snake_case_name and 2*3*4')
    expect(toTelegramHtml('# Title\n- one\n- two')).toBe('<b>Title</b>\n• one\n• two')
  })
  test('chunks respect the limit after escaping', () => {
    const text = `${'<&>'.repeat(3000)}\n${'word '.repeat(2000)}`
    const chunks = htmlChunks(text, 4096)
    expect(chunks.length).toBeGreaterThan(2)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096)
    // nothing is lost
    const back = chunks.join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    expect(back.replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })
})

describe('errors and secrets', () => {
  test('the token is scrubbed from urls and text', () => {
    const token = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789'
    expect(
      scrubToken(`fetch failed https://api.telegram.org/bot${token}/getMe`, token),
    ).not.toContain('ABCdef')
    expect(scrubToken(`bot${token}/x`)).toBe('bot***/x')
  })
  test('rate limits carry retry_after, 401 is fatal, 403 and 400 are invalid, 5xx transient', async () => {
    const { GrammyError } = await import('grammy')
    const mk = (error_code: number, description: string, parameters?: { retry_after?: number }) =>
      new GrammyError(
        'x',
        { ok: false, error_code, description, ...(parameters ? { parameters } : {}) },
        'sendMessage',
        {},
      )
    const limited = mapTelegramError(
      mk(429, 'Too Many Requests: retry after 7', { retry_after: 7 }),
    ) as ChannelError
    expect([limited.kind, limited.retryAfterMs]).toEqual(['rate_limit', 7000])
    expect(mapTelegramError(mk(401, 'Unauthorized')).kind).toBe('fatal')
    const blocked = mapTelegramError(
      mk(403, "Forbidden: bot can't initiate conversation with a user"),
    )
    expect(blocked.kind).toBe('invalid')
    expect(blocked.message).toContain('press Start')
    expect(mapTelegramError(mk(400, 'Bad Request: chat not found')).kind).toBe('invalid')
    expect(mapTelegramError(mk(502, 'Bad Gateway')).kind).toBe('transient')
  })
})

describe('polling (grammY + runner under Bun)', () => {
  test('long polling delivers messages in order; allowed_updates is explicit; getMe feeds self()', async () => {
    const { fake, adapter, events, start } = setup()
    await start()
    expect(adapter.self()).toMatchObject({ username: 'team_test_bot', isSelf: true, isBot: true })
    expect(adapter.info()?.canReadAllGroupMessages).toBe(false)
    for (let i = 1; i <= 5; i++) fake.push(tg.message({ chat: tg.group(), text: `m${i}`, id: i }))
    await until('five messages', () => events.length === 5)
    expect(events.map((e) => (e.type === 'message.created' ? e.message.text : ''))).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
    ])
    const polled = fake.callsOf('getUpdates')[0]
    expect(polled?.params.allowed_updates).toEqual([...ALLOWED_UPDATES])
    expect(ALLOWED_UPDATES).toEqual(
      expect.arrayContaining([
        'message',
        'edited_message',
        'channel_post',
        'edited_channel_post',
        'callback_query',
        'my_chat_member',
        'chat_member',
        'message_reaction',
        'chat_join_request',
      ]),
    )
    // acknowledged: the next poll carries an offset
    await until('offset', () =>
      fake.callsOf('getUpdates').some((c) => Number(c.params.offset) > 1000),
    )
  })

  test('mention, text_mention, reply to the bot and addressed commands are signals', async () => {
    const { fake, events, start } = setup()
    await start()
    const g = tg.group()
    fake.push(
      tg.message({
        chat: g,
        id: 1,
        text: 'hi @team_test_bot ok',
        entities: [{ type: 'mention', offset: 3, length: 14 }],
      }),
    )
    fake.push(
      tg.message({
        chat: g,
        id: 2,
        text: 'hey you',
        entities: [
          {
            type: 'text_mention',
            offset: 4,
            length: 3,
            user: { id: 777, is_bot: true, first_name: 'Team Bot' },
          },
        ],
      }),
    )
    fake.push(
      tg.message({
        chat: g,
        id: 3,
        text: 'ping @someone_else',
        entities: [{ type: 'mention', offset: 5, length: 13 }],
      }),
    )
    fake.push(
      tg.message({
        chat: g,
        id: 4,
        text: 'yes',
        extra: {
          reply_to_message: {
            message_id: 9,
            date: 1,
            chat: g,
            from: { id: 777, is_bot: true, first_name: 'Team Bot' },
            text: 'earlier',
          },
        },
      }),
    )
    fake.push(
      tg.message({
        chat: g,
        id: 5,
        text: '/status@team_test_bot now',
        entities: [{ type: 'bot_command', offset: 0, length: 21 }],
      }),
    )
    fake.push(
      tg.message({
        chat: g,
        id: 6,
        text: '/status@other_bot now',
        entities: [{ type: 'bot_command', offset: 0, length: 17 }],
      }),
    )
    await until('six', () => events.length === 6)
    const sig = events.map((e) => (e.type === 'message.created' ? e.signals : undefined))
    expect(sig[0]).toMatchObject({ mentionedSelf: true, replyToSelf: false })
    expect(sig[1]).toMatchObject({ mentionedSelf: true })
    expect(sig[2]).toMatchObject({ mentionedSelf: false, mentionedOthers: true })
    expect(sig[3]).toMatchObject({ replyToSelf: true })
    expect(sig[3]).not.toHaveProperty('mentionedOthers')
    expect(sig[4]?.command).toEqual({ name: 'status', args: 'now' })
    expect(sig[5]?.command).toBeUndefined()
    expect(sig[5]).toMatchObject({ mentionedOthers: true })
    const reply = events[3]
    expect(reply?.type === 'message.created' && reply.message.replyTo?.text).toBe('earlier')
  })

  test('forum topics are thread nodes under the forum; the topic root is not a reply to the bot', async () => {
    const { fake, events, start } = setup()
    await start()
    const g = tg.group(-1002, 'Forum', { is_forum: true })
    fake.push(
      tg.message({
        chat: g,
        id: 31,
        text: 'in a topic',
        extra: {
          message_thread_id: 30,
          is_topic_message: true,
          // every message of a topic replies to the topic's first message, which the bot created
          reply_to_message: {
            message_id: 30,
            date: 1,
            chat: g,
            from: { id: 777, is_bot: true, first_name: 'Team Bot' },
            forum_topic_created: { name: 'Billing', icon_color: 1 },
          },
        },
      }),
    )
    fake.push(tg.message({ chat: g, id: 32, text: 'general' }))
    await until('two', () => events.length === 2)
    const [topic, general] = events
    expect(topic?.node).toMatchObject({
      nativeId: '-1002/30',
      chain: [
        { nativeId: '-1002/30', kind: 'thread', title: 'Billing', parent: '-1002' },
        { nativeId: '-1002', kind: 'room', traits: { container: true, postable: false } },
      ],
    })
    expect(topic?.type === 'message.created' && topic.signals.replyToSelf).toBe(false)
    expect(topic?.type === 'message.created' && topic.message.replyTo).toBeUndefined()
    // a message outside any topic is in General (topic 0), a child of the forum
    expect(general?.node?.nativeId).toBe('-1002/0')
  })

  test('edits, channel posts, reactions and my_chat_member are normalized', async () => {
    const { fake, events, start } = setup()
    await start()
    const chan = { id: -1003, type: 'channel', title: 'News' }
    fake.push({
      channel_post: { message_id: 5, date: 1, chat: chan, sender_chat: chan, text: 'post' },
    })
    fake.push({
      edited_message: {
        message_id: 6,
        date: 1,
        edit_date: 2,
        chat: tg.group(),
        from: tg.user(),
        text: 'fixed',
      },
    })
    fake.push({
      message_reaction: {
        chat: tg.group(),
        message_id: 6,
        user: tg.user(),
        date: 3,
        old_reaction: [],
        new_reaction: [{ type: 'emoji', emoji: '👍' }],
      },
    })
    fake.push({
      my_chat_member: {
        chat: tg.group(-1009, 'New group'),
        from: tg.user(),
        date: 4,
        old_chat_member: { status: 'left', user: {} },
        new_chat_member: { status: 'administrator', user: {}, can_post_messages: true },
      },
    })
    await until('four events', () => events.length === 4)
    // chats are polled concurrently: look events up by type
    const by = (type: string) => events.find((e) => e.type === type)
    expect(by('message.created')).toMatchObject({
      type: 'message.created',
      node: { nativeId: '-1003', chain: [{ kind: 'room', traits: { broadcast: true } }] },
      message: { sender: { id: 'chat:-1003', name: 'News', kind: 'channel' } },
    })
    expect(by('message.edited')).toMatchObject({ message: { text: 'fixed' } })
    expect(by('reaction.added')).toMatchObject({
      type: 'reaction.added',
      emoji: '👍',
      messageNativeId: '6',
    })
    // what the bot is in a chat now: the chat is discovered from this, with its access
    expect(by('member.updated')).toMatchObject({
      role: 'admin',
      node: {
        nativeId: '-1009',
        chain: [{ title: 'New group', access: { member: 'admin', canPost: true } }],
      },
    })
  })

  test('a callback query becomes an action event and is answered at once', async () => {
    const { fake, events, start } = setup()
    await start()
    fake.push({
      callback_query: {
        id: 'cb1',
        from: tg.user(),
        chat_instance: 'x',
        data: 'approve:row-123',
        message: {
          message_id: 88,
          date: 5,
          chat: tg.group(),
          from: { id: 777, is_bot: true, first_name: 'Team Bot' },
        },
      },
    })
    await until('action', () => events.length === 1)
    expect(events[0]).toMatchObject({
      type: 'action',
      name: 'approve',
      data: 'row-123',
      messageNativeId: '88',
      node: { nativeId: '-1001' },
    })
    await until('answered', () => fake.callsOf('answerCallbackQuery').length === 1)
    expect(fake.callsOf('answerCallbackQuery')[0]?.params.callback_query_id).toBe('cb1')
  })

  test('a bad token fails the start as fatal and never leaks the token', async () => {
    const { fake, adapter } = setup()
    fake.revoke()
    const error = (await adapter.start(async () => undefined, host).catch((e) => e)) as ChannelError
    expect(error.kind).toBe('fatal')
    expect(error.message).not.toContain(fake.token)
  })

  test('a revoked token while polling reports an auth failure', async () => {
    const failures: Array<{ kind: string; message: string }> = []
    const { fake, start } = setup({ hooks: { onFailure: (f) => void failures.push(f) } })
    await start()
    fake.revoke()
    await until('failure', () => failures.length > 0, 8000)
    expect(failures[0]?.kind).toBe('auth')
    expect(failures[0]?.message).not.toContain(fake.token)
  })

  test('a webhook is refused by default and removed on request', async () => {
    const a = setup()
    a.fake.setWebhook('https://example.com/hook')
    const error = (await a.start().catch((e) => e)) as TelegramSetupError
    expect(error).toBeInstanceOf(TelegramSetupError)
    expect(error.code).toBe('webhook-set')
    expect(a.fake.callsOf('deleteWebhook')).toHaveLength(0)
    const b = setup({ onWebhook: 'delete' })
    b.fake.setWebhook('https://example.com/hook')
    await b.start()
    expect(b.fake.callsOf('deleteWebhook')).toHaveLength(1)
  })
})

describe('outbound', () => {
  /** A stored node as the adapter receives it: a chat, a forum topic (a child) or a direct chat. */
  const ref = (container = '-1001', topic?: string): ChannelNode => ({
    id: topic === undefined ? container : `${container}/${topic}`,
    connectionId: 'tg1',
    nativeId: topic === undefined ? container : `${container}/${topic}`,
    kind: topic === undefined ? 'room' : 'thread',
    traits: traitsOf({ multiUser: true }),
    platformType: topic === undefined ? 'telegram:supergroup' : 'telegram:forum_topic',
    title: undefined,
    parentNativeId: topic === undefined ? undefined : container,
    meta:
      topic === undefined ? { chatId: container } : { chatId: container, topicId: Number(topic) },
  })

  test('sendMessage: HTML escaped, quoted reply, topic, buttons as an inline keyboard', async () => {
    const { fake, adapter, start } = setup()
    await start()
    const sent = await adapter.send(ref('-1001', '30'), {
      text: 'Use **care** with <b> & friends',
      replyTo: '12',
      buttons: [
        { name: 'approve', label: 'Approve', data: 'row-1' },
        { name: 'deny', label: 'Deny', data: 'row-1' },
      ],
    })
    expect(sent.nativeId).toMatch(/^\d+$/)
    const call = fake.callsOf('sendMessage')[0]
    expect(call?.params).toMatchObject({
      chat_id: -1001,
      text: 'Use <b>care</b> with &lt;b&gt; &amp; friends',
      parse_mode: 'HTML',
      message_thread_id: 30,
      reply_parameters: { message_id: 12, allow_sending_without_reply: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: 'approve:row-1' },
            { text: 'Deny', callback_data: 'deny:row-1' },
          ],
        ],
      },
    })
  })

  test('golden: a mention token goes out as a tg://user link by id with the readable name, never as a raw token', async () => {
    const { fake, adapter, start } = setup()
    await start()
    await adapter.send(ref('-1001', '30'), {
      text: `Reminder for ${mentionToken('6148484116', 'vh vh')}: call the vendor. Also ${mentionToken('chat:5', 'Odd <b>')}`,
    })
    const params = fake.callsOf('sendMessage')[0]?.params
    expect(params).toMatchObject({
      parse_mode: 'HTML',
      text: 'Reminder for <a href="tg://user?id=6148484116">vh vh</a>: call the vendor. Also Odd &lt;b&gt;',
    })
    expect(String(params?.text)).not.toMatch(/%20|[\uE000-\uE002]/)
  })

  test('a long reply is split under 4096 characters after escaping, buttons only on the last part', async () => {
    const { fake, adapter, start } = setup()
    await start()
    await adapter.send(ref(), {
      text: `${'<&> '.repeat(2500)}`,
      buttons: [{ name: 'approve', label: 'Ok' }],
    })
    const calls = fake.callsOf('sendMessage')
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(String(c.params.text).length).toBeLessThanOrEqual(4096)
    expect(calls[0]?.params.reply_markup).toBeUndefined()
    expect(calls.at(-1)?.params.reply_markup).toBeDefined()
  })

  test('an entity parse error falls back to plain text', async () => {
    const { fake, adapter, start } = setup()
    await start()
    fake.fail('sendMessage', {
      error_code: 400,
      description: "Bad Request: can't parse entities: Unexpected end tag",
    })
    await adapter.send(ref(), { text: '**a _b** c_' })
    const calls = fake.callsOf('sendMessage')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.params.parse_mode).toBeUndefined()
    expect(calls[1]?.params.text).toBe('**a _b** c_')
  })

  test('a short flood wait is waited out by auto-retry; a long one becomes a rate_limit error', async () => {
    const { fake, adapter, start } = setup({ maxRetryDelaySec: 2 })
    await start()
    fake.fail('sendMessage', {
      error_code: 429,
      description: 'Too Many Requests: retry after 1',
      parameters: { retry_after: 1 },
    })
    const t0 = Date.now()
    await adapter.send(ref(), { text: 'after a short wait' })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(fake.callsOf('sendMessage')).toHaveLength(2)
    fake.fail('sendMessage', {
      error_code: 429,
      description: 'Too Many Requests: retry after 30',
      parameters: { retry_after: 30 },
    })
    const error = (await adapter.send(ref(), { text: 'long wait' }).catch((e) => e)) as ChannelError
    expect(error.kind).toBe('rate_limit')
    expect(error.retryAfterMs).toBe(30_000)
  })

  test('the idempotency key never posts twice in a process', async () => {
    const { fake, adapter, start } = setup()
    await start()
    const a = await adapter.send(ref(), { text: 'once', sendTxnId: 'row-1' })
    const b = await adapter.send(ref(), { text: 'once', sendTxnId: 'row-1' })
    expect(b).toEqual(a)
    expect(fake.callsOf('sendMessage')).toHaveLength(1)
  })

  test('edit removes the buttons; delete, pin, react, typing, members hit the right methods', async () => {
    const { fake, adapter, start } = setup()
    await start()
    await adapter.edit?.(ref(), '9', 'Approved by Ana')
    expect(fake.callsOf('editMessageText')[0]?.params).toMatchObject({
      chat_id: -1001,
      message_id: 9,
      reply_markup: { inline_keyboard: [] },
    })
    await adapter.delete?.(ref(), '9')
    await adapter.pin?.(ref(), '9', true)
    await adapter.pin?.(ref(), '9', false)
    await adapter.react?.(ref(), '9', '👀')
    await adapter.typing?.(ref('-1001', '30'))
    expect(fake.callsOf('deleteMessage')[0]?.params).toMatchObject({ message_id: 9 })
    expect(fake.callsOf('pinChatMessage')[0]?.params).toMatchObject({
      message_id: 9,
      disable_notification: true,
    })
    expect(fake.callsOf('unpinChatMessage')[0]?.params).toMatchObject({ message_id: 9 })
    expect(fake.callsOf('setMessageReaction')[0]?.params.reaction).toEqual([
      { type: 'emoji', emoji: '👀' },
    ])
    expect(fake.callsOf('sendChatAction')[0]?.params).toMatchObject({
      action: 'typing',
      message_thread_id: 30,
    })
    const listed = await adapter.listMembers?.(ref(), { limit: 5 })
    expect(listed?.members[0]?.name).toBe('Ana')
    expect(listed?.scope).toBe('admins')
    // what a node supports is the adapter's answer for that node
    expect(adapter.getCapabilities(ref())).toMatchObject({
      history: false,
      buttons: true,
      members: true,
      maxTextLength: 4096,
      maxCaptionLength: 1024,
    })
    expect(adapter.getCapabilities({ ...ref('42'), kind: 'direct' }).members).toBe(false)
    expect(adapter.fetchHistory).toBeUndefined()
  })

  test('a person who never started the bot gives an invalid error that says what to do', async () => {
    const { fake, adapter, start } = setup()
    await start()
    fake.fail('sendMessage', {
      error_code: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    })
    const error = (await adapter
      .send({ ...ref('42'), kind: 'direct' }, { text: 'hi' })
      .catch((e) => e)) as ChannelError
    expect(error.kind).toBe('invalid')
    expect(error.message).toContain('press Start')
  })

  test('files: a photo with a caption, an album and a document', async () => {
    const { fake, adapter, start } = setup()
    await start()
    const png = { name: 'a.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
    await adapter.send(ref(), { text: 'caption', files: [png] })
    const photo = fake.callsOf('sendPhoto')[0]
    expect(photo?.params).toMatchObject({ caption: 'caption', parse_mode: 'HTML' })
    expect(photo?.files[0]).toEndWith(':a.png')
    await adapter.send(ref(), { text: 'album', files: [png, { ...png, name: 'b.png' }] })
    expect(fake.callsOf('sendMediaGroup')).toHaveLength(1)
    await adapter.send(ref(), {
      text: '',
      files: [{ name: 'r.pdf', mediaType: 'application/pdf', bytes: new Uint8Array([9]) }],
    })
    expect(fake.callsOf('sendDocument')).toHaveLength(1)
  })
})

describe('files in', () => {
  test('a document is downloaded through getFile; over 20 MB is refused with a readable error', async () => {
    const { fake, events, start } = setup()
    await start()
    fake.addFile('small', new Uint8Array([1, 2, 3, 4]), 'docs/small.txt')
    fake.addFile('huge', new Uint8Array([1]), 'docs/huge.bin')
    fake.push(
      tg.message({
        chat: tg.group(),
        id: 1,
        extra: {
          caption: 'see',
          document: {
            file_id: 'small',
            file_unique_id: 'us',
            file_name: 'small.txt',
            mime_type: 'text/plain',
            file_size: 4,
          },
        },
      }),
    )
    fake.push(
      tg.message({
        chat: tg.group(),
        id: 2,
        extra: {
          document: {
            file_id: 'huge',
            file_unique_id: 'uh',
            file_name: 'huge.bin',
            mime_type: 'application/octet-stream',
            file_size: 25 * 1024 * 1024,
          },
        },
      }),
    )
    fake.push(
      tg.message({
        chat: tg.group(),
        id: 3,
        extra: {
          photo: [
            { file_id: 'small', file_unique_id: 'p1', width: 10, height: 10, file_size: 4 },
            { file_id: 'small', file_unique_id: 'p2', width: 100, height: 100, file_size: 4 },
          ],
        },
      }),
    )
    await until('three', () => events.length === 3)
    const [doc, big, photo] = events
    const docAtt = doc?.type === 'message.created' ? doc.message.attachments[0] : undefined
    expect(docAtt).toMatchObject({ name: 'small.txt', mediaType: 'text/plain', size: 4 })
    expect(Array.from((await docAtt?.fetch())?.bytes ?? [])).toEqual([1, 2, 3, 4])
    expect(doc?.type === 'message.created' && doc.message.text).toBe('see')
    // the gateway reads `size` before downloading; the adapter also refuses on its own
    const bigAtt = big?.type === 'message.created' ? big.message.attachments[0] : undefined
    expect(bigAtt?.size).toBe(25 * 1024 * 1024)
    await expect(bigAtt?.fetch()).rejects.toThrow(/up to 20971520/)
    expect(fake.callsOf('getFile').some((c) => c.params.file_id === 'huge')).toBe(false)
    // the largest photo size wins
    expect(photo?.type === 'message.created' && photo.message.attachments).toHaveLength(1)
    expect(photo?.type === 'message.created' && photo.message.attachments[0]?.id).toBe('p2')
  })

  test('getFile reporting a size over the cap is refused too', async () => {
    const { fake, events, start } = setup()
    await start()
    fake.addFile('liar', new Uint8Array([1]), 'docs/liar.bin')
    fake.setFileSize('liar', 30 * 1024 * 1024)
    fake.push(
      tg.message({
        chat: tg.group(),
        id: 1,
        extra: { document: { file_id: 'liar', file_unique_id: 'ul', file_name: 'l.bin' } },
      }),
    )
    await until('one', () => events.length === 1)
    const att = events[0]?.type === 'message.created' ? events[0].message.attachments[0] : undefined
    await expect(att?.fetch()).rejects.toThrow(/up to 20971520/)
  })
})

describe('native actions', () => {
  test('the catalog is a few grouped tools with static risks', () => {
    const f = fakeTelegram(4929)
    fakes.push(f)
    const adapter = createTelegramAdapter({ connectionId: 'x', token: f.token, apiRoot: f.url })
    adapters.push(adapter)
    const risk = Object.fromEntries((adapter.actions ?? []).map((a) => [a.name, a.risk]))
    expect(risk).toMatchObject({
      chat_info: 'read',
      join_requests: 'external',
      chat_messages: 'external',
      chat_topics: 'write',
      chat_settings: 'write',
      chat_members: 'write',
      chat_invites: 'external',
      bot_profile: 'write',
      chat_destructive: 'destructive',
    })
    expect(typeof nativeActions).toBe('function')
  })
})
