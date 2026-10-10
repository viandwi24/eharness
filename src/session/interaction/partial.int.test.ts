import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import type { HarnessUIMessage, PendingState } from '../../messages/types.ts'
import { scriptedModel } from '../../testing/scripted-model.ts'
import { collect, spyMessages, spyState } from '../int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function instance(
  shared: { messages: ReturnType<typeof spyMessages>; state: ReturnType<typeof spyState> },
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  return defineHarnessAgent({
    contextWindow: 100_000,
    storage: shared,
    logger: silent,
    ...config,
  })
}

function setup(withClient = false) {
  const log: string[] = []
  const mk = (name: string) =>
    tool({
      description: name,
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        log.push(`${name}:${n}`)
        return `${name} ${n}`
      },
    })
  const tools: Record<string, ReturnType<typeof mk>> = { fetch: mk('fetch'), search: mk('search') }
  if (withClient) {
    ;(tools as Record<string, unknown>).ask = tool({
      description: 'ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
  }
  const shared = { messages: spyMessages(), state: spyState() }
  const calls = [
    { toolName: 'fetch', input: { n: 1 } },
    { toolName: 'search', input: { n: 2 } },
    ...(withClient ? [{ toolName: 'ask', input: { q: 'x' } }] : []),
  ]
  const config = (script: Parameters<typeof scriptedModel>[0]) => ({
    model: scriptedModel(script),
    tools,
    approval: { policy: { fetch: 'user-approval' as const, search: 'user-approval' as const } },
  })
  return { log, shared, calls, config }
}

const ids = (p: PendingState | undefined): string[] => (p?.approvals ?? []).map((x) => x.approvalId)

const pendingOf = async (shared: ReturnType<typeof setup>['shared']) =>
  (await shared.state.get('s1'))?.core.pending as PendingState | undefined

describe('partial resolution of pending approvals (ADR-0044)', () => {
  test('two parallel approvals answered one by one on one instance', async () => {
    const { log, shared, calls, config } = setup()
    const model = scriptedModel([{ toolCalls: calls }, { text: 'done' }])
    const agent = instance(shared, { ...config([]), model })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.pending?.approvals).toHaveLength(2)
    const [a, b] = ids(first.pending)

    const one = await session.respond({ approvals: [{ id: a as string, approved: true }] }).result
    expect(one.stop).toBe('tool-pending')
    expect(one.partial).toBe(true)
    expect(one.messageId).toBeUndefined()
    expect(one.pending?.approvals.find((x) => x.approvalId === a)?.answer?.approved).toBe(true)
    expect(one.pending?.approvals.find((x) => x.approvalId === b)?.answer).toBeUndefined()
    expect(log).toEqual([])
    expect(model.calls).toHaveLength(1)
    expect((await pendingOf(shared))?.approvals[0]?.answer?.approved).toBe(true)
    expect((await session.stats()).pending?.approvals[0]?.answer?.approved).toBe(true)

    // an identical repeat is a no-op
    const again = await session.respond({ approvals: [{ id: a as string, approved: true }] }).result
    expect(again.partial).toBe(true)

    const run = session.respond({ approvals: [{ id: b as string, approved: false, reason: 'no' }] })
    const chunks = await collect(run.stream)
    const last = await run.result
    expect(last.stop).toBe('complete')
    expect(last.partial).toBeUndefined()
    expect(last.messageId).toBe(first.messageId)
    expect(log).toEqual(['fetch:1'])
    const responses = chunks.filter((c) => c.type === 'tool-approval-response') as Array<{
      approved: boolean
    }>
    expect(responses.map((c) => c.approved).sort()).toEqual([false, true])
    expect(await pendingOf(shared)).toBeUndefined()
    const stored = (await shared.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(stored.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  test('answers from two instances sharing storage; the last one continues', async () => {
    const { log, shared, calls, config } = setup()
    const a = instance(shared, { ...config([]), model: scriptedModel([{ toolCalls: calls }]) })
    const b = instance(shared, { ...config([]), model: scriptedModel([{ text: 'done' }]) })
    const first = await a.session('s1').send('go').result
    const [x, y] = ids(first.pending)

    const r1 = await a.session('s1').respond({ approvals: [{ id: x as string, approved: true }] })
      .result
    expect(r1.partial).toBe(true)
    const r2 = await b.session('s1').respond({ approvals: [{ id: y as string, approved: true }] })
      .result
    expect(r2.stop).toBe('complete')
    expect(r2.messageId).toBe(first.messageId)
    expect(log.sort()).toEqual(['fetch:1', 'search:2'])
    expect(await pendingOf(shared)).toBeUndefined()
  })

  test('a conflicting re-answer is rejected and records nothing', async () => {
    const { shared, calls, config } = setup()
    const agent = instance(shared, {
      ...config([]),
      model: scriptedModel([{ toolCalls: calls }, { text: 'done' }]),
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    const [a] = ids(first.pending)
    await session.respond({ approvals: [{ id: a as string, approved: true }] }).result
    const bad = await session.respond({ approvals: [{ id: a as string, approved: false }] }).result
    expect(bad.stop).toBe('error')
    expect(bad.error?.code).toBe('EH_INVALID_INPUT')
    expect(bad.error?.details?.reason).toBe('conflict')
    expect((await pendingOf(shared))?.approvals[0]?.answer?.approved).toBe(true)
  })

  test('approvals and client tool outputs mix across calls', async () => {
    const { log, shared, calls, config } = setup(true)
    const model = scriptedModel([{ toolCalls: calls }, { text: 'done' }])
    const agent = instance(shared, { ...config([]), model })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.pending?.clientTools).toHaveLength(1)
    const approvalIds = ids(first.pending)
    const callId = first.pending?.clientTools[0]?.toolCallId as string

    const r1 = await session.respond({
      approvals: approvalIds.map((id) => ({ id, approved: true })),
    }).result
    expect(r1.partial).toBe(true)
    expect(r1.pending?.approvals.every((x) => x.answer !== undefined)).toBe(true)
    const r2 = await session.respond({
      toolOutputs: [{ toolCallId: callId, output: { ok: true } }],
    }).result
    expect(r2.stop).toBe('complete')
    expect(log.sort()).toEqual(['fetch:1', 'search:2'])
  })

  test('partial answers when nothing is pending, or none at all, still fail', async () => {
    const { shared, calls, config } = setup()
    const agent = instance(shared, {
      ...config([]),
      model: scriptedModel([{ toolCalls: calls }, { text: 'done' }]),
    })
    const session = agent.session('s1')
    const none = await session.respond({ approvals: [{ id: 'x', approved: true }] }).result
    expect(none.error?.details?.reason).toBe('unknown-id')
    await session.send('go').result
    const empty = await session.respond({}).result
    expect(empty.error?.details?.reason).toBe('incomplete')
    const unknown = await session.respond({ approvals: [{ id: 'nope', approved: true }] }).result
    expect(unknown.error?.details?.reason).toBe('unknown-id')
  })
})
