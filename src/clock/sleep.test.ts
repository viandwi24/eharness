/**
 * The `sleep` tool (ADR-0067): a call parks the turn as an external wait whose timeout is the
 * wake-up time; the session's wait timer or `expireWaits()` continues it. A background worker that
 * sleeps does not wake its parent; its report comes when it finishes.
 */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type HarnessAgent, type HarnessUIMessage } from '../index.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { reconcileBackgroundChildren, subagent } from '../subagent/index.ts'
import { type ScriptedModel, scriptedModel } from '../testing/scripted-model.ts'
import { sleep as pause, until } from '../testing/test-utils.ts'
import { clock, sleepTool } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>
type Step = Parameters<typeof scriptedModel>[0][number]

const storage = () => ({
  messages: inMemoryMessages(),
  state: inMemoryState(),
  inbox: inMemoryInbox(),
})

const sleepCall = (minutes: number, id = 's1'): Step => ({
  toolCalls: [{ toolName: 'sleep', toolCallId: id, input: { minutes, reason: 'pace the batch' } }],
})

/** A clock whose "now" is `minutes` minus `ms` behind: a sleep of `minutes` wakes after `ms`. */
const shortly = (minutes: number, ms: number) => () => Date.now() - minutes * 60_000 + ms

const text = async (agent: Agent, id: string): Promise<string> =>
  JSON.stringify((await agent.session(id).messages()) as HarnessUIMessage[])

describe('sleep', () => {
  test('parks the turn until the wake-up time, then continues with the wake-up text', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([sleepCall(30), { text: 'batch 2 sent' }]),
      contextWindow: 100_000,
      storage: storage(),
      logger: silent,
      plugins: [clock({ timezone: 'Asia/Jakarta', sleep: true })],
    }) as Agent
    const first = await agent.session('s').send('send in batches').result
    expect(first.stop).toBe('tool-pending')
    await until('start ran', async () => {
      const [wait] = await agent.session('s').pendingWaits()
      return wait?.payload !== undefined
    })
    const [wait] = await agent.session('s').pendingWaits()
    expect(wait?.toolName).toBe('sleep')
    const due = wait?.timeoutAt as number
    expect(Math.abs(due - (Date.now() + 30 * 60_000))).toBeLessThan(5_000)
    expect(wait?.payload).toMatchObject({ sleep: true, minutes: 30 })

    // not due yet: nothing happens
    expect((await agent.session('s').expireWaits(due - 1_000)).run).toBeUndefined()
    // due: the turn continues (after a restart, too: `expireWaits` reads the stored state)
    const woke = await agent.session('s').expireWaits(due + 1)
    expect(woke.expired).toEqual([wait?.waitId as string])
    expect((await woke.run?.result)?.stop).toBe('complete')
    const all = await text(agent, 's')
    expect(all).toContain('Woke up after sleeping 30 minutes (pace the batch)')
    expect(all).toContain('Asia/Jakarta (UTC+07:00)')
    expect(all).toContain('batch 2 sent')
  })

  test("the session's own timer wakes it; a loop sleeps and works until it is done", async () => {
    const model = scriptedModel([
      {
        text: 'batch 1',
        toolCalls: [{ toolName: 'nap', toolCallId: 'n1', input: { minutes: 1 } }],
      },
      {
        text: 'batch 2',
        toolCalls: [{ toolName: 'nap', toolCallId: 'n2', input: { minutes: 1 } }],
      },
      { text: 'all batches sent' },
    ])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage: storage(),
      logger: silent,
      tools: { nap: sleepTool({ timezone: 'UTC', now: shortly(1, 150) }) } as never,
    }) as Agent
    expect((await agent.session('loop').send('go').result).stop).toBe('tool-pending')
    await until('done', async () => (await text(agent, 'loop')).includes('all batches sent'), 5_000)
    expect(model.calls).toHaveLength(3)
    expect(await agent.session('loop').pendingWaits()).toEqual([])
  })

  test('a minute count outside the range is a tool error the model reads', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([sleepCall(0), { text: 'ok, no sleep' }]),
      contextWindow: 100_000,
      storage: storage(),
      logger: silent,
      plugins: [clock({ timezone: 'UTC', sleep: { maxMinutes: 60 } })],
    }) as Agent
    const result = await agent.session('bad').send('go').result
    expect(result.stop).toBe('complete')
    expect(await text(agent, 'bad')).toContain('ok, no sleep')
    expect(await agent.session('bad').pendingWaits()).toEqual([])
  })

  test('a sleeping background worker does not wake its parent; the report comes when it finishes', async () => {
    const { main, worker, mainModel } = pair(
      [{ toolCalls: [spawnCall] }, { text: 'started the worker' }, { text: 'the worker reported' }],
      [
        {
          text: 'batch 1',
          toolCalls: [{ toolName: 'sleep', toolCallId: 'w1', input: { minutes: 1 } }],
        },
        { text: 'batch 2, all done' },
      ],
      400,
    )
    await main.session('p').send('follow up everybody').result
    await until('started', async () => (await text(main, 'p')).includes('started the worker'))
    // the worker is asleep: the parent was not woken for it
    await until(
      'worker asleep',
      async () => (await worker.session('p:agent:c1').pendingWaits()).length === 1,
    )
    await pause(100)
    expect(mainModel.calls).toHaveLength(2)
    expect(await text(main, 'p')).not.toContain('is waiting')

    await until(
      'report',
      async () => (await text(main, 'p')).includes('the worker reported'),
      5_000,
    )
    expect(await text(main, 'p')).toContain('batch 2, all done')
    expect(mainModel.calls).toHaveLength(3)
  })

  test('reconcile sends no "waiting" reminder for a sleeping worker', async () => {
    const { main, worker, mainModel } = pair(
      [{ toolCalls: [spawnCall] }, { text: 'started the worker' }],
      [
        {
          text: 'batch 1',
          toolCalls: [{ toolName: 'sleep', toolCallId: 'w1', input: { minutes: 60 } }],
        },
      ],
      60 * 60_000,
    )
    await main.session('p').send('follow up everybody').result
    await until(
      'worker asleep',
      async () => (await worker.session('p:agent:c1').pendingWaits()).length === 1,
    )
    const out = await reconcileBackgroundChildren(main.session('p') as never, {
      openChild: (id) => worker.session(id) as never,
      waitingReminderMs: 1,
      now: () => Date.now() + 30 * 60_000,
    })
    expect(out).toEqual([expect.objectContaining({ sessionId: 'p:agent:c1', outcome: 'running' })])
    await pause(100)
    expect(mainModel.calls).toHaveLength(2)
  })

  test('a message to a sleeping worker ends the sleep early; the worker reads it', async () => {
    const { main, worker, workerModel } = pair(
      [
        { toolCalls: [spawnCall] },
        { text: 'started the worker' },
        {
          toolCalls: [
            {
              toolName: 'send_message',
              toolCallId: 'm1',
              input: { to: 'followups', message: 'status please' },
            },
          ],
        },
        { text: 'asked for status' },
        { text: 'the worker reported' },
      ],
      [
        {
          text: 'batch 1',
          toolCalls: [{ toolName: 'sleep', toolCallId: 'w1', input: { minutes: 60 } }],
        },
        { text: 'woke for the message, batch 2 sent' },
      ],
      60 * 60_000,
    )
    await main.session('p').send('follow up everybody').result
    await until(
      'worker asleep',
      async () => (await worker.session('p:agent:c1').pendingWaits()).length === 1,
    )
    await main.session('p').send('how is it going?').result
    expect(await text(main, 'p')).toContain('It was asleep; the message woke it')
    await until(
      'worker woke',
      async () => (await text(worker, 'p:agent:c1')).includes('woke for the message'),
      5_000,
    )
    expect(JSON.stringify(workerModel.calls.at(-1))).toContain('status please')
    expect(await worker.session('p:agent:c1').pendingWaits()).toEqual([])
  })

  test('agent_stop ends a sleeping worker: it wakes with a stop notice, wraps up and reports', async () => {
    const { main, worker, workerModel } = pair(
      [
        { toolCalls: [spawnCall] },
        { text: 'started the worker' },
        { toolCalls: [{ toolName: 'agent_stop', toolCallId: 'st', input: { id: 'followups' } }] },
        { text: 'asked it to stop' },
        { text: 'the worker reported' },
      ],
      [
        {
          text: 'batch 1',
          toolCalls: [{ toolName: 'sleep', toolCallId: 'w1', input: { minutes: 60 } }],
        },
        { text: 'stopped after batch 1' },
      ],
      60 * 60_000,
    )
    await main.session('p').send('follow up everybody').result
    await until(
      'worker asleep',
      async () => (await worker.session('p:agent:c1').pendingWaits()).length === 1,
    )
    await main.session('p').send('stop the follow-ups').result
    const all = await text(main, 'p')
    expect(all).toContain('Stopped followups: it was paused')
    await until(
      'report',
      async () => (await text(main, 'p')).includes('the worker reported'),
      5_000,
    )
    expect(JSON.stringify(workerModel.calls.at(-1))).toContain('do not sleep again')
    expect(await worker.session('p:agent:c1').pendingWaits()).toEqual([])
  })
})

