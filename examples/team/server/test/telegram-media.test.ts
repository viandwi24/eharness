/**
 * Media of Telegram messages (P60 W1): every kind reaches the gateway with what it is, a reusable
 * file reference, and nothing is silently dropped (stickers, video notes, places, polls, dice).
 */
import { describe, expect, test } from 'bun:test'
import type { Update } from 'grammy/types'
import type { InboundAttachment } from '../src/infra/channels/types.ts'
import { normalizeUpdate } from '../src/infra/telegram/normalize.ts'
import type { TgMessage } from '../src/infra/telegram-user/client.ts'
import { normalizeMessage } from '../src/infra/telegram-user/normalize.ts'

const ctx = {
  botId: 1,
  botUsername: 'team_bot',
  download: async () => ({ bytes: new Uint8Array([1]) }),
}
const chat = { id: -1001, type: 'supergroup' as const, title: 'Signals' }
const from = { id: 42, is_bot: false, first_name: 'Ana' }
const update = (message: Record<string, unknown>, id = 1): Update =>
  ({
    update_id: id,
    message: { message_id: id, date: 1_700_000_000, chat, from, ...message },
  }) as unknown as Update
const one = (message: Record<string, unknown>) => {
  const e = normalizeUpdate(update(message), ctx).events.find((x) => x.type === 'message.created')
  if (e === undefined || e.type !== 'message.created') throw new Error('no message')
  return e.message
}
const shape = (a: InboundAttachment) => {
  const { fetch: _f, ...rest } = a
  return rest
}

describe('Telegram bot media', () => {
  test('a photo with a formatted caption: the largest size, its file id, the caption entities', () => {
    const m = one({
      photo: [
        { file_id: 'small', file_unique_id: 'u1', width: 90, height: 90, file_size: 100 },
        { file_id: 'big', file_unique_id: 'u2', width: 1280, height: 720, file_size: 9000 },
      ],
      caption: 'BUY $BTC now',
      caption_entities: [
        { type: 'bold', offset: 0, length: 3 },
        { type: 'cashtag', offset: 4, length: 4 },
      ],
      media_group_id: 'album-1',
    })
    expect(m.text).toBe('BUY $BTC now')
    expect(m.groupId).toBe('album-1')
    expect(m.entities).toEqual([
      { type: 'bold', offset: 0, length: 3 },
      { type: 'cashtag', offset: 4, length: 4 },
    ])
    expect(m.attachments.map(shape)).toEqual([
      {
        id: 'u2',
        kind: 'image',
        media: 'photo',
        ref: 'big',
        name: 'photo-u2.jpg',
        mediaType: 'image/jpeg',
        size: 9000,
        width: 1280,
        height: 720,
      },
    ])
  })

  test('a sticker is a message with a sticker attachment (no longer dropped)', () => {
    const m = one({
      sticker: {
        file_id: 'st',
        file_unique_id: 'su',
        width: 512,
        height: 512,
        is_animated: false,
        is_video: true,
        type: 'regular',
        emoji: '🚀',
        set_name: 'Rockets',
      },
    })
    expect(m.text).toBe('')
    expect(m.attachments.map(shape)).toEqual([
      {
        id: 'su',
        kind: 'image',
        media: 'sticker',
        ref: 'st',
        name: 'sticker-su.webm',
        mediaType: 'video/webm',
        width: 512,
        height: 512,
        sticker: { format: 'video', emoji: '🚀', setName: 'Rockets' },
      },
    ])
  })

  test('a GIF is an animation (once, not also a document); voice, audio and video notes keep their kind', () => {
    const gif = one({
      animation: {
        file_id: 'a',
        file_unique_id: 'au',
        width: 320,
        height: 240,
        duration: 3,
        mime_type: 'video/mp4',
      },
      document: { file_id: 'a', file_unique_id: 'au', mime_type: 'video/mp4' },
    })
    expect(gif.attachments.map((a) => a.media)).toEqual(['animation'])
    expect(
      one({ voice: { file_id: 'v', file_unique_id: 'vu', duration: 4 } }).attachments[0],
    ).toMatchObject({ media: 'voice', duration: 4, ref: 'v' })
    expect(
      one({ video_note: { file_id: 'n', file_unique_id: 'nu', length: 240, duration: 9 } })
        .attachments[0],
    ).toMatchObject({ media: 'video_note', kind: 'video', duration: 9 })
    expect(
      one({ audio: { file_id: 'au', file_unique_id: 'auu', duration: 120, file_name: 'song.mp3' } })
        .attachments[0],
    ).toMatchObject({ media: 'audio', name: 'song.mp3' })
  })

  test('places, contacts, polls and dice arrive as content with a short line of text', () => {
    expect(one({ location: { latitude: -6.2, longitude: 106.8 } })).toMatchObject({
      text: '[location -6.2, 106.8]',
      content: { type: 'location', latitude: -6.2, longitude: 106.8 },
    })
    expect(
      one({
        poll: {
          id: 'p',
          question: 'Long or short?',
          options: [
            { text: 'Long', voter_count: 0 },
            { text: 'Short', voter_count: 0 },
          ],
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: 'regular',
          allows_multiple_answers: false,
        },
      }),
    ).toMatchObject({
      text: '[poll: Long or short?]',
      content: {
        type: 'poll',
        question: 'Long or short?',
        options: ['Long', 'Short'],
        anonymous: true,
      },
    })
    expect(one({ dice: { emoji: '🎲', value: 5 } }).content).toEqual({
      type: 'dice',
      emoji: '🎲',
      value: 5,
    })
    expect(
      one({ contact: { phone_number: '+62 811', first_name: 'Budi', user_id: 7 } }).content,
    ).toEqual({ type: 'contact', phone: '+62 811', firstName: 'Budi', userId: '7' })
  })
})

describe('Telegram user account media', () => {
  const base: TgMessage = {
    chat: { id: '-1002', kind: 'group', title: 'Signals', forum: false },
    id: 7,
    at: 1_700_000_000_000,
    text: '',
    sender: { id: '42', name: 'Ana', isBot: false },
    outgoing: false,
    mention: false,
    mentionsOthers: false,
    attachments: [],
    service: false,
  }
  const opts = { selfId: '1', fetch: () => async () => ({ bytes: new Uint8Array([1]) }) }

  test('a voice note in an album keeps its kind, the album id, entities and forward origin', () => {
    const e = normalizeMessage(
      {
        ...base,
        text: 'TP hit',
        groupId: 'g9',
        entities: [{ type: 'bold', offset: 0, length: 2 }],
        forward: { at: 1, name: 'Signals HQ', chat: '-100' },
        attachments: [
          { id: 'v1', kind: 'audio', media: 'voice', duration: 4, mediaType: 'audio/ogg' },
        ],
      },
      opts,
    )
    expect(e.message.groupId).toBe('g9')
    expect(e.message.entities).toEqual([{ type: 'bold', offset: 0, length: 2 }])
    expect(e.message.forwardOf).toMatchObject({ name: 'Signals HQ', chat: '-100' })
    expect(e.message.attachments[0]).toMatchObject({ id: 'v1', media: 'voice', duration: 4 })
  })

  test('a poll without text gets a short line and its content', () => {
    const e = normalizeMessage(
      {
        ...base,
        content: { type: 'poll', question: 'Long or short?', options: ['Long', 'Short'] },
      },
      opts,
    )
    expect(e.message.text).toBe('[poll: Long or short?]')
    expect(e.message.content).toMatchObject({ type: 'poll', options: ['Long', 'Short'] })
  })
})
