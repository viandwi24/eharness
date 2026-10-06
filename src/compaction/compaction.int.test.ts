import { describe, expect, test } from 'bun:test'
import { APICallError, type LanguageModel, type ModelMessage, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { SessionStateSnapshot, StateAdapter } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import { uuidv7 } from '../messages/ids.ts'
import { isKindMessage } from '../messages/kinds.ts'
import { INTERRUPTED_UNKNOWN } from '../messages/texts.ts'
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import {
  chunkTypes,
  collect,
  normalizeVolatile,
  spyMessages,
  spyState,
} from '../session/int-kit.ts'
import { defaultMemoryState } from '../session/memory-storage.ts'
import { memoryBudgetLedger } from '../storage/memory.ts'
import {
  type ScriptedCallOptions,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { answer, estimatedInput, summarizerModel, summarizerPromptText } from './test-kit.ts'
import { defaultCountTokens, wireTokens } from './tokens.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** A user message of about `tokens` tokens, recognizable by `tag`. */
const big = (tag: string, tokens = 300) => `${tag} ${'x'.repeat(tokens * 4)}`

/** A scripted tool-call step with realistic input usage. */
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

async function expectGolden(name: string, value: unknown): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.json`, import.meta.url))
  const actual = JSON.parse(JSON.stringify(value))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (!(await file.exists())) throw new Error(`missing golden ${name}.json (UPDATE_GOLDEN=1)`)
  expect(actual).toEqual(await file.json())
}

function setup(
  steps: ScriptedStepInput[],
  config: Partial<HarnessAgentConfig> = {},
  storage: { messages?: ReturnType<typeof spyMessages>; state?: StateAdapter } = {},
) {
  const model = scriptedModel(steps)
  const summarizer = summarizerModel((_call, i) => `SUMMARY-${i + 1}`)
  const messages = storage.messages ?? spyMessages()
  const state = storage.state ?? spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    model,
    contextWindow: 2_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100 },
    ...config,
  })
  return { agent, model, summarizer, messages, state, warnings }
}

async function all(messages: ReturnType<typeof spyMessages>): Promise<HarnessUIMessage[]> {
  const out = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  messages.loads.pop()
  return out
}

async function markers(messages: ReturnType<typeof spyMessages>) {
  return (await all(messages)).filter((m) => isKindMessage(m, 'eh.compaction'))
}

const payload = (marker: HarnessUIMessage | undefined): CompactionPayload =>
  (marker?.parts[0] as { data: CompactionPayload } | undefined)?.data as CompactionPayload

const promptText = (prompt: unknown) => JSON.stringify(prompt)

/** Copy of a session's storage (messages + state) for a cold reload next to the hot session. */
async function cloneStorage(messages: ReturnType<typeof spyMessages>, state: StateAdapter) {
  const copy = spyMessages()
  await copy.save('s1', await all(messages))
  copy.saves.length = 0
  const stateCopy = spyState()
  const snapshot = await state.get('s1')
  if (snapshot !== null) await defaultMemoryStateSet(stateCopy, snapshot)
  stateCopy.writes.length = 0
  return { messages: copy, state: stateCopy }
}

async function defaultMemoryStateSet(state: StateAdapter, snapshot: SessionStateSnapshot) {
  await state.set('s1', structuredClone(snapshot))
}

/** Five turns of ~310 tokens each fill a 2k window past summarizeAt (1500) at the fifth. */
async function fillTurns(session: { send(text: string): { result: Promise<unknown> } }, n: number) {
  for (let i = 1; i <= n; i++) await session.send(big(`Q${i}`)).result
}

describe('scenario 5: pre-turn compaction', () => {
  test('marker saved, pointer in state, stream divider, summarized wire, cold load = one load({ fromId })', async () => {
    const after: string[] = []
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({
        hooks: {
          'compaction.prompt': (_ctx, out) => void out.context.push('file src/a.ts in progress'),
          'compaction.after': (_ctx, e) => void after.push(e.marker.id),
          // the stream divider must carry the saved payload (after message.beforeSave)
          'message.beforeSave': (_ctx, m) =>
            isKindMessage(m, 'eh.compaction')
              ? {
                  ...m,
                  parts: [
                    {
                      ...(m.parts[0] as { type: 'data-eh.compaction'; data: CompactionPayload }),
                      data: { ...payload(m), tag: 'saved' } as CompactionPayload,
                    },
                  ],
                }
              : undefined,
        },
      }),
    })
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, model, summarizer, messages, state } = setup(steps, { plugins: [probe] })
    const session = agent.session('s1')
    const events: unknown[] = []
    const reader = session.events().getReader()
    void (async () => {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        events.push(next.value)
      }
    })()
    await fillTurns(session, 4)
    expect(await markers(messages)).toHaveLength(0)

    const run = session.send(big('Q5'))
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')

    // stream: compacting status before thinking, transient divider with the payload
    const types = chunkTypes(chunks as never)
    expect(types.indexOf('data-eh.status:compacting')).toBeGreaterThan(0)
    expect(types.indexOf('data-eh.status:compacting')).toBeLessThan(
      types.indexOf('data-eh.status:thinking'),
    )
    const divider = chunks.find((c) => c.type === 'data-eh.compaction') as {
      data: CompactionPayload
      transient?: boolean
    }
    expect(divider.transient).toBe(true)

    // marker: trigger 'turn', resumeFromId = first kept message (turn 4's user message)
    const stored = await all(messages)
    const [marker] = await markers(messages)
    const p = payload(marker)
    const q4 = stored.find((m) => m.role === 'user' && JSON.stringify(m.parts).includes('Q4 '))
    expect(p).toMatchObject({ summary: 'SUMMARY-1', resumeFromId: q4?.id, trigger: 'turn' })
    expect(p.model).toBe('mock/summarizer')
    expect(p.tokens.before).toBeGreaterThan(1_500)
    expect(p.tokens.after).toBeLessThan(p.tokens.before)
    expect(divider.data).toEqual(p)
    expect(divider.data).toMatchObject({ tag: 'saved' })
    expect(marker?.metadata?.eharness).toMatchObject({
      kind: 'eh.compaction',
      turnId: result.turnId,
    })
    expect(after).toEqual([marker?.id as string])
    await reader.cancel()
    expect(
      events.some(
        (e) => (e as { type: string; message?: HarnessUIMessage }).message?.id === marker?.id,
      ),
    ).toBe(true)

    // state pointer
    expect((await state.get('s1'))?.core.compaction).toEqual({
      markerId: marker?.id as string,
      resumeFromId: q4?.id as string,
    })

    // the summarizer saw turns 1–3 as a flat transcript plus the hook context
    const transcript = summarizerPromptText(summarizer.calls[0] as (typeof summarizer.calls)[0])
    expect(transcript).toContain('USER: Q1 ')
    expect(transcript).toContain('ASSISTANT: A3')
    expect(transcript).not.toContain('Q4 ')
    expect(transcript).toContain('- file src/a.ts in progress')

    // the wire of turn 5 starts with the summary and skips turns 1–3
    const wire = promptText(model.prompts[4])
    expect(wire).toContain('<conversation-summary>SUMMARY-1</conversation-summary>')
    for (const gone of ['Q1 ', 'Q2 ', 'Q3 ', 'A3']) expect(wire).not.toContain(gone)
    for (const kept of ['Q4 ', 'A4', 'Q5 ']) expect(wire).toContain(kept)

    // history intact: 10 chat messages + the marker
    expect(stored).toHaveLength(11)

    // cold load (new agent instance, same adapters): exactly one load({ fromId })
    messages.loads.length = 0
    const cold = setup([answer('A6')], {}, { messages, state })
    await cold.agent.session('s1').send('next').result
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: q4?.id as string }])
    const coldWire = promptText(cold.model.prompts[0])
    expect(coldWire).toContain('SUMMARY-1')
    expect(coldWire).not.toContain('Q3 ')
    expect(coldWire).toContain('Q5 ')
  })

  test('stats() reports calibrated tokens and lastCompaction; tokens are cached in metadata', async () => {
    const { agent, messages } = setup(Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`)))
    const session = agent.session('s1')
    await fillTurns(session, 5)
    const stats = await session.stats()
    const [marker] = await markers(messages)
    expect(stats.window).toBe(2_000)
    expect(stats.summarizeAt).toBe(1_500)
    expect(stats.hardLimit).toBe(1_640)
    expect(stats.lastCompaction).toMatchObject({
      markerId: marker?.id,
      before: payload(marker).tokens.before,
      after: payload(marker).tokens.after,
    })
    expect(stats.tokens).toBeLessThan(stats.summarizeAt)
    expect(stats.tokens).toBe(stats.instructions + stats.tools + stats.messages)
    for (const m of await all(messages)) {
      expect(typeof m.metadata?.eharness?.tokens).toBe('number')
    }
  })
})