const spawnCall = {
  toolName: 'agent',
  toolCallId: 'c1',
  input: {
    subagent_type: 'worker',
    description: 'follow-ups',
    prompt: 'send the follow-ups in batches',
    name: 'followups',
    run_in_background: true,
  },
}

/** A lead with a background-capable `worker` that has `sleep`; a sleep wakes after `wakeMs`. */
function pair(
  mainSteps: Step[],
  workerSteps: Step[],
  wakeMs: number,
): { main: Agent; worker: Agent; mainModel: ScriptedModel; workerModel: ScriptedModel } {
  const shared = storage()
  const holder: { main?: Agent; worker?: Agent } = {}
  const mainModel = scriptedModel(mainSteps)
  const workerModel = scriptedModel(workerSteps)
  const worker = defineHarnessAgent({
    model: workerModel,
    contextWindow: 100_000,
    storage: shared,
    logger: silent,
    inbox: { pollMs: 20 },
    tools: { sleep: sleepTool({ timezone: 'UTC', now: shortly(1, wakeMs) }) } as never,
    plugins: [
      subagent({
        agents: {},
        approvals: 'park',
        parentAgent: () => holder.main as Agent,
        selfAgent: () => holder.worker as Agent,
      }),
    ] as never,
  }) as Agent
  holder.worker = worker
  const main = defineHarnessAgent({
    model: mainModel,
    contextWindow: 100_000,
    storage: shared,
    logger: silent,
    inbox: { pollMs: 20 },
    plugins: [
      subagent({
        agents: { worker: { agent: worker, description: 'does work' } },
        approvals: 'park',
        background: true,
        selfAgent: () => holder.main as Agent,
      }),
    ] as never,
  }) as Agent
  holder.main = main
  return { main, worker, mainModel, workerModel }
}
