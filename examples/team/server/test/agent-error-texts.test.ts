/**
 * Fixes from a production agent's transcripts: a program note by proposal id, the connection named
 * by its connector id, and attachment names.
 */
import { describe, expect, test } from 'bun:test'
import { programNoteAction } from '../src/app/programs.ts'
import { resolveConnectionRef } from '../src/infra/channels/connection-ref.ts'
import type { ConnectionInfo } from '../src/infra/channels/gateway.ts'
import { toTelegramHtml } from '../src/infra/telegram/format.ts'
import { classifyError, describeError } from '../src/infra/telegram-user/errors.ts'

const conn = (connectionId: string, platform: string, connected = true): ConnectionInfo => ({
  connectionId,
  platform,
  agentId: 'a1',
  connected,
  breaker: undefined,
})

describe('resolveConnectionRef', () => {
  const one = [conn('01abc', 'telegram-user'), conn('01def', 'telegram')]
  test('the connection id, the connector id and a spelled-differently connector id all work', () => {
    expect(resolveConnectionRef(one, '01abc')).toEqual({ ok: true, id: '01abc' })
    expect(resolveConnectionRef(one, 'telegram-user')).toEqual({ ok: true, id: '01abc' })
    expect(resolveConnectionRef(one, 'telegram_user')).toEqual({ ok: true, id: '01abc' })
    expect(resolveConnectionRef(one, 'telegram')).toEqual({ ok: true, id: '01def' })
  })
  test('several connections of one connector, or none, list the valid ids', () => {
    const two = [conn('a', 'telegram-user'), conn('b', 'telegram-user', false)]
    const many = resolveConnectionRef(two, 'telegram-user')
    expect(many.ok).toBe(false)
    expect(many.ok ? '' : many.text).toContain(
      'a (telegram-user), b (telegram-user, not connected)',
    )
    const none = resolveConnectionRef(one, 'slack')
    expect(none.ok ? '' : none.text).toContain(
      'Your connections (use the id): 01abc (telegram-user)',
    )
    expect(resolveConnectionRef([], 'x').ok).toBe(false)
  })
})

describe('program_note by proposal id', () => {
  const program = { id: 'p1', name: 'Follow Up', notes: ['be brief'] }
  const deps = (decision: unknown): never =>
    ({
      programs: { list: () => [program] },
      decisions: { get: (id: string) => (id === 'd1' ? decision : undefined) },
    }) as never

  test('an approved proposal resolves to the program it became', () => {
    const d = { kind: 'proposal', status: 'approved', title: 'T', outcome: { programId: 'p1' } }
    expect(programNoteAction(deps(d), { action: 'list', program: 'd1' })).toContain('be brief')
  })
  test('an open or rejected proposal says what it is', () => {
    const open = { kind: 'proposal', status: 'open', title: 'T', outcome: null }
    expect(() => programNoteAction(deps(open), { action: 'list', program: 'd1' })).toThrow(
      /proposal \("T"\) the client has not decided yet/,
    )
    const rejected = { kind: 'proposal', status: 'rejected', title: 'T', outcome: null }
    expect(() => programNoteAction(deps(rejected), { action: 'list', program: 'd1' })).toThrow(
      /did not become a program/,
    )
  })
  test('an unknown ref still lists the programs', () => {
    expect(() => programNoteAction(deps(undefined), { action: 'list', program: 'zzz' })).toThrow(
      /programs: Follow Up/,
    )
  })
})

describe('bare urls in Telegram text', () => {
  const a = (url: string) => `<a href="${url}">${url}</a>`
  test('punctuation after a url stays outside the link', () => {
    expect(toTelegramHtml('see https://tiktok.com/@a/video/1, then')).toBe(
      `see ${a('https://tiktok.com/@a/video/1')}, then`,
    )
    expect(toTelegramHtml('(https://a.b/c).')).toBe(`(${a('https://a.b/c')}).`)
    expect(toTelegramHtml('https://a.b/x_(y)_z!')).toBe(`${a('https://a.b/x_(y)_z')}!`)
  })
  test('underscores in a url are not emphasis, and ampersands are escaped', () => {
    expect(toTelegramHtml('go https://a.b/_x_/y?a=1&b=2 now')).toBe(
      'go <a href="https://a.b/_x_/y?a=1&amp;b=2">https://a.b/_x_/y?a=1&amp;b=2</a> now',
    )
  })
  test('markdown links, code and plain text keep working', () => {
    expect(toTelegramHtml('[x](https://a.b/c) and `https://a.b/d,`')).toBe(
      `<a href="https://a.b/c">x</a> and <code>https://a.b/d,</code>`,
    )
    expect(toTelegramHtml('no url here, ok.')).toBe('no url here, ok.')
  })
})

describe('MTProto peer cache miss', () => {
  test('is a readable refusal, not "Telegram request failed"', () => {
    const k = classifyError(new Error('Peer 8150013151 is not found in local cache'))
    expect(k.kind).toBe('invalid')
    const text = describeError(k)
    expect(text).not.toContain('Telegram request failed')
    expect(text).toContain('8150013151')
    expect(text).toContain('not among the account')
  })
})
