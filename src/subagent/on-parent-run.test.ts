/**
 * `onParentRun` (spec 20 §3.1, §4): when a parked child finishes, the continuation run that
 * `resolveWait()` starts on the parent is handed to the application instead of being drained.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, type HarnessAgent, type HarnessUIMessage } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { pendingSubagentApprovals, subagent, subagentChild } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
type AnyRun = { stream: AsyncIterable<unknown>; result: Promise<{ stop: string }> }

const danger = tool({
  description: 'A dangerous action',
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => `did ${what}`,
})

describe('subagentChild({ onParentRun })', () => {
  test("receives the parent's continuation run and the parent session id", async () => {
    const storage = { messages: inMemoryMessages(), state: inMemoryState() }
    const holder: { main?: Agent } = {}
    const seen: Array<{ run: AnyRun; parentSessionId: string }> = []
    const worker = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      tools: { danger },
      approval: { policy: { danger: 'user-approval' } },
      plugins: [
        subagentChild({
          parent: () => holder.main as Agent,
          onParentRun: (run, parentSessionId) => {
            seen.push({ run: run as unknown as AnyRun, parentSessionId })
          },
        }),
      ] as never,
    }) as Agent
    const main = defineHarnessAgent({
      model: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'agent',
              input: { subagent_type: 'worker', description: 'task', prompt: 'do it' },
            },
          ],
        },
        { text: 'parent done' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      plugins: [
        subagent({
          agents: { worker: { agent: worker, description: 'does work' } },
          approvals: 'park',
        }),
      ] as never,
    }) as Agent
    holder.main = main

    const parked = await main.session('p1').send('go').result
    expect(parked.stop).toBe('tool-pending')
    expect(seen).toHaveLength(0)

    const found = await pendingSubagentApprovals(main.session('p1'), worker)
    const approvalId = found[0]?.pending.approvals[0]?.approvalId as string
    const childRun = worker
      .session(found[0]?.sessionId as string)
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await childRun.result).stop).toBe('complete')

    await until('onParentRun called', () => seen.length > 0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.parentSessionId).toBe('p1')
    // the application owns the run: it can drive it to completion
    expect((await seen[0]?.run.result)?.stop).toBe('complete')
    const messages = (await main.session('p1').messages()) as HarnessUIMessage[]
    expect(JSON.stringify(messages)).toContain('parent done')
    await main.close()
    await worker.close()
  })
})
