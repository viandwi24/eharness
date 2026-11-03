/**
 * A program run whose final answer is cut at the output limit gets one more step for a short report;
 * a chat turn is left alone, and a second cut ends the turn.
 */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type HarnessAgent } from 'eharness'
import { inMemoryMessages, inMemoryState } from 'eharness/storage/memory'
import { scriptedModel } from 'eharness/testing'
import { CUT_ANSWER_NOTE, cutAnswer } from '../src/infra/eh/cut-answer-plugin.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function agent(steps: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(steps)
  const a = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    plugins: [cutAnswer()],
  }) as HarnessAgent
  return { a, model }
}

const cut = { text: 'a very long report that never ends', finishReason: 'length' as const }

describe('cut answer', () => {
  test('a program run continues once with a note and completes', async () => {
    const { a, model } = agent([cut, { text: 'short report' }])
    const result = await a.session('program:p1:1').send('run').result
    expect(result.stop).toBe('complete')
    expect(model.calls).toHaveLength(2)
    expect(JSON.stringify(model.calls[1]?.prompt)).toContain('cut at the output limit')
    expect(CUT_ANSWER_NOTE).toContain('Do not repeat it')
  })

  test('a second cut ends the turn', async () => {
    const { a, model } = agent([cut, cut, { text: 'never' }])
    const result = await a.session('program:p1:2').send('run').result
    expect(result.stop).toBe('length')
    expect(model.calls).toHaveLength(2)
  })

  test('a chat turn is not continued', async () => {
    const { a, model } = agent([cut, { text: 'never' }])
    const result = await a.session('dm:a1').send('hi').result
    expect(result.stop).toBe('length')
    expect(model.calls).toHaveLength(1)
  })
})
