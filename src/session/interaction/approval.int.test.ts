import { describe, expect, test } from 'bun:test'
import { tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { StateAdapter } from '../../agent/session-types.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../../errors.ts'
import { nextId } from '../../messages/ids.ts'
import {
  DENIED_NEW_INPUT,
  INTERRUPTED_CRASH,
  INTERRUPTED_TURN,
  INTERRUPTED_UNKNOWN,
  NOT_EXECUTED_NEW_INPUT,
} from '../../messages/texts.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { definePlugin } from '../../plugin/define-plugin.ts'
import { type ScriptedPrompt, scriptedModel } from '../../testing/scripted-model.ts'
import { chunkTypes, collect, normalizeVolatile, spyMessages, spyState } from '../int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function payTool(log: string[] = [], delayMs = 0) {
  return tool({
    description: 'Pay an amount',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      log.push(`pay:${amount}`)
      return `paid ${amount}`
    },
  })
}

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  storage: { messages?: ReturnType<typeof spyMessages>; state?: StateAdapter } = {},
) {
  const messages = storage.messages ?? spyMessages()
  const state = storage.state ?? spyState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, messages, state, warnings }
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.json`, import.meta.url))
  const actual = JSON.parse(JSON.stringify(value))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (!(await file.exists())) throw new Error(`missing golden ${name}.json (UPDATE_GOLDEN=1)`)
  expect(actual).toEqual(await file.json())
}

function toolPart(message: HarnessUIMessage | undefined, name: string) {
  return message?.parts.find((p) => p.type === `tool-${name}`) as
    | {
        state: string
        approval?: Record<string, unknown>
        output?: unknown
        errorText?: string
        toolCallId: string
      }
    | undefined
}

/** The role/content summary of a provider prompt (for order assertions). */
function roles(prompt: ScriptedPrompt | undefined): string[] {
  return (prompt ?? []).map((m) => m.role)
}

function lastMessage(prompt: ScriptedPrompt | undefined) {
  return prompt?.at(-1)
}

describe('scenario 17: approval → respond → continuation', () => {
  test('approve: same message id, tool runs once before the next model call, golden chunks', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      (call) => {
        log.push('model')
        return { text: `done (${call.prompt.length})` }
      },
    ])
    const { agent, state } = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay 5').result
    expect(first.stop).toBe('tool-pending')
    const pending = first.pending
    if (pending === undefined) throw new Error('expected pending')
    expect((await state.get('s1'))?.core.pending).toEqual(pending)
    const stored = first.messages.find((m) => m.id === first.messageId)
    expect(stored?.metadata?.eharness?.pending).toEqual(pending)
    expect((await session.stats()).pending).toEqual(pending)

    const approvalId = pending.approvals[0]?.approvalId as string
    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    const chunks = await collect<UIMessageChunk>(run.stream)
    const result = await run.result
    expect(result.kind).toBe('respond')
    expect(result.stop).toBe('complete')
    expect(await run.messageId).toBe(first.messageId as string)
    expect(result.messageId).toBe(first.messageId)
    expect(log).toEqual(['pay:5', 'model'])
    await expectGolden('respond-approve.chunks', normalizeVolatile(chunks))
    expect(chunks[0]).toEqual({ type: 'start', messageId: first.messageId as string })
    const types = chunkTypes(chunks)
    expect(types.indexOf('tool-output-available')).toBeGreaterThan(0)
    expect(types.indexOf('tool-output-available')).toBeLessThan(types.indexOf('start-step'))

    const final = result.messages.find((m) => m.id === first.messageId)
    const part = toolPart(final, 'pay')
    expect(part?.state).toBe('output-available')
    expect(part?.output).toBe('paid 5')
    expect(final?.metadata?.eharness?.pending).toBeNull()
    expect(final?.metadata?.eharness?.createdAt).toBe(
      stored?.metadata?.eharness?.createdAt as number,
    )
    expect(final?.metadata?.eharness?.turnId).toBe(stored?.metadata?.eharness?.turnId as string)
    expect(final?.metadata?.eharness?.steps).toBe(2)
    expect(final?.metadata?.eharness?.usage?.outputTokens).toBe(10)
    expect((await state.get('s1'))?.core.pending).toBeUndefined()
    expect((await session.stats()).pending).toBeNull()
    // the model saw the tool result before answering
    const prompt = model.prompts[1]
    expect(JSON.stringify(prompt)).toContain('paid 5')
  })

  test('deny: the model sees execution-denied with the reason; the tool never runs', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'ok, not paying' },
    ])
    const { agent } = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay 5').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const run = session.respond({
      approvals: [{ id: approvalId, approved: false, reason: 'too expensive' }],
    })
    const chunks = await collect<UIMessageChunk>(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(log).toEqual([])
    expect(chunkTypes(chunks)).toContain('tool-output-denied')
    const toolMessage = model.prompts[1]?.find((m) => m.role === 'tool')
    expect(JSON.stringify(toolMessage)).toContain('too expensive')
    const part = toolPart(
      result.messages.find((m) => m.id === first.messageId),
      'pay',
    )
    expect(part?.state).toBe('output-denied')
    expect(part?.approval).toMatchObject({ approved: false, reason: 'too expensive' })
  })

  test('step 0 of a continuation ends with the tool message; reminder and steer from step 1', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { toolCalls: [{ toolName: 'pay', input: { amount: 6 } }] },
      { text: 'done' },
    ])
    const reminders = definePlugin({
      name: 'rem',
      setup: () => ({
        hooks: {
          'step.prepare': () => ({ reminder: 'STEP-REMINDER' }),
        },
      }),
    })
    const { agent } = setup({
      model,
      plugins: [reminders],
      tools: { pay: payTool(log, 30) },
      approval: {
        policy: (o) =>
          (o.toolCall.input as { amount: number }).amount === 5 ? 'user-approval' : 'approved',
      },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    // the approved tool runs for 30ms before step 0's model call: steer meanwhile
    await new Promise((r) => setTimeout(r, 5))
    session.send('also pay 6', { ifBusy: 'steer' })
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['pay:5', 'pay:6'])
    const step0 = model.prompts[1]
    expect(lastMessage(step0)?.role).toBe('tool')
    expect(JSON.stringify(step0)).not.toContain('STEP-REMINDER')
    expect(JSON.stringify(step0)).not.toContain('also pay 6')
    const step1 = model.prompts[2]
    expect(JSON.stringify(step1)).toContain('STEP-REMINDER')
    expect(JSON.stringify(step1)).toContain('also pay 6')
    const final = result.messages.find((m) => m.id === first.messageId)
    expect(final?.parts.some((p) => p.type === 'data-eh.input')).toBe(true)
  })

  test('approval.secret: the patched part keeps its signature and the continuation executes', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'done' },
    ])
    const { agent, messages } = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' }, secret: 'top-secret' },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const before = toolPart(
      first.messages.find((m) => m.id === first.messageId),
      'pay',
    )
    expect(typeof before?.approval?.signature).toBe('string')
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const result = await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['pay:5'])
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    expect(toolPart(stored, 'pay')?.approval?.signature).toBe(before?.approval?.signature)
  })

  test('a refining tool.before runs once (inputSchemaInput survives the merge)', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'done' },
    ])
    const doubling = definePlugin({
      name: 'double',
      setup: () => ({
        hooks: {
          'tool.before': (_ctx, e) => ({
            input: { amount: (e.input as { amount: number }).amount * 2 },
          }),
        },
      }),
    })
    const { agent } = setup({
      model,
      plugins: [doubling],
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const requested = toolPart(
      first.messages.find((m) => m.id === first.messageId),
      'pay',
    )
    expect(requested?.approval?.inputSchemaInput).toEqual({ amount: 5 })
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const result = await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['pay:10'])
  })

  test('a non-deterministic tool.before is caught: the approved call is rejected, not executed', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'done' },
    ])
    let calls = 0
    const drifting = definePlugin({
      name: 'drift',
      setup: () => ({
        hooks: {
          'tool.before': (_ctx, e) => ({
            input: { amount: (e.input as { amount: number }).amount + ++calls },
          }),
        },
      }),
    })
    const { agent } = setup({
      model,
      plugins: [drifting],
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const result = await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result
    expect(log).toEqual([])
    const part = toolPart(
      result.messages.find((m) => m.id === first.messageId),
      'pay',
    )
    expect(part?.state).toBe('output-error')
  })
})

describe('automatic approvals', () => {
  test("policy 'approved' executes each call exactly once across steps", async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 3 } }] },
      { toolCalls: [{ toolName: 'pay', input: { amount: 4 } }] },
      { text: 'done' },
    ])
    const { agent } = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'approved' } },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['pay:3', 'pay:4'])
  })
})

describe('scenario 18: respond() safety', () => {
  async function pendingSession(config: Partial<HarnessAgentConfig> = {}) {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'done' },
      { text: 'again' },
    ])
    const env = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
      ...config,
    })
    const session = env.agent.session('s1')
    const first = await session.send('pay').result
    return { ...env, model, log, session, first }
  }

  test('unknown id, incomplete and stale answers execute nothing', async () => {
    const { session, first, log } = await pendingSession()
    const approvalId = first.pending?.approvals[0]?.approvalId as string

    const unknown = await session.respond({ approvals: [{ id: 'nope', approved: true }] }).result
    expect(unknown.error?.code).toBe('EH_INVALID_INPUT')
    expect(unknown.stop).toBe('error')
    const incomplete = await session.respond({}).result
    expect(incomplete.error?.code).toBe('EH_INVALID_INPUT')
    expect((await session.stats()).pending?.approvals[0]?.approvalId).toBe(approvalId)
    expect(log).toEqual([])
    void incomplete
  })

  test('details.reason tells unknown-id / incomplete / stale apart; a replay finds nothing', async () => {
    const { session, first, log, messages } = await pendingSession()
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const reason = async (run: ReturnType<typeof session.respond>) =>
      (await run.result).error?.details?.reason
    expect(await reason(session.respond({ approvals: [{ id: 'nope', approved: true }] }))).toBe(
      'unknown-id',
    )
    expect(await reason(session.respond({}))).toBe('incomplete')
    // a kind message after the pending message is fine
    await session.inject('eh.event', { name: 'x', text: 'background' })
    expect(log).toEqual([])
    const ok = await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result
    expect(ok.stop).toBe('complete')
    expect(log).toEqual(['pay:5'])
    // replay of the identical request: nothing pending anymore
    const replay = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    expect(await reason(replay)).toBe('unknown-id')
    expect(log).toEqual(['pay:5'])
    void messages
  })

  test('stale: a newer chat message (another writer) rejects the answers', async () => {
    const { session, first, log, messages } = await pendingSession()
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const newest = (await messages.load({ sessionId: 's1' })).at(-1)?.id
    await messages.save('s1', [
      {
        id: nextId(newest),
        role: 'user',
        metadata: { eharness: { v: 1, createdAt: Date.now() } },
        parts: [{ type: 'text', text: 'written elsewhere' }],
      },
    ])
    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    const result = await run.result
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(result.error?.details?.reason).toBe('stale')
    expect(log).toEqual([])
    // nothing was consumed
    expect((await session.stats()).pending?.approvals[0]?.approvalId).toBe(approvalId)
  })

  test('two agent instances with setIf: a concurrent replay is accepted by exactly one', async () => {
    const log: string[] = []
    const messages = spyMessages()
    const state = spyState()
    const config = {
      tools: { pay: payTool(log, 20) },
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const a = setup(
      {
        model: scriptedModel([
          { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
          { text: 'a' },
        ]),
        ...config,
      },
      { messages, state },
    )
    const first = await a.agent.session('s1').send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const b = setup({ model: scriptedModel([{ text: 'b' }]), ...config }, { messages, state })
    const answer = { approvals: [{ id: approvalId, approved: true }] }
    const [ra, rb] = await Promise.all([
      a.agent.session('s1').respond(answer).result,
      b.agent.session('s1').respond(answer).result,
    ])
    const stops = [ra.stop, rb.stop].sort()
    expect(stops).toEqual(['complete', 'error'])
    const failed = ra.stop === 'error' ? ra : rb
    expect(failed.error?.code).toBe('EH_SESSION_BUSY')
    expect(log).toEqual(['pay:5'])
  })

  test('a respond turn killed after consuming: the next send projects INTERRUPTED_UNKNOWN', async () => {
    const log: string[] = []
    const messages = spyMessages()
    const state = spyState()
    const config = {
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' as const } },
      recovery: false as const,
    }
    const a = setup(
      {
        model: scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }]),
        ...config,
      },
      { messages, state },
    )
    const first = await a.agent.session('s1').send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    // simulate the commit point of a respond() whose process died: pending consumed, A' saved
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    const patched = structuredClone(stored)
    const meta = patched.metadata?.eharness as unknown as Record<string, unknown>
    meta.pending = null
    delete meta.stop
    for (const part of patched.parts as Array<Record<string, unknown>>) {
      if (part.type === 'tool-pay') {
        part.state = 'approval-responded'
        part.approval = { ...(part.approval as object), approved: true }
      }
    }
    await messages.save('s1', [patched])
    const snapshot = await state.get('s1')
    if (snapshot === null) throw new Error('no state')
    delete snapshot.core.pending
    await state.set('s1', { ...snapshot, rev: snapshot.rev + 1 })
    void approvalId

    const model = scriptedModel([{ text: 'fine' }])
    const b = setup({ model, ...config }, { messages, state })
    const result = await b.agent.session('s1').send('what happened?').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual([])
    expect(JSON.stringify(model.prompts[0])).toContain(INTERRUPTED_UNKNOWN)
  })
})

describe('scenario 19: onNewInput', () => {
  test("'deny' patches pending parts; the next projection has the denials before the new message", async () => {
    const log: string[] = []
    const client = tool({
      description: 'Ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'pay', input: { amount: 5 } },
          { toolName: 'client', input: { q: 'where?' } },
        ],
      },
      { text: 'ok' },
    ])
    const { agent, state, messages } = setup({
      model,
      tools: { pay: payTool(log), client },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.pending?.approvals).toHaveLength(1)
    expect(first.pending?.clientTools).toHaveLength(1)
    const events: string[] = []
    const reader = session.events().getReader()
    const result = await session.send('never mind').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual([])
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    const pay = toolPart(stored, 'pay')
    expect(pay?.state).toBe('output-denied')
    expect(pay?.approval).toMatchObject({ approved: false, reason: DENIED_NEW_INPUT })
    expect(toolPart(stored, 'client')).toMatchObject({
      state: 'output-error',
      errorText: NOT_EXECUTED_NEW_INPUT,
    })
    expect(stored.metadata?.eharness?.pending).toBeNull()
    expect((await state.get('s1'))?.core.pending).toBeUndefined()
    const prompt = JSON.stringify(model.prompts[1])
    expect(prompt.indexOf(DENIED_NEW_INPUT)).toBeGreaterThan(-1)
    expect(prompt.indexOf(DENIED_NEW_INPUT)).toBeLessThan(prompt.indexOf('never mind'))
    expect(prompt).not.toContain(INTERRUPTED_UNKNOWN)
    await session.close()
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value.type === 'pending' ? `pending:${next.value.pending}` : next.value.type)
    }
    expect(events).toContain('pending:null')
  })

  test("'reject' → EH_PENDING_RESPONSE, nothing persisted", async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }])
    const { agent, messages } = setup({
      model,
      tools: { pay: payTool() },
      approval: { policy: { pay: 'user-approval' }, onNewInput: 'reject' },
    })
    const session = agent.session('s1')
    await session.send('go').result
    const saves = messages.saves.length
    const result = await session.send('something else').result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_PENDING_RESPONSE')
    expect(messages.saves.length).toBe(saves)
    expect((await session.stats()).pending).not.toBeNull()
  })
})

describe('scenario 20: approval combination and grants', () => {
  test('policy approved + hook denied → denied; a throwing policy → denied (fail closed)', async () => {
    const log: string[] = []
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'pay', input: { amount: 1 } },
          { toolName: 'refund', input: { amount: 2 } },
        ],
      },
      { text: 'done' },
    ])
    const refund = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        log.push('refund')
        return 'refunded'
      },
    })
    const guard = definePlugin({
      name: 'guard',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) => (e.toolName === 'pay' ? 'denied' : undefined),
        },
      }),
    })
    const { agent } = setup({
      model,
      plugins: [guard],
      tools: { pay: payTool(log), refund },
      approval: {
        policy: {
          pay: 'approved',
          refund: () => {
            throw new Error('policy exploded')
          },
        },
      },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual([])
    const message = result.messages.find((m) => m.id === result.messageId)
    expect(toolPart(message, 'pay')?.state).toBe('output-denied')
    expect(toolPart(message, 'refund')?.state).toBe('output-denied')
    expect(JSON.stringify(model.prompts[1])).toContain('policy exploded')
  })

  test('an unknown status from a hook or a policy is denied (fail closed)', async () => {
    const log: string[] = []
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'pay', input: { amount: 1 } },
          { toolName: 'refund', input: { amount: 2 } },
        ],
      },
      { text: 'done' },
    ])
    const refund = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        log.push('refund')
        return 'refunded'
      },
    })
    const typo = definePlugin({
      name: 'typo',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) => (e.toolName === 'pay' ? ('deny' as never) : undefined),
        },
      }),
    })
    const { agent } = setup({
      model,
      plugins: [typo],
      tools: { pay: payTool(log), refund },
      approval: { policy: { pay: 'approved', refund: { type: 'nope' } as never } },
    })
    const result = await agent.session('s1').send('go').result
    expect(log).toEqual([])
    const message = result.messages.find((m) => m.id === result.messageId)
    expect(toolPart(message, 'pay')?.state).toBe('output-denied')
    expect(toolPart(message, 'refund')?.state).toBe('output-denied')
  })

  test("remember: 'session' grants apply after step 0, only upgrade user-approval, survive reload", async () => {
    const log: string[] = []
    const messages = spyMessages()
    const state = spyState()
    const limit = definePlugin({
      name: 'limit',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) =>
            (e.input as { amount: number }).amount > 100 ? 'denied' : undefined,
        },
      }),
    })
    const config = {
      tools: { pay: payTool(log) },
      plugins: [limit],
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 1 } }] },
      // step 0 of the continuation: the grant just recorded does not apply yet
      { toolCalls: [{ toolName: 'pay', input: { amount: 2 } }] },
    ])
    const { agent } = setup({ model, ...config }, { messages, state })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const id1 = first.pending?.approvals[0]?.approvalId as string
    const second = await session.respond({
      approvals: [{ id: id1, approved: true, remember: 'session' }],
    }).result
    expect(second.stop).toBe('tool-pending')
    expect(log).toEqual(['pay:1'])
    expect((await state.get('s1'))?.core.grants).toEqual({ pay: 'always' })
    const id2 = second.pending?.approvals[0]?.approvalId as string
    await agent.close()

    // reload: a fresh agent on the same storage still has the grant
    const model2 = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 3 } }] }, // granted: runs without asking
      { toolCalls: [{ toolName: 'pay', input: { amount: 1000 } }] }, // denied by the hook
      { text: 'done' },
    ])
    const env2 = setup({ model: model2, ...config }, { messages, state })
    const session2 = env2.agent.session('s1')
    const third = await session2.respond({ approvals: [{ id: id2, approved: true }] }).result
    expect(third.stop).toBe('complete')
    expect(log).toEqual(['pay:1', 'pay:2', 'pay:3'])
    expect(env2.warnings.map((w) => w.code)).toContain('W_GRANT_IGNORED')
    await session2.clearGrants()
    expect((await state.get('s1'))?.core.grants).toBeUndefined()
  })

  test("a 'never' grant denies later calls", async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 1 } }] },
      { text: 'ok' },
      { toolCalls: [{ toolName: 'pay', input: { amount: 2 } }] },
      { text: 'ok' },
    ])
    const { agent } = setup({
      model,
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const id = first.pending?.approvals[0]?.approvalId as string
    await session.respond({ approvals: [{ id, approved: false, remember: 'session' }] }).result
    const next = await session.send('pay again').result
    expect(next.stop).toBe('complete')
    expect(log).toEqual([])
    expect(
      toolPart(
        next.messages.find((m) => m.id === next.messageId),
        'pay',
      )?.state,
    ).toBe('output-denied')
  })
})

describe('scenario 21: client tools', () => {
  test('respond({ toolOutputs }) continues the message; tool.after and output limits apply', async () => {
    const client = tool({
      description: 'Ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'client', input: { q: 'where?' } }] },
      { text: 'thanks' },
    ])
    const seen: unknown[] = []
    const after = definePlugin({
      name: 'after',
      setup: () => ({
        hooks: {
          'tool.after': (_ctx, e) => {
            seen.push(e.output)
            return { output: `${String(e.output)}!` }
          },
        },
      }),
    })
    const { agent, warnings } = setup({
      model,
      plugins: [after],
      tools: { client },
      toolOutput: { maxChars: 100 },
    })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    expect(first.stop).toBe('tool-pending')
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    const big = 'x'.repeat(500)
    const run = session.respond({ toolOutputs: [{ toolCallId, output: big }] })
    const chunks = await collect<UIMessageChunk>(run.stream)
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
    expect(seen).toEqual([big])
    const types = chunkTypes(chunks)
    expect(chunks[types.indexOf('tool-output-available')]).toMatchObject({ toolCallId })
    expect(types.indexOf('tool-output-available')).toBeLessThan(types.indexOf('start-step'))
    const part = toolPart(
      result.messages.find((m) => m.id === first.messageId),
      'client',
    )
    expect(part?.state).toBe('output-available')
    expect(String(part?.output).length).toBeLessThan(big.length)
    expect(warnings.map((w) => w.code)).toContain('W_TOOL_OUTPUT_LIMITED')
    expect(JSON.stringify(model.prompts[1])).toContain('truncated')
  })

  test('an errorText answer reaches the model as a tool error', async () => {
    const client = tool({ inputSchema: z.object({ q: z.string() }) })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'client', input: { q: 'where?' } }] },
      { text: 'sorry' },
    ])
    const { agent } = setup({ model, tools: { client } })
    const session = agent.session('s1')
    const first = await session.send('ask').result
    const toolCallId = first.pending?.clientTools[0]?.toolCallId as string
    const result = await session.respond({
      toolOutputs: [{ toolCallId, errorText: 'denied by user' }],
    }).result
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('denied by user')
  })
})

describe('reload after respond reproduces the hot wire', () => {
  test('hot next turn and cold next turn send the same prompt', async () => {
    const run = async (reload: boolean) => {
      const messages = spyMessages()
      const state = spyState()
      const model = scriptedModel([
        { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
        { text: 'paid' },
        { text: 'next' },
      ])
      const config = {
        model,
        tools: { pay: payTool() },
        approval: { policy: { pay: 'user-approval' as const } },
      }
      const env = setup(config, { messages, state })
      let session = env.agent.session('s1')
      const first = await session.send('pay').result
      const id = first.pending?.approvals[0]?.approvalId as string
      await session.respond({ approvals: [{ id, approved: true }] }).result
      if (reload) {
        await env.agent.close()
        const env2 = setup(config, { messages, state })
        session = env2.agent.session('s1')
      }
      await session.send('and now?').result
      return model.prompts[2]
    }
    const hot = await run(false)
    const cold = await run(true)
    expect(roles(cold)).toEqual(roles(hot))
    expect(normalizeVolatile(cold)).toEqual(normalizeVolatile(hot))
  })
})

void isHarnessError

describe('continuations that do not finish', () => {
  test('a crash after consuming but before A′ was saved: the pending message is healed', async () => {
    const log: string[] = []
    const messages = spyMessages()
    const state = spyState()
    const config = {
      tools: { pay: payTool(log) },
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const a = setup(
      {
        model: scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }]),
        ...config,
      },
      { messages, state },
    )
    const first = await a.agent.session('s1').send('pay').result
    await a.agent.close()
    // the consuming state write happened, the process died before A' was saved
    const snapshot = await state.get('s1')
    if (snapshot === null) throw new Error('no state')
    delete snapshot.core.pending
    await state.set('s1', { ...snapshot, rev: snapshot.rev + 1 })

    const model = scriptedModel([{ text: 'fine' }])
    const b = setup({ model, ...config }, { messages, state })
    const session = b.agent.session('s1')
    const result = await session.send('what happened?').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual([])
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    expect(stored.metadata?.eharness?.pending).toBeNull()
    expect(stored.metadata?.eharness?.stop).toBe('interrupted')
    expect(toolPart(stored, 'pay')).toMatchObject({
      state: 'output-error',
      errorText: INTERRUPTED_CRASH,
    })
    expect(JSON.stringify(model.prompts[0])).toContain(INTERRUPTED_CRASH)
    expect((await session.stats()).pending).toBeNull()
  })

  test('abort during step 0: approved calls end as interrupted, never re-executed', async () => {
    const log: string[] = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'next' },
    ])
    const { agent, messages } = setup({
      model,
      tools: { pay: payTool(log, 40) },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    await new Promise((r) => setTimeout(r, 10))
    run.abort('stop')
    const chunks = await collect<UIMessageChunk>(run.stream)
    const result = await run.result
    expect(result.stop).toBe('aborted')
    expect(chunks.find((c) => c.type === 'tool-output-error')).toMatchObject({
      toolCallId: 'call-0-0',
      errorText: INTERRUPTED_TURN,
    })
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    expect(toolPart(stored, 'pay')).toMatchObject({
      state: 'output-error',
      errorText: INTERRUPTED_TURN,
    })
    expect(stored.metadata?.eharness?.stop).toBe('aborted')
    await new Promise((r) => setTimeout(r, 50)) // the aborted tool may still finish its sleep
    const before = log.length
    await session.send('status?').result
    expect(log.length).toBe(before)
    expect(log.filter((l) => l === 'pay:5').length).toBeLessThanOrEqual(1)
  })

  test('a continuation whose process died is recovered (INTERRUPTED_CRASH, stop interrupted)', async () => {
    const log: string[] = []
    const messages = spyMessages()
    const shared = spyState()
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const hang = tool({
      description: 'Pay slowly',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        log.push('hang')
        started()
        return new Promise<string>(() => {}) // the process "dies" while this runs
      },
    })
    const stateA = spyState(shared)
    const a = setup(
      {
        model: scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }]),
        tools: { pay: hang },
        approval: { policy: { pay: 'user-approval' } },
        recovery: { staleMs: 40 },
      },
      { messages, state: stateA },
    )
    const first = await a.agent.session('s1').send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    void a.agent.session('s1').respond({ approvals: [{ id: approvalId, approved: true }] })
    await running
    stateA.failWrite = true // no more heartbeats from the dead instance
    await new Promise((r) => setTimeout(r, 80))

    const model = scriptedModel([{ text: 'recovered' }])
    const b = setup(
      { model, tools: { pay: payTool(log) }, recovery: { staleMs: 40 } },
      { messages, state: shared },
    )
    const result = await b.agent.session('s1').send('hello?').result
    expect(result.stop).toBe('complete')
    expect(log).toEqual(['hang'])
    const stored = (await messages.load({ sessionId: 's1' })).find(
      (m) => m.id === first.messageId,
    ) as HarnessUIMessage
    expect(stored.metadata?.eharness?.stop).toBe('interrupted')
    expect(toolPart(stored, 'pay')).toMatchObject({
      state: 'output-error',
      errorText: INTERRUPTED_CRASH,
    })
  })
})

describe('risk, decisions and pending details (spec 11 §3.2–3.3)', () => {
  const deleteTool = () =>
    tool({
      description: 'Delete a record',
      inputSchema: z.object({ id: z.string() }),
      metadata: { risk: 'destructive' },
      execute: async ({ id }) => `deleted ${id}`,
    })
  const readTool = () =>
    tool({
      inputSchema: z.object({ id: z.string() }),
      metadata: { risk: 'read' },
      execute: async ({ id }) => `record ${id}`,
    })

  test('approval.risk asks for destructive tools; pending carries input and risk', async () => {
    const decisions: unknown[] = []
    const audit = definePlugin({
      name: 'audit',
      setup: () => ({ hooks: { 'approval.decided': (_ctx, e) => void decisions.push(e) } }),
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'read', input: { id: 'a' } },
          { toolName: 'remove', input: { id: 'a' } },
        ],
      },
      { text: 'done' },
    ])
    const { agent } = setup({
      model,
      tools: { read: readTool(), remove: deleteTool() },
      plugins: [audit],
      approval: { risk: { read: 'approved', destructive: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('clean up').result
    expect(first.stop).toBe('tool-pending')
    expect(first.pending?.approvals).toEqual([
      expect.objectContaining({ toolName: 'remove', input: { id: 'a' }, risk: 'destructive' }),
    ])
    expect(decisions).toEqual([
      expect.objectContaining({ toolName: 'read', approved: true, by: 'risk', risk: 'read' }),
    ])

    const approvalId = first.pending?.approvals[0]?.approvalId ?? ''
    const second = await session.respond({
      approvals: [
        { id: approvalId, approved: false, reason: 'keep it', actor: { id: 'u-7', name: 'Rina' } },
      ],
    }).result
    expect(second.stop).toBe('complete')
    expect(decisions.at(-1)).toEqual({
      toolName: 'remove',
      toolCallId: expect.any(String),
      input: { id: 'a' },
      risk: 'destructive',
      approved: false,
      by: 'user',
      reason: 'keep it',
      actor: { id: 'u-7', name: 'Rina' },
      approvalId,
    })
  })

  test('unknown covers tools without a risk; MCP destructiveHint counts as destructive', async () => {
    const plain = tool({ inputSchema: z.object({}), execute: async () => 'x' })
    const hinted = tool({
      inputSchema: z.object({}),
      metadata: { annotations: { destructiveHint: true, readOnlyHint: true } },
      execute: async () => 'y',
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'plain', input: {} },
          { toolName: 'hinted', input: {} },
        ],
      },
      { text: 'ok' },
    ])
    const seen: unknown[] = []
    const spy = definePlugin({
      name: 'spy',
      setup: () => ({
        hooks: { 'tool.approve': (_ctx, e) => void seen.push([e.toolName, e.risk]) },
      }),
    })
    const { agent } = setup({
      model,
      tools: { plain, hinted },
      plugins: [spy],
      approval: { risk: { unknown: 'denied', destructive: 'user-approval' } },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.pending?.approvals.map((a) => [a.toolName, a.risk])).toEqual([
      ['hinted', 'destructive'],
    ])
    expect(seen).toEqual([
      ['plain', undefined],
      ['hinted', 'destructive'],
    ])
  })

  test("approval.risk.external asks for an openWorldHint tool; pending carries risk 'external'", async () => {
    const send = tool({
      description: 'Send an email',
      inputSchema: z.object({ to: z.string() }),
      // as @ai-sdk/mcp sets it for a server tool with openWorldHint
      metadata: { annotations: { openWorldHint: true, idempotentHint: true } },
      execute: async ({ to }) => `sent to ${to}`,
    })
    const post = tool({
      inputSchema: z.object({}),
      metadata: { risk: 'external', idempotent: true },
      execute: async () => 'posted',
    })
    const seen: unknown[] = []
    const decisions: unknown[] = []
    const spy = definePlugin({
      name: 'spy',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) => void seen.push([e.toolName, e.risk, e.idempotent, e.hints]),
          'approval.decided': (_ctx, e) => void decisions.push(e),
        },
      }),
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'send', input: { to: 'a@example.com' } },
          { toolName: 'post', input: {} },
        ],
      },
      { text: 'ok' },
    ])
    const { agent, state } = setup({
      model,
      tools: { send, post },
      plugins: [spy],
      approval: { risk: { external: 'user-approval', unknown: 'approved' } },
    })
    const session = agent.session('s1')
    const first = await session.send('go').result
    expect(first.stop).toBe('tool-pending')
    expect(first.pending?.approvals).toEqual([
      expect.objectContaining({ toolName: 'send', risk: 'external' }),
      expect.objectContaining({ toolName: 'post', risk: 'external', idempotent: true }),
    ])
    // idempotentHint never becomes `idempotent`
    expect(first.pending?.approvals[0]).not.toHaveProperty('idempotent')
    expect(seen).toEqual([
      ['send', 'external', undefined, { openWorldHint: true, idempotentHint: true }],
      ['post', 'external', true, undefined],
    ])
    const stored = (await state.get('s1')) as { core?: { pending?: unknown } } | null
    expect(stored?.core?.pending).toMatchObject({
      approvals: [
        { toolName: 'send', risk: 'external' },
        { toolName: 'post', risk: 'external' },
      ],
    })
    const approvals = (first.pending?.approvals ?? []).map((a) => ({
      id: a.approvalId,
      approved: true,
    }))
    const second = await session.respond({ approvals }).result
    expect(second.stop).toBe('complete')
    expect(decisions).toEqual([
      expect.objectContaining({ toolName: 'send', risk: 'external', by: 'user', approved: true }),
      expect.objectContaining({
        toolName: 'post',
        risk: 'external',
        idempotent: true,
        by: 'user',
        approved: true,
      }),
    ])
  })

  test('a risk status never loosens a hook: approval.risk approved + hook denied → denied', async () => {
    const send = tool({
      inputSchema: z.object({}),
      metadata: { annotations: { openWorldHint: true } },
      execute: async () => 'sent',
    })
    const decisions: Array<{ by: string; approved: boolean; risk?: string }> = []
    const guard = definePlugin({
      name: 'guard',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) => (e.risk === 'external' ? 'denied' : undefined),
          'approval.decided': (_ctx, e) =>
            void decisions.push({ by: e.by, approved: e.approved, risk: e.risk }),
        },
      }),
    })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'send', input: {} }] }, { text: 'ok' }])
    const { agent } = setup({
      model,
      tools: { send },
      plugins: [guard],
      approval: { risk: { external: 'approved' } },
    })
    const result = await agent.session('s1').send('go').result
    expect(result.stop).toBe('complete')
    expect(decisions).toEqual([{ by: 'plugin:guard', approved: false, risk: 'external' }])
  })

  test('grant and hook decisions are reported with their source; new input denies with new-input', async () => {
    const decisions: Array<{ by: string; approved: boolean }> = []
    const plugin = definePlugin({
      name: 'guard',
      setup: () => ({
        hooks: {
          'tool.approve': (_ctx, e) =>
            (e.input as { amount: number }).amount > 100 ? 'denied' : undefined,
          'approval.decided': (_ctx, e) => void decisions.push({ by: e.by, approved: e.approved }),
        },
      }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 500 } }] },
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'waiting' },
      { text: 'new topic' },
    ])
    const { agent } = setup({
      model,
      tools: { pay: payTool() },
      plugins: [plugin],
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    expect(first.stop).toBe('tool-pending')
    expect(decisions).toEqual([{ by: 'plugin:guard', approved: false }])
    await session.send('never mind').result
    expect(decisions.at(-1)).toEqual({ by: 'new-input', approved: false })
  })

  test('respond() rejects a malformed actor', async () => {
    const model = scriptedModel([{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }])
    const { agent } = setup({
      model,
      tools: { pay: payTool() },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const id = first.pending?.approvals[0]?.approvalId ?? ''
    const run = session.respond({
      approvals: [{ id, approved: true, actor: { name: 'x' } as never }],
    })
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
  })
})
