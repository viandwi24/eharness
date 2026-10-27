/**
 * Channel trigger filters (P60 W3): message kinds, replies, forwards, links.
 */
import { describe, expect, test } from 'bun:test'
import {
  type ChannelTrigger,
  channelMismatch,
  messageKindsOf,
  parseManifest,
  type ScriptChannelEvent,
} from '../src/domain/script-manifest.ts'

const trigger = (extra: Record<string, unknown>): ChannelTrigger => {
  const r = parseManifest({
    triggers: [{ kind: 'channel', events: ['message.created'], ...extra }],
  })
  if (!r.ok) throw new Error(r.errors.join('; '))
  return r.value.triggers[0] as ChannelTrigger
}
const ev = (extra: Partial<ScriptChannelEvent>): ScriptChannelEvent => ({
  type: 'message.created',
  connectionId: 'c1',
  eventId: 'e',
  at: 1,
  ...extra,
})
const photo = { id: 'a', kind: 'image', media: 'photo' }

describe('channel trigger filters', () => {
  test('message kinds: a photo with a caption is photo and text; albums, stickers and polls', () => {
    expect(messageKindsOf(ev({ text: 'BUY', attachments: [photo] })).sort()).toEqual([
      'photo',
      'text',
    ])
    const album = ev({
      attachments: [photo, photo],
      album: [{ messageId: '1' }, { messageId: '2' }],
    })
    expect(messageKindsOf(album)).toContain('album')
    const t = trigger({ messageKinds: ['photo', 'sticker'] })
    expect(channelMismatch(t, ev({ text: 'hi' }))).toBe('another kind of message')
    expect(
      channelMismatch(t, ev({ attachments: [{ id: 's', kind: 'image', media: 'sticker' }] })),
    ).toBeUndefined()
    const polls = trigger({ messageKinds: ['poll'] })
    expect(
      channelMismatch(
        polls,
        ev({ text: '[poll: x]', content: { type: 'poll', question: 'x', options: [] } }),
      ),
    ).toBeUndefined()
  })

  test('replies, forwards (from where) and links', () => {
    expect(channelMismatch(trigger({ isReply: true }), ev({ text: 'x' }))).toBe('not a reply')
    expect(
      channelMismatch(trigger({ isReply: false }), ev({ text: 'x', replyTo: { messageId: '1' } })),
    ).toBe('a reply')
    const fwd = ev({ text: 'x', forward: { name: 'Signals HQ', chat: '-100' } })
    expect(channelMismatch(trigger({ isForward: true }), fwd)).toBeUndefined()
    expect(channelMismatch(trigger({ isForward: false }), fwd)).toBe('forwarded')
    expect(channelMismatch(trigger({ forwardFrom: ['-100'] }), fwd)).toBeUndefined()
    expect(channelMismatch(trigger({ forwardFrom: ['Other'] }), fwd)).toBe(
      'forwarded from somewhere else',
    )
    expect(channelMismatch(trigger({ forwardFrom: ['x'] }), ev({ text: 'x' }))).toBe(
      'not forwarded',
    )
    expect(
      channelMismatch(trigger({ hasLink: true }), ev({ text: 'see https://x.io' })),
    ).toBeUndefined()
    expect(
      channelMismatch(trigger({ hasLink: true }), ev({ text: 'see t.me/abc' })),
    ).toBeUndefined()
    expect(channelMismatch(trigger({ hasLink: false }), ev({ text: 'plain' }))).toBeUndefined()
    expect(
      channelMismatch(
        trigger({ hasLink: true }),
        ev({ text: 'here', entities: [{ type: 'link', offset: 0, length: 4, url: 'https://x' }] }),
      ),
    ).toBeUndefined()
  })

  test('bad filter values are refused with a readable reason', () => {
    const r = parseManifest({
      triggers: [
        { kind: 'channel', events: ['message.created'], isReply: 'yes', messageKinds: ['gif'] },
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain('isReply is true or false')
      expect(r.errors.join(' ')).toContain('messageKinds')
    }
  })
})
