import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig, PruneConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { isKindMessage } from '../messages/kinds.ts'
import type { ContextStats, HarnessUIMessage } from '../messages/types.ts'
import { collect, normalizeVolatile, spyMessages, spyState } from '../session/int-kit.ts'
import {
  type ScriptedCallOptions,
  type ScriptedPrompt,
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { answer, estimatedInput, summarizerModel } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

const read = tool({
  description: 'Read a chunk',
  inputSchema: z.object({ n: z.number() }),
  execute: async ({ n }) => `R${n} ${'y'.repeat(2_400)}`,
})

const callTool =
  (n: number) =>
  (call: ScriptedCallOptions): ScriptedStep => ({
    toolCalls: [{ toolName: 'read', input: { n } }],
    usage: { inputTokens: estimatedInput(call), outputTokens: 5 },
  })

/** `turns` tool-heavy turns: read(n) → answer, each with a ~2.4k-char tool output. */
function toolTurns(turns: number, from = 0): ScriptedStepInput[] {
  const steps: ScriptedStepInput[] = []
  for (let i = from; i < from + turns; i++) steps.push(callTool(i), answer(`A${i}`))
  return steps
}

function setup(
  steps: ScriptedStepInput[],
  prune: PruneConfig | false | undefined,
  config: Partial<HarnessAgentConfig> = {},
) {
  const model = scriptedModel(steps)
  const summarizer = summarizerModel((_call, i) => `SUMMARY-${i + 1}`)
  const messages = spyMessages()
  const state = spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    model,
    contextWindow: 4_000,
    tools: { read },
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    compaction: {
      model: summarizer,
      keepLast: 2,
      maxSummaryTokens: 100,
      ...(prune === undefined ? {} : { prune }),
    },
    ...config,
  })
  return { agent, model, summarizer, messages, state, warnings }
}

async function all(messages: ReturnType<typeof spyMessages>): Promise<HarnessUIMessage[]> {
  const out = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  messages.loads.pop()
  return out
}

/** Stored conversation without compaction markers, ids normalized, usage-free. */
async function storedConversation(messages: ReturnType<typeof spyMessages>): Promise<unknown> {
  const stored = (await all(messages)).filter((m) => !isKindMessage(m, 'eh.compaction'))
  return normalizeVolatile(stored.map((m) => ({ id: m.id, role: m.role, parts: m.parts })))
}

async function runTurns(session: { send(text: string): { result: Promise<unknown> } }, n: number) {
  for (let i = 0; i < n; i++) await session.send(`Q${i}`).result
}

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

const PLACEHOLDER = /\[output of read pruned: \d+ chars\]/

/** Index of the first user message of a prompt containing `text`. */
function indexOfUser(prompt: ScriptedPrompt, text: string): number {
  return prompt.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes(text))
}

describe('prune off (default)', () => {
  test('golden: prune undefined → wire identical to 0.3 (also with prune: false)', async () => {
    const off = setup(toolTurns(6), undefined)
    await runTurns(off.agent.session('s1'), 6)
    expect(off.summarizer.calls.length).toBeGreaterThan(0)
    await expectGolden('prune-off.prompts', normalizeVolatile(off.model.prompts))
    const disabled = setup(toolTurns(6), false)
    await runTurns(disabled.agent.session('s1'), 6)
    expect(normalizeVolatile(disabled.model.prompts)).toEqual(normalizeVolatile(off.model.prompts))
  })
})