describe('scenario 6: mid-turn compaction', () => {
  function midTurnSetup() {
    return setup(
      [
        answer('A1'),
        answer('A2'),
        callTool('read', { n: 0 }),
        callTool('read', { n: 1 }),
        answer('Done.'),
        answer('fin'),
      ],
      { tools: { read } },
    )
  }

  test('partial honoured in projection; current user message and last step kept; history intact; reload = same wire', async () => {
    const { agent, model, summarizer, messages, state } = midTurnSetup()
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const run = session.send('Refactor the module')
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(result.steps).toBe(3)

    const [marker] = await markers(messages)
    const p = payload(marker)
    const stored = await all(messages)
    const user3 = stored.find((m) => JSON.stringify(m.parts).includes('Refactor the module'))
    expect(p).toMatchObject({
      trigger: 'auto',
      resumeFromId: user3?.id,
      partial: { messageId: result.messageId, fromStep: 1 },
    })
    // the compaction ran between steps 1 and 2 (after the second finish-step)
    const types = chunkTypes(chunks as never)
    const compacting = types.indexOf('data-eh.status:compacting')
    expect(types.filter((t) => t === 'finish-step').length).toBe(3)
    expect(types.slice(0, compacting).filter((t) => t === 'finish-step')).toHaveLength(2)

    // step 2's wire: summary, the user message, step 1 verbatim; step 0 and older turns gone
    const wire = promptText(model.prompts[4])
    expect(wire).toContain('<conversation-summary>SUMMARY-1</conversation-summary>')
    expect(wire).toContain('Refactor the module')
    expect(wire).toContain('R1 ')
    for (const gone of ['R0 ', 'Q1 ', 'Q2 ']) expect(wire).not.toContain(gone)
    const transcript = summarizerPromptText(summarizer.calls[0] as (typeof summarizer.calls)[0])
    expect(transcript).toContain('TOOL read({"n":0}) → R0 ')
    expect(transcript).not.toContain('R1 ')

    // history intact: the stored assistant message has all three steps
    const assistant = stored.find((m) => m.id === result.messageId) as HarnessUIMessage
    expect(assistant.parts.filter((p) => p.type === 'step-start')).toHaveLength(3)
    expect(JSON.stringify(assistant.parts)).toContain('R0 ')

    // reload reproduces the same wire: next turn hot vs cold (copied storage)
    const copy = await cloneStorage(messages, state)
    await session.send('next').result
    const cold = setup([answer('fin')], { tools: { read } }, copy)
    await cold.agent.session('s1').send('next').result
    expect(copy.messages.loads).toEqual([{ sessionId: 's1', fromId: user3?.id as string }])
    expect(normalizeVolatile(cold.model.prompts[0])).toEqual(normalizeVolatile(model.prompts[5]))
    expect(promptText(cold.model.prompts[0])).not.toContain('R0 ')
  })

  test('golden: a later pre-turn compaction never brings trimmed steps back (carry-forward)', async () => {
    const { agent, model, messages } = setup(
      [
        answer('A1'),
        answer('A2'),
        callTool('read', { n: 0 }),
        callTool('read', { n: 1 }),
        answer('Done.'),
        ...Array.from({ length: 6 }, (_, i) => answer(`B${i + 1}`)),
      ],
      {
        tools: { read },
        compaction: {
          model: summarizerModel((_c, i) => `S${i + 1}`),
          keepLast: 1,
          maxSummaryTokens: 100,
        },
      },
    )
    const session = agent.session('s1')
    await fillTurns(session, 2)
    await session.send('Refactor the module').result
    for (let i = 4; (await markers(messages)).length < 2 && i < 10; i++) {
      await session.send(big(`Q${i}`)).result
    }
    const all2 = await markers(messages)
    expect(all2).toHaveLength(2)
    expect(payload(all2[1]).trigger).toBe('turn')
    for (const prompt of model.prompts.slice(4)) expect(promptText(prompt)).not.toContain('R0 ')
    await expectGolden('carry-forward.prompt', normalizeVolatile(model.prompts.at(-1)))
  })

  test('carry-forward: a kept message trimmed by the previous marker keeps its partial', async () => {
    // stored state after a mid-turn compaction whose marker kept an earlier turn too
    const { agent, model, messages } = setup([answer('B1')], {
      compaction: { model: summarizerModel(['S2']), keepLast: 1, maxSummaryTokens: 100 },
    })
    const ids = Array.from({ length: 5 }, () => uuidv7())
    const [u1, a1, u2, a2, m1] = ids as [string, string, string, string, string]
    const meta = { eharness: { v: 1 as const, createdAt: 1 } }
    await messages.save('s1', [
      { id: u1, role: 'user', metadata: meta, parts: [{ type: 'text', text: big('Q1', 400) }] },
      {
        id: a1,
        role: 'assistant',
        metadata: meta,
        parts: [{ type: 'step-start' }, { type: 'text', text: 'A1' }],
      },
      { id: u2, role: 'user', metadata: meta, parts: [{ type: 'text', text: 'Refactor' }] },
      {
        id: a2,
        role: 'assistant',
        metadata: meta,
        parts: [
          { type: 'step-start' },
          { type: 'text', text: 'TRIMMED-STEP' },
          { type: 'step-start' },
          { type: 'text', text: 'KEPT-STEP' },
        ],
      },
      {
        id: m1,
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: 1, kind: 'eh.compaction' } },
        parts: [
          {
            type: 'data-eh.compaction',
            data: {
              summary: 'S1',
              resumeFromId: u1,
              partial: { messageId: a2, fromStep: 1 },
              tokens: { before: 0, after: 0 },
              trigger: 'auto',
            },
          },
        ],
      },
    ] as HarnessUIMessage[])
    await agent.session('s1').send(big('Q3', 1_200)).result
    const [, marker] = await markers(messages)
    expect(payload(marker)).toMatchObject({
      resumeFromId: u2,
      partial: { messageId: a2, fromStep: 1 },
    })
    const wire = promptText(model.prompts[0])
    expect(wire).toContain('KEPT-STEP')
    expect(wire).not.toContain('TRIMMED-STEP')
    expect(wire).not.toContain('Q1 ')
  })
})

