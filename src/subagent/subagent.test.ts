import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessSession,
  type HarnessUIMessage,
  type StateAdapter,
} from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  pendingSubagentApprovals,
  reconcileSubagentWaits,
  SUBAGENT_NO_USER,
  type SubagentApprovalRequest,
  type SubagentsOptions,
  subagentChild,
  subagents,
} from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

type Storage = { messages: ReturnType<typeof memoryMessages>; state: StateAdapter }
const shared = (): Storage => ({ messages: memoryMessages(), state: memoryState() })

// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const danger = (log: string[] = []) =>
  tool({
    description: 'A dangerous action',
    inputSchema: z.object({ what: z.string() }),
    execute: async ({ what }) => {
      log.push(what)
      return `did ${what}`
    },
  })

const spawn = (
  prompt = 'do the thing',
  toolCallId?: string,
  extra: Record<string, unknown> = {},
) => ({
  toolName: 'agent',
  input: { subagent_type: 'worker', description: 'task', prompt, ...extra },
  ...(toolCallId === undefined ? {} : { toolCallId }),
})

/** A child agent that asks to run `danger` and then reports. */
function childAgent(
  storage: Storage,
  opts: { steps?: Parameters<typeof scriptedModel>[0]; log?: string[]; plugins?: unknown[] } = {},
): Agent {
  return defineHarnessAgent({
    model: scriptedModel(
      opts.steps ?? [
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ],
    ),
    contextWindow: 100_000,
    storage,
    logger: silent,
    tools: { danger: danger(opts.log) },
    approval: { policy: { danger: 'user-approval' } },
    plugins: (opts.plugins ?? []) as never,
  }) as Agent
}

function parentAgent(
  storage: Storage,
  worker: Agent,
  options: Partial<SubagentsOptions> & Pick<SubagentsOptions, 'approvals'>,
  steps: Parameters<typeof scriptedModel>[0] = [{ toolCalls: [spawn()] }, { text: 'parent done' }],
  extraPlugins: unknown[] = [],
): Agent {
  return defineHarnessAgent({
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage,
    logger: silent,
    plugins: [
      ...extraPlugins,
      subagents({ agents: { worker: { agent: worker, description: 'does work' } }, ...options }),
    ] as never,
  }) as Agent
}

function agentOutput(messages: HarnessUIMessage[], toolCallId?: string) {
  for (const message of messages.toReversed()) {
    for (const part of message.parts) {
      const p = part as {
        type: string
        toolCallId?: string
        state?: string
        output?: unknown
        errorText?: string
      }
      if (p.type === 'tool-agent' && (toolCallId === undefined || p.toolCallId === toolCallId))
        return p
    }
  }
  return undefined
}

describe("approvals: 'inline'", () => {
  test('approve: the child tool runs, the report comes back, progress and the run part are emitted', async () => {
    const storage = shared()
    const log: string[] = []
    const requests: SubagentApprovalRequest[] = []
    const worker = childAgent(storage, { log })
    const main = parentAgent(storage, worker, {
      approvals: 'inline',
      answer: (request) => {
        requests.push(request)
        return { approved: true }
      },
    })
    const session = main.session('p1')
    const run = session.send('go')
    const chunks: Array<{ type: string; data?: unknown }> = []
    const reading = (async () => {
      for await (const chunk of run.stream) chunks.push(chunk as never)
    })()
    const result = await run.result
    await reading
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['rm'])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ type: 'approval', toolName: 'danger', agent: 'worker' })
    const part = agentOutput(await session.messages())
    expect(part?.output).toBe('child report')
    // progress as preliminary outputs, and a persisted data part with the child id
    expect(
      chunks.some(
        (c) =>
          c.type === 'tool-output-available' &&
          (c as never as { preliminary?: boolean }).preliminary,
      ),
    ).toBe(true)
    const marker = (await session.messages())
      .flatMap((m) => m.parts)
      .filter((p) => (p.type as string) === 'data-subagent.run')
    expect(marker).toHaveLength(1)
    expect(
      (marker[0] as unknown as { data: { sessionId: string; status: string } }).data,
    ).toMatchObject({
      sessionId: 'p1:agent:call-0-0',
      status: 'done',
    })
    // the child session is linked to the parent and closed again
    expect((await session.children()).map((c) => c.sessionId)).toEqual(['p1:agent:call-0-0'])
    // usage of the child counts in the parent turn
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(30)
    await main.close()
  })

  test('deny with feedback: the model of the child reads the reason', async () => {
    const storage = shared()
    const log: string[] = []
    const worker = childAgent(storage, { log })
    const main = parentAgent(storage, worker, {
      approvals: 'inline',
      answer: () => ({ approved: false, reason: 'use a safer command' }),
    })
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(log).toEqual([])
    const child = worker.session('p1:agent:call-0-0')
    const text = JSON.stringify(await child.messages())
    expect(text).toContain('use a safer command')
    await main.close()
  })

  test('a throwing answer denies; a client tool is answered through the same callback', async () => {
    const storage = shared()
    const ask = tool({
      description: 'Ask the user',
      inputSchema: z.object({ q: z.string() }),
    })
    const worker = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'ask', input: { q: 'name?' } }] },
        { text: 'got it' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      tools: { ask },
    }) as Agent
    const requests: SubagentApprovalRequest[] = []
    const main = parentAgent(storage, worker, {
      approvals: 'inline',
      answer: (request) => {
        requests.push(request)
        return { output: 'Ada' }
      },
    })
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(requests[0]).toMatchObject({ type: 'client-tool', toolName: 'ask' })
    expect(JSON.stringify(await worker.session('p1:agent:call-0-0').messages())).toContain('Ada')
    await main.close()
  })

  test('requires an answer callback', () => {
    expect(() =>
      subagents({ agents: {}, approvals: 'inline' } as unknown as SubagentsOptions),
    ).toThrow(/answer/)
  })
})

