import { describe, expect, test } from 'bun:test'
import { createKindMessage } from '../messages/kinds.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'
import { planSplit, type SplitInput } from './split.ts'
import {
  currentTurnStartId,
  groupTurns,
  isBoundaryMessage,
  sliceSteps,
  stepStarts,
  trimToPartial,
} from './turns.ts'

const registry = createCoreMessageRegistry()
type Part = HarnessUIMessage['parts'][number]

const meta = { eharness: { v: 1 as const, createdAt: 1 } }
const user = (id: string, text = id): HarnessUIMessage => ({
  id,
  role: 'user',
  metadata: meta,
  parts: [{ type: 'text', text }],
})
const assistant = (id: string, steps: string[] = [id]): HarnessUIMessage => ({
  id,
  role: 'assistant',
  metadata: meta,
  parts: steps.flatMap((text) => [
    { type: 'step-start' } as Part,
    { type: 'text', text, state: 'done' } as Part,
  ]),
})
const event = (id: string) =>
  createKindMessage('eh.event', { name: 'e', text: id }, { id, createdAt: 1 })
const rewind = (id: string) =>
  createKindMessage('eh.rewind', { afterId: null, reason: 'regenerate' }, { id, createdAt: 1 })
const marker = (id: string, payload: Partial<CompactionPayload> = {}) =>
  createKindMessage(
    'eh.compaction',
    {
      summary: `summary ${id}`,
      resumeFromId: null,
      tokens: { before: 0, after: 0 },
      trigger: 'auto',
      ...payload,
    },
    { id, createdAt: 1 },
  )
const ids = (messages: readonly HarnessUIMessage[]) => messages.map((m) => m.id)
const texts = (message: HarnessUIMessage | undefined) =>
  (message?.parts ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text)

describe('turn grouping (spec 06 §5.1)', () => {
  test('a turn starts at every non-kind user message; leading kinds join the first turn', () => {
    const messages = [
      event('0s'),
      user('1q'),
      assistant('1r'),
      event('1s'),
      user('2q'),
      assistant('2r'),
    ]
    expect(groupTurns(messages)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 6 },
    ])
    expect(groupTurns([event('0s'), rewind('0t')])).toEqual([{ start: 0, end: 2 }])
    expect(groupTurns([])).toEqual([])
  })

  test('data-eh.input parts and rewinds never start a turn', () => {
    const steered: HarnessUIMessage = {
      ...assistant('1r'),
      parts: [
        ...assistant('1r').parts,
        { type: 'data-eh.input', data: { source: 'user', text: 'steer' } } as Part,
      ],
    }
    expect(groupTurns([user('1q'), steered, rewind('1t'), user('2q')])).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 4 },
    ])
  })

  test('current turn rules: input, no-input (kinds / own message), respond, regenerate', () => {
    const view = [marker('m0'), user('1q'), assistant('1r'), event('1s'), event('2s')]
    expect(currentTurnStartId(view, { kind: 'input', userMessageId: '9q' }, registry)).toBe('9q')
    expect(currentTurnStartId(view, { kind: 'no-input', assistantId: '9z' }, registry)).toBe('1s')
    expect(
      currentTurnStartId(view.slice(0, 3), { kind: 'no-input', assistantId: '9z' }, registry),
    ).toBe('9z')
    const history = [user('1q'), assistant('1r'), user('2q'), event('3s'), assistant('2r')]
    expect(currentTurnStartId(history, { kind: 'respond', messageId: '2r' }, registry)).toBe('2q')
    expect(currentTurnStartId(history, { kind: 'regenerate', assistantId: '9z' }, registry)).toBe(
      '2q',
    )
  })

  test('steps: step-start indices, slices, partial trimming', () => {
    const a = assistant('1r', ['s0', 's1', 's2'])
    expect(stepStarts(a)).toEqual([0, 2, 4])
    expect(sliceSteps(a, 0, 2).map((p) => p.type)).toEqual([
      'step-start',
      'text',
      'step-start',
      'text',
    ])
    expect(texts({ ...a, parts: sliceSteps(a, 1) })).toEqual(['s1', 's2'])
    expect(texts(trimToPartial(a, { messageId: '1r', fromStep: 2 }))).toEqual(['s2'])
    expect(trimToPartial(a, { messageId: 'other', fromStep: 2 })).toBe(a)
    expect(trimToPartial(a, { messageId: '1r', fromStep: 9 }).parts).toEqual([])
  })
})

function input(overrides: Partial<SplitInput>): SplitInput {
  return {
    view: [],
    isBoundary: (m) => isBoundaryMessage(m, registry),
    mode: 'pre-turn',
    currentStartId: undefined,
    keepLast: 4,
    maxKeptTokens: 1_000_000,
    tokensOf: async (m) =>
      m.parts.reduce((n, p) => n + ((p as { text?: string }).text?.length ?? 0), 0),
    ...overrides,
  }
}

