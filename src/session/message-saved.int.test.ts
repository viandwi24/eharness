/** `message.saved`: observe-only, after the adapter stored the messages (spec 01 §5). */
import { expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

test('message.saved fires after the save with the stored messages; its errors never affect the save', async () => {
  const messages = spyMessages()
  const seen: Array<{ saves: number; ids: string[] }> = []
  const plugin = definePlugin({
    name: 'saved-probe',
    setup: () => ({
      hooks: {
        'message.saved': (_ctx, saved) => {
          seen.push({ saves: messages.saves.length, ids: saved.map((m) => m.id) })
          if (seen.length === 1) throw new Error('boom')
        },
      },
    }),
  })
  const warnings: string[] = []
  const agent = defineHarnessAgent({
    model: scriptedModel([{ text: 'hi' }]),
    contextWindow: 100_000,
    storage: { messages },
    logger: silent,
    onWarning: (w) => warnings.push(w.code),
    plugins: [plugin],
  })
  const result = await agent.session('s1').send('hello').result
  expect(result.stop).toBe('complete')
  expect(seen.length).toBeGreaterThanOrEqual(2)
  // every call came after its save reached the adapter
  seen.forEach((s, i) => {
    expect(s.saves).toBeGreaterThanOrEqual(i + 1)
  })
  const stored = (await messages.load({ sessionId: 's1' })).map((m) => m.id)
  expect(stored).toContain(result.messageId as string)
  expect(warnings).toContain('W_HOOK_FAILED')
  await agent.close()
})
