import { describe, expect, test } from 'bun:test'
import { APICallError, type LanguageModel, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { coreMessageKinds, isKindMessage } from '../messages/kinds.ts'
import { project } from '../messages/project.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { FlushPayload, HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type {
  ApprovalDecision,
  CompactionBeforeEvent,
  CompactionBeforePatch,
} from '../plugin/types.ts'
import { collect, normalizeVolatile, spyMessages } from '../session/int-kit.ts'
import {
  type ScriptedCallOptions,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { FLUSH_APPROVAL_DENIED } from './flush.ts'
import { answer, estimatedInput, summarizerModel } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** A user message of about `tokens` tokens, recognizable by `tag`. */
const big = (tag: string, tokens = 300) => `${tag} ${'x'.repeat(tokens * 4)}`

const callTool =
  (toolName: string, input: unknown) =>
  (call: ScriptedCallOptions): ScriptedStep => ({
    toolCalls: [{ toolName, input }],
    usage: { inputTokens: estimatedInput(call), outputTokens: 5 },
  })

const read = tool({
  description: 'Read a chunk',
  inputSchema: z.object({ n: z.number() }),
  execute: async ({ n }) => `R${n} ${'y'.repeat(2_400)}`,
})

/** Flush model windows are large; the agent model has 2k (summarizeAt 1500). */
const windowOf = (m: LanguageModel) =>
  typeof m === 'object' && m.modelId.startsWith('flusher') ? 100_000 : 2_000

interface Harness {
  order: string[]
  facts: string[]
  events: CompactionBeforeEvent[]
  decisions: ApprovalDecision[]
}

function savingPlugin(
  h: Harness,
  patch: (e: CompactionBeforeEvent) => CompactionBeforePatch | undefined,
) {
  return definePlugin({
    name: 'saver',
    setup: () => ({
      tools: {
        save_fact: tool({
          description: 'Save a fact',
          inputSchema: z.object({ fact: z.string() }),
          execute: async ({ fact }) => {
            h.order.push(`save:${fact}`)
            h.facts.push(fact)
            return 'saved'
          },
        }),
        other: tool({
          description: 'Not for the flush',
          inputSchema: z.object({}),
          execute: async () => 'other',
        }),
        danger: tool({
          description: 'Needs approval',
          inputSchema: z.object({}),
          execute: async () => {
            h.order.push('danger')
            return 'done'
          },
        }),
      },
      hooks: {
        'compaction.before': (_ctx, e) => {
          h.events.push(e)
          return patch(e)
        },
        'approval.decided': (_ctx, e) => void h.decisions.push(e),
      },
    }),
  })
}

function setup(
  steps: ScriptedStepInput[],
  options: {
    flushSteps?: ScriptedStepInput[]
    patch?: (e: CompactionBeforeEvent, flusher: LanguageModel) => CompactionBeforePatch | undefined
    config?: Partial<HarnessAgentConfig>
    noPlugin?: boolean
  } = {},
) {
  const h: Harness = { order: [], facts: [], events: [], decisions: [] }
  const model = scriptedModel(steps)
  const flusher = scriptedModel(options.flushSteps ?? [], { modelId: 'flusher' })
  const summarizer = summarizerModel((_call, i) => {
    h.order.push('summarize')
    return `SUMMARY-${i + 1}`
  })
  const messages = spyMessages()
  const warnings: HarnessWarning[] = []
  const patch =
    options.patch ??
    ((_e: CompactionBeforeEvent, f: LanguageModel) => ({
      flush: { prompt: 'FLUSH: save what matters.', tools: ['save_fact'], model: f },
    }))
  const agent = defineHarnessAgent({
    model,
    contextWindow: windowOf,
    storage: { messages },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100 },
    plugins: options.noPlugin === true ? [] : [savingPlugin(h, (e) => patch(e, flusher))],
    ...options.config,
  })
  return { agent, model, flusher, summarizer, messages, warnings, h }
}

async function all(messages: ReturnType<typeof spyMessages>): Promise<HarnessUIMessage[]> {
  const out = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  messages.loads.pop()
  return out
}

