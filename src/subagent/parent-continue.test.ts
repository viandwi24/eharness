/**
 * The parent of a finished parked child always continues (spec 20 §3 step 5): a continuation that
 * fails before it stored anything (the session lock is held elsewhere) is retried, and
 * `reconcileSubagentWaits()` continues a parent whose waits are all resolved but whose turn never
 * continued.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  defineHarnessAgent,
  type HarnessAgent,
  HarnessError,
  type HarnessUIMessage,
  type SessionLock,
} from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import {
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  subagent,
  subagentChild,
} from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
type AnyRun = { stream: AsyncIterable<unknown>; result: Promise<{ stop: string }> }

const danger = tool({
  description: 'A dangerous action',
  inputSchema: z.object({ what: z.string() }),
  execute: async ({ what }) => `did ${what}`,
})

/** A lock that answers "held elsewhere" for the next `busy` acquisitions. */
function flakyLock(): SessionLock & { busy: number; acquired: number } {
  const lock = {
    busy: 0,
    acquired: 0,
    async acquire(): Promise<() => Promise<void>> {
      if (lock.busy > 0) {
        lock.busy--
        throw new HarnessError('EH_SESSION_BUSY', 'locked elsewhere')
      }
      lock.acquired++
      return async () => {}
    },
  }
  return lock
}

function agents(o: { lock: SessionLock; runs?: AnyRun[]; warnings?: string[] }): {
  main: Agent
  worker: Agent
} {
  const storage = { messages: inMemoryMessages(), state: inMemoryState() }
  const holder: { main?: Agent } = {}
  const worker = defineHarnessAgent({
    model: scriptedModel([
      { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
      { text: 'child report' },
    ]),
    contextWindow: 100_000,
    storage,
    logger: {
      ...silent,
      warn: (message: string) => {
        o.warnings?.push(message)
      },
    },
    tools: { danger },
    approval: { policy: { danger: 'user-approval' } },
    plugins: [
      subagentChild({
        parent: () => holder.main as Agent,
        parentSession: () => ({ lock: o.lock }),
        ...(o.runs === undefined
          ? {}
          : {
              onParentRun: (run) => {
                const r = run as unknown as AnyRun
                o.runs?.push(r)
                void (async () => {
                  for await (const _ of r.stream) {
                    // drained
                  }
                })()
              },
            }),
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
  return { main, worker }
}

async function parkAndFindChild(
  main: Agent,
  worker: Agent,
  lock: SessionLock,
): Promise<{ childId: string; approvalId: string }> {
  const parked = await main.session('p1', { lock }).send('go').result
  expect(parked.stop).toBe('tool-pending')
  const found = await pendingSubagentApprovals(main.session('p1'), worker)
  return {
    childId: found[0]?.sessionId as string,
    approvalId: found[0]?.pending.approvals[0]?.approvalId as string,
  }
}

const text = async (main: Agent): Promise<string> =>
  JSON.stringify((await main.session('p1').messages()) as HarnessUIMessage[])

describe('the parent of a finished parked child continues', () => {
  test('a continuation that lost the session lock is retried until it runs', async () => {
    const lock = flakyLock()
    const runs: AnyRun[] = []
    const { main, worker } = agents({ lock, runs })
    const { childId, approvalId } = await parkAndFindChild(main, worker, lock)

    lock.busy = 2 // the next two continuations find the lock held elsewhere
    const child = worker
      .session(childId)
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await child.result).stop).toBe('complete')

    await until('parent continued', async () => (await text(main)).includes('parent done'), 5_000)
    expect(lock.busy).toBe(0)
    // two runs failed before their commit point, the third one ran the turn
    expect(runs).toHaveLength(3)
    expect((await runs[0]?.result)?.stop).toBe('error')
    expect((await runs[2]?.result)?.stop).toBe('complete')
    expect((await main.session('p1').pendingWaits()).length).toBe(0)
  })

  test('reconcile continues a parent whose waits are resolved but whose turn never continued', async () => {
    const lock = flakyLock()
    const { main, worker } = agents({ lock })
    await parkAndFindChild(main, worker, lock)
    const waits = await main.session('p1').pendingWaits()
    const waitId = waits[0]?.waitId as string
    expect(waitId.startsWith('w_')).toBe(true)

    // resolved by hand while the lock is held elsewhere: the continuation fails before its commit
    lock.busy = 1
    const out = await main.session('p1').resolveWait(waitId, { output: 'by hand' })
    expect(out.status).toBe('continued')
    if (out.status === 'continued') expect((await out.run.result).stop).toBe('error')
    expect((await main.session('p1').pendingWaits())[0]?.result).toBeDefined()
    expect(await text(main)).not.toContain('parent done')

    const entries = await reconcileSubagentWaits(main.session('p1') as never, {
      openChild: (id) => worker.session(id) as never,
    })
    expect(entries).toEqual([])
    await until('parent continued', async () => (await text(main)).includes('parent done'), 5_000)
  })
})