describe('scenario 7: guard', () => {
  test('dangling call → synthesized Interrupted result; orphan result removed', async () => {
    const orphanRewrite = definePlugin({
      name: 'rewrite',
      setup: () => ({
        hooks: {
          'step.prepare': (_ctx, e) => ({
            messages: [
              ...e.messages,
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'ghost',
                    toolName: 'x',
                    output: { type: 'text', value: 'orphan' },
                  },
                ],
              } as ModelMessage,
            ],
          }),
        },
      }),
    })
    const messages = spyMessages()
    await messages.save('s1', [
      {
        id: uuidv7(),
        role: 'assistant',
        metadata: { eharness: { v: 1, createdAt: 1 } },
        parts: [{ type: 'tool-gone', toolCallId: 'x1', state: 'input-available', input: {} }],
      } as unknown as HarnessUIMessage,
    ])
    const { agent, model } = setup([answer('ok')], { plugins: [orphanRewrite] }, { messages })
    await agent.session('s1').send('hi').result
    const wire = promptText(model.prompts[0])
    expect(wire).toContain(INTERRUPTED_UNKNOWN)
    expect(wire).not.toContain('ghost')
  })

  test('hard cap: oldest turns dropped from the wire only (W_CONTEXT_TRUNCATED), storage untouched', async () => {
    const steps = Array.from({ length: 6 }, (_, i) => answer(`A${i + 1}`))
    const { agent, model, messages, warnings } = setup(steps, { compaction: false })
    const session = agent.session('s1')
    await fillTurns(session, 6)
    expect(await markers(messages)).toHaveLength(0)
    const truncated = warnings.filter((w) => w.code === 'W_CONTEXT_TRUNCATED')
    expect(truncated).toHaveLength(1)
    const wire = promptText(model.prompts[5])
    expect(wire).not.toContain('Q1 ')
    expect(wire).toContain('Q6 ')
    for (const prompt of model.prompts) {
      expect(
        wireTokens(prompt as unknown as ModelMessage[], defaultCountTokens),
      ).toBeLessThanOrEqual(1_640)
    }
    expect(await all(messages)).toHaveLength(12)
  })

  test('hard cap: the largest tool output of the current turn is truncated in the wire copy', async () => {
    const huge = tool({
      inputSchema: z.object({}),
      execute: async () => `HEAD ${'y'.repeat(8_000)} TAIL`,
    })
    const { agent, model, messages, warnings } = setup([callTool('huge', {}), answer('ok')], {
      compaction: false,
      tools: { huge },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    const wire = promptText(model.prompts[1])
    expect(wire).toContain('…[truncated ')
    expect(wire).toContain('HEAD ')
    expect(wire).toContain(' TAIL')
    expect(warnings.some((w) => w.code === 'W_CONTEXT_TRUNCATED')).toBe(true)
    const stored = (await all(messages)).find((m) => m.id === result.messageId)
    expect(JSON.stringify(stored?.parts)).toContain('y'.repeat(8_000))
  })

  test('select: final say over the assembled view (wire only)', async () => {
    const { agent, model, messages } = setup([answer('SECRET answer'), answer('A2')], {
      compaction: {
        select: (view) => view.filter((m) => !JSON.stringify(m.parts).includes('SECRET')),
      },
    })
    const session = agent.session('s1')
    await session.send('plan').result
    await session.send('next').result
    expect(promptText(model.prompts[1])).not.toContain('SECRET')
    expect(promptText(model.prompts[1])).toContain('plan')
    expect(promptText(model.prompts[1])).toContain('next')
    expect(JSON.stringify(await all(messages))).toContain('SECRET')
  })
})