const flushRecords = async (messages: ReturnType<typeof spyMessages>) =>
  (await all(messages)).filter((m) => isKindMessage(m, 'eh.flush'))
const markers = async (messages: ReturnType<typeof spyMessages>) =>
  (await all(messages)).filter((m) => isKindMessage(m, 'eh.compaction'))
const flushData = (m: HarnessUIMessage | undefined): FlushPayload =>
  (m?.parts[0] as { data: FlushPayload } | undefined)?.data as FlushPayload

const text = (value: unknown) => JSON.stringify(value)

async function fillTurns(session: { send(text: string): { result: Promise<unknown> } }, n: number) {
  for (let i = 1; i <= n; i++) await session.send(big(`Q${i}`)).result
}

const fiveTurns = () => Array.from({ length: 6 }, (_, i) => answer(`A${i + 1}`))

describe('pre-compaction flush (spec 06 §5.2a)', () => {
  test('pre-turn: hook gets drop/tokens/trigger, whitelisted tool saves before the summary, record before marker, no trace in the next wire', async () => {
    const { agent, model, flusher, messages, h } = setup(fiveTurns(), {
      flushSteps: [
        { toolCalls: [{ toolName: 'save_fact', input: { fact: 'F1' } }] },
        { text: 'ok' },
      ],
    })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    expect(h.events).toHaveLength(0)
    const run = session.send(big('Q5'))
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')

    // hook input: exactly the dropped part (turns 1–3), calibrated tokens, trigger 'turn'
    const [event] = h.events
    expect(event?.trigger).toBe('turn')
    expect(event?.tokens).toBeGreaterThan(1_500)
    const dropped = text(event?.messages)
    for (const tag of ['Q1 ', 'Q2 ', 'Q3 ', 'A3']) expect(dropped).toContain(tag)
    for (const tag of ['Q4 ', 'Q5 ']) expect(dropped).not.toContain(tag)

    // the flush call: current wire + prompt, only the whitelisted tool
    expect(flusher.calls).toHaveLength(2)
    const first = flusher.calls[0] as ScriptedCallOptions
    expect((first.tools ?? []).map((t) => t.name)).toEqual(['save_fact'])
    const wire = text(first.prompt)
    expect(wire).toContain('Q5 ')
    expect(wire).toContain('Q1 ')
    expect(text(first.prompt.at(-1))).toContain('FLUSH: save what matters.')

    // the fact was written before the summary was produced
    expect(h.order).toEqual(['save:F1', 'summarize'])

    // storage: exactly one eh.flush, before the marker, valid and omitted from projection
    const stored = await all(messages)
    const records = stored.filter((m) => isKindMessage(m, 'eh.flush'))
    const [marker] = await markers(messages)
    expect(records).toHaveLength(1)
    const record = records[0] as HarnessUIMessage
    expect(record.id < (marker?.id as string)).toBe(true)
    expect(record.role).toBe('assistant')
    expect(record.metadata?.eharness).toMatchObject({ kind: 'eh.flush', turnId: result.turnId })
    const data = flushData(record)
    expect(
      (coreMessageKinds['eh.flush'].schema as unknown as z.ZodType).safeParse(data).success,
    ).toBe(true)
    expect(data).toMatchObject({
      trigger: 'turn',
      prompt: 'FLUSH: save what matters.',
      model: 'mock/flusher',
      steps: 2,
      toolCalls: [{ toolName: 'save_fact', status: 'output' }],
      usage: { inputTokens: 20, outputTokens: 10 },
    })
    const registry = createCoreMessageRegistry()
    expect(await project([record], { registry, sessionId: 's1' })).toEqual([])
    // transient status part on the stream, not persisted
    const live = chunks.find((c) => c.type === 'data-eh.flush') as { transient?: boolean }
    expect(live?.transient).toBe(true)

    // the turn's wire and the next turn's wire carry only the summary, never the flush
    await session.send('next').result
    for (const prompt of model.prompts.slice(4)) {
      const w = text(prompt)
      expect(w).toContain('SUMMARY-1')
      expect(w).not.toContain('FLUSH:')
      expect(w).not.toContain('save_fact')
    }
  })

  test('usage of the flush is in TurnResult.usage and costUsd', async () => {
    const models = (m: LanguageModel) =>
      typeof m === 'object' && m.modelId === 'flusher'
        ? { contextWindow: 100_000, pricing: { input: 1_000, output: 1_000 } }
        : { contextWindow: 2_000, pricing: { input: 0, output: 0 } }
    const { agent } = setup(fiveTurns(), {
      flushSteps: [{ text: 'nothing to save' }],
      config: { models, contextWindow: undefined },
    })
    const plain = setup(fiveTurns(), {
      flushSteps: [],
      config: { models, contextWindow: undefined },
      noPlugin: true,
    })
    // same history with and without a flush: the difference is the flush call (10 in, 5 out)
    for (const a of [agent, plain.agent]) await fillTurns(a.session('s1'), 4)
    const withFlush = await agent.session('s1').send(big('Q5')).result
    const without = await plain.agent.session('s1').send(big('Q5')).result
    expect(withFlush.usage.costUsd ?? 0).toBeCloseTo((without.usage.costUsd ?? 0) + 0.015, 10)
    expect(withFlush.usage.inputTokens).toBe(without.usage.inputTokens + 10)
  })

  test('mid-turn: trigger auto; the running turn keeps its step count', async () => {
    const steps = () => [
      answer('A1'),
      answer('A2'),
      callTool('read', { n: 0 }),
      callTool('read', { n: 1 }),
      answer('Done.'),
    ]
    const flushed = setup(steps(), {
      flushSteps: [
        { toolCalls: [{ toolName: 'save_fact', input: { fact: 'M' } }] },
        { text: 'ok' },
      ],
      config: { tools: { read } },
    })
    const plain = setup(steps(), { config: { tools: { read } }, noPlugin: true })
    const results = []
    for (const s of [flushed, plain]) {
      const session = s.agent.session('s1')
      await fillTurns(session, 2)
      results.push(await session.send('Refactor the module').result)
    }
    const [a, b] = results
    expect(flushed.h.events.map((e) => e.trigger)).toEqual(['auto'])
    expect(flushed.h.facts).toEqual(['M'])
    expect(a?.steps).toBe(b?.steps as number)
    expect(a?.stop).toBe('complete')
    // the main model saw the same wires (the flush leaves no trace)
    expect(normalizeVolatile(flushed.model.prompts)).toEqual(normalizeVolatile(plain.model.prompts))
    // the record belongs to the running turn and sorts after its assistant message
    const [record] = await flushRecords(flushed.messages)
    expect(record?.metadata?.eharness?.turnId).toBe(a?.turnId)
    expect((record?.id as string) > (a?.messageId as string)).toBe(true)
    expect(flushData(record).trigger).toBe('auto')
  })

  test('manual compact(): trigger manual, record delivered as a session message event', async () => {
    const { agent, messages, h } = setup([answer('A1'), answer('A2')], {
      flushSteps: [{ text: 'nothing' }],
      config: { compaction: { model: summarizerModel(['S']), keepLast: 0, maxSummaryTokens: 100 } },
    })
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const seen: string[] = []
    const reader = session.events().getReader()
    void (async () => {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        const m = (next.value as { message?: HarnessUIMessage }).message
        if (m !== undefined) seen.push(m.metadata?.eharness?.kind ?? m.role)
      }
    })()
    expect(await session.compact()).not.toBeNull()
    await reader.cancel()
    expect(h.events.map((e) => e.trigger)).toEqual(['manual'])
    const [record] = await flushRecords(messages)
    expect(record?.metadata?.eharness?.turnId).toBeUndefined()
    expect(seen).toEqual(['eh.flush', 'eh.compaction'])
  })

  test('patches of two plugins merge (prompt, tools, maxSteps, model)', async () => {
    const flusher2 = scriptedModel(
      Array.from({ length: 6 }, (_, i) => ({
        toolCalls: [{ toolName: i % 2 === 0 ? 'save_fact' : 'other', input: { fact: `x${i}` } }],
      })),
      { modelId: 'flusher-2' },
    )
    const second = definePlugin({
      name: 'second',
      setup: () => ({
        hooks: {
          'compaction.before': () => ({
            flush: { prompt: 'P2', tools: ['other', 'save_fact'], maxSteps: 4, model: flusher2 },
          }),
        },
      }),
    })
    const flusher = scriptedModel([], { modelId: 'flusher' })
    const h: Harness = { order: [], facts: [], events: [], decisions: [] }
    const both = defineHarnessAgent({
      model: scriptedModel(fiveTurns()),
      contextWindow: windowOf,
      storage: { messages: spyMessages() },
      logger: silent,
      onWarning: () => {},
      compaction: { model: summarizerModel(['S']), keepLast: 1, maxSummaryTokens: 100 },
      plugins: [
        savingPlugin(h, () => ({
          flush: { prompt: 'P1', tools: ['save_fact'], maxSteps: 2, model: flusher },
        })),
        second,
      ],
    })
    const session = both.session('s1')
    await fillTurns(session, 5)
    expect(flusher.calls).toHaveLength(0)
    expect(flusher2.calls).toHaveLength(4)
    const call = flusher2.calls[0] as ScriptedCallOptions
    expect(text(call.prompt.at(-1))).toContain('P1\\n\\nP2')
    expect((call.tools ?? []).map((t) => t.name).sort()).toEqual(['other', 'save_fact'])
    expect(h.facts).toEqual(['x0', 'x2'])
  })

  test('a tool outside the whitelist is not offered; a whitelisted tool needing approval is auto-denied', async () => {
    const { agent, flusher, messages, h } = setup(fiveTurns(), {
      flushSteps: [{ toolCalls: [{ toolName: 'danger', input: {} }] }, { text: 'ok' }],
      patch: (_e, f) => ({ flush: { prompt: 'FLUSH', tools: ['danger', 'missing'], model: f } }),
      config: { approval: { policy: { danger: 'user-approval' } } },
    })
    await fillTurns(agent.session('s1'), 5)
    const offered = ((flusher.calls[0] as ScriptedCallOptions).tools ?? []).map((t) => t.name)
    expect(offered).toEqual(['danger'])
    expect(h.order).not.toContain('danger')
    expect(h.decisions).toEqual([
      expect.objectContaining({
        toolName: 'danger',
        approved: false,
        by: 'policy',
        reason: FLUSH_APPROVAL_DENIED,
      }),
    ])
    const [record] = await flushRecords(messages)
    expect(flushData(record).toolCalls).toEqual([{ toolName: 'danger', status: 'denied' }])
  })

  test('flush error → W_HOOK_FAILED (phase flush), the record carries the error, compaction still commits', async () => {
    const { agent, messages, warnings } = setup(fiveTurns(), {
      flushSteps: [{ throws: new Error('provider down'), streamError: new Error('provider down') }],
    })
    const result = await (async () => {
      const session = agent.session('s1')
      await fillTurns(session, 4)
      return session.send(big('Q5')).result
    })()
    expect(result.stop).toBe('complete')
    const failed = warnings.find((w) => w.code === 'W_HOOK_FAILED')
    expect(failed?.details).toMatchObject({ hook: 'compaction.before', phase: 'flush' })
    expect(await markers(messages)).toHaveLength(1)
    const [record] = await flushRecords(messages)
    expect(flushData(record).error).toContain('provider down')
  })

  test('a throwing compaction.before hook is W_HOOK_FAILED and skipped; compaction proceeds', async () => {
    const { agent, flusher, messages, warnings } = setup(fiveTurns(), {
      patch: () => {
        throw new Error('boom')
      },
    })
    await fillTurns(agent.session('s1'), 5)
    expect(warnings.some((w) => w.code === 'W_HOOK_FAILED')).toBe(true)
    expect(flusher.calls).toHaveLength(0)
    expect(await markers(messages)).toHaveLength(1)
    expect(await flushRecords(messages)).toHaveLength(0)
  })

  test('a used-up budget skips the compaction and with it the flush', async () => {
    const { agent, flusher, h } = setup([answer('A1'), answer('A2')], {
      flushSteps: [{ text: 'x' }],
      config: {
        models: () => ({ contextWindow: 2_000, pricing: { input: 1_000_000, output: 0 } }),
        contextWindow: undefined,
        budget: { maxSessionUsd: 0.5 },
      },
    })
    const session = agent.session('s1')
    await session.send(big('Q1')).result
    await expect(session.compact()).resolves.toBeNull()
    expect(h.events).toHaveLength(0)
    expect(flusher.calls).toHaveLength(0)
  })

  test('overflow trigger: skipped unless the flush model has a larger window', async () => {
    const overflow = () =>
      new APICallError({
        message: 'prompt is too long',
        url: 'https://api.example.com',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      })
    const steps = () => [answer('A1'), answer('A2'), { throws: overflow() }, answer('ok')]
    // same window (2k) as the agent model → skipped
    const small = setup(steps(), {
      flushSteps: [{ text: 'x' }],
      config: { contextWindow: 2_000 },
    })
    await fillTurns(small.agent.session('s1'), 2)
    expect((await small.agent.session('s1').send(big('Q3')).result).stop).toBe('complete')
    expect(small.h.events.map((e) => e.trigger)).toEqual(['overflow'])
    expect(small.flusher.calls).toHaveLength(0)
    expect(
      small.warnings.find((w) => w.code === 'W_COMPACTION_FLUSH_SKIPPED')?.details,
    ).toMatchObject({ reason: 'window', trigger: 'overflow' })
    expect(await markers(small.messages)).toHaveLength(1)
    // larger window → runs
    const large = setup(steps(), { flushSteps: [{ text: 'x' }] })
    await fillTurns(large.agent.session('s1'), 2)
    expect((await large.agent.session('s1').send(big('Q3')).result).stop).toBe('complete')
    expect(large.flusher.calls).toHaveLength(1)
    expect(flushData((await flushRecords(large.messages))[0]).trigger).toBe('overflow')
  })

  test('golden: next-turn wires are identical with and without a flush; storage has one extra eh.flush', async () => {
    const flushed = setup(fiveTurns(), { flushSteps: [{ text: 'ok' }] })
    const plain = setup(fiveTurns(), { noPlugin: true })
    for (const s of [flushed, plain]) await fillTurns(s.agent.session('s1'), 6)
    expect(normalizeVolatile(flushed.model.prompts)).toEqual(normalizeVolatile(plain.model.prompts))
    const a = await all(flushed.messages)
    const b = await all(plain.messages)
    expect(a.length).toBe(b.length + 1)
    expect(a.filter((m) => !isKindMessage(m, 'eh.flush')).map((m) => m.role)).toEqual(
      b.map((m) => m.role),
    )
  })

  test('abort during the flush aborts the turn: no marker, no record', async () => {
    let abort: () => void = () => {}
    const { agent, messages } = setup(fiveTurns(), {
      flushSteps: [{ toolCalls: [{ toolName: 'save_fact', input: { fact: 'A' } }] }, { text: 'x' }],
      patch: (_e, f) => {
        abort()
        return { flush: { prompt: 'FLUSH', tools: ['save_fact'], model: f } }
      },
    })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    abort = () => session.abort()
    const result = await session.send(big('Q5')).result
    expect(result.stop).toBe('aborted')
    expect(await markers(messages)).toHaveLength(0)
    expect(await flushRecords(messages)).toHaveLength(0)
  })

  test('no compaction.before hook → no flush record (0.3 behaviour)', async () => {
    const { agent, messages } = setup(fiveTurns(), { noPlugin: true })
    await fillTurns(agent.session('s1'), 5)
    expect(await markers(messages)).toHaveLength(1)
    expect(await flushRecords(messages)).toHaveLength(0)
  })
})
