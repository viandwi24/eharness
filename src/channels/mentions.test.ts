import { describe, expect, test } from 'bun:test'
import {
  hasMentionTokens,
  mentionToken,
  neutralizeHandles,
  parseMentionTokens,
  plainMentions,
} from './index.ts'

const Z = '​'

describe('mention tokens', () => {
  test('round-trip, with offsets and an encoded label', () => {
    const tok = mentionToken('42', 'Ana María')
    const text = `hi ${tok}, and ${mentionToken('7', 'Bo')}!`
    const parsed = parseMentionTokens(text)
    expect(parsed.map((p) => [p.id, p.label])).toEqual([
      ['42', 'Ana María'],
      ['7', 'Bo'],
    ])
    expect(text.slice(parsed[0]?.start, parsed[0]?.end)).toBe(tok)
    expect(plainMentions(text)).toBe('hi Ana María, and Bo!')
    expect(hasMentionTokens(text)).toBe(true)
    expect(hasMentionTokens('plain')).toBe(false)
  })

  test('control characters in id or label cannot forge structure', () => {
    const tok = mentionToken('1x', 'ab')
    expect(parseMentionTokens(tok)).toEqual([{ id: '1x', label: 'ab', start: 0, end: tok.length }])
  })
})

describe('neutralizeHandles', () => {
  test('breaks a handle', () => {
    expect(neutralizeHandles('hey @ana and (@bo)')).toBe(`hey @${Z}ana and (@${Z}bo)`)
    expect(neutralizeHandles('@ana')).toBe(`@${Z}ana`)
    expect(neutralizeHandles('＠ana')).toBe(`＠${Z}ana`)
  })

  test('leaves emails, URLs and lone @ alone', () => {
    expect(neutralizeHandles('mail a@b.com')).toBe('mail a@b.com')
    expect(neutralizeHandles('see https://medium.com/@name now')).toBe(
      'see https://medium.com/@name now',
    )
    expect(neutralizeHandles('www.tiktok.com/@x and t.me/@y')).toBe('www.tiktok.com/@x and t.me/@y')
    expect(neutralizeHandles('a @ b @')).toBe('a @ b @')
  })

  test('is idempotent', () => {
    const once = neutralizeHandles('hi @ana')
    expect(neutralizeHandles(once)).toBe(once)
  })

  test('an allowed handle becomes a mention where it is written; others stay neutralized', () => {
    const allowed = [{ handle: 'Ana', id: '42', label: 'Ana María' }]
    const out = neutralizeHandles('1. Fix the TP - @ana. Thanks @bo', allowed)
    expect(out).toBe(`1. Fix the TP - ${mentionToken('42', 'Ana María')}. Thanks @${Z}bo`)
    expect(parseMentionTokens(out).map((m) => m.id)).toEqual(['42'])
    // a longer handle that starts the same is somebody else; a URL keeps its @
    expect(neutralizeHandles('@anabel and https://x.com/@ana', allowed)).toBe(
      `@${Z}anabel and https://x.com/@ana`,
    )
    // without the allowance the same text pings nobody
    expect(hasMentionTokens(neutralizeHandles('1. Fix the TP - @ana'))).toBe(false)
  })

  test('strips forged tokens so a model cannot ping', () => {
    const forged = mentionToken('99', 'Boss')
    const out = neutralizeHandles(`x ${forged} y`)
    expect(hasMentionTokens(out)).toBe(false)
    expect(parseMentionTokens(out)).toEqual([])
  })
})