describe('manual compaction', () => {
  test('compact() summarizes all but keepLast turns, sets the pointer, is exclusive', async () => {
    const { agent, model, messages, state } = setup([
      answer('A1'),
      answer('A2'),
      answer('A3'),
      answer('A4'),
    ])
    const session = agent.session('s1')
    await fillTurns(session, 3)
    const pending = session.compact()
    expect(() => session.send('now')).toThrow(/running/)
    const marker = (await pending) as HarnessUIMessage
    expect(payload(marker)).toMatchObject({ trigger: 'manual', summary: 'SUMMARY-1' })
    const stored = await all(messages)
    const q3 = stored.find((m) => JSON.stringify(m.parts).includes('Q3 '))
    expect(payload(marker).resumeFromId).toBe(q3?.id as string)
    expect((await state.get('s1'))?.core.compaction?.markerId).toBe(marker.id)
    await session.send('next').result
    const wire = promptText(model.prompts[3])
    expect(wire).toContain('SUMMARY-1')
    expect(wire).not.toContain('Q2 ')
    expect(wire).toContain('Q3 ')
  })

  test('keepLast 0 → resumeFromId null; the cold load starts at the marker', async () => {
    const { agent, messages, state } = setup([answer('A1'), answer('A2')], {
      compaction: { model: summarizerModel(['ALL']), keepLast: 0, maxSummaryTokens: 100 },
    })
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const marker = (await session.compact()) as HarnessUIMessage
    expect(payload(marker).resumeFromId).toBeNull()
    messages.loads.length = 0
    const cold = setup([answer('A3')], {}, { messages, state })
    await cold.agent.session('s1').send('next').result
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: marker.id }])
    const wire = promptText(cold.model.prompts[0])
    expect(wire).toContain('ALL')
    expect(wire).not.toContain('Q2 ')
  })

  test('busy while a turn runs; EH_COMPACTION_FAILED on summarizer failure; null when disabled or nothing to do', async () => {
    const { agent } = setup([{ text: 'slow', delayMs: 20 }])
    const session = agent.session('s1')
    const run = session.send('hi')
    await expect(session.compact()).rejects.toMatchObject({ code: 'EH_SESSION_BUSY' })
    await run.result
    expect(await session.compact()).toBeNull() // one turn, keepLast 1: nothing to drop

    const failing = setup([answer('A1'), answer('A2')], {
      compaction: {
        model: summarizerModel([new Error('down')]),
        keepLast: 0,
        maxSummaryTokens: 100,
      },
    })
    await fillTurns(failing.agent.session('s1'), 1)
    let error: unknown
    try {
      await failing.agent.session('s1').compact()
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error, 'EH_COMPACTION_FAILED')).toBe(true)
    expect(await markers(failing.messages)).toHaveLength(0)

    // a summary cut at maxSummaryTokens is a failure too (spec 06 §5.5)
    const cut = setup([answer('A1'), answer('A2')], {
      compaction: {
        model: summarizerModel([{ text: 'half a summ', finishReason: 'length' }]),
        keepLast: 0,
        maxSummaryTokens: 100,
      },
    })
    await fillTurns(cut.agent.session('s1'), 1)
    let cutError: unknown
    try {
      await cut.agent.session('s1').compact()
    } catch (e) {
      cutError = e
    }
    expect(isHarnessError(cutError, 'EH_COMPACTION_FAILED')).toBe(true)
    expect((cutError as { details?: unknown }).details).toEqual({ reason: 'length' })
    expect(await markers(cut.messages)).toHaveLength(0)

    const disabled = setup([answer('A1')], { compaction: false })
    await fillTurns(disabled.agent.session('s1'), 1)
    expect(await disabled.agent.session('s1').compact()).toBeNull()
  })
})

