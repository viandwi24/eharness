import { describe, expect, test } from 'bun:test'
import type { FlexibleSchema } from 'ai'
import { z } from 'zod/v4'
import { isHarnessError } from '../errors.ts'
import { defineDataPart } from './data-parts.ts'
import { createKindMessage, defineMessageKind } from './kinds.ts'
import { createCoreMessageRegistry } from './registry.ts'
import { validateStoredMessages } from './validate.ts'

function registry() {
  const r = createCoreMessageRegistry()
  r.registerDataPart(
    'note',
    defineDataPart({
      schema: z.object({ value: z.string() }) as FlexibleSchema<{ value: string }>,
      upgrade: (data) => (typeof data === 'string' ? { value: data } : (data as { value: string })),
    }),
    'app',
  )
  r.registerKind(
    'report',
    defineMessageKind({
      role: 'assistant',
      schema: z.object({ title: z.string() }) as FlexibleSchema<{ title: string }>,
      upgrade: (data) => ({ title: String((data as { name?: string }).name ?? '') }),
    }),
    'app',
  )
  return r
}

const valid = {
  id: 'm1',
  role: 'user',
  metadata: { app: { tenant: 't1' }, eharness: { v: 1, createdAt: 1, future: { x: 1 } } },
  parts: [{ type: 'text', text: 'hi' }],
}

describe('validateStoredMessages', () => {
  test('keeps unknown metadata keys and does not mutate the input', async () => {
    const input = [structuredClone(valid)]
    const { messages, warnings } = await validateStoredMessages(input, registry())
    expect(warnings).toEqual([])
    expect(messages).toEqual([valid as never])
    expect(input).toEqual([valid])
    expect(messages[0]).not.toBe(input[0] as never)
  })

  test('applies upgrade before validation', async () => {
    const old = {
      id: 'm2',
      role: 'assistant',
      parts: [{ type: 'data-note', data: 'legacy string' }],
    }
    const kind = createKindMessage('report', { name: 'Q3' }, { id: 'm3', role: 'assistant' })
    const { messages } = await validateStoredMessages([old, kind], registry())
    expect(messages[0]?.parts[0] as unknown).toEqual({
      type: 'data-note',
      data: { value: 'legacy string' },
    })
    expect(messages[1]?.parts[0] as unknown).toEqual({ type: 'data-report', data: { title: 'Q3' } })
    // storage copy untouched
    expect(old.parts[0]?.data).toBe('legacy string')
  })

  test('removes unregistered data parts, warns once per type', async () => {
    const message = {
      id: 'm4',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'a' },
        { type: 'data-ghost', data: 1 },
        { type: 'data-ghost', data: 2 },
      ],
    }
    const second = { ...message, id: 'm5' }
    const { messages, warnings } = await validateStoredMessages(
      [message, second],
      registry(),
      'throw',
    )
    expect(messages.map((m) => m.parts.length)).toEqual([1, 1])
    expect(warnings.map((w) => w.code)).toEqual(['W_UNKNOWN_STORED_PART'])
    expect(warnings[0]?.details?.type).toBe('data-ghost')
  })

  test('skips kind messages of unregistered kinds', async () => {
    const kind = createKindMessage('gone.kind', { a: 1 }, { id: 'm6' })
    const { messages, warnings } = await validateStoredMessages([kind, valid], registry())
    expect(messages.map((m) => m.id)).toEqual(['m1'])
    expect(warnings.map((w) => w.code)).toEqual(['W_UNKNOWN_STORED_PART'])
  })

  const invalidMessages = [
    { ...valid, id: 'bad-meta', metadata: { eharness: { v: 2, createdAt: 1 } } },
    { id: 'bad-data', role: 'assistant', parts: [{ type: 'data-note', data: { value: 1 } }] },
    {
      ...createKindMessage('eh.event', { name: 'a', text: 'b' }, { id: 'bad-kind' }),
      parts: [
        { type: 'data-eh.event', data: { name: 'a', text: 'b' } },
        { type: 'text', text: 'extra' },
      ],
    },
    { id: 'no-parts', role: 'user' },
    { id: 'bad-role', role: 'robot', parts: [] },
  ]

  test("policy 'drop' skips invalid messages with W_INVALID_MESSAGE", async () => {
    const { messages, warnings } = await validateStoredMessages(
      [...invalidMessages, valid],
      registry(),
      'drop',
    )
    expect(messages.map((m) => m.id)).toEqual(['m1'])
    expect(warnings.map((w) => w.details?.messageId)).toEqual([
      'bad-meta',
      'bad-data',
      'bad-kind',
      'no-parts',
      'bad-role',
    ])
    expect(new Set(warnings.map((w) => w.code))).toEqual(new Set(['W_INVALID_MESSAGE']))
  })

  test("policy 'keep' keeps message-shaped invalid copies", async () => {
    const { messages, warnings } = await validateStoredMessages(invalidMessages, registry(), 'keep')
    expect(messages.map((m) => m.id)).toEqual(['bad-meta', 'bad-data', 'bad-kind', 'bad-role'])
    expect(warnings.map((w) => w.details?.messageId)).toEqual(['no-parts'])
  })

  test("policy 'throw' rejects with EH_INVALID_MESSAGE", async () => {
    try {
      await validateStoredMessages([valid, invalidMessages[1]], registry(), 'throw')
      throw new Error('expected a rejection')
    } catch (error) {
      expect(isHarnessError(error, 'EH_INVALID_MESSAGE')).toBe(true)
      expect((error as Error).message).toContain('bad-data')
    }
  })

  test('core kinds validate their payloads', async () => {
    const marker = createKindMessage(
      'eh.compaction',
      { summary: 's', resumeFromId: null, tokens: { before: 1, after: 1 }, trigger: 'manual' },
      { id: 'c1' },
    )
    const broken = createKindMessage('eh.compaction', { summary: 's' }, { id: 'c2' })
    const { messages } = await validateStoredMessages([marker, broken], registry())
    expect(messages.map((m) => m.id)).toEqual(['c1'])
  })

  test("a throwing upgrade leaves the part's pre-upgrade data (policy 'keep')", async () => {
    const r = createCoreMessageRegistry()
    r.registerDataPart(
      'bad',
      defineDataPart({
        schema: z.object({ v: z.number() }) as FlexibleSchema<{ v: number }>,
        upgrade: (data) => {
          ;(data as { v: unknown }).v = 'half-mutated'
          throw new Error('nope')
        },
      }),
      'app',
    )
    const stored = { id: 'u1', role: 'assistant', parts: [{ type: 'data-bad', data: { v: 1 } }] }
    const { messages } = await validateStoredMessages([stored], r, 'keep')
    expect(messages[0]?.parts[0] as unknown).toEqual({ type: 'data-bad', data: { v: 1 } })
    expect(stored.parts[0]?.data).toEqual({ v: 1 })
  })
})
