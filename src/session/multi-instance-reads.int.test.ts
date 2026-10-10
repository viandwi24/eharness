/**
 * Two agent instances over one storage: a cached idle handle never reports state another instance
 * already changed (spec 05 §2.1 "Reads on a live handle"), and a direct `send()` never overtakes
 * older queued inbox items (spec 05 §12 rule 7).
 */
import { expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { memoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('stats() of a cached idle handle reflects an approval answered on another instance', async () => {
  const storage = { messages: defaultMemoryMessages(), state: defaultMemoryState() }
  const pay = tool({
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => `paid ${amount}`,
  })
  const make = (script: Parameters<typeof scriptedModel>[0]) =>
    defineHarnessAgent({
      model: scriptedModel(script),
      contextWindow: 100_000,
      storage,
      logger: silent,
      onWarning() {},
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
  const a = make([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }])
  const b = make([{ text: 'done' }])
  const first = await a.session('s1').send('pay').result
  const approvalId = first.pending?.approvals[0]?.approvalId as string
  expect((await a.session('s1').stats()).pending).not.toBeNull()

  await b.session('s1').respond({ approvals: [{ id: approvalId, approved: true }] }).result

  const stale = a.session('s1') // the same cached handle
  expect((await stale.stats()).pending).toBeNull()
  expect(await stale.pendingWaits()).toEqual([])
  await a.close()
  await b.close()
})

test('a direct send() does not overtake older queued inbox items of the session', async () => {
  const storage = {
    messages: defaultMemoryMessages(),
    state: defaultMemoryState(),
    inbox: memoryInbox(),
  }
  const model = scriptedModel([{ text: 'r1' }, { text: 'r2' }])
  const base = { contextWindow: 100_000, storage, logger: silent, onWarning() {}, model }
  const a = defineHarnessAgent({ ...base, inbox: { pollMs: 0 } })
  const b = defineHarnessAgent({ ...base, inbox: { pollMs: 0 } })
  // B queues an item while nobody holds the session; A has no live handle yet
  await storage.inbox.enqueue('s1', {
    kind: 'send',
    mode: 'queue',
    input: { parts: [{ type: 'text', text: 'QUEUED-FIRST' }] },
    at: Date.now(),
  })
  await sleep(2)
  const direct = a.session('s1').send('DIRECT-SECOND')
  await direct.result
  await a.session('s1').idle()
  const stored = await storage.messages.load({ sessionId: 's1' })
  const users = stored
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
  expect(users).toEqual(['QUEUED-FIRST', 'DIRECT-SECOND'])
  await a.close()
  await b.close()
})