describe('summarizer usage and budgets (spec 06 §5.3, spec 12)', () => {
  // the summarizer reports 10 input + 5 output tokens per call: $0.015 at $1 per 1k tokens
  const models = (m: LanguageModel) =>
    typeof m === 'object' && m.modelId === 'summarizer'
      ? { pricing: { input: 1_000, output: 1_000 } }
      : { pricing: { input: 0, output: 0 } }

  test('automatic compaction usage counts toward the turn usage, cost and budget', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, state } = setup(steps, { models, budget: { maxTurnUsd: 0.01 } })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    const result = await session.send(big('Q5')).result
    expect(result.usage.costUsd).toBeCloseTo(0.015, 10)
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(10)
    // the compaction alone used up the turn budget: no model call
    expect(result.stop).toBe('cost-cap')
    expect(result.steps).toBe(0)
    expect((await state.get('s1'))?.core.usage?.costUsd).toBeCloseTo(0.015, 10)
  })

  test('a used-up budget skips compaction before the summarizer runs (W_BUDGET)', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, summarizer, warnings, messages } = setup(steps, {
      models: () => ({ pricing: { input: 1_000_000, output: 0 } }),
      budget: { maxSessionUsd: 0.5 },
    })
    const session = agent.session('s1')
    await session.send(big('Q1')).result
    // the first turn used up the session budget: the second stops before its model call
    expect((await session.send(big('Q2')).result).stop).toBe('cost-cap')
    const before = summarizer.calls.length
    await expect(session.compact()).resolves.toBeNull()
    expect(summarizer.calls.length).toBe(before)
    expect(await markers(messages)).toHaveLength(0)
    expect(warnings.some((w) => w.code === 'W_BUDGET' && w.details?.compaction === true)).toBe(true)
  })

  test('manual compact() usage is added to state.core.usage', async () => {
    const steps = Array.from({ length: 2 }, (_, i) => answer(`A${i + 1}`))
    const { agent, state } = setup(steps, {
      models,
      compaction: {
        model: summarizerModel(['SUMMARY']),
        keepLast: 0,
        maxSummaryTokens: 100,
      },
    })
    const session = agent.session('s1')
    await fillTurns(session, 1)
    const before = (await state.get('s1'))?.core.usage
    expect(await session.compact()).not.toBeNull()
    const after = (await state.get('s1'))?.core.usage
    expect(after?.costUsd).toBeCloseTo((before?.costUsd ?? 0) + 0.015, 10)
    expect(after?.inputTokens).toBe((before?.inputTokens ?? 0) + 10)
    expect(after?.outputTokens).toBe((before?.outputTokens ?? 0) + 5)
    expect(after?.turns).toBe(before?.turns)
  })

  test('summarizer usage is recorded on budget.ledger (automatic and manual), once', async () => {
    const adapter = memoryBudgetLedger()
    const ledger = { adapter, scopes: () => ['user:ada'] }
    const steps = Array.from({ length: 6 }, (_, i) => answer(`A${i + 1}`))
    const { agent } = setup(steps, { models, budget: { ledger } })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    const spent = async () => (await adapter.check(['user:ada'])).scopes[0]?.spentUsd ?? 0
    const beforeAuto = await spent()
    const result = await session.send(big('Q5')).result
    expect(result.stop).toBe('complete')
    // the main model is free: only the summarizer call ($0.015) is spent
    expect((await spent()) - beforeAuto).toBeCloseTo(0.015, 10)

    const manual = setup(
      Array.from({ length: 2 }, (_, i) => answer(`A${i + 1}`)),
      {
        models,
        budget: { ledger },
        compaction: { model: summarizerModel(['SUMMARY']), keepLast: 0, maxSummaryTokens: 100 },
      },
    )
    const s = manual.agent.session('s2')
    await s.send(big('Q1')).result
    const beforeManual = await spent()
    expect(await s.compact()).not.toBeNull()
    expect((await spent()) - beforeManual).toBeCloseTo(0.015, 10)
  })
})

