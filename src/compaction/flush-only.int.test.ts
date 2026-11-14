import { describe, expect, test } from 'bun:test'
import { type LanguageModel, tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import { isKindMessage } from '../messages/kinds.ts'
import type { FlushPayload, HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type { CompactionBeforeEvent, CompactionBeforePatch } from '../plugin/types.ts'
import { spyMessages } from '../session/test-kit.ts'
import { type ScriptedStepInput, scriptedModel } from '../testing/scripted-model.ts'
import { answer, summarizerModel } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** A user message of about `tokens` tokens, recognizable by `tag`. */
const big = (tag: string, tokens = 320) => `${tag} ${'x'.repeat(tokens * 4)}`

/** A model window that is large for the flush model and small (2k) for the agent model. */
const windowOf = (m: LanguageModel) =>
  typeof m === 'object' && m.modelId.startsWith('flusher') ? 100_000 : 2_000

function setup(
  options: {
    flushSteps?: ScriptedStepInput[]
    steps?: ScriptedStepInput[]
    noPlugin?: boolean
    patch?: (e: CompactionBeforeEvent, flusher: LanguageModel) => CompactionBeforePatch | undefined
    contextWindow?: (m: LanguageModel) => number
  } = {},
) {
  const events: CompactionBeforeEvent[] = []
  const hookInputs: object[] = []
  const flusher = scriptedModel(options.flushSteps ?? [], { modelId: 'flusher' })
  const summarizer = summarizerModel((_call, i) => `SUMMARY-${i + 1}`)
  const messages = spyMessages()
  const warnings: HarnessWarning[] = []
  const facts: string[] = []
  const patch =
    options.patch ??
    ((_e: CompactionBeforeEvent, f: LanguageModel) => ({
      flush: { prompt: 'FLUSH: save what matters.', tools: ['save_fact'], model: f },
    }))
  const plugin = definePlugin({
    name: 'saver',
    setup: () => ({
      tools: {
        save_fact: tool({
          description: 'Save a fact',
          inputSchema: z.object({ fact: z.string() }),
          execute: async ({ fact }) => {
            facts.push(fact)
            return 'saved'
          },
        }),
      },
      hooks: {
        'compaction.before': (_ctx, e) => {
          events.push(e)
          hookInputs.push(e)
          return patch(e, flusher)
        },
      },
    }),
  })
  const agent = defineHarnessAgent({
    model: scriptedModel(options.steps ?? Array.from({ length: 6 }, (_, i) => answer(`A${i + 1}`))),
    contextWindow: options.contextWindow ?? windowOf,
    storage: { messages },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    compaction: { model: summarizer, keepLast: 1, maxSummaryTokens: 100 },
    plugins: options.noPlugin === true ? [] : [plugin],
  })
  return { agent, flusher, summarizer, messages, warnings, events, hookInputs, facts }
}

async function stored(messages: ReturnType<typeof spyMessages>): Promise<HarnessUIMessage[]> {
  const out = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  messages.loads.pop()
  return out
}
const markersOf = async (messages: ReturnType<typeof spyMessages>) =>
  (await stored(messages)).filter((m) => isKindMessage(m, 'eh.compaction'))
const recordsOf = async (messages: ReturnType<typeof spyMessages>) =>
  (await stored(messages)).filter((m) => isKindMessage(m, 'eh.flush'))
const flushDataOf = (m: HarnessUIMessage | undefined): FlushPayload =>
  (m?.parts[0] as { data: FlushPayload } | undefined)?.data as FlushPayload

async function fillTurns(session: { send(text: string): { result: Promise<unknown> } }, n: number) {
  for (let i = 1; i <= n; i++) await session.send(big(`Q${i}`)).result
}

describe('session.flush() (spec 06 §5.2a rule 11)', () => {
  test('runs the flush over the history: the hook sees flushOnly, the fact is saved, the record is stored, no summary, no marker, history unchanged', async () => {
    const { agent, flusher, summarizer, messages, events, facts } = setup({
      flushSteps: [
        { toolCalls: [{ toolName: 'save_fact', input: { fact: 'F1' } }] },
        { text: 'ok' },
      ],
    })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    const before = (await stored(messages)).map((m) => JSON.stringify(m))
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

    expect(await session.flush()).toEqual({ status: 'flushed' })
    await reader.cancel()

    expect(events).toHaveLength(1)
    expect(events[0]?.trigger).toBe('manual')
    expect(events[0]?.flushOnly).toBe(true)
    expect(events[0]?.messages.length).toBeGreaterThan(0)
    expect(facts).toEqual(['F1'])
    expect(flusher.calls.length).toBeGreaterThan(0)
    expect(summarizer.calls).toHaveLength(0)
    expect(await markersOf(messages)).toHaveLength(0)

    const records = await recordsOf(messages)
    expect(records).toHaveLength(1)
    expect(flushDataOf(records[0]).trigger).toBe('manual')
    expect(flushDataOf(records[0]).error).toBeUndefined()
    expect(seen).toEqual(['eh.flush'])

    const after = (await stored(messages)).map((m) => JSON.stringify(m))
    expect(after.filter((m) => !m.includes('"eh.flush"'))).toEqual(before)
  })

  test('skipped (no-hook) when no compaction.before hook asks for a flush: no record, no hook call', async () => {
    const { agent, flusher, summarizer, messages, events } = setup({ noPlugin: true })
    const session = agent.session('s1')
    await fillTurns(session, 4)
    expect(await session.flush()).toEqual({ status: 'skipped', reason: 'no-hook' })
    expect(events).toHaveLength(0)
    expect(flusher.calls).toHaveLength(0)
    expect(summarizer.calls).toHaveLength(0)
    expect(await recordsOf(messages)).toHaveLength(0)
  })

  test('skipped (nothing-to-flush) on an empty session: the hook is not called', async () => {
    const { agent, events } = setup()
    expect(await agent.session('s1').flush()).toEqual({
      status: 'skipped',
      reason: 'nothing-to-flush',
    })
    expect(events).toHaveLength(0)
  })

  test("skipped (window) when the flush model cannot fit the history; a patch with onFailure 'abort' does not throw", async () => {
    const { agent, summarizer, messages, warnings } = setup({
      contextWindow: (m) => (typeof m === 'object' && m.modelId === 'flusher' ? 100 : 100_000),
      patch: (_e, f) => ({
        flush: { prompt: 'FLUSH', tools: ['save_fact'], model: f, onFailure: 'abort' },
      }),
    })
    const session = agent.session('s1')
    await fillTurns(session, 2)
    expect(await session.flush()).toEqual({ status: 'skipped', reason: 'window' })
    expect(summarizer.calls).toHaveLength(0)
    expect(await markersOf(messages)).toHaveLength(0)
    expect(await recordsOf(messages)).toHaveLength(0)
    expect(warnings.find((w) => w.code === 'W_COMPACTION_FLUSH_SKIPPED')?.details).toMatchObject({
      reason: 'window',
      trigger: 'manual',
    })
  })

  test('failed (reason flush) when the flush model errors: the error text is returned, the record carries it, no summary', async () => {
    const { agent, summarizer, messages, warnings } = setup({
      flushSteps: [{ throws: new Error('provider down'), streamError: new Error('provider down') }],
    })
    const session = agent.session('s1')
    await fillTurns(session, 2)
    const result = await session.flush()
    expect(result.status).toBe('failed')
    expect(result).toMatchObject({ reason: 'flush' })
    expect((result as { error: string }).error).toContain('provider down')
    expect(summarizer.calls).toHaveLength(0)
    expect(await markersOf(messages)).toHaveLength(0)
    const [record] = await recordsOf(messages)
    expect(flushDataOf(record).error).toContain('provider down')
    expect(warnings.find((w) => w.code === 'W_HOOK_FAILED')?.details).toMatchObject({
      phase: 'flush',
    })
  })

  test('busy while a turn runs: rejects EH_SESSION_BUSY like compact()', async () => {
    const { agent, flusher } = setup({ steps: [{ text: 'slow', delayMs: 20 }] })
    const session = agent.session('s1')
    const run = session.send('hi')
    await expect(session.flush()).rejects.toMatchObject({ code: 'EH_SESSION_BUSY' })
    await run.result
    expect(flusher.calls).toHaveLength(0)
  })

  test('compact() hooks see no flushOnly field; a later compact() still summarizes the history', async () => {
    const { agent, messages, hookInputs, events, summarizer } = setup({
      flushSteps: [{ text: 'nothing' }, { text: 'nothing' }],
    })
    const session = agent.session('s1')
    await fillTurns(session, 2)
    expect(await session.flush()).toEqual({ status: 'flushed' })
    expect(events[0]?.flushOnly).toBe(true)

    const marker = await session.compact({ keepLast: 0 })
    expect(marker).not.toBeNull()
    expect(events[1]?.trigger).toBe('manual')
    expect('flushOnly' in (hookInputs[1] as object)).toBe(false)
    expect(summarizer.calls).toHaveLength(1)
    expect(await markersOf(messages)).toHaveLength(1)
    expect(await recordsOf(messages)).toHaveLength(2)
  })

  test('a closed session rejects like compact()', async () => {
    const { agent } = setup()
    const session = agent.session('s1')
    await session.close()
    const error = await session.flush().then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(isHarnessError(error, 'EH_SESSION_CLOSED')).toBe(true)
  })
})
