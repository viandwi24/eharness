import { describe, expect, test } from 'bun:test'
import type { FlexibleSchema } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod/v4'
import { defineDataPart } from './data-parts.ts'
import { createKindMessage, defineMessageKind } from './kinds.ts'
import { project } from './project.ts'
import { createCoreMessageRegistry } from './registry.ts'
import { sanitizeModelMessages } from './sanitize.ts'
import { INTERRUPTED_UNKNOWN } from './texts.ts'
import type { HarnessUIMessage, PendingState } from './types.ts'

/**
 * Golden files live in `__golden__/`. Run `UPDATE_GOLDEN=1 bun test` to (re)write them; review
 * the diff before committing.
 */
async function expectGolden(name: string, value: unknown): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.json`, import.meta.url))
  const actual = JSON.parse(JSON.stringify(value))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (!(await file.exists())) {
    throw new Error(`missing golden file ${name}.json (run UPDATE_GOLDEN=1 bun test)`)
  }
  expect(actual).toEqual(await file.json())
}

type Part = HarnessUIMessage['parts'][number]
const meta = (extra: Record<string, unknown> = {}) => ({
  eharness: { v: 1 as const, createdAt: 1, ...extra },
})
const user = (id: string, text: string): HarnessUIMessage => ({
  id,
  role: 'user',
  metadata: meta(),
  parts: [{ type: 'text', text }],
})
const assistant = (id: string, parts: unknown[], extra?: Record<string, unknown>) =>
  ({ id, role: 'assistant', metadata: meta(extra), parts: parts as Part[] }) as HarnessUIMessage
const text = (value: string) => ({ type: 'text', text: value, state: 'done' })
const stepStart = { type: 'step-start' }
const toolDone = (id: string, output: unknown) => ({
  type: 'tool-weather',
  toolCallId: id,
  state: 'output-available',
  input: { city: 'Oslo' },
  output,
})

function registry() {
  const r = createCoreMessageRegistry()
  const schema = z.object({ value: z.string() }) as FlexibleSchema<{ value: string }>
  r.registerDataPart('note', defineDataPart({ schema, model: 'text' }), 'app')
  r.registerDataPart('secret', defineDataPart({ schema }), 'app')
  r.registerDataPart('progress', defineDataPart({ schema, transient: true, model: 'text' }), 'app')
  r.registerDataPart(
    'fs.change',
    defineDataPart({
      schema: z.object({ path: z.string() }) as FlexibleSchema<{ path: string }>,
      model: (data, ctx) => ({
        type: 'text',
        text: `[changed ${data.path} in ${ctx.sessionId}/${ctx.message.id}]`,
      }),
    }),
    'fs',
  )
  r.registerKind(
    'report',
    defineMessageKind({
      role: 'assistant',
      schema: z.object({ title: z.string() }) as FlexibleSchema<{ title: string }>,
      model: (data) => [{ type: 'text', text: `Report: ${data.title}` }],
    }),
    'app',
  )
  return r
}

const base = { registry: registry(), sessionId: 's1' }

describe('project (golden)', () => {
  test('plain chat', async () => {
    const view = [
      user('01', 'Hello'),
      assistant('02', [stepStart, text('Hi! How can I help?')]),
      user('03', 'Tell me a joke'),
      assistant('04', [stepStart, text('Why did the chicken…')]),
    ]
    await expectGolden('plain-chat', await project(view, base))
  })

  test('tool round-trip', async () => {
    const view = [
      user('01', 'Weather?'),
      assistant('02', [
        stepStart,
        text('Checking.'),
        toolDone('c1', { temp: 20 }),
        {
          type: 'tool-fails',
          toolCallId: 'c2',
          state: 'output-error',
          input: {},
          errorText: 'Error: boom',
        },
        {
          type: 'dynamic-tool',
          toolName: 'mcp_lookup',
          toolCallId: 'c3',
          state: 'output-available',
          input: { q: 'x' },
          output: 'found',
        },
        stepStart,
        text('It is 20 degrees.'),
      ]),
    ]
    await expectGolden('tool-round-trip', await project(view, base))
  })

  test('data parts: omit, text, fn, transient and unknown', async () => {
    const view = [
      user('01', 'Save the note'),
      assistant('02', [
        stepStart,
        { type: 'data-note', data: { value: 'remember milk' } },
        { type: 'data-secret', data: { value: 'hidden' } },
        { type: 'data-progress', data: { value: '50%' } },
        { type: 'data-ghost', data: { anything: true } },
        text('Saved.'),
        { type: 'data-fs.change', id: '/a.md', data: { path: '/a.md' } },
        { type: 'data-eh.status', data: { state: 'idle' } },
      ]),
    ]
    await expectGolden('data-parts', await project(view, base))
  })

  test('kinds: projected, omitted, delivered, unknown', async () => {
    const view = [
      user('01', 'Start'),
      assistant('02', [stepStart, text('Started.')]),
      createKindMessage(
        'eh.event',
        { name: 'backtest.finished', text: 'Backtest #42 finished: +12%' },
        { id: '03', createdAt: 1 },
      ),
      createKindMessage(
        'eh.notice',
        { level: 'error', message: 'Provider unavailable' },
        { id: '04', createdAt: 1 },
      ),
      createKindMessage(
        'eh.rewind',
        { afterId: '02', reason: 'revert' },
        { id: '05', createdAt: 1 },
      ),
      createKindMessage('report', { title: 'Q3' }, { id: '06', createdAt: 1, role: 'assistant' }),
      createKindMessage(
        'eh.event',
        { name: 'x', text: 'already delivered inline' },
        { id: '07', createdAt: 1, deliveredIn: '02' },
      ),
      createKindMessage('unknown.kind', { a: 1 }, { id: '08', createdAt: 1 }),
      user('09', 'And now?'),
    ]
    await expectGolden('kinds', await project(view, base))
  })

  test('older boundary dropped, newest summary leads', async () => {
    const view = [
      createKindMessage(
        'eh.compaction',
        { summary: 'OLD', resumeFromId: '01', tokens: { before: 1, after: 1 }, trigger: 'auto' },
        { id: '00a', createdAt: 1 },
      ),
      createKindMessage(
        'eh.compaction',
        { summary: 'NEW', resumeFromId: '01', tokens: { before: 9, after: 2 }, trigger: 'turn' },
        { id: '00b', createdAt: 1 },
      ),
      user('01', 'Continue'),
      assistant('02', [stepStart, text('Continuing.')]),
    ]
    await expectGolden('boundary', await project(view, base))
  })

  test('partial trimming drops summarized steps of one message', async () => {
    const marker = createKindMessage(
      'eh.compaction',
      {
        summary: 'Steps 0-1 read three files.',
        resumeFromId: '01',
        partial: { messageId: '02', fromStep: 2 },
        tokens: { before: 100, after: 20 },
        trigger: 'auto',
      },
      { id: '03', createdAt: 1 },
    )
    const view = [
      marker,
      user('01', 'Refactor'),
      assistant('02', [
        stepStart,
        toolDone('c1', 'file a'),
        stepStart,
        toolDone('c2', 'file b'),
        stepStart,
        toolDone('c3', 'file c'),
        stepStart,
        text('Done.'),
      ]),
    ]
    const wire = await project(view, base)
    expect(JSON.stringify(wire)).not.toContain('file a')
    expect(JSON.stringify(wire)).not.toContain('file b')
    await expectGolden('partial', wire)
  })

  test('interrupted tool calls are answered, pending and continued ones kept', async () => {
    const pending: PendingState = {
      messageId: '04',
      approvals: [{ approvalId: 'ap-4', toolCallId: 'c4', toolName: 'deploy' }],
      clientTools: [],
    }
    const view = [
      user('01', 'Go'),
      assistant('02', [
        stepStart,
        { type: 'tool-weather', toolCallId: 'c1', state: 'input-streaming', input: { ci: 1 } },
        { type: 'tool-weather', toolCallId: 'c1b', state: 'input-streaming' },
        { type: 'tool-weather', toolCallId: 'c2', state: 'input-available', input: { city: 'B' } },
        {
          type: 'tool-deploy',
          toolCallId: 'c3',
          state: 'approval-requested',
          input: {},
          approval: { id: 'ap-3' },
        },
        {
          type: 'tool-deploy',
          toolCallId: 'c3b',
          state: 'approval-responded',
          input: {},
          approval: { id: 'ap-3b', approved: true },
        },
        {
          type: 'tool-weather',
          toolCallId: 'c3c',
          state: 'output-available',
          input: { city: 'C' },
          output: 'partial…',
          preliminary: true,
        },
      ]),
      user('03', 'Next'),
      assistant('04', [
        stepStart,
        {
          type: 'tool-deploy',
          toolCallId: 'c4',
          state: 'approval-requested',
          input: { env: 'prod' },
          approval: { id: 'ap-4' },
        },
      ]),
    ]
    const wire = await project(view, { ...base, pending })
    await expectGolden('interrupted', wire)
    const results = JSON.stringify(wire)
    for (const id of ['c1', 'c1b', 'c2', 'c3', 'c3b', 'c3c']) {
      expect(results).toContain(`"toolCallId":"${id}"`)
    }
    expect(results.split(INTERRUPTED_UNKNOWN).length - 1).toBe(6)
    // the pending approval is neither answered nor sent
    expect(results).not.toContain('"c4"')
  })

  test('respond continuation keeps the approval response at the end of the wire', async () => {
    const view = [
      user('01', 'Deploy'),
      assistant('02', [
        stepStart,
        {
          type: 'tool-deploy',
          toolCallId: 'c1',
          state: 'approval-responded',
          input: { env: 'prod' },
          approval: { id: 'ap-1', approved: true, signature: 'sig' },
        },
        {
          type: 'tool-deploy',
          toolCallId: 'c2',
          state: 'approval-responded',
          input: { env: 'dev' },
          approval: { id: 'ap-2', approved: false, reason: 'no' },
        },
      ]),
    ]
    const wire = await project(view, { ...base, continuing: '02' })
    await expectGolden('continuation', wire)
    expect(wire.at(-1)?.role).toBe('tool')
    expect(JSON.stringify(wire)).not.toContain(INTERRUPTED_UNKNOWN)
  })

  test('split at data-eh.input with files', async () => {
    const view = [
      user('01', 'Start'),
      assistant('02', [
        stepStart,
        toolDone('c1', 'x'),
        {
          type: 'data-eh.input',
          data: {
            source: 'user',
            text: 'Use this file',
            files: [{ type: 'file', mediaType: 'text/plain', url: 'https://example.com/a.txt' }],
          },
        },
        { type: 'data-eh.input', data: { source: 'plugin:todo', text: 'Todo left: 1' } },
        stepStart,
        text('Ok.'),
      ]),
    ]
    await expectGolden('split', await project(view, base))
  })

  test('foreign-provider reasoning is dropped on model switch', async () => {
    const reasoningMessage = assistant(
      '02',
      [
        stepStart,
        {
          type: 'reasoning',
          text: 'thinking',
          providerMetadata: { anthropic: { signature: 's' } },
        },
        { type: 'text', text: 'Answer', providerMetadata: { anthropic: { cache: 1 } } },
      ],
      { model: 'anthropic/claude-sonnet-4.6' },
    )
    const view = [user('01', 'Q'), reasoningMessage]
    const openai = new MockLanguageModelV4({ provider: 'openai.responses', modelId: 'gpt-5' })
    const anthropic = new MockLanguageModelV4({ provider: 'anthropic.messages', modelId: 'c' })
    const switched = await project(view, { ...base, model: openai })
    await expectGolden('foreign-reasoning', switched)
    expect(JSON.stringify(switched)).not.toContain('thinking')
    const same = await project(view, { ...base, model: anthropic })
    expect(JSON.stringify(same)).toContain('thinking')
    expect(JSON.stringify(same)).toContain('signature')
  })

  test('is deterministic and does not mutate its input', async () => {
    const view = [
      user('01', 'Go'),
      assistant('02', [
        stepStart,
        { type: 'tool-weather', toolCallId: 'c', state: 'input-available', input: {} },
      ]),
    ]
    const before = structuredClone(view)
    const a = await project(view, base)
    const b = await project(view, base)
    expect(a).toEqual(b)
    expect(view).toEqual(before)
  })
})

describe('sanitizeModelMessages', () => {
  test('orphan results removed, missing results synthesized, empty messages removed', async () => {
    const wire = sanitizeModelMessages([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'x',
            toolName: 't',
            output: { type: 'text', value: 'orphan' },
          },
        ],
      },
      { role: 'user', content: '' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'a', toolName: 't', input: {} },
          { type: 'tool-call', toolCallId: 'b', toolName: 't', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 't',
            output: { type: 'text', value: 'ok' },
          },
          {
            type: 'tool-result',
            toolCallId: 'a',
            toolName: 't',
            output: { type: 'text', value: 'dup' },
          },
          {
            type: 'tool-result',
            toolCallId: 'zzz',
            toolName: 't',
            output: { type: 'text', value: 'orphan' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c', toolName: 't', input: {} }],
      },
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ])
    await expectGolden('sanitize', wire)
    expect(JSON.stringify(wire)).not.toContain('orphan')
    expect(JSON.stringify(wire)).not.toContain('dup')
  })

  test('output-error parts with rawInput project without the AI SDK deprecation warning', async () => {
    const g = globalThis as { AI_SDK_LOG_WARNINGS?: unknown }
    const previous = g.AI_SDK_LOG_WARNINGS
    const logged: unknown[] = []
    g.AI_SDK_LOG_WARNINGS = (o: unknown) => logged.push(o)
    try {
      const stored = assistant('a1', [
        stepStart,
        {
          type: 'tool-weather',
          toolCallId: 'c1',
          state: 'output-error',
          input: undefined,
          rawInput: { city: 'Oslo' },
          errorText: 'Invalid input',
        },
      ])
      const wire = await project([user('u1', 'hi'), stored], {
        registry: registry(),
        sessionId: 's1',
      })
      expect(logged).toEqual([])
      expect(JSON.stringify(wire)).toContain('Oslo')
      // the input is not mutated
      expect(JSON.stringify(stored)).toContain('rawInput')
    } finally {
      g.AI_SDK_LOG_WARNINGS = previous
    }
  })
})