describe('crash safety', () => {
  test('(a) save(marker) fails: W_COMPACTION_FAILED, no marker, no pointer, the turn continues', async () => {
    const messages = spyMessages()
    messages.failSave = (batch) => batch.some((m) => isKindMessage(m, 'eh.compaction'))
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, state, warnings } = setup(steps, {}, { messages })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    const result = await session.send(big('Q5')).result
    expect(result.stop).toBe('complete')
    expect(warnings.some((w) => w.code === 'W_COMPACTION_FAILED')).toBe(true)
    expect(await markers(messages)).toHaveLength(0)
    expect((await state.get('s1'))?.core.compaction).toBeUndefined()
  })

  /** A state adapter that loses every write whose pointer matches `lose(markerId)`. */
  function lossyState(lose: (markerId: string | undefined) => boolean) {
    const inner = defaultMemoryState()
    const adapter: StateAdapter & { enabled: boolean } = {
      enabled: true,
      get: (id) => inner.get(id),
      async set(id, snapshot) {
        if (adapter.enabled && lose(snapshot.core.compaction?.markerId)) throw new Error('lost')
        return inner.set(id, snapshot)
      },
    }
    return adapter
  }

  test('(b) the state write of the first compaction is lost: the cold load pages, finds the marker and heals', async () => {
    const state = lossyState((markerId) => markerId !== undefined)
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, messages } = setup(steps, {}, { state })
    await fillTurns(agent.session('s1'), 5)
    expect(await markers(messages)).toHaveLength(1)
    expect((await state.get('s1'))?.core.compaction).toBeUndefined()
    state.enabled = false
    messages.loads.length = 0
    const cold = setup([answer('A6')], {}, { messages, state })
    await cold.agent.session('s1').send('next').result
    expect(messages.loads.every((q) => q.fromId === undefined)).toBe(true)
    const wire = promptText(cold.model.prompts[0])
    expect(wire).toContain('SUMMARY-1')
    for (const gone of ['Q1 ', 'Q2 ', 'Q3 ']) expect(wire).not.toContain(gone)
    const [marker] = await markers(messages)
    expect((await state.get('s1'))?.core.compaction?.markerId).toBe(marker?.id as string)
  })

  test('(c) the state write of a later compaction is lost: the stale pointer range still finds the newer marker', async () => {
    let first: string | undefined
    const state = lossyState((markerId) => first !== undefined && markerId !== first)
    const steps = Array.from({ length: 14 }, (_, i) => answer(`A${i + 1}`))
    const { agent, messages } = setup(steps, {}, { state })
    const session = agent.session('s1')
    let i = 1
    while ((await markers(messages)).length < 1) await session.send(big(`Q${i++}`)).result
    first = (await markers(messages))[0]?.id
    while ((await markers(messages)).length < 2 && i < 14) await session.send(big(`Q${i++}`)).result
    const [m1, m2] = await markers(messages)
    expect(m2).toBeDefined()
    const stale = (await state.get('s1'))?.core.compaction
    expect(stale?.markerId).toBe(m1?.id as string)

    state.enabled = false
    messages.loads.length = 0
    const cold = setup([answer('fin')], {}, { messages, state })
    await cold.agent.session('s1').send('next').result
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: stale?.resumeFromId as string }])
    const wire = promptText(cold.model.prompts[0])
    expect(wire).toContain(payload(m2).summary)
    expect(wire).not.toContain(payload(m1).summary)
    // nothing summarized by the newer marker is resent
    const resumeFrom = payload(m2).resumeFromId as string
    const summarized = (await all(messages)).filter(
      (m) => m.id < resumeFrom && m.role === 'user' && !isKindMessage(m),
    )
    for (const m of summarized) {
      const tag = JSON.stringify(m.parts).match(/Q\d+ /)?.[0] as string
      expect(wire).not.toContain(tag)
    }
    expect((await state.get('s1'))?.core.compaction?.markerId).toBe(m2?.id as string)
  })
})

describe('scenario 34: overflow recovery', () => {
  const overflow = () =>
    new APICallError({
      message: 'prompt is too long',
      url: 'https://api.example.com',
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: false,
    })

  test('context-length error before streaming → W_OVERFLOW_RETRY, compaction, retry succeeds; error chunk held back', async () => {
    const steps: ScriptedStepInput[] = [
      answer('A1'),
      answer('A2'),
      { throws: overflow() },
      answer('ok'),
    ]
    const { agent, model, messages, warnings } = setup(steps)
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const run = session.send(big('Q3'))
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
    expect(warnings.filter((w) => w.code === 'W_OVERFLOW_RETRY')).toHaveLength(1)
    expect(model.calls).toHaveLength(4)
    const [marker] = await markers(messages)
    expect(payload(marker)).toMatchObject({ trigger: 'auto' })
    const retry = promptText(model.prompts[3])
    expect(retry).toContain('SUMMARY-1')
    expect(retry).not.toContain('Q1 ')
    expect((await session.stats()).tokens).toBeGreaterThan(0)
  })

  test('still overflowing after the compaction retry and the tighter guard → stop error EH_CONTEXT_OVERFLOW', async () => {
    const steps: ScriptedStepInput[] = [
      answer('A1'),
      answer('A2'),
      { throws: overflow() },
      { throws: overflow() },
      { throws: overflow() },
    ]
    const { agent, model, warnings } = setup(steps)
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const run = session.send(big('Q3'))
    const chunks = await collect(run.stream)
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_CONTEXT_OVERFLOW')
    expect(chunks.filter((c) => c.type === 'error')).toHaveLength(1)
    expect(model.calls).toHaveLength(5)
    expect(warnings.filter((w) => w.code === 'W_OVERFLOW_RETRY')).toHaveLength(2)
  })

  test('compaction disabled: only the tighter guard retry; config.isContextOverflow extends detection', async () => {
    const custom = new Error('CTX_FULL')
    const { agent, model } = setup([{ throws: custom }, { throws: custom }], {
      compaction: false,
      isContextOverflow: (e) => (e as Error).message === 'CTX_FULL',
    })
    const result = await agent.session('s1').send('hi').result
    expect(result.error?.code).toBe('EH_CONTEXT_OVERFLOW')
    expect(model.calls).toHaveLength(2)
  })

  test('errors after streaming started and other errors are not retried', async () => {
    const { agent, model } = setup([{ text: 'partial', streamError: overflow() }])
    const result = await agent.session('s1').send('hi').result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBeUndefined()
    expect(model.calls).toHaveLength(1)
    const other = setup([
      {
        throws: new APICallError({
          message: 'rate limited',
          url: 'x',
          requestBodyValues: {},
          statusCode: 429,
          isRetryable: false,
        }),
      },
    ])
    const r = await other.agent.session('s1').send('hi').result
    expect(r.stop).toBe('error')
    expect(other.model.calls).toHaveLength(1)
  })
})

