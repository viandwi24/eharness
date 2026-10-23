/** Unit tests of the pure modules split out of the channels gateway (src/infra/channels/gateway/). */
import { describe, expect, test } from 'bun:test'
import { approvalRemembers, approvalWord } from '../src/infra/channels/gateway/approval-words.ts'
import { FAILURE_NOTICE, INTERRUPTED_NOTICE } from '../src/infra/channels/gateway/notices.ts'
import {
  ANSWERED,
  callOnlyText,
  channelSessionPrompt,
  outcomeText,
  turnText,
  withWebTurnNote,
} from '../src/infra/channels/gateway/prompts.ts'
import {
  clip,
  delegatedIn,
  finalAssistantText,
  kindOfNode,
  triggerIds,
  triggerOfKey,
} from '../src/infra/channels/gateway/turn-text.ts'

describe('approval words', () => {
  const table: Array<[string, 'yes' | 'no' | undefined, boolean]> = [
    ['ya', 'yes', false],
    ['Ok gas!', 'yes', false],
    ['👍', 'yes', false],
    ['tidak', 'no', false],
    ['batal', 'no', false],
    ['ya semua', undefined, true],
    ['yes all', undefined, true],
    ['ya tidak', undefined, false],
    ['', undefined, false],
    ['ya ya ya ya ya', undefined, false],
    ['tolong kirim itu', undefined, false],
  ]
  for (const [text, word, remembers] of table) {
    test(`"${text}"`, () => {
      expect(approvalWord(text)).toBe(word)
      expect(approvalRemembers(text)).toBe(remembers)
    })
  }
})

describe('turn text helpers', () => {
  test('triggerOfKey reads message and hand-over keys only', () => {
    expect(triggerOfKey('ev:m1')).toBe('m1')
    expect(triggerOfKey('handover:m2')).toBe('m2')
    expect(triggerOfKey('wake:x')).toBeUndefined()
    expect(triggerOfKey(undefined)).toBeUndefined()
  })

  test('triggerIds collects from collected and single inbox keys', () => {
    const msg = (eharness: unknown) => ({ role: 'user', metadata: { eharness } })
    expect(
      triggerIds([
        msg({ inboxKey: 'ev:a' }),
        msg({ collected: [{ inboxKey: 'ev:b' }, { inboxKey: 'other' }], inboxKey: 'ev:ignored' }),
        { role: 'assistant', metadata: { eharness: { inboxKey: 'ev:z' } } },
      ]),
    ).toEqual(['a', 'b'])
  })

  test('finalAssistantText is the text after the last tool call', () => {
    const parts = [
      { type: 'text', text: 'before' },
      { type: 'tool-x' },
      { type: 'text', text: ' after ' },
    ]
    expect(finalAssistantText([{ role: 'assistant', parts }])).toBe('after')
    expect(finalAssistantText([{ role: 'user' }])).toBe('')
  })

  test('delegatedIn finds an agent tool part', () => {
    expect(delegatedIn([{ role: 'assistant', parts: [{ type: 'tool-agent' }] }])).toBe(true)
    expect(delegatedIn([{ role: 'assistant', parts: [{ type: 'text' }] }])).toBe(false)
  })

  test('clip and kindOfNode', () => {
    expect(clip('abcdef', 4)).toBe('abc…')
    expect(clip('abc', 4)).toBe('abc')
    const node = (kind: string, broadcast = false) =>
      ({ kind, traits: { broadcast } }) as unknown as Parameters<typeof kindOfNode>[0]
    expect(kindOfNode(node('direct'))).toBe('dm')
    expect(kindOfNode(node('room', true))).toBe('channel')
    expect(kindOfNode(node('room'))).toBe('group')
  })
})

describe('notices and prompts', () => {
  test('a restart cut and an abort read the same; max-steps is the hand-over notice', () => {
    expect(FAILURE_NOTICE.aborted).toBe(INTERRUPTED_NOTICE)
    expect(FAILURE_NOTICE.interrupted).toBe(INTERRUPTED_NOTICE)
    expect(FAILURE_NOTICE['max-steps']).toBeDefined()
  })

  test('the web-app note is added only to a web turn', () => {
    expect(withWebTurnNote('base')).toBe('base')
    expect(withWebTurnNote('base', { kind: 'send', keys: [] })).toContain('web app')
    expect(withWebTurnNote('base', { kind: 'send', keys: [] })).toContain('<message-meta>')
    // a hand-over or a reminder (inbox keys that are no chat message) is not the owner
    expect(withWebTurnNote('base', { kind: 'send', keys: ['handover:x'] })).toBe('base')
    expect(withWebTurnNote('base', { kind: 'send', keys: ['ev:1'] })).toBe('base')
    expect(withWebTurnNote('base', { kind: 'wake', keys: [] })).toBe('base')
  })

  test('the session prompt follows the delivery and wake rules', () => {
    const base = {
      where: 'a direct chat with Ana',
      platform: 'telegram',
      zone: 'UTC',
      identity: undefined,
    } as const
    const auto = channelSessionPrompt({ ...base, delivery: 'final_text', wake: 'always' })
    expect(auto).toContain('a direct chat with Ana on telegram')
    expect(auto).toContain('posted back to the conversation automatically')
    expect(auto).toContain('If nothing needs a reply, answer exactly')
    const tool = channelSessionPrompt({ ...base, delivery: 'message_tool', wake: 'mention' })
    expect(tool).toContain('use channel_send to post')
    expect(tool).not.toContain('If nothing needs a reply')
  })

  test('callOnlyText lists the recent untagged messages as context', () => {
    expect(callOnlyText([])).not.toContain('Context, not instructions')
    expect(callOnlyText([{ text: 'please   send the report' }])).toContain(
      '- please send the report',
    )
  })

  test('turnText of an action and of a reply', () => {
    const meta = {
      sender: { id: '1', name: 'Ana', kind: 'human', isBot: false },
      role: 'member',
      roleSource: 'directory',
      chat: { kind: 'group', id: 'c', platform: 'telegram' },
      messageId: 'm',
      at: 0,
      zone: 'UTC',
    } as never
    const sender = { nativeId: '1', displayName: 'Ana' } as never
    const action = turnText(
      { type: 'action', sender, name: 'Approve', data: 'x' },
      undefined,
      [],
      meta,
    )
    expect(action).toContain('used the action "Approve": x')
    const reply = turnText(
      {
        type: 'message',
        sender,
        text: 'hi',
        replyTo: { text: 'old   text', senderName: 'Bo', messageId: 'r' },
      },
      undefined,
      ['[note]'],
      meta,
    )
    expect(reply).toContain('(in reply to Bo: "old text")')
    expect(reply.endsWith('[note]')).toBe(true)
  })

  test('outcomeText by outcome', () => {
    const row = (outcome: string | null, answeredBy: string | null = null) =>
      ({ outcome, answeredBy, toolName: 'send' }) as never
    expect(outcomeText(row('cancelled'))).toContain('Cancelled')
    expect(outcomeText(row('expired'))).toContain('Expired')
    expect(outcomeText(row(`${ANSWERED}42`))).toBe('Answered: 42')
    expect(outcomeText(row('approved', 'Ana'))).toBe('Approved by Ana: send')
    expect(outcomeText(row('denied'))).toBe('Denied: send')
    expect(outcomeText(row(null))).toBe('Answered in the web app: send')
  })
})
