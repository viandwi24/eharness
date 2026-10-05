import { describe, expect, test } from 'bun:test'
import { collectDue, DEFAULT_COLLECT, mergeInputs, resolveCollect } from './collect.ts'
import { forgetDelivered, inboxIdsIn, recordDelivered } from './dedupe.ts'
import { fromSerialized, toSerialized } from './serialize.ts'

describe('collect', () => {
  test('resolveCollect: defaults, layers, invalid values ignored', () => {
    expect(resolveCollect()).toEqual({ ...DEFAULT_COLLECT })
    expect(resolveCollect({ quietMs: 10 }, { maxItems: 3, maxWaitMs: -1 })).toEqual({
      quietMs: 10,
      maxWaitMs: 10_000,
      maxItems: 3,
    })
  })

  test('collectDue: quiet, max wait and max items', () => {
    const options = { quietMs: 100, maxWaitMs: 1_000, maxItems: 3 }
    expect(collectDue({ firstAt: 0, lastAt: 50, count: 2 }, options, 120)).toEqual({
      due: false,
      at: 150,
    })
    expect(collectDue({ firstAt: 0, lastAt: 50, count: 2 }, options, 150)).toEqual({ due: true })
    expect(collectDue({ firstAt: 0, lastAt: 990, count: 2 }, options, 1_000)).toEqual({
      due: true,
    })
    expect(collectDue({ firstAt: 0, lastAt: 0, count: 3 }, options, 0)).toEqual({ due: true })
  })

  test('mergeInputs: texts joined with a blank line in order, files concatenated', () => {
    const file = { type: 'file' as const, mediaType: 'image/png', url: 'https://x/a.png' }
    expect(
      mergeInputs([
        { parts: [{ type: 'text', text: 'a' }, file], clientId: 'c1', appMetadata: { k: 1 } },
        { parts: [{ type: 'text', text: 'b1' }, { type: 'text', text: 'b2' }] },
        { parts: [file], appMetadata: { k: 2, j: true } },
      ]),
    ).toEqual({
      parts: [{ type: 'text', text: 'a\n\nb1\n\nb2' }, file, file],
      appMetadata: { k: 2, j: true },
    })
  })
})

describe('dedupe', () => {
  test('inboxIdsIn reads user metadata and data-eh.input parts', () => {
    const ids = inboxIdsIn([
      { id: '1', role: 'user', parts: [], metadata: { eharness: { v: 1, createdAt: 0, inboxId: 'a' } } },
      {
        id: '2',
        role: 'user',
        parts: [],
        metadata: { eharness: { v: 1, createdAt: 0, collected: [{ inboxId: 'b' }, {}] } },
      },
      {
        id: '3',
        role: 'assistant',
        parts: [{ type: 'data-eh.input', data: { source: 'user', text: 'x', inboxId: 'c' } }],
      },
    ])
    expect([...ids].sort()).toEqual(['a', 'b', 'c'])
  })

  test('recordDelivered keeps the newest 100 ids; forgetDelivered removes', () => {
    const core: { inboxDelivered?: string[] } = {}
    recordDelivered(core, Array.from({ length: 120 }, (_, i) => `id${i}`))
    expect(core.inboxDelivered?.length).toBe(100)
    expect(core.inboxDelivered?.[0]).toBe('id20')
    recordDelivered(core, ['id20'])
    expect(core.inboxDelivered?.at(-1)).toBe('id20')
    forgetDelivered(core, core.inboxDelivered ?? [])
    expect(core.inboxDelivered).toBeUndefined()
  })
})

describe('serialize', () => {
  test('round trip through the stored form re-validates the input', () => {
    const input = {
      parts: [{ type: 'text' as const, text: 'hi' }],
      clientId: 'client-1',
      appMetadata: { tenant: 't1' },
    }
    const stored = toSerialized(input)
    expect(stored).toEqual(input)
    expect(fromSerialized(stored, { acceptClientMetadata: true, files: undefined })).toEqual(input)
    expect(fromSerialized(stored, { acceptClientMetadata: false, files: undefined })).toEqual({
      parts: input.parts,
      clientId: 'client-1',
    })
    expect(() =>
      fromSerialized(
        { parts: [{ type: 'file', mediaType: 'text/plain', url: 'file:///etc/passwd' }] },
        { acceptClientMetadata: false, files: undefined },
      ),
    ).toThrow()
  })
})
