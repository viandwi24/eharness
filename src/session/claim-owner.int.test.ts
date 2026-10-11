/**
 * Inbox claims of a restarted process (found by the fuzz test, spec 05 §15): two agent objects with
 * the same stable `recovery.instanceId` (a process and its restart) must claim with different
 * owner strings, or the restart renews (and so holds forever) the claims its dead predecessor left.
 */
import { expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { InboxAdapter } from '../agent/session-types.ts'
import { inMemoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

test('a restarted agent with the same instanceId claims with a new owner string', async () => {
  const inner = inMemoryInbox()
  const owners = new Set<string>()
  const inbox: InboxAdapter = {
    ...inner,
    claim: (sessionId, owner, opts) => {
      owners.add(owner)
      return inner.claim(sessionId, owner, opts)
    },
  }
  const storage = { messages: defaultMemoryMessages(), state: defaultMemoryState(), inbox }
  const make = () =>
    defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      contextWindow: 100_000,
      storage,
      inbox: { pollMs: 5 },
      recovery: { instanceId: 'stable-1' },
      logger: silent,
    })
  const first = make()
  await first.session('s1').ready()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = make()
  await second.session('s1').ready()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(owners.size).toBe(2)
  for (const owner of owners) expect(owner.startsWith('stable-1')).toBe(true)
  await first.close()
  await second.close()
})
