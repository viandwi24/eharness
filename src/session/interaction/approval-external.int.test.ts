/**
 * Approval x tools without `execute` (spec 11 §3, §4.2, §5, ADR-0027): an `approved` status (policy,
 * risk, hook or grant) of a tool without `execute` means "no human approval needed" - the call
 * parks as its normal kind (external wait or client call). Only `user-approval` produces an
 * approval entry; after the human approved, the call parks the same way.
 */
import { describe, expect, test } from 'bun:test'
import { tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import type { HarnessUIMessage, PendingState } from '../../messages/types.ts'
import { externalTool } from '../../registry/external.ts'
import { scriptedModel } from '../../testing/scripted-model.ts'
import { collect, spyMessages, spyState } from '../int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>) {
  const messages = spyMessages()
  const state = spyState()
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    ...config,
  })
  const stored = async () => (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  const pendingOf = async () => (await state.get('s1'))?.core.pending as PendingState | undefined
  return { agent, stored, pendingOf }
}

const shape = (pending: PendingState | undefined) => ({
  approvals: pending?.approvals.length ?? 0,
  externals: pending?.externals?.length ?? 0,
  clientTools: pending?.clientTools.length ?? 0,
})

function partOf(message: HarnessUIMessage | undefined, name: string) {
  return message?.parts.find((p) => p.type === `tool-${name}`) as
    | { state: string; output?: unknown; approval?: unknown }
    | undefined
}

const ask = (starts: string[] = []) =>
  externalTool({
    description: 'Ask a person',
    inputSchema: z.object({ q: z.string() }),
    start: (_input, { waitId }) => {
      starts.push(waitId)
      return { correlationId: `c-${waitId}` }
    },
  })

const userApproval = () => ({ type: 'user-approval', reason: 'confirm first' }) as never

describe('an approved status of a tool without execute parks it as its normal kind', () => {
  test('policy approved: external tool parks a wait, no approval entry; resolveWait continues', async () => {
    const starts: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'ready?' } }] },
      { text: 'continued' },
    ])
    const { agent, stored, pendingOf } = setup({
      model,
      tools: { ask: ask(starts) },
      approval: { policy: () => 'approved' },
    })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    expect(first.stop).toBe('tool-pending')
    expect(shape(first.pending)).toEqual({ approvals: 0, externals: 1, clientTools: 0 })
    expect(starts).toEqual(['w_call-0-0'])
    expect(shape(await pendingOf())).toEqual({ approvals: 0, externals: 1, clientTools: 0 })
    const parked = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(parked, 'ask')?.state).toBe('input-available')

    const resolved = await session.resolveWait('w_call-0-0', { output: 'yes' })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    const result = await resolved.run.result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
    expect(starts).toHaveLength(1)
    const done = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(done, 'ask')).toMatchObject({ state: 'output-available', output: 'yes' })
    expect(JSON.stringify(model.prompts[1])).toContain('yes')
    expect(await pendingOf()).toBeUndefined()
  })

  test('policy approved: a client tool parks as a client call, no approval entry', async () => {
    const client = tool({
      description: 'Ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'client', input: { q: 'where?' } }] },
      { text: 'thanks' },
    ])
    const { agent, stored } = setup({
      model,
      tools: { client },
      approval: { policy: () => 'approved' },
    })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    expect(first.stop).toBe('tool-pending')
    expect(shape(first.pending)).toEqual({ approvals: 0, externals: 0, clientTools: 1 })
    const parked = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(parked, 'client')?.state).toBe('input-available')
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    const result = await session.respond({ toolOutputs: [{ toolCallId, output: 'here' }] }).result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
    const done = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(done, 'client')).toMatchObject({ state: 'output-available', output: 'here' })
  })

  test('policy denied still denies an external tool', async () => {
    const starts: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'ready?' } }] },
      { text: 'ok, not asking' },
    ])
    const { agent } = setup({
      model,
      tools: { ask: ask(starts) },
      approval: { policy: () => 'denied' },
    })
    const result = await agent.session('s1').send('ask').result
    expect(result.stop).toBe('complete')
    expect(starts).toEqual([])
    expect(model.calls).toHaveLength(2)
  })

  test('mixed batch: the approved server tool runs, the approved external tool parks', async () => {
    let runs = 0
    const run = tool({
      description: 'Run',
      inputSchema: z.object({}),
      execute: async () => {
        runs++
        return 'ran'
      },
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'run', input: {} },
          { toolName: 'ask', input: { q: 'ready?' } },
        ],
      },
      { text: 'both done' },
    ])
    const { agent, stored } = setup({
      model,
      tools: { run, ask: ask() },
      approval: { policy: () => 'approved' },
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.stop).toBe('tool-pending')
    expect(shape(first.pending)).toEqual({ approvals: 0, externals: 1, clientTools: 0 })
    expect(runs).toBe(1)
    const resolved = await session.resolveWait('w_call-0-1', { output: 'yes' })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    expect((await resolved.run.result).stop).toBe('complete')
    expect(runs).toBe(1)
    const done = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(done, 'run')).toMatchObject({ state: 'output-available', output: 'ran' })
    expect(partOf(done, 'ask')).toMatchObject({ state: 'output-available', output: 'yes' })
  })
})

