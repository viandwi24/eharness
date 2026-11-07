import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isKindMessage } from '../messages/kinds.ts'
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { answer, summarizerModel } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const big = (tag: string): string => `${tag} ${'x'.repeat(1_200)}`

type Compaction = Exclude<HarnessAgentConfig['compaction'], false | undefined>

function agentWith(compaction: Compaction): ReturnType<typeof defineHarnessAgent> {
  return defineHarnessAgent({
    model: scriptedModel(Array.from({ length: 12 }, (_, i) => answer(`A${i + 1}`))),
    contextWindow: 2_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    onWarning: () => {},
    compaction,
  })
}

async function fill(
  agent: ReturnType<typeof defineHarnessAgent>,
  id: string,
  runtime: Record<string, unknown>,
  turns = 5,
): Promise<HarnessUIMessage[]> {
  const session = agent.session(id, { runtime })
  for (let i = 1; i <= turns; i++) await session.send(big(`Q${i}`)).result
  return (await session.messages()) as HarnessUIMessage[]
}

const marker = (messages: HarnessUIMessage[]): CompactionPayload | undefined =>
  (
    messages.find((m) => isKindMessage(m, 'eh.compaction'))?.parts[0] as
      | { data: CompactionPayload }
      | undefined
  )?.data

describe('compaction options take the ctx', () => {
  test('model: each session summarizes with its own model', async () => {
    const a = summarizerModel(['SUMMARY-A'])
    const b = summarizerModel(['SUMMARY-B'])
    const agent = agentWith({
      keepLast: 1,
      maxSummaryTokens: 100,
      model: async (ctx) => (ctx.runtime.tenant === 'a' ? a : b),
    })
    expect(marker(await fill(agent, 's-a', { tenant: 'a' }))?.summary).toBe('SUMMARY-A')
    expect(marker(await fill(agent, 's-b', { tenant: 'b' }))?.summary).toBe('SUMMARY-B')
    expect(a.calls).toHaveLength(1)
    expect(b.calls).toHaveLength(1)
  })

  test('summarizeAt: a higher ratio for one session means no compaction yet', async () => {
    const agent = agentWith({
      keepLast: 1,
      maxSummaryTokens: 100,
      model: summarizerModel(['S']),
      summarizeAt: (ctx) => Number(ctx.runtime.at),
    })
    expect(marker(await fill(agent, 's-low', { at: 0.75 }))).toBeDefined()
    expect(marker(await fill(agent, 's-high', { at: 0.99 }))).toBeUndefined()
  })

  test('keepLast: keeps as many recent turns as the ctx says', async () => {
    const agent = agentWith({
      maxSummaryTokens: 100,
      model: summarizerModel(['S']),
      keepLast: (ctx) => Number(ctx.runtime.keep),
    })
    const few = await fill(agent, 's-few', { keep: 1 })
    const many = await fill(agent, 's-none', { keep: 0 })
    const idOf = (messages: HarnessUIMessage[], tag: string): string | undefined =>
      messages.find((m) => m.role === 'user' && JSON.stringify(m.parts).includes(`${tag} `))?.id
    expect(marker(few)?.resumeFromId).toBe(idOf(few, 'Q4'))
    expect(marker(many)?.resumeFromId).toBe(idOf(many, 'Q5'))
  })

  test('an invalid or throwing value falls back to the default', async () => {
    const agent = agentWith({
      maxSummaryTokens: 100,
      model: summarizerModel(['S']),
      keepLast: () => {
        throw new Error('boom')
      },
      summarizeAt: () => 7,
    })
    expect(marker(await fill(agent, 's-bad', {}))).toBeDefined()
  })
})