describe('triggers and windows', () => {
  test('no-input turn: the injected events start the current turn and are kept', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent, model, messages } = setup(steps)
    const session = agent.session('s1')
    await fillTurns(session, 4)
    const { message: event } = await session.inject('eh.event', {
      name: 'report',
      text: big('EVENT-TEXT'),
    })
    const result = await session.send().result
    expect(result.stop).toBe('complete')
    const [marker] = await markers(messages)
    const stored = await all(messages)
    const q4 = stored.find((m) => JSON.stringify(m.parts).includes('Q4 '))
    expect(payload(marker)).toMatchObject({ trigger: 'turn', resumeFromId: q4?.id })
    const wire = promptText(model.prompts[4])
    expect(wire).toContain('EVENT-TEXT')
    expect(wire).not.toContain('Q3 ')
    expect(event.id > (q4?.id ?? '')).toBe(true)
  })

  test('compaction.prompt hooks replace the prompt; config.prompt is the base', async () => {
    const seen: Array<string | undefined> = []
    const replace = definePlugin({
      name: 'brief',
      setup: () => ({
        hooks: {
          'compaction.prompt': (_ctx, out) => {
            seen.push(out.prompt)
            out.prompt = 'CUSTOM PROMPT'
          },
        },
      }),
    })
    const summarizer = summarizerModel(['S'])
    const steps = Array.from({ length: 5 }, (_, i) => answer(`A${i + 1}`))
    const { agent } = setup(steps, {
      plugins: [replace],
      compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100, prompt: 'BASE' },
    })
    await fillTurns(agent.session('s1'), 5)
    expect(seen).toEqual(['BASE'])
    expect(summarizer.calls[0]?.prompt[0]).toMatchObject({
      role: 'system',
      content: 'CUSTOM PROMPT',
    })
  })

  test('a step model with a smaller window is checked against that window (guard)', async () => {
    const window = (m: unknown) =>
      typeof m !== 'string' && (m as { modelId?: string }).modelId === 'small' ? 1_000 : 2_000
    const steps = Array.from({ length: 3 }, (_, i) => answer(`A${i + 1}`))
    const first = setup(steps, { compaction: false, contextWindow: window })
    await fillTurns(first.agent.session('s1'), 3)
    expect(first.warnings.some((w) => w.code === 'W_CONTEXT_TRUNCATED')).toBe(false)

    const small = scriptedModel([answer('small')], { modelId: 'small' })
    const switcher = definePlugin({
      name: 'switch',
      setup: () => ({ hooks: { 'step.prepare': () => ({ model: small }) } }),
    })
    const second = setup(
      [],
      { compaction: false, contextWindow: window, plugins: [switcher] },
      { messages: first.messages, state: first.state },
    )
    // ~1235 tokens: fits the turn model (limit 1640) but not the step model (limit 820)
    const result = await second.agent.session('s1').send(big('Q4')).result
    expect(result.stop).toBe('complete')
    expect(second.warnings.some((w) => w.code === 'W_CONTEXT_TRUNCATED')).toBe(true)
    const wire = promptText(small.prompts[0])
    expect(wire).not.toContain('Q1 ')
    expect(wire).toContain('Q3 ')
    expect(wire).toContain('Q4 ')
  })

  test('a failing summarizer mid-turn: W_COMPACTION_FAILED, the turn continues with the guard', async () => {
    const { agent, messages, warnings } = setup(
      [
        answer('A1'),
        answer('A2'),
        callTool('read', { n: 0 }),
        callTool('read', { n: 1 }),
        answer('Done.'),
      ],
      {
        tools: { read },
        compaction: {
          model: summarizerModel([new Error('down')]),
          keepLast: 1,
          maxSummaryTokens: 100,
        },
      },
    )
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const result = await session.send('Refactor the module').result
    expect(result.stop).toBe('complete')
    expect(warnings.filter((w) => w.code === 'W_COMPACTION_FAILED')).toHaveLength(1)
    expect(warnings.some((w) => w.code === 'W_CONTEXT_TRUNCATED')).toBe(true)
    expect(await markers(messages)).toHaveLength(0)
  })
})