describe("approvals: 'policy'", () => {
  test('deny (default): the child tool does not run and sees the autonomous-mode reason', async () => {
    const storage = shared()
    const log: string[] = []
    const worker = childAgent(storage, { log })
    const main = parentAgent(storage, worker, { approvals: 'policy' })
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(log).toEqual([])
    expect(JSON.stringify(await worker.session('p1:agent:call-0-0').messages())).toContain(
      SUBAGENT_NO_USER,
    )
    await main.close()
  })

  test('approve: the child tool runs', async () => {
    const storage = shared()
    const log: string[] = []
    const worker = childAgent(storage, { log })
    const main = parentAgent(storage, worker, { approvals: 'policy', policy: 'approve' })
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(log).toEqual(['rm'])
    expect(agentOutput(await session.messages())?.output).toBe('child report')
    await main.close()
  })
})

describe('failures, limits and abort', () => {
  test('a child error becomes an ERROR text for the parent model', async () => {
    const storage = shared()
    const worker = childAgent(storage, { steps: [{ throws: new Error('boom') }] })
    const main = parentAgent(storage, worker, { approvals: 'policy' })
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    const part = agentOutput(await session.messages())
    expect(String(part?.output ?? part?.errorText)).toContain('ERROR: subagent failed')
    await main.close()
  })

  test('parent abort aborts the child', async () => {
    const storage = shared()
    const worker = childAgent(storage, { steps: [{ text: 'slow', delayMs: 400 }] })
    const main = parentAgent(storage, worker, { approvals: 'policy' })
    const session = main.session('p1')
    const run = session.send('go')
    await until('child started', async () => (await session.children()).length > 0)
    await sleep(50)
    session.abort('stop')
    const result = await run.result
    expect(result.stop).toBe('aborted')
    const child = worker.session('p1:agent:call-0-0')
    await until('child aborted', async () => {
      const messages = await child.messages()
      return messages.some(
        (m) =>
          (m.metadata as { eharness?: { stop?: string } } | undefined)?.eharness?.stop ===
          'aborted',
      )
    })
    await main.close()
  })

  test('depth limit: a session at maxDepth has no agent tool', async () => {
    const storage = shared()
    const worker = childAgent(storage, { steps: [{ text: 'x' }] })
    const main = parentAgent(storage, worker, { approvals: 'policy', maxDepth: 1 })
    const root = main.session('root')
    expect(await root.tools().then((t) => t.map((x) => x.name))).toContain('agent')
    const nested = main.session('nested', {
      parent: { sessionId: 'root', turnId: 't', toolCallId: 'c', depth: 1 },
    })
    expect(await nested.tools().then((t) => t.map((x) => x.name))).not.toContain('agent')
    await main.close()
  })

  test('concurrency: at most maxConcurrent children run at once per depth', async () => {
    const storage = shared()
    let running = 0
    let peak = 0
    const worker = defineHarnessAgent({
      model: scriptedModel(
        Array.from({ length: 4 }, () => () => {
          running++
          peak = Math.max(peak, running)
          setTimeout(() => running--, 100)
          return { text: 'ok', delayMs: 20 }
        }),
      ),
      contextWindow: 100_000,
      storage,
      logger: silent,
    }) as Agent
    const main = parentAgent(storage, worker, { approvals: 'policy', maxConcurrent: 2 }, [
      { toolCalls: [spawn('a', 'c1'), spawn('b', 'c2'), spawn('c', 'c3'), spawn('d', 'c4')] },
      { text: 'done' },
    ])
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(peak).toBe(2)
    for (const id of ['c1', 'c2', 'c3', 'c4']) {
      expect(agentOutput(await session.messages(), id)?.output).toBe('ok')
    }
    await main.close()
  })

  test('background: the report is injected into the parent and wakes it', async () => {
    const storage = shared()
    const worker = childAgent(storage, { steps: [{ text: 'bg report', delayMs: 30 }] })
    const main = parentAgent(storage, worker, { approvals: 'policy', background: true }, [
      { toolCalls: [spawn('later', 'cb', { run_in_background: true })] },
      { text: 'started it' },
      { text: 'saw the report' },
    ])
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(String(agentOutput(await session.messages())?.output)).toContain('Started background')
    await until('wake turn finished', async () => {
      const messages = await session.messages()
      return JSON.stringify(messages).includes('saw the report')
    })
    const stored = JSON.stringify(await session.messages())
    expect(stored).toContain('bg report')
    expect(stored).toContain('data-eh.event')
    await main.close()
  })

  test("background is not available with 'park'", () => {
    expect(() => subagents({ agents: {}, approvals: 'park', background: true })).toThrow(/park/)
  })
})

