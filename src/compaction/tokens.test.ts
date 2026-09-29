import { describe, expect, test } from 'bun:test'
import { type ModelMessage, tool } from 'ai'
import { z } from 'zod/v4'
import { createKindMessage } from '../messages/kinds.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import {
  buildStats,
  contextLimits,
  createCalibration,
  DEFAULT_CONTEXT_WINDOW,
  defaultCountTokens,
  FILE_TOKENS,
  messageTokens,
  modelMessageTokens,
  resolveWindow,
  toolTokens,
  wireTokens,
  withTokens,
} from './tokens.ts'

const registry = createCoreMessageRegistry()
const count = defaultCountTokens

describe('token estimates', () => {
  test('default counter is ceil(chars / 4)', () => {
    expect(defaultCountTokens('')).toBe(0)
    expect(defaultCountTokens('abcd')).toBe(1)
    expect(defaultCountTokens('abcde')).toBe(2)
  })

  test('model messages: text, tool calls and results, files, overhead', () => {
    expect(modelMessageTokens({ role: 'user', content: 'x'.repeat(40) }, count)).toBe(14)
    const assistant: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'x'.repeat(8) },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'read', input: { path: '/a' } },
      ],
    }
    // 4 overhead + 2 text + 1 name + 4 json
    expect(modelMessageTokens(assistant, count)).toBe(4 + 2 + 1 + 4)
    const result: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'read',
          output: { type: 'text', value: 'y'.repeat(400) },
        },
      ],
    }
    expect(modelMessageTokens(result, count)).toBe(4 + 1 + 100)
    const file: ModelMessage = {
      role: 'user',
      content: [{ type: 'file', mediaType: 'image/png', data: 'AAAA' }],
    }
    expect(modelMessageTokens(file, count)).toBe(4 + FILE_TOKENS)
    expect(wireTokens([result, file], count)).toBe(105 + 4 + FILE_TOKENS)
  })

  test('stored messages: projection estimate, cached in metadata.eharness.tokens', async () => {
    const message: HarnessUIMessage = {
      id: 'm1',
      role: 'user',
      metadata: { eharness: { v: 1, createdAt: 1 } },
      parts: [{ type: 'text', text: 'x'.repeat(40) }],
    }
    const annotated = await withTokens(message, registry, count)
    expect(annotated.metadata?.eharness?.tokens).toBe(14)
    expect(message.metadata?.eharness?.tokens).toBeUndefined() // not mutated
    // the cached value wins over a recomputation
    const cached = { ...annotated, parts: [{ type: 'text' as const, text: 'x'.repeat(4000) }] }
    expect(await messageTokens(cached, registry, count)).toBe(14)
    // kinds: their projection (a compaction marker projects its summary)
    const marker = createKindMessage('eh.compaction', {
      summary: 'x'.repeat(80),
      resumeFromId: null,
      tokens: { before: 0, after: 0 },
      trigger: 'manual',
    })
    const expected = count('<conversation-summary></conversation-summary>') + 20 + 4
    expect(await messageTokens(marker, registry, count)).toBe(expected)
    // an omitted kind projects to nothing
    const notice = createKindMessage('eh.notice', { level: 'error', message: 'boom' })
    expect(await messageTokens(notice, registry, count)).toBe(0)
  })

  test('tool definitions include the input schema; cached per tool object', async () => {
    const t = tool({
      description: 'Read a file',
      inputSchema: z.object({ path: z.string() }),
      execute: async () => 'ok',
    })
    const a = await toolTokens('read', t, count)
    expect(a).toBeGreaterThan(10 + count('Read a file'))
    expect(await toolTokens('read', t, count)).toBe(a)
  })
})

describe('calibration', () => {
  test('starts at 1, moves towards actual / estimate (EMA), clamped to [0.5, 2]', () => {
    const k = createCalibration()
    expect(k.factor).toBe(1)
    expect(k.apply(100)).toBe(100)
    k.observe(100, 150)
    expect(k.factor).toBeCloseTo(1.15)
    for (let i = 0; i < 50; i++) k.observe(100, 1_000)
    expect(k.factor).toBeCloseTo(2)
    for (let i = 0; i < 50; i++) k.observe(100, 1)
    expect(k.factor).toBeCloseTo(0.5)
    k.observe(100, undefined)
    k.observe(0, 50)
    expect(k.factor).toBeCloseTo(0.5)
  })

  test('overflow: the reported count sets k unclamped; otherwise k × 1.25', () => {
    const k = createCalibration()
    k.overflow(100, undefined)
    expect(k.factor).toBe(1.25)
    k.overflow(100, 300)
    expect(k.factor).toBe(3)
    k.observe(100, 1_000) // no longer clamped
    expect(k.factor).toBeGreaterThan(2)
  })
})

describe('window and limits', () => {
  test('number, function, default with W_DEFAULT_CONTEXT_WINDOW', () => {
    const warnings: string[] = []
    const warn = (w: { code: string }) => warnings.push(w.code)
    expect(resolveWindow({ contextWindow: 1_000 }, 'a/b', warn)).toBe(1_000)
    expect(
      resolveWindow({ contextWindow: (m) => (m === 'a/b' ? 500 : undefined) }, 'a/b', warn),
    ).toBe(500)
    expect(warnings).toEqual([])
    expect(resolveWindow({ contextWindow: () => undefined }, 'a/b', warn)).toBe(
      DEFAULT_CONTEXT_WINDOW,
    )
    expect(resolveWindow({}, 'a/b', warn)).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(warnings).toEqual(['W_DEFAULT_CONTEXT_WINDOW', 'W_DEFAULT_CONTEXT_WINDOW'])
  })

  test('summarizeAt, hard limit with reserve (guard, maxOutputTokens, 8%) and ratio factor', () => {
    expect(contextLimits({}, 10_000)).toEqual({
      window: 10_000,
      summarizeAt: 7_500,
      hardLimit: 8_200,
    })
    expect(contextLimits({ compaction: { summarizeAt: 0.5 } }, 10_000).summarizeAt).toBe(5_000)
    expect(contextLimits({ settings: { maxOutputTokens: 1_000 } }, 10_000).hardLimit).toBe(8_000)
    expect(contextLimits({}, 10_000, { maxOutputTokens: 500 }).hardLimit).toBe(8_500)
    expect(
      contextLimits({ guard: { reserveTokens: 0, maxContextRatio: 1 } }, 10_000).hardLimit,
    ).toBe(10_000)
    expect(
      contextLimits({ guard: { reserveTokens: 0 } }, 10_000, { ratioFactor: 0.8 }).hardLimit,
    ).toBe(7_200)
  })

  test('stats are calibrated', () => {
    const k = createCalibration()
    k.overflow(100, 200)
    const stats = buildStats(k, contextLimits({}, 1_000), {
      instructions: 10,
      tools: 20,
      messages: 30,
    })
    expect(stats).toEqual({
      window: 1_000,
      tokens: 120,
      instructions: 20,
      tools: 40,
      messages: 60,
      summarizeAt: 750,
      hardLimit: 820,
    })
  })
})
