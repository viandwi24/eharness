/**
 * Telegram user account delivery errors: which image types go as photos, the photo-to-document
 * fallback, request/content errors failing one message only, and the outbound breaker pausing
 * sending only for account or transport problems.
 */
import { describe, expect, test } from 'bun:test'
import { traitsOf } from '../src/infra/channels/model.ts'
import { sqliteNodeStore } from '../src/infra/channels/nodes.ts'
import { createOutbound } from '../src/infra/channels/outbound.ts'
import { RateLimitsSchema } from '../src/infra/channels/policy.ts'
import { ChannelError, type ChannelNode } from '../src/infra/channels/types.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import { createTelegramUserAdapter } from '../src/infra/telegram-user/adapter.ts'
import type { TgChat, TgUserClient } from '../src/infra/telegram-user/client.ts'
import { classifyError, describeError, TgRpcError } from '../src/infra/telegram-user/errors.ts'
import { type MediaSender, sendFilesWith } from '../src/infra/telegram-user/mtcute-client.ts'
import { nodeChatStore } from '../src/infra/telegram-user/store.ts'

const file = (name: string, mediaType: string) => ({
  name,
  mediaType,
  bytes: new Uint8Array([1, 2, 3]),
})

function sender(failPhoto?: string, failAll?: string) {
  const calls: Array<{ type: string; mime: string }> = []
  const tg: MediaSender = {
    async sendMedia(_chat, media) {
      const m = media as unknown as { type: string; fileMime: string }
      calls.push({ type: m.type, mime: m.fileMime })
      if (failAll !== undefined) throw new TgRpcError(failAll)
      if (failPhoto !== undefined && m.type === 'photo') throw new TgRpcError(failPhoto)
      return { id: 7 }
    },
    async sendMediaGroup(_chat, media) {
      for (const m of media as unknown as Array<{ type: string; fileMime: string }>) {
        calls.push({ type: m.type, mime: m.fileMime })
      }
      return [{ id: 8 }]
    },
  }
  return { tg, calls }
}
const key = () => 1

describe('media kinds on the user account', () => {
  test('voice, video note, GIF and sticker go as their kind; photos and videos share an album; every id comes back', async () => {
    const seen: Array<Record<string, unknown>> = []
    let id = 10
    const tg: MediaSender = {
      async sendMedia(_chat, media) {
        seen.push(media as unknown as Record<string, unknown>)
        return { id: ++id }
      },
      async sendMediaGroup(_chat, media) {
        const list = media as unknown as Array<Record<string, unknown>>
        seen.push(...list)
        return list.map(() => ({ id: ++id }))
      },
    }
    const f = (name: string, mediaType: string, media?: string) => ({
      ...file(name, mediaType),
      ...(media === undefined ? {} : { media: media as never }),
    })
    const one = await sendFilesWith(
      tg,
      '1',
      [
        f('v.ogg', 'audio/ogg', 'voice'),
        f('n.mp4', 'video/mp4', 'video_note'),
        f('g.mp4', 'video/mp4', 'animation'),
        f('s.webp', 'image/webp', 'sticker'),
      ],
      'hello',
      undefined,
      key,
    )
    expect(one.ids).toHaveLength(4)
    expect(
      seen.map((m) => [m.type, m.isRound ?? false, m.isAnimated ?? false, m.caption ?? null]),
    ).toEqual([
      ['voice', false, false, 'hello'],
      ['video', true, false, null],
      ['video', false, true, null],
      ['sticker', false, false, null],
    ])
    seen.length = 0
    const album = await sendFilesWith(
      tg,
      '1',
      [f('a.jpg', 'image/jpeg'), f('b.mp4', 'video/mp4')],
      'cap',
      undefined,
      key,
    )
    expect(album.ids).toHaveLength(2)
    expect(seen.map((m) => m.type)).toEqual(['photo', 'video'])
    expect(seen[0]?.caption).toBe('cap')
  })
})