describe('planSplit', () => {
  const history = [
    user('1q'),
    assistant('1r'),
    user('2q'),
    assistant('2r'),
    user('3q'),
    assistant('3r'),
  ]

  test('pre-turn: keeps T + the last keepLast completed turns; resumeFromId = first kept', async () => {
    const plan = await planSplit(
      input({ view: [...history, user('4q')], currentStartId: '4q', keepLast: 1 }),
    )
    expect(ids(plan.drop)).toEqual(['1q', '1r', '2q', '2r'])
    expect(ids(plan.keep)).toEqual(['3q', '3r', '4q'])
    expect(plan.resumeFromId).toBe('3q')
    expect(plan.keptTurns).toBe(1)
    expect(plan.partial).toBeUndefined()
  })

  test('auto-shrink: kept completed turns above the budget shrink to 0 (T never removed)', async () => {
    const view = [
      user('1q', 'x'.repeat(100)),
      assistant('1r'),
      user('2q', 'y'.repeat(100)),
      assistant('2r'),
      user('3q'),
    ]
    const plan = await planSplit(
      input({ view, currentStartId: '3q', keepLast: 4, maxKeptTokens: 50 }),
    )
    expect(plan.keptTurns).toBe(0)
    expect(ids(plan.keep)).toEqual(['3q'])
    expect(plan.resumeFromId).toBe('3q')
    const one = await planSplit(input({ view, currentStartId: '3q', maxKeptTokens: 150 }))
    expect(one.keptTurns).toBe(1)
    expect(one.resumeFromId).toBe('2q')
  })

  test('pre-turn without input and without injected kinds: resumeFromId is the new assistant id', async () => {
    const plan = await planSplit(
      input({ view: history, currentStartId: '9z', assistantId: '9z', keepLast: 0 }),
    )
    expect(ids(plan.drop)).toEqual(ids(history))
    expect(plan.keep).toEqual([])
    expect(plan.resumeFromId).toBe('9z')
  })

  test('manual: keepLast 0 → resumeFromId null; the pending turn is kept like a current turn', async () => {
    const all = await planSplit(input({ view: history, mode: 'manual', keepLast: 0 }))
    expect(all.resumeFromId).toBeNull()
    expect(ids(all.drop)).toEqual(ids(history))
    const pending = await planSplit(
      input({ view: history, mode: 'manual', keepLast: 0, currentStartId: '3q' }),
    )
    expect(pending.resumeFromId).toBe('3q')
    expect(ids(pending.keep)).toEqual(['3q', '3r'])
  })

  test('the previous summary is carried into the transcript; the boundary is never dropped', async () => {
    const view = [marker('m0', { resumeFromId: '2q' }), ...history.slice(2), user('4q')]
    const plan = await planSplit(input({ view, currentStartId: '4q', keepLast: 1 }))
    expect(plan.previousSummary).toBe('summary m0')
    expect(ids(plan.drop)).toEqual(['2q', '2r'])
  })

  test('mid-turn: keep T.first + the last completed step of A; partial = { A, s }', async () => {
    const a = assistant('4r', ['s0', 's1', 's2'])
    const view = [...history, user('4q'), a]
    const plan = await planSplit(
      input({ view, mode: 'mid-turn', currentStartId: '4q', assistantId: '4r' }),
    )
    expect(plan.resumeFromId).toBe('4q')
    expect(plan.partial).toEqual({ messageId: '4r', fromStep: 2 })
    expect(ids(plan.drop)).toEqual([...ids(history), '4r'])
    expect(texts(plan.drop.at(-1))).toEqual(['s0', 's1'])
    expect(ids(plan.keep)).toEqual(['4q', '4r'])
    expect(texts(plan.keep.at(-1))).toEqual(['s2'])
  })

  test('mid-turn after a mid-turn: only the steps since the previous partial are summarized', async () => {
    const a = assistant('4r', ['s0', 's1', 's2', 's3'])
    const previous = marker('m1', { resumeFromId: '4q', partial: { messageId: '4r', fromStep: 2 } })
    const plan = await planSplit(
      input({
        view: [previous, user('4q'), a],
        mode: 'mid-turn',
        currentStartId: '4q',
        assistantId: '4r',
      }),
    )
    expect(plan.partial).toEqual({ messageId: '4r', fromStep: 3 })
    expect(plan.drop).toHaveLength(1)
    expect(texts(plan.drop[0])).toEqual(['s2'])
    // nothing new: no drop, the previous partial is kept
    const idle = await planSplit(
      input({
        view: [previous, user('4q'), assistant('4r', ['s0', 's1', 's2'])],
        mode: 'mid-turn',
        currentStartId: '4q',
        assistantId: '4r',
      }),
    )
    expect(idle.drop).toEqual([])
    expect(idle.partial).toEqual({ messageId: '4r', fromStep: 2 })
  })

  test('carry forward: a pre-turn compaction keeps the previous partial when its message is kept', async () => {
    const a = assistant('4r', ['s0', 's1', 's2'])
    const previous = marker('m1', { resumeFromId: '4q', partial: { messageId: '4r', fromStep: 2 } })
    const view = [previous, user('4q'), a, user('5q'), assistant('5r'), user('6q')]
    const kept = await planSplit(input({ view, currentStartId: '6q', keepLast: 2 }))
    expect(kept.partial).toEqual({ messageId: '4r', fromStep: 2 })
    expect(texts(kept.keep.find((m) => m.id === '4r'))).toEqual(['s2'])
    // when the message is dropped, only its untrimmed steps reach the transcript
    const dropped = await planSplit(input({ view, currentStartId: '6q', keepLast: 1 }))
    expect(dropped.partial).toBeUndefined()
    expect(texts(dropped.drop.find((m) => m.id === '4r'))).toEqual(['s2'])
  })
})