describe('prune on', () => {
  test('acceptance: 20 tool-heavy turns reach the summarizer later (or never); stored messages identical', async () => {
    const off = setup(toolTurns(20), undefined)
    await runTurns(off.agent.session('s1'), 20)
    const on = setup(toolTurns(20), {})
    await runTurns(on.agent.session('s1'), 20)
    expect(off.summarizer.calls.length).toBeGreaterThan(0)
    expect(on.summarizer.calls.length).toBeLessThan(off.summarizer.calls.length)
    expect(await storedConversation(on.messages)).toEqual(await storedConversation(off.messages))
    // the stored history keeps every original output
    for (const save of on.messages.saves) expect(JSON.stringify(save)).not.toMatch(PLACEHOLDER)
    // older outputs are pruned in the request, the last two completed turns are verbatim
    const last = on.model.prompts.at(-1) as ScriptedPrompt
    const wire = JSON.stringify(last)
    expect(wire).toMatch(PLACEHOLDER)
    for (const kept of ['R17 ', 'R18 ', 'R19 ']) expect(wire).toContain(kept)
    expect(wire).not.toContain('R10 ')
    expect(wire).toContain('"toolName":"read","input":{"n":10}') // the call itself stays
  })

  test('summarize is not triggered when prune alone brings the context under summarizeAt', async () => {
    // 6 turns of ~650 tokens exceed summarizeAt (3 000) without prune
    const off = setup(toolTurns(6), undefined)
    await runTurns(off.agent.session('s1'), 6)
    expect(off.summarizer.calls.length).toBe(1)
    const on = setup(toolTurns(6), {})
    await runTurns(on.agent.session('s1'), 6)
    expect(on.summarizer.calls).toHaveLength(0)
  })

  test('summarize still runs when prune is not enough', async () => {
    const big = (i: number) => `Q${i} ${'x'.repeat(4_000)}`
    const on = setup(toolTurns(6), {})
    const session = on.agent.session('s1')
    for (let i = 0; i < 6; i++) await session.send(big(i)).result
    expect(on.summarizer.calls.length).toBeGreaterThan(0)
    // the summarizer transcript sees the original outputs (capped), not the placeholders
    const transcript = JSON.stringify(on.summarizer.calls[0]?.prompt)
    expect(transcript).toContain('R0 yyyy')
    expect(transcript).not.toMatch(PLACEHOLDER)
  })

  test('cache-stable: within a 10-step turn the prefix is identical; across turns only the newly aged turn changes', async () => {
    const steps: ScriptedStepInput[] = [...toolTurns(3)]
    for (let i = 0; i < 9; i++) steps.push(callTool(100 + i))
    steps.push(answer('long done'), ...toolTurns(1, 50))
    const { agent, model } = setup(
      steps,
      { keepTurns: 1, minChars: 100 },
      { contextWindow: 200_000 },
    )
    const session = agent.session('s1')
    await runTurns(session, 3)
    await session.send('LONG').result
    await session.send('AFTER').result
    const prompts = model.prompts
    expect(prompts).toHaveLength(6 + 10 + 2)
    const long = prompts.slice(6, 16)
    const at = indexOfUser(long[0] as ScriptedPrompt, 'LONG')
    expect(at).toBeGreaterThan(0)
    const prefix = JSON.stringify((long[0] as ScriptedPrompt).slice(0, at))
    expect(prefix).toMatch(PLACEHOLDER) // turn 0 and 1 are pruned (keepTurns 1)
    expect(prefix).toContain('R2 yyy') // turn 2 is kept
    for (const p of long) expect(JSON.stringify(p.slice(0, at))).toBe(prefix)

    // the next turn: everything before the LONG turn is the same except turn 2, newly aged
    const next = prompts[16] as ScriptedPrompt
    const before = (long[0] as ScriptedPrompt).slice(0, at)
    const changed = before
      .map((m, i) => JSON.stringify(m) === JSON.stringify(next[i]))
      .flatMap((same, i) => (same ? [] : [i]))
    expect(changed).toHaveLength(1)
    const aged = next[changed[0] as number]
    expect(aged?.role).toBe('tool')
    expect(JSON.stringify(aged)).toMatch(PLACEHOLDER)
    // the LONG turn's own outputs are verbatim (keepTurns 1), so are the AFTER turn's
    expect(JSON.stringify(next)).toContain('R108 yyy')
  })

  test('storage untouched: the same saves with and without prune', async () => {
    const off = setup(toolTurns(5), undefined, { contextWindow: 200_000 })
    await runTurns(off.agent.session('s1'), 5)
    const on = setup(toolTurns(5), { minChars: 10, keepTurns: 0 }, { contextWindow: 200_000 })
    await runTurns(on.agent.session('s1'), 5)
    expect(on.messages.saves.length).toBe(off.messages.saves.length)
    expect(JSON.stringify(on.model.prompts.at(-1))).toMatch(PLACEHOLDER)
    const parts = (saves: HarnessUIMessage[][]) =>
      normalizeVolatile(saves.map((batch) => batch.map((m) => ({ id: m.id, parts: m.parts }))))
    expect(parts(on.messages.saves)).toEqual(parts(off.messages.saves))
  })

  test('ContextStats.pruned: data-eh.context after a step and session.stats()', async () => {
    const { agent } = setup(toolTurns(4), {}, { contextWindow: 200_000 })
    const session = agent.session('s1')
    await runTurns(session, 3)
    const run = session.send('Q3')
    const chunks = await collect(run.stream)
    await run.result
    const contexts = chunks
      .filter((c) => c.type === 'data-eh.context')
      .map((c) => (c as { data: ContextStats }).data)
    // turn 0 is pruned (keepTurns 2): one output, ~2.4k chars saved
    expect(contexts[0]?.pruned?.outputs).toBe(1)
    expect(contexts[0]?.pruned?.chars).toBeGreaterThan(2_300)
    const stats = await session.stats()
    // idle: 4 completed turns, the 2 oldest are pruned in the next request
    expect(stats.pruned?.outputs).toBe(2)
    expect(stats.messages).toBeLessThan(stats.tokens)

    const off = setup(toolTurns(4), undefined, { contextWindow: 200_000 })
    const offSession = off.agent.session('s1')
    await runTurns(offSession, 4)
    const offStats = await offSession.stats()
    expect(offStats.pruned).toBeUndefined()
    // the pruned estimate is smaller by roughly the saved characters / 4
    expect(offStats.messages - stats.messages).toBeGreaterThan(1_000)
  })
})