describe('image type routing', () => {
  test('jpeg, png and webp go as photos; gif, svg, bmp, heic and pdf as documents', async () => {
    for (const [mime, type] of [
      ['image/jpeg', 'photo'],
      ['image/png', 'photo'],
      ['image/webp', 'photo'],
      ['image/gif', 'document'],
      ['image/svg+xml', 'document'],
      ['image/bmp', 'document'],
      ['image/heic', 'document'],
      ['application/pdf', 'document'],
    ] as const) {
      const { tg, calls } = sender()
      await sendFilesWith(tg, '1', [file('f', mime)], 'c', undefined, key)
      expect(calls).toEqual([{ type, mime }])
    }
  })

  test('a refused photo is retried once as a document', async () => {
    const { tg, calls } = sender('PHOTO_EXT_INVALID')
    const sent = await sendFilesWith(
      tg,
      '1',
      [file('a.png', 'image/png')],
      undefined,
      undefined,
      key,
    )
    expect(sent.id).toBe(7)
    expect(calls.map((c) => c.type)).toEqual(['photo', 'document'])
  })

  test('IMAGE_PROCESS_FAILED also falls back; other errors do not', async () => {
    const a = sender('IMAGE_PROCESS_FAILED')
    await sendFilesWith(a.tg, '1', [file('a.png', 'image/png')], undefined, undefined, key)
    expect(a.calls.map((c) => c.type)).toEqual(['photo', 'document'])
    const b = sender('CHAT_WRITE_FORBIDDEN')
    await expect(
      sendFilesWith(b.tg, '1', [file('a.png', 'image/png')], undefined, undefined, key),
    ).rejects.toThrow('CHAT_WRITE_FORBIDDEN')
    expect(b.calls).toHaveLength(1)
  })

  test('when even the document fails, the error comes out (one retry only)', async () => {
    const { tg, calls } = sender(undefined, 'PHOTO_EXT_INVALID')
    await expect(
      sendFilesWith(tg, '1', [file('a.png', 'image/png')], undefined, undefined, key),
    ).rejects.toThrow('PHOTO_EXT_INVALID')
    expect(calls).toHaveLength(2)
  })

  test('a gif never tries photo, so there is no fallback to run', async () => {
    const { tg, calls } = sender(undefined, 'MEDIA_EMPTY')
    await expect(
      sendFilesWith(tg, '1', [file('a.gif', 'image/gif')], undefined, undefined, key),
    ).rejects.toThrow('MEDIA_EMPTY')
    expect(calls).toHaveLength(1)
  })
})

describe('error classification', () => {
  test('request and content errors are invalid (that one message only)', () => {
    for (const code of [
      'PHOTO_EXT_INVALID',
      'PHOTO_INVALID_DIMENSIONS',
      'PHOTO_SAVE_FILE_INVALID',
      'MEDIA_CAPTION_TOO_LONG',
      'MEDIA_INVALID',
      'FILE_PART_0_MISSING',
      'FILE_PARTS_INVALID',
      'FILE_REFERENCE_EXPIRED',
      'IMAGE_PROCESS_FAILED',
      'ENTITY_BOUNDS_INVALID',
      'WEBPAGE_CURL_FAILED',
      'WEBPAGE_MEDIA_EMPTY',
      'TEXT_EMPTY',
      'BUTTON_DATA_INVALID',
      'FILE_TOO_BIG',
      'MESSAGE_TOO_LONG',
    ]) {
      expect(classifyError(new TgRpcError(code)).kind).toBe('invalid')
    }
  })

  test('account and transport problems keep their kinds', () => {
    expect(classifyError(new TgRpcError('FLOOD_WAIT_30')).kind).toBe('flood')
    expect(classifyError(new TgRpcError('PEER_FLOOD')).kind).toBe('peer-flood')
    // mtcute cuts the number out of the text and keeps it in a field
    const mt = Object.assign(new Error('Telegram API error 420: FLOOD_WAIT_%d'), {
      text: 'FLOOD_WAIT_%d',
      seconds: 42,
    })
    expect(classifyError(mt)).toEqual({ kind: 'flood', seconds: 42, text: 'FLOOD_WAIT_42' })
    const slow = Object.assign(new Error('x'), { text: 'SLOWMODE_WAIT_%d', seconds: 30 })
    expect(classifyError(slow)).toMatchObject({ kind: 'flood', seconds: 30 })
    const premium = Object.assign(new Error('x'), { text: 'FLOOD_PREMIUM_WAIT_%d', seconds: 5 })
    expect(classifyError(premium)).toMatchObject({ kind: 'flood', seconds: 5 })
    expect(classifyError(new TgRpcError('AUTH_KEY_INVALID')).kind).toBe('auth-lost')
    expect(classifyError(new TgRpcError('SESSION_REVOKED')).kind).toBe('auth-lost')
    expect(classifyError(new Error('socket hang up')).kind).toBe('transient')
    expect(classifyError(new Error('ETIMEDOUT')).kind).toBe('transient')
    expect(classifyError(new TgRpcError('INTERDC_CALL_ERROR')).kind).toBe('transient')
  })

  test('a photo refusal reads as a sentence for the model', () => {
    const text = describeError(classifyError(new TgRpcError('PHOTO_EXT_INVALID')))
    expect(text).toContain('does not accept this file as a photo')
    expect(text).toContain('PHOTO_EXT_INVALID')
  })
})

