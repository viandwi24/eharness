import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from 'eharness'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { scriptedModel } from 'eharness/testing'
import { compactWithFocus, createCompactFocus } from '../src/app/compact-focus.ts'

function build(texts: string[]) {
  const focus = createCompactFocus()
  const model = scriptedModel(texts.map((text) => ({ text })))
  const agent = defineHarnessAgent({
    id: 'cf',
    model,
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    compaction: { keepLast: 1 },
    plugins: [focus.plugin],
  })
  return { focus, model, session: agent.session('s') }
}

const promptText = (model: { prompts: unknown[] }, index: number): string =>
  JSON.stringify(model.prompts[index])

describe('compact focus', () => {
  test('the focus reaches the summarizer prompt once', async () => {
    const { focus, model, session } = build(['a1', 'a2', 'SUMMARY ONE', 'a3', 'a4', 'SUMMARY TWO'])
    await session.send('first request about the parser').result
    await session.send('second request about the lexer').result
    await compactWithFocus(focus, () => session.compact(), 'keep the open TODOs about the lexer')
    const summarizer = promptText(model, 2)
    expect(summarizer).toContain('first request about the parser')
    expect(summarizer).toContain('keep the open TODOs about the lexer')
    expect(focus.pending()).toBeUndefined()

    await session.send('third').result
    await session.send('fourth').result
    await compactWithFocus(focus, () => session.compact())
    expect(promptText(model, 5)).not.toContain('keep the open TODOs about the lexer')
  })

  test('setFocus is consumed once and an empty focus clears it', () => {
    const focus = createCompactFocus()
    focus.setFocus('  tests  ')
    expect(focus.pending()).toBe('tests')
    focus.setFocus('   ')
    expect(focus.pending()).toBeUndefined()
  })

  test('a compaction that summarizes nothing leaves no focus behind', async () => {
    const { focus, session } = build([])
    await compactWithFocus(focus, () => session.compact().catch(() => null), 'anything')
    expect(focus.pending()).toBeUndefined()
  })
})