describe('user-approval of an external tool: after approval the call parks a wait', () => {
  test('approve → commit, start, wait registered; resolveWait continues the same message', async () => {
    const starts: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'ready?' } }] },
      { text: 'continued' },
    ])
    const { agent, stored, pendingOf } = setup({
      model,
      tools: { ask: ask(starts) },
      approval: { policy: userApproval },
    })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    expect(first.stop).toBe('tool-pending')
    expect(shape(first.pending)).toEqual({ approvals: 1, externals: 0, clientTools: 0 })
    expect(starts).toEqual([]) // never before the human approved
    const approvalId = first.pending?.approvals[0]?.approvalId as string

    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    const chunks = await collect<UIMessageChunk>(run.stream)
    const second = await run.result
    expect(second.stop).toBe('tool-pending')
    expect(second.messageId).toBe(first.messageId)
    expect(shape(second.pending)).toEqual({ approvals: 0, externals: 1, clientTools: 0 })
    expect(second.pending?.externals?.[0]).toMatchObject({
      waitId: 'w_call-0-0',
      toolName: 'ask',
      started: true,
      correlationId: 'c-w_call-0-0',
    })
    expect(starts).toEqual(['w_call-0-0'])
    expect(model.calls).toHaveLength(1) // no model call until the wait is resolved
    expect(shape(await pendingOf())).toEqual({ approvals: 0, externals: 1, clientTools: 0 })
    expect(chunks.some((c) => c.type === 'tool-input-available')).toBe(true)
    const parked = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(parked, 'ask')?.state).toBe('input-available')

    const resolved = await session.resolveWait('w_call-0-0', { output: 'yes' })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    const third = await resolved.run.result
    expect(third.stop).toBe('complete')
    expect(third.messageId).toBe(first.messageId)
    expect(starts).toHaveLength(1) // start never runs again
    const done = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(done, 'ask')).toMatchObject({ state: 'output-available', output: 'yes' })
    expect(JSON.stringify(done)).not.toContain('Interrupted')
    expect(JSON.stringify(model.prompts[1])).toContain('yes')
  })

  test('deny gives the normal denied result and never starts the wait', async () => {
    const starts: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'ask', input: { q: 'ready?' } }] },
      { text: 'ok, not asking' },
    ])
    const { agent } = setup({
      model,
      tools: { ask: ask(starts) },
      approval: { policy: userApproval },
    })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const second = await session.respond({ approvals: [{ id: approvalId, approved: false }] })
      .result
    expect(second.stop).toBe('complete')
    expect(starts).toEqual([])
    expect(model.calls).toHaveLength(2)
  })

  test('mixed batch: approved server tool + approved external tool; the server tool runs once, after the wait', async () => {
    let runs = 0
    const starts: string[] = []
    const run = tool({
      description: 'Run',
      inputSchema: z.object({}),
      execute: async () => {
        runs++
        return 'ran'
      },
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'run', input: {} },
          { toolName: 'ask', input: { q: 'ready?' } },
        ],
      },
      { text: 'both done' },
    ])
    const { agent, stored } = setup({
      model,
      tools: { run, ask: ask(starts) },
      approval: { policy: userApproval },
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.pending?.approvals).toHaveLength(2)
    const answers = (first.pending as PendingState).approvals.map((a) => ({
      id: a.approvalId,
      approved: true,
    }))
    const second = await session.respond({ approvals: answers }).result
    expect(second.stop).toBe('tool-pending')
    expect(runs).toBe(0)
    expect(starts).toEqual(['w_call-0-1'])
    expect(second.pending?.externals?.map((e) => e.toolName)).toEqual(['ask'])
    const resolved = await session.resolveWait('w_call-0-1', { output: 'yes' })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    const third = await resolved.run.result
    expect(third.stop).toBe('complete')
    expect(runs).toBe(1)
    const done = (await stored()).find((m) => m.id === first.messageId)
    expect(partOf(done, 'run')).toMatchObject({ state: 'output-available', output: 'ran' })
    expect(partOf(done, 'ask')).toMatchObject({ state: 'output-available', output: 'yes' })
  })

  test('a client tool approved by a human parks as a client call', async () => {
    const client = tool({
      description: 'Ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'client', input: { q: 'where?' } }] },
      { text: 'thanks' },
    ])
    const { agent } = setup({ model, tools: { client }, approval: { policy: userApproval } })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const second = await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result
    expect(shape(second.pending)).toEqual({ approvals: 0, externals: 0, clientTools: 1 })
    const toolCallId = second.pending?.clientTools[0]?.toolCallId as string
    const third = await session.respond({ toolOutputs: [{ toolCallId, output: 'here' }] }).result
    expect(third.stop).toBe('complete')
  })
})