// --- the breaker, through the real adapter -------------------------------------------------------

const GROUP = '-1001'

function accountWith(sendFiles: () => Promise<{ id: number }>) {
  const conn = openDatabase(':memory:')
  const nodes = sqliteNodeStore(conn.sqlite)
  const chats = nodeChatStore({ sqlite: conn.sqlite, nodes, allowed: () => true })
  const dialog: TgChat = { id: GROUP, kind: 'group', title: 'Company', forum: false, admin: false }
  chats.upsertDialog('c1', dialog, 1)
  const fatals: string[] = []
  const client = {
    sendFiles,
    sendText: async () => ({ id: 1 }),
    listChats: async () => [dialog],
  } as unknown as TgUserClient
  const adapter = createTelegramUserAdapter({
    connectionId: 'c1',
    client,
    me: { id: '1', name: 'Me', isBot: false },
    chats,
    counters: { get: () => 0, add: () => undefined },
    settings: () => ({ dmDailyMax: 30, dailyMax: 300, adminLogEveryMs: 3_600_000 }),
    hooks: {
      onFatal: (f) => void fatals.push(f.kind),
      warn: () => undefined,
    },
  })
  const node: ChannelNode = {
    id: 'n1',
    connectionId: 'c1',
    nativeId: GROUP,
    kind: 'room',
    traits: traitsOf({ multiUser: true }),
    platformType: 'telegram-user:group',
    title: 'Company',
    parentNativeId: undefined,
    meta: {},
  }
  const limits = RateLimitsSchema.parse({ chatMinIntervalMs: 0, breakerFailures: 3 })
  const outbound = createOutbound({
    limitsOf: () => limits,
    sleep: async () => undefined,
  })
  const target = { connectionId: 'c1', conversationId: 'n1', kind: 'group' as const }
  const send = (text: string, files = true) =>
    outbound.run(target, () =>
      adapter.send(node, {
        text,
        ...(files ? { files: [file('a.png', 'image/png')] } : {}),
      } as never),
    )
  return { adapter, outbound, send, fatals }
}

describe('the outbound breaker', () => {
  test('PHOTO_EXT_INVALID failures never pause the connection; the next message goes out', async () => {
    let photoBroken = true
    const { send, outbound } = accountWith(async () => {
      if (photoBroken) throw new TgRpcError('PHOTO_EXT_INVALID')
      return { id: 5 }
    })
    for (let i = 0; i < 8; i++) {
      const error = await send(`img ${i}`).catch((e) => e)
      expect(error).toBeInstanceOf(ChannelError)
      expect((error as ChannelError).kind).toBe('invalid')
      expect((error as ChannelError).message).toContain('photo')
    }
    expect(outbound.breaker('c1')).toBeUndefined()
    // a text message right after is sent
    await expect(send('hello', false)).resolves.toEqual({ nativeId: '1' })
    photoBroken = false
    await expect(send('fixed')).resolves.toEqual({ nativeId: '5' })
  })

  test('one message that keeps failing with a transport error counts once, not once per retry', async () => {
    const { send, outbound } = accountWith(async () => {
      throw new Error('socket hang up')
    })
    await send('x').catch(() => undefined)
    expect(outbound.breaker('c1')).toBeUndefined()
  })

  test('failures of different messages in a row (transport) still pause sending', async () => {
    const { send, outbound } = accountWith(async () => {
      throw new Error('socket hang up')
    })
    for (let i = 0; i < 3; i++) await send(`m${i}`).catch(() => undefined)
    expect(outbound.breaker('c1')?.open).toBe(true)
    await expect(send('after')).rejects.toThrow(/paused/)
  })

  test('a flood storm / PEER_FLOOD still pauses the connection', async () => {
    const { send, outbound, fatals } = accountWith(async () => {
      throw new TgRpcError('PEER_FLOOD')
    })
    await expect(send('x')).rejects.toThrow(/limits this account/)
    expect(fatals).toEqual(['peer-flood'])
    expect(outbound.breaker('c1')?.open).toBe(true)
    await expect(send('y', false)).rejects.toThrow(/paused/)
  })
})
