import { describe, expect, test } from 'bun:test'
import type { UIMessage } from 'ai'
import { scriptedModel } from 'eharness/testing'
import { createRecap, RECAP_MAX_CHARS, SUGGEST_MAX_CHARS } from '../src/app/recap.ts'
import { createStorage } from '../src/app/sessions.ts'
import { setup } from './helpers.ts'

async function env(steps: Parameters<typeof scriptedModel>[0], timeoutMs?: number, empty = false) {
  const { config } = await setup()
  const storage = createStorage(config)
  const messages: UIMessage[] = Array.from({ length: 40 }, (_, i) => ({
    id: `m${String(i).padStart(2, '0')}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    parts: [{ type: 'text', text: `message number ${i}` }],
  }))
  if (!empty) await storage.messages.save('s', messages)
  const model = scriptedModel(steps)
  return {
    model,
    ...createRecap({
      storage,
      sessionId: () => 's',
      model: () => model,
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
  }
}

describe('recap and suggestions', () => {
  test('recap: one line of at most 400 chars from the last 30 messages', async () => {
    const long = `"${'word '.repeat(200)}"\nsecond line`
    const t = await env([{ text: long }])
    const text = await t.recap()
    expect(text.length).toBeLessThanOrEqual(RECAP_MAX_CHARS)
    expect(text).not.toContain('\n')
    expect(text.startsWith('word')).toBe(true)
    const wire = JSON.stringify(t.model.calls[0]?.prompt)
    expect(wire).toContain('message number 39')
    expect(wire).toContain('message number 10')
    expect(wire).not.toContain('message number 9"')
  })

  test('suggestNext: short single line, quotes stripped; none and empty give undefined', async () => {
    const t = await env([
      { text: '"Run the tests again please"' },
      { text: 'none' },
      { text: '   ' },
      { text: 'x'.repeat(200) },
    ])
    expect(await t.suggestNext()).toBe('Run the tests again please')
    expect(await t.suggestNext()).toBeUndefined()
    expect(await t.suggestNext()).toBeUndefined()
    expect((await t.suggestNext())?.length).toBeLessThanOrEqual(SUGGEST_MAX_CHARS)
  })

  test('failures and timeouts never throw: recap is empty, suggestion undefined', async () => {
    const failing = await env([{ throws: new Error('boom') }, { throws: new Error('boom') }])
    expect(await failing.recap()).toBe('')
    expect(await failing.suggestNext()).toBeUndefined()

    const slow = await env(
      [
        { text: 'late', delayMs: 300 },
        { text: 'late', delayMs: 300 },
      ],
      50,
    )
    const started = Date.now()
    expect(await slow.recap()).toBe('')
    expect(await slow.suggestNext()).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(250)
  })

  test('an empty session makes no model call', async () => {
    const t = await env([{ text: 'unused' }], undefined, true)
    expect(await t.recap()).toBe('')
    expect(await t.suggestNext()).toBeUndefined()
    expect(t.model.calls).toHaveLength(0)
  })
})