describe('compaction thrash (spec 06 §4)', () => {
  const fetchTool = tool({
    description: 'Fetch a document',
    inputSchema: z.object({ n: z.number(), size: z.number() }),
    execute: async ({ n, size }) => `F${n} ${'z'.repeat(size)}`,
  })
  /** ~1 000 tokens per big output, ~1 400 per huge one, ~50 per small one. */
  const fetch = (n: number, size: 'big' | 'huge' | 'small') =>
    callTool('fetch', { n, size: size === 'big' ? 4_000 : size === 'huge' ? 6_400 : 200 })

  test('context refills within 2 steps → context-thrash, W_CONTEXT_THRASH, notice saved, one summarizer call', async () => {
    const { agent, model, summarizer, messages, warnings } = setup(
      [fetch(0, 'big'), fetch(1, 'big'), fetch(2, 'huge'), fetch(3, 'big'), answer('done')],
      { tools: { fetch: fetchTool } },
    )
    const result = await agent.session('s1').send('Go').result
    expect(result.stop).toBe('context-thrash')
    expect(result.steps).toBe(3)
    expect(summarizer.calls).toHaveLength(1)
    expect(model.prompts).toHaveLength(3) // no model call after the thrash
    const thrash = warnings.filter((w) => w.code === 'W_CONTEXT_THRASH')
    expect(thrash).toHaveLength(1)
    expect(thrash[0]?.details).toMatchObject({ stepIndex: 3, lastCompaction: 2 })
    expect(thrash[0]?.details?.tokens as number).toBeGreaterThan(
      thrash[0]?.details?.summarizeAt as number,
    )
    const stored = await all(messages)
    const notice = stored.find((m) => isKindMessage(m, 'eh.notice'))
    expect(notice?.parts[0]).toMatchObject({
      data: { level: 'warning', code: 'EH_CONTEXT_THRASH' },
    })
    const assistant = stored.find((m) => m.id === result.messageId)
    expect(assistant?.metadata?.eharness?.stop).toBe('context-thrash')
  })

  test('turn.beforeEnd does not run for context-thrash', async () => {
    const calls: string[] = []
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({
        hooks: {
          'turn.beforeEnd': (_ctx, e) => {
            calls.push(e.stop)
            return { continue: { reason: 'keep going' } }
          },
        },
      }),
    })
    const { agent } = setup(
      [fetch(0, 'big'), fetch(1, 'big'), fetch(2, 'huge'), fetch(3, 'big'), answer('done')],
      { tools: { fetch: fetchTool }, plugins: [probe] },
    )
    const result = await agent.session('s1').send('Go').result
    expect(result.stop).toBe('context-thrash')
    expect(calls).toHaveLength(0)
  })

  test('refill after 3 steps → a normal second compaction', async () => {
    const { agent, summarizer, warnings } = setup(
      [
        fetch(0, 'big'),
        fetch(1, 'big'),
        fetch(2, 'small'),
        fetch(3, 'small'),
        fetch(4, 'big'),
        answer('done'),
      ],
      { tools: { fetch: fetchTool } },
    )
    const result = await agent.session('s1').send('Go').result
    expect(result.stop).toBe('complete')
    expect(summarizer.calls).toHaveLength(2)
    expect(warnings.filter((w) => w.code === 'W_CONTEXT_THRASH')).toHaveLength(0)
  })

  test('a second compaction that gets below summarizeAt is not a thrash', async () => {
    const { agent, summarizer, warnings } = setup(
      [fetch(0, 'big'), fetch(1, 'big'), fetch(2, 'big'), fetch(3, 'big'), answer('done')],
      { tools: { fetch: fetchTool } },
    )
    const result = await agent.session('s1').send('Go').result
    expect(result.stop).toBe('complete')
    expect(summarizer.calls.length).toBeGreaterThanOrEqual(2)
    expect(warnings.filter((w) => w.code === 'W_CONTEXT_THRASH')).toHaveLength(0)
  })

  test('a pre-turn compaction does not start the thrash window (one big tool output completes)', async () => {
    const run = async (thrash: false | undefined) => {
      const summarizer = summarizerModel((_call, i) => `SUMMARY-${i + 1}`)
      const { agent, warnings } = setup(
        [
          answer('A1'),
          answer('A2'),
          answer('A3'),
          answer('A4'),
          callTool('fetch', { n: 0, size: 4_400 }),
          answer('done'),
        ],
        {
          tools: { fetch: fetchTool },
          compaction: {
            model: summarizer,
            keepLast: 1,
            maxSummaryTokens: 100,
            ...(thrash === false ? { thrash } : {}),
          },
        },
      )
      const session = agent.session('s1')
      for (let i = 1; i <= 4; i++) await session.send(big(`Q${i}`)).result
      const result = await session.send(big('Q5')).result
      return { result, summarizer, warnings }
    }
    const on = await run(undefined)
    const off = await run(false)
    expect(on.result.stop).toBe('complete')
    expect(on.result.stop).toBe(off.result.stop)
    expect(on.summarizer.calls.length).toBe(off.summarizer.calls.length)
    expect(on.warnings.filter((w) => w.code === 'W_CONTEXT_THRASH')).toHaveLength(0)
  })

  test('thrash: false → compacts again (0.3 behaviour)', async () => {
    const summarizer = summarizerModel((_call, i) => `SUMMARY-${i + 1}`)
    const { agent, warnings } = setup(
      [fetch(0, 'big'), fetch(1, 'big'), fetch(2, 'huge'), fetch(3, 'big'), answer('done')],
      {
        tools: { fetch: fetchTool },
        compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100, thrash: false },
      },
    )
    const result = await agent.session('s1').send('Go').result
    expect(result.stop).toBe('complete')
    expect(summarizer.calls.length).toBeGreaterThanOrEqual(2)
    expect(warnings.filter((w) => w.code === 'W_CONTEXT_THRASH')).toHaveLength(0)
  })
})

describe('acceptance', () => {
  test('30 turns in a small window: compacts at the ratio, never over the hard limit, full history kept', async () => {
    const steps = Array.from({ length: 30 }, (_, i) => answer(`A${i + 1}`))
    const { agent, model, messages, warnings } = setup(steps)
    const session = agent.session('s1')
    for (let i = 1; i <= 30; i++) {
      const result = await session.send(big(`Q${i}`)).result
      expect(result.stop).toBe('complete')
    }
    const all30 = await all(messages)
    const found = all30.filter((m) => isKindMessage(m, 'eh.compaction'))
    expect(found.length).toBeGreaterThanOrEqual(5)
    for (const marker of found) expect(payload(marker).tokens.before).toBeGreaterThan(1_500)
    for (const prompt of model.prompts) {
      expect(
        wireTokens(prompt as unknown as ModelMessage[], defaultCountTokens),
      ).toBeLessThanOrEqual(1_640)
    }
    expect(all30.length - found.length).toBe(60)
    expect(warnings.filter((w) => w.code === 'W_CONTEXT_TRUNCATED')).toHaveLength(0)
  })
})
