import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { defineDataPart } from '../messages/data-parts.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { chunkEntries, summarize } from './summarize.ts'
import { summarizerModel, summarizerPromptText } from './test-kit.ts'
import { defaultCountTokens } from './tokens.ts'
import { renderTranscript, renderTranscriptEntries } from './transcript.ts'

async function expectGolden(name: string, value: string): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.txt`, import.meta.url))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, value)
    return
  }
  if (!(await file.exists())) throw new Error(`missing golden ${name}.txt (UPDATE_GOLDEN=1)`)
  expect(value).toBe(await file.text())
}

type Part = HarnessUIMessage['parts'][number]
const registry = createCoreMessageRegistry()
registry.registerDataPart(
  'invoice',
  defineDataPart({ schema: z.object({ n: z.number() }), model: 'text' }),
  'app',
)
registry.registerDataPart('hidden', defineDataPart({ schema: z.object({}) }), 'app')

const meta = { eharness: { v: 1 as const, createdAt: 1 } }

const messages: HarnessUIMessage[] = [
  {
    id: '1',
    role: 'user',
    metadata: meta,
    parts: [
      { type: 'text', text: 'Refactor src/strategy.ts and keep the public API.' },
      {
        type: 'file',
        mediaType: 'image/png',
        url: 'data:image/png;base64,AAAA',
        filename: 'plan.png',
      },
    ],
  },
  {
    id: '2',
    role: 'assistant',
    metadata: meta,
    parts: [
      { type: 'step-start' },
      { type: 'reasoning', text: 'secret chain of thought', state: 'done' },
      { type: 'text', text: 'Reading the file first.', state: 'done' },
      {
        type: 'tool-read_file',
        toolCallId: 'c1',
        state: 'output-available',
        input: { path: 'src/strategy.ts', pad: 'p'.repeat(600) },
        output: `export function run() {}\n${'x'.repeat(2_100)}`,
      },
      {
        type: 'tool-write_file',
        toolCallId: 'c2',
        state: 'output-error',
        input: { path: 'src/strategy.ts' },
        errorText: 'STALE: read the file again',
      },
      {
        type: 'tool-delete_file',
        toolCallId: 'c3',
        state: 'output-denied',
        input: { path: '/' },
        approval: { id: 'ap1', approved: false, reason: 'too dangerous' },
      },
      { type: 'tool-slow', toolCallId: 'c4', state: 'input-available', input: {} },
      {
        type: 'dynamic-tool',
        toolName: 'mcp_search',
        toolCallId: 'c5',
        state: 'output-available',
        input: { q: 'x' },
        output: { hits: 2 },
      },
      { type: 'data-eh.input', data: { source: 'user', text: 'also add tests' } },
      { type: 'data-eh.input', data: { source: 'event', text: 'CI failed' } },
      { type: 'data-eh.input', data: { source: 'plugin:todo', text: '2 todos open' } },
      { type: 'step-start' },
      { type: 'text', text: 'Done.', state: 'done' },
      { type: 'text', text: 'Anything else?', state: 'done' },
      { type: 'data-invoice', data: { n: 7 } },
      { type: 'data-hidden', data: {} },
    ] as Part[],
  },
  createKindMessage('eh.event', { name: 'deploy', text: 'Deploy finished' }, { id: '3' }),
  createKindMessage('eh.notice', { level: 'error', message: 'omitted' }, { id: '4' }),
  createKindMessage(
    'eh.compaction',
    { summary: 'old', resumeFromId: null, tokens: { before: 0, after: 0 }, trigger: 'auto' },
    { id: '5' },
  ),
]

describe('transcript (spec 06 §5.3)', () => {
  test('golden: flat text, truncation, in-place inputs, kinds, no reasoning, no markup', async () => {
    const text = renderTranscript({
      previousSummary: 'The user wants a refactor.',
      messages,
      registry,
      sessionId: 's1',
    })
    await expectGolden('transcript', text)
    expect(text).not.toContain('secret chain of thought')
    expect(text).not.toContain('omitted')
    expect(text).not.toContain('summary old') // boundary markers are never rendered as messages
  })

  test('empty input renders nothing', () => {
    expect(renderTranscriptEntries({ messages: [], registry, sessionId: 's1' })).toEqual([])
    expect(
      renderTranscriptEntries({ previousSummary: '  ', messages: [], registry, sessionId: 's1' }),
    ).toEqual([])
  })
})

describe('summarize', () => {
  test('one call: instructions, transcript and hook context, maxOutputTokens', async () => {
    const model = summarizerModel(['  the brief  '])
    const { summary } = await summarize({
      model,
      prompt: 'PROMPT',
      entries: ['USER: a', 'ASSISTANT: b'],
      context: ['file src/a.ts in progress'],
      maxSummaryTokens: 300,
      window: 10_000,
      count: defaultCountTokens,
    })
    expect(summary).toBe('the brief')
    expect(model.calls).toHaveLength(1)
    const call = model.calls[0] as (typeof model.calls)[number]
    expect(call.maxOutputTokens).toBe(300)
    expect(call.prompt[0]).toMatchObject({ role: 'system', content: 'PROMPT' })
    const text = summarizerPromptText(call)
    expect(text).toContain('<transcript>\nUSER: a\n\nASSISTANT: b\n</transcript>')
    expect(text).toContain('- file src/a.ts in progress')
  })

  test('rolling chunks above 60% of the summarizer window; the running summary is fed forward', async () => {
    const model = summarizerModel((_call, i) => `summary ${i}`)
    const entries = Array.from({ length: 6 }, (_, i) => `USER: ${String(i).repeat(400)}`)
    const { summary } = await summarize({
      model,
      prompt: 'P',
      entries,
      context: ['ctx'],
      maxSummaryTokens: 50,
      window: 500, // 60% = 300 tokens; each entry ≈ 102 tokens
      count: defaultCountTokens,
    })
    expect(model.calls.length).toBeGreaterThan(1)
    expect(summary).toBe(`summary ${model.calls.length - 1}`)
    const second = summarizerPromptText(model.calls[1] as (typeof model.calls)[number])
    expect(second).toContain('PREVIOUS SUMMARY:\nsummary 0')
    // hook context only in the last call
    expect(summarizerPromptText(model.calls[0] as (typeof model.calls)[number])).not.toContain(
      'ctx',
    )
    expect(summarizerPromptText(model.calls.at(-1) as (typeof model.calls)[number])).toContain(
      '- ctx',
    )
  })

  test('empty output and model errors reject', async () => {
    const base = {
      prompt: 'P',
      entries: ['USER: a'],
      context: [],
      maxSummaryTokens: 10,
      window: 1_000,
      count: defaultCountTokens,
    }
    await expect(summarize({ ...base, model: summarizerModel(['']) })).rejects.toThrow('empty')
    await expect(
      summarize({ ...base, model: summarizerModel([new Error('provider down')]) }),
    ).rejects.toThrow('provider down')
  })

  test('chunking keeps order and truncates an entry larger than the budget', () => {
    const chunks = chunkEntries(
      ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(4_000)],
      25,
      defaultCountTokens,
    )
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual(['a'.repeat(40), 'b'.repeat(40)])
    expect(chunks[1]?.[0]).toContain('…[truncated ')
    expect(defaultCountTokens(chunks[1]?.[0] ?? '')).toBeLessThanOrEqual(30)
  })
})