describe("approvals: 'park'", () => {
  /** The parent agent and the worker, wired to each other. */
  function wire(storage: Storage, log: string[], steps?: Parameters<typeof scriptedModel>[0]) {
    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      log,
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' }, steps)
    holder.main = main
    return { main, worker }
  }

  const waitsOf = async (
    session: HarnessSession<never, never> | { pendingWaits(): Promise<unknown[]> },
  ) =>
    (await session.pendingWaits()) as Array<{
      waitId: string
      correlationId?: string
      payload?: { status?: string; pending: { approvals: Array<{ toolName: string }> } }
      result?: unknown
    }>

  test('child stops pending: the parent parks; the child is answered from another instance; the parent continues', async () => {
    const storage = shared()
    const log: string[] = []
    const { main } = wire(storage, log)
    const session = main.session('p1')
    const result = await session.send('go').result
    expect(result.stop).toBe('tool-pending')
    const waits = await waitsOf(session)
    expect(waits).toHaveLength(1)
    const childId = 'p1:agent:call-0-0'
    expect(waits[0]).toMatchObject({ waitId: 'w_call-0-0', correlationId: childId })
    expect(waits[0]?.payload?.status).toBe('waiting')
    expect(waits[0]?.payload?.pending.approvals[0]).toMatchObject({ toolName: 'danger' })
    expect(log).toEqual([])

    // another server instance: its own agents on the same storage
    const holder2: { main?: Agent } = {}
    const worker2 = childAgent(storage, {
      log,
      plugins: [subagentChild({ parent: () => holder2.main as Agent })],
      steps: [
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ],
    })
    const main2 = parentAgent(storage, worker2, { approvals: 'park' }, [{ text: 'parent done' }])
    holder2.main = main2

    // the UI finds the child through the parent
    const found = await pendingSubagentApprovals(main2.session('p1'), worker2)
    expect(found.map((f) => f.sessionId)).toEqual([childId])
    const approvalId = found[0]?.pending.approvals[0]?.approvalId as string

    const childRun = worker2
      .session(childId)
      .respond({ approvals: [{ id: approvalId, approved: true }] })
    expect((await childRun.result).stop).toBe('complete')
    expect(log).toEqual(['rm'])

    // the child's turn.end hook resolved the parent's wait and the parent continued
    await until('parent continued', async () =>
      JSON.stringify(await main2.session('p1').messages()).includes('parent done'),
    )
    const after = agentOutput(await main2.session('p1').messages())
    expect(after?.output).toBe('child report')
    expect(await waitsOf(main2.session('p1'))).toEqual([])
    await main.close()
    await main2.close()
    await worker2.close()
  })

  test('the parent process restarts between: everything is read from storage', async () => {
    const storage = shared()
    const log: string[] = []
    const first = wire(storage, log)
    const result = await first.main.session('p1').send('go').result
    expect(result.stop).toBe('tool-pending')
    await first.main.close()
    await first.worker.close()

    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      log,
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
      steps: [
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' }, [{ text: 'parent done' }])
    holder.main = main
    const childId = 'p1:agent:call-0-0'
    const pending = (await worker.session(childId).stats()).pending
    expect(pending?.approvals).toHaveLength(1)
    const run = worker
      .session(childId)
      .respond({ approvals: [{ id: pending?.approvals[0]?.approvalId as string, approved: true }] })
    expect((await run.result).stop).toBe('complete')
    await until('parent continued', async () =>
      JSON.stringify(await main.session('p1').messages()).includes('parent done'),
    )
    expect(agentOutput(await main.session('p1').messages())?.output).toBe('child report')
    await main.close()
    await worker.close()
  })

  test('a child that finishes without pending resolves the wait right after the parent turn', async () => {
    const storage = shared()
    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      steps: [{ text: 'quick report' }],
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' })
    holder.main = main
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('tool-pending')
    await until('parent continued', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    expect(agentOutput(await session.messages())?.output).toBe('quick report')
    await main.close()
    await worker.close()
  })

  test('a child that fails resolves the wait with an error text', async () => {
    const storage = shared()
    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      steps: [{ throws: new Error('boom') }],
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' })
    holder.main = main
    const session = main.session('p1')
    expect((await session.send('go').result).stop).toBe('tool-pending')
    await until('parent continued', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    const part = agentOutput(await session.messages())
    expect(String(part?.errorText ?? part?.output)).toContain('ERROR: subagent failed')
    await main.close()
    await worker.close()
  })
})

describe('reconcileSubagentWaits (crash between the child finishing and its hook)', () => {
  /** Parks the parent, then finishes the child through an agent WITHOUT the child plugin (the hook never runs). */
  async function crashed(storage: Storage, steps: Parameters<typeof scriptedModel>[0]) {
    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' })
    holder.main = main
    expect((await main.session('p1').send('go').result).stop).toBe('tool-pending')
    await main.close()
    await worker.close()
    const childId = 'p1:agent:call-0-0'
    const bare = childAgent(storage, { steps }) // no subagentChild: no hook
    const pending = (await bare.session(childId).stats()).pending
    const run = bare
      .session(childId)
      .respond({ approvals: [{ id: pending?.approvals[0]?.approvalId as string, approved: true }] })
    await run.result
    await bare.close()
    return childId
  }

  test('resolves the wait from the finished child; the parent continues; idempotent', async () => {
    const storage = shared()
    const childId = await crashed(storage, [
      { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
      { text: 'late report' },
    ])
    const worker = childAgent(storage)
    const main = parentAgent(storage, worker, { approvals: 'park' }, [{ text: 'parent done' }])
    const session = main.session('p1')
    expect(await session.pendingWaits()).toHaveLength(1)
    const opened: string[] = []
    const out = await reconcileSubagentWaits(session, {
      openChild: (id) => {
        opened.push(id)
        return worker.session(id)
      },
    })
    expect(opened).toEqual([childId])
    expect(out).toEqual([{ waitId: 'w_call-0-0', childSessionId: childId, status: 'resolved' }])
    await until('parent continued', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    expect(agentOutput(await session.messages())?.output).toBe('late report')
    // nothing left to resolve
    expect(
      await reconcileSubagentWaits(session, { openChild: (id) => worker.session(id) }),
    ).toEqual([])
    await main.close()
    await worker.close()
  })

  test('a child that is still waiting for its approval is skipped', async () => {
    const storage = shared()
    const holder: { main?: Agent } = {}
    const worker = childAgent(storage, {
      plugins: [subagentChild({ parent: () => holder.main as Agent })],
    })
    const main = parentAgent(storage, worker, { approvals: 'park' })
    holder.main = main
    const session = main.session('p1')
    await session.send('go').result
    const out = await reconcileSubagentWaits(session, { openChild: (id) => worker.session(id) })
    expect(out.map((e) => e.status)).toEqual(['skipped'])
    expect(await session.pendingWaits()).toHaveLength(1)
    await main.close()
    await worker.close()
  })

  test('selfAgent: the wait is healed when the parent session opens', async () => {
    const storage = shared()
    await crashed(storage, [
      { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
      { text: 'late report' },
    ])
    const worker = childAgent(storage)
    const holder: { main?: Agent } = {}
    const main = parentAgent(
      storage,
      worker,
      { approvals: 'park', selfAgent: () => holder.main as Agent },
      [{ text: 'parent done' }],
    )
    holder.main = main
    const session = main.session('p1')
    await session.ready() // opens the session: the hook starts the reconcile
    await until('parent continued', async () =>
      JSON.stringify(await session.messages()).includes('parent done'),
    )
    expect(agentOutput(await session.messages())?.output).toBe('late report')
    await main.close()
    await worker.close()
  })
})
