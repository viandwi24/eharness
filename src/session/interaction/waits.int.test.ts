/**
 * External waits (spec 11 §4.2, ADR-0027): two agent instances share one message store, one state
 * store and one `memoryInbox()`. A turn parks on an `externalTool()`; the result (or a timeout)
 * arrives in another instance and continues the same assistant message.
 */
import { describe, expect, test } from 'bun:test'
import { tool, type UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { InboxAdapter, SessionEvent } from '../../agent/session-types.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../../errors.ts'
import {
  INTERRUPTED_CRASH,
  WAIT_CANCELLED_NEW_INPUT,
  WAIT_TIMED_OUT,
} from '../../messages/texts.ts'
import type { HarnessUIMessage, PendingState } from '../../messages/types.ts'
import { externalTool } from '../../registry/external.ts'
import { memoryInbox } from '../../storage/memory.ts'
import { scriptedModel } from '../../testing/scripted-model.ts'
import { collect, spyMessages, spyState } from '../int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(3)
  }
}

type Storage = {
  messages: ReturnType<typeof spyMessages>
  state: ReturnType<typeof spyState>
  inbox?: InboxAdapter
}

function storage(options: { inbox?: boolean } = {}): Storage {
  return {
    messages: spyMessages(),
    state: spyState(),
    ...(options.inbox === true ? { inbox: memoryInbox() } : {}),
  }
}

/** One agent instance on shared storage. */
function instance(
  shared: Storage,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: {
      messages: shared.messages,
      state: shared.state,
      ...(shared.inbox === undefined ? {} : { inbox: shared.inbox }),
    },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
    ...(shared.inbox === undefined ? {} : { inbox: { pollMs: 10, ...config.inbox } }),
  })
  return { agent, warnings }
}

async function stored(shared: Storage): Promise<HarnessUIMessage[]> {
  return (await shared.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
}

async function pendingOf(shared: Storage): Promise<PendingState | undefined> {
  return (await shared.state.get('s1'))?.core.pending as PendingState | undefined
}

function toolPart(message: HarnessUIMessage | undefined, name: string) {
  return message?.parts.find((p) => p.type === `tool-${name}`) as
    | { state: string; output?: unknown; errorText?: string; toolCallId: string }
    | undefined
}

function build(starts: Array<{ waitId: string; input: unknown }> = [], extra = {}) {
  return externalTool({
    description: 'Run a build and wait for the result',
    inputSchema: z.object({ ref: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    start: ({ ref }, { waitId }) => {
      starts.push({ waitId, input: { ref } })
      return { correlationId: `ci-${ref}`, payload: { ref } }
    },
    ...extra,
  })
}

const waitFor = 'w_call-0-0'

describe('external waits: park and resolve', () => {
  test('park → tool-pending with externals; a second instance resolves and continues the same message', async () => {
    const shared = storage()
    const starts: Array<{ waitId: string; input: unknown }> = []
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'main' } }] },
      { text: 'the build passed' },
    ])
    const a = instance(shared, { model, tools: { build: build(starts) } })
    const first = await a.agent.session('s1').send('build main').result
    expect(first.stop).toBe('tool-pending')
    const pending = first.pending as PendingState
    expect(pending.v).toBe(2)
    expect(pending.clientTools).toEqual([])
    expect(pending.externals).toEqual([
      {
        waitId: waitFor,
        toolCallId: 'call-0-0',
        toolName: 'build',
        correlationId: 'ci-main',
        payload: { ref: 'main' },
        onTimeout: { errorText: WAIT_TIMED_OUT },
        started: true,
        parkedAt: expect.any(Number),
      },
    ])
    expect(starts).toEqual([{ waitId: waitFor, input: { ref: 'main' } }])
    expect(await pendingOf(shared)).toEqual(pending)
    // the parked call stays as it is in the stored message
    const parked = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(parked, 'build')?.state).toBe('input-available')

    const b = instance(shared, { model, tools: { build: build(starts) } })
    const sessionB = b.agent.session('s1')
    expect(await sessionB.pendingWaits()).toEqual(pending.externals ?? [])
    const resolved = await sessionB.resolveWait(waitFor, { output: { ok: true } })
    expect(resolved.status).toBe('continued')
    if (resolved.status !== 'continued') throw new Error('unreachable')
    const chunks = await collect<UIMessageChunk>(resolved.run.stream)
    const result = await resolved.run.result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
    expect(chunks.some((c) => c.type === 'tool-output-available')).toBe(true)
    expect(starts).toHaveLength(1) // start never runs again
    expect(await pendingOf(shared)).toBeUndefined()

    // stored order = model order, also after a cold reload
    const messages = await stored(shared)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const part = toolPart(messages[1], 'build')
    expect(part?.state).toBe('output-available')
    expect(part?.output).toEqual({ ok: true })
    const second = JSON.stringify(model.prompts[1])
    expect(second).toContain('"ok":true')

    const coldModel = scriptedModel([{ text: 'next' }])
    const c = instance(shared, { model: coldModel, tools: { build: build() } })
    await c.agent.session('s1').send('and now?').result
    const warm = model.prompts[1] ?? []
    const cold = coldModel.prompts[0] ?? []
    expect(cold.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    expect(JSON.stringify(cold.slice(0, 3))).toBe(JSON.stringify(warm.slice(0, 3)))
  })

  test('the instance that parked keeps working after another instance resolved the wait', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'passed' },
      { text: 'you are welcome' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    const holder = a.agent.session('s1')
    await holder.send('go').result
    const other = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    const resolved = await other.resolveWait(waitFor, { output: { ok: true } })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    await resolved.run.result
    // the holder's cache still says "pending": it reloads the state and the patched message
    const next = await holder.send('thanks').result
    expect(next.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[2])).toContain('"ok":true')
  })

  test('two parallel waits: the first is recorded, the second continues', async () => {
    const shared = storage()
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'build', input: { ref: 'a' } },
          { toolName: 'build', input: { ref: 'b' } },
        ],
      },
      { text: 'both done' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    const first = await a.agent.session('s1').send('two builds').result
    expect(first.pending?.externals?.map((e) => e.waitId)).toEqual(['w_call-0-0', 'w_call-0-1'])
    const b = instance(shared, { model, tools: { build: build() } })
    const session = b.agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    void (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        events.push(next.value)
      }
    })()
    const one = await session.resolveWait('w_call-0-1', { output: { ok: false } })
    expect(one).toEqual({ status: 'recorded', remaining: 1 })
    expect(model.calls).toHaveLength(1) // nothing continued yet
    const stateAfterOne = await pendingOf(shared)
    expect(stateAfterOne?.externals?.[1]?.result).toEqual({ output: { ok: false }, by: 'result' })
    const two = await session.resolveWait('w_call-0-0', { output: { ok: true } })
    expect(two.status).toBe('continued')
    if (two.status !== 'continued') throw new Error('unreachable')
    const result = await two.run.result
    expect(result.stop).toBe('complete')
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    const parts = (message?.parts ?? []).filter((p) => p.type === 'tool-build') as Array<{
      output: unknown
    }>
    expect(parts.map((p) => p.output)).toEqual([{ ok: true }, { ok: false }])
    expect(events.filter((e) => e.type === 'wait-resolved')).toEqual([
      { type: 'wait-resolved', waitId: 'w_call-0-1', by: 'result' },
      { type: 'wait-resolved', waitId: 'w_call-0-0', by: 'result' },
    ])
  })

  test('a wait next to an approval: results are recorded, respond({ approvals }) continues with both', async () => {
    const shared = storage()
    const paid: string[] = []
    const pay = tool({
      description: 'Pay',
      inputSchema: z.object({ amount: z.number() }),
      execute: ({ amount }) => {
        paid.push(`pay:${amount}`)
        return `paid ${amount}`
      },
    })
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'build', input: { ref: 'a' } },
          { toolName: 'pay', input: { amount: 5 } },
        ],
      },
      { text: 'done' },
    ])
    const config = {
      model,
      tools: { build: build(), pay },
      approval: { policy: { pay: 'user-approval' as const } },
    }
    const a = instance(shared, config)
    const first = await a.agent.session('s1').send('go').result
    expect(first.pending?.approvals).toHaveLength(1)
    expect(first.pending?.externals).toHaveLength(1)
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const b = instance(shared, config)
    const session = b.agent.session('s1')
    expect(await session.resolveWait(waitFor, { output: { ok: true } })).toEqual({
      status: 'recorded',
      remaining: 1,
    })
    // answering the approval alone is enough once the wait is recorded
    const run = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(paid).toEqual(['pay:5'])
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.output).toEqual({ ok: true })
    expect(toolPart(message, 'pay')?.state).toBe('output-available')
  })

  test('respond({ externals }) answers an open wait together with the rest', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'ok' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    const session = a.agent.session('s1')
    const first = await session.send('go').result
    const run = session.respond({ externals: [{ waitId: waitFor, output: { ok: true } }] })
    const result = await run.result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
  })
})

describe('external waits: idempotency and races', () => {
  test('a duplicate result is already-resolved; an unknown wait and a consumed state are not-pending', async () => {
    const shared = storage()
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'build', input: { ref: 'a' } },
          { toolName: 'build', input: { ref: 'b' } },
        ],
      },
      { text: 'done' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    await a.agent.session('s1').send('go').result
    const session = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    expect((await session.resolveWait('w_call-0-0', { output: { ok: true } })).status).toBe(
      'recorded',
    )
    // the same result again, and a different one: the first result wins
    expect(await session.resolveWait('w_call-0-0', { output: { ok: true } })).toEqual({
      status: 'already-resolved',
    })
    expect(await session.resolveWait('w_call-0-0', { output: { ok: false } })).toEqual({
      status: 'already-resolved',
    })
    expect(await session.resolveWait('w_nope', { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
    const last = await session.resolveWait('w_call-0-1', { errorText: 'build failed' })
    expect(last.status).toBe('continued')
    if (last.status !== 'continued') throw new Error('unreachable')
    await last.run.result
    // the pending state was consumed
    expect(await session.resolveWait('w_call-0-1', { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
    expect(model.calls).toHaveLength(2) // one continuation, never two
  })

  test('a result after a timeout is already-resolved', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'timed out' },
    ])
    const tools = { build: build([], { timeoutMs: 20 }) }
    const a = instance(shared, { model, tools })
    const session = a.agent.session('s1')
    await session.send('go').result
    const swept = await session.expireWaits(Date.now() + 1_000)
    expect(swept.expired).toEqual([waitFor])
    await swept.run?.result
    expect(await session.resolveWait(waitFor, { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
  })

  test('a result racing a timeout across two instances: exactly one wins, one continuation', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'raced' },
      { text: 'must not run' },
    ])
    const tools = { build: build([], { timeoutMs: 5 }) }
    const first = await instance(shared, { model, tools }).agent.session('s1').send('go').result
    const sa = instance(shared, { model, tools }).agent.session('s1')
    const sb = instance(shared, { model, tools }).agent.session('s1')
    const [resolved, expired] = await Promise.allSettled([
      sa.resolveWait(waitFor, { output: { ok: true } }),
      sb.expireWaits(Date.now() + 10_000),
    ])
    const runs: Array<Promise<unknown>> = []
    let winners = 0
    if (resolved.status === 'fulfilled' && resolved.value.status === 'continued') {
      winners++
      runs.push(resolved.value.run.result)
    }
    if (expired.status === 'fulfilled' && expired.value.expired.length > 0) winners++
    if (expired.status === 'fulfilled' && expired.value.run !== undefined) {
      runs.push(expired.value.run.result)
    }
    await Promise.all(runs)
    expect(winners).toBe(1)
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    const part = toolPart(message, 'build')
    expect(['output-available', 'output-error']).toContain(part?.state as string)
    expect(model.calls.length).toBeLessThanOrEqual(2)
    expect(await pendingOf(shared)).toBeUndefined()
  })

  test('an invalid result is EH_INVALID_INPUT invalid-result and nothing is stored', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'ok' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    await a.agent.session('s1').send('go').result
    const session = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    const error = await session.resolveWait(waitFor, { output: { ok: 'yes' } }).catch((e) => e)
    expect(isHarnessError(error, 'EH_INVALID_INPUT')).toBe(true)
    expect((error as { details?: { reason?: string } }).details?.reason).toBe('invalid-result')
    expect((await pendingOf(shared))?.externals?.[0]?.result).toBeUndefined()
    // an errorText result is not schema-checked
    expect((await session.resolveWait(waitFor, { errorText: 'failed' })).status).toBe('continued')
  })

  test('replaying a recorded resolution after the continuation is a no-op', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'ok' },
    ])
    await instance(shared, { model, tools: { build: build() } })
      .agent.session('s1')
      .send('go').result
    const s = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    const first = await s.resolveWait(waitFor, { output: { ok: true } })
    if (first.status !== 'continued') throw new Error('expected a continuation')
    await first.run.result
    const before = JSON.stringify(await stored(shared))
    expect(await s.resolveWait(waitFor, { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
    expect(JSON.stringify(await stored(shared))).toBe(before)
  })
})

describe('external waits: kinds are enforced', () => {
  test('respond({ toolOutputs }) for an external call is wrong-kind; handleChatRequest ignores it', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'never' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    const session = a.agent.session('s1')
    const first = await session.send('go').result
    const wrong = await session.respond({
      toolOutputs: [{ toolCallId: 'call-0-0', output: { ok: true } }],
    }).result
    expect(wrong.stop).toBe('error')
    expect(wrong.error?.code).toBe('EH_INVALID_INPUT')
    expect(wrong.error?.details?.reason).toBe('wrong-kind')
    expect((await pendingOf(shared))?.externals).toHaveLength(1)

    // a client message that claims the output is ignored like a non-pending answer: the wait
    // stays open and the request fails as incomplete
    const { handleChatRequest } = await import('../../stream/chat-request.ts')
    const claim = {
      id: first.messageId as string,
      role: 'assistant',
      parts: [
        {
          type: 'tool-build',
          toolCallId: 'call-0-0',
          state: 'output-available',
          input: { ref: 'a' },
          output: { ok: true },
        },
      ],
    }
    const viaChat = await handleChatRequest(session, { id: 's1', messages: [claim] } as never)
      .result
    expect(viaChat.stop).toBe('error')
    expect(viaChat.error?.details?.reason).toBe('incomplete')
    expect((await pendingOf(shared))?.externals?.[0]?.result).toBeUndefined()
    expect(model.calls).toHaveLength(1)
  })
})

describe('external waits: timeouts', () => {
  test('respond({ externals }) is validated against outputSchema before anything is consumed', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'done' },
    ])
    const session = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    await session.send('go').result
    const bad = await session.respond({
      externals: [{ waitId: waitFor, output: { ok: 'NOT A BOOL' } }],
    }).result
    expect(bad.stop).toBe('error')
    expect(bad.error?.code).toBe('EH_INVALID_INPUT')
    expect(bad.error?.details).toMatchObject({ reason: 'invalid-result', waitId: waitFor })
    expect((await pendingOf(shared))?.externals?.[0]?.result).toBeUndefined()
    const good = await session.respond({ externals: [{ waitId: waitFor, output: { ok: true } }] })
      .result
    expect(good.stop).toBe('complete')
  })

  test('an onTimeout output that fails outputSchema falls back to WAIT_TIMED_OUT', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'gave up' },
    ])
    const tools = { build: build([], { timeoutMs: 60_000, onTimeout: { output: { ok: 'nope' } } }) }
    const a = instance(shared, { model, tools })
    const session = a.agent.session('s1')
    const first = await session.send('go').result
    const swept = await session.expireWaits(Date.now() + 120_000)
    expect(swept.expired).toEqual([waitFor])
    await swept.run?.result
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.errorText).toBe(WAIT_TIMED_OUT)
    expect(a.warnings.map((w) => w.code)).toContain('W_HOOK_FAILED')
  })

  test('the live timer of the holding process expires the wait with its onTimeout output', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'handled' },
    ])
    const tools = { build: build([], { timeoutMs: 30, onTimeout: { output: { ok: false } } }) }
    const a = instance(shared, { model, tools })
    const session = a.agent.session('s1')
    const first = await session.send('go').result
    expect(first.pending?.externals?.[0]?.timeoutAt).toBeGreaterThan(Date.now() - 1)
    await until('the continuation ran', async () => model.calls.length === 2)
    await session.idle()
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.output).toEqual({ ok: false })
    expect(await pendingOf(shared)).toBeUndefined()
  })

  test('without onTimeout the model gets WAIT_TIMED_OUT (expireWaits, no inbox)', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'gave up' },
    ])
    const tools = { build: build([], { timeoutMs: 60_000 }) }
    const session = instance(shared, { model, tools }).agent.session('s1')
    const first = await session.send('go').result
    expect(await session.expireWaits(Date.now())).toEqual({ expired: [] }) // not due yet
    const sweeper = instance(shared, { model, tools }).agent.session('s1')
    const swept = await sweeper.expireWaits(Date.now() + 120_000)
    expect(swept.expired).toEqual([waitFor])
    await swept.run?.result
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.state).toBe('output-error')
    expect(toolPart(message, 'build')?.errorText).toBe(WAIT_TIMED_OUT)
  })

  test('a durable wait-timeout inbox item expires the wait in another instance (the holder is gone)', async () => {
    const shared = storage({ inbox: true })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'expired elsewhere' },
    ])
    const tools = { build: build([], { timeoutMs: 80 }) }
    const holder = instance(shared, { model, tools })
    const first = await holder.agent.session('s1').send('go').result
    expect(first.stop).toBe('tool-pending')
    const stats = await shared.inbox?.stats?.({ sessionId: 's1' })
    expect(stats?.delayed).toBe(1) // enqueued at the commit point with availableAt = timeoutAt
    await holder.agent.close() // the holder disappears: no live timer, no drain

    const other = instance(shared, { model, tools })
    const session = other.agent.session('s1')
    await until('the other instance continued the turn', async () => {
      const message = (await stored(shared)).find((m) => m.id === first.messageId)
      return (
        toolPart(message, 'build')?.state === 'output-error' &&
        (await pendingOf(shared)) === undefined
      )
    })
    await session.idle()
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.errorText).toBe(WAIT_TIMED_OUT)
    expect(await shared.inbox?.stats?.({ sessionId: 's1' })).toMatchObject({ ready: 0, delayed: 0 })
  })

  test('a wait-timeout item whose wait is already resolved is acked without effect', async () => {
    const shared = storage({ inbox: true })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'resolved first' },
    ])
    const tools = { build: build([], { timeoutMs: 60 }) }
    const holder = instance(shared, { model, tools })
    const session = holder.agent.session('s1')
    await session.send('go').result
    const resolved = await session.resolveWait(waitFor, { output: { ok: true } })
    if (resolved.status !== 'continued') throw new Error('expected a continuation')
    await resolved.run.result
    await until('the timer item was acked', async () => {
      const stats = await shared.inbox?.stats?.({ sessionId: 's1' })
      return stats?.delayed === 0 && stats.ready === 0 && stats.claimed === 0
    })
    expect(model.calls).toHaveLength(2)
    const message = (await stored(shared)).at(-1)
    expect(toolPart(message, 'build')?.output).toEqual({ ok: true })
  })
})

describe('external waits: new input, crashes, start errors, versions', () => {
  test('new input cancels open waits with WAIT_CANCELLED_NEW_INPUT; a late result is not-pending', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'ok, new topic' },
    ])
    const a = instance(shared, { model, tools: { build: build() } })
    const session = a.agent.session('s1')
    const events: SessionEvent[] = []
    const reader = session.events().getReader()
    void (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return
        events.push(next.value)
      }
    })()
    const first = await session.send('go').result
    const second = await session.send('never mind').result
    expect(second.stop).toBe('complete')
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.state).toBe('output-error')
    expect(toolPart(message, 'build')?.errorText).toBe(WAIT_CANCELLED_NEW_INPUT)
    expect(events).toContainEqual({ type: 'wait-resolved', waitId: waitFor, by: 'cancel' })
    expect(await session.resolveWait(waitFor, { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
  })

  test('a recorded result survives new input (the cancel keeps what was recorded)', async () => {
    const shared = storage()
    const model = scriptedModel([
      {
        toolCalls: [
          { toolName: 'build', input: { ref: 'a' } },
          { toolName: 'build', input: { ref: 'b' } },
        ],
      },
      { text: 'moving on' },
    ])
    const session = instance(shared, { model, tools: { build: build() } }).agent.session('s1')
    const first = await session.send('go').result
    await session.resolveWait('w_call-0-0', { output: { ok: true } })
    await session.send('actually, something else').result
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    const parts = (message?.parts ?? []).filter((p) => p.type === 'tool-build') as Array<{
      state: string
      output?: unknown
      errorText?: string
    }>
    expect(parts[0]).toMatchObject({ state: 'output-available', output: { ok: true } })
    expect(parts[1]).toMatchObject({ state: 'output-error', errorText: WAIT_CANCELLED_NEW_INPUT })
  })

  test('crash between the commit and start: the next instance dispatches start again (same waitId)', async () => {
    const shared = storage()
    const ids: string[] = []
    const flaky = externalTool({
      description: 'The first start never returns',
      inputSchema: z.object({ ref: z.string() }),
      start: (_input, { waitId, abortSignal }) => {
        ids.push(waitId)
        if (ids.length > 1) return { correlationId: 'second' }
        return new Promise<void>((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('process died')))
        })
      },
    })
    const model = scriptedModel([{ toolCalls: [{ toolName: 'flaky', input: { ref: 'a' } }] }])
    const a = instance(shared, { model, tools: { flaky } })
    const run = a.agent.session('s1').send('go')
    await until('start ran', () => ids.length === 1)
    // committed but never started: the "process dies" and another instance opens the session
    expect((await pendingOf(shared))?.externals?.[0]?.started).toBe(false)
    await sleep(25)
    const b = instance(shared, {
      model: scriptedModel([]),
      tools: { flaky },
      recovery: { staleMs: 10 },
    })
    const sessionB = b.agent.session('s1')
    await sessionB.expireWaits() // a sweeper (or any operation that opens the session)
    await until('second start ran', () => ids.length === 2)
    expect(ids).toEqual([waitFor, waitFor])
    await until('outcome stored', async () => (await sessionB.pendingWaits())[0]?.started === true)
    expect((await sessionB.pendingWaits())[0]?.correlationId).toBe('second')
    run.abort('test cleanup')
    await run.result.catch(() => undefined)
  })

  test('a callback that arrives from start is recorded: the pending state is committed first', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'done' },
    ])
    let early: unknown
    const other = instance(shared, { model, tools: { build: build() } })
    const a = instance(shared, {
      model,
      tools: {
        build: build([], {
          start: async (_i: unknown, e: { waitId: string }) => {
            try {
              early = await other.agent
                .session('s1')
                .resolveWait(e.waitId, { output: { ok: true } })
            } catch (error) {
              early = error
            }
          },
        }),
      },
    })
    const first = await a.agent.session('s1').send('go').result
    expect(first.stop).toBe('tool-pending')
    // the other instance found the committed wait: its result was recorded and it continued
    const outcome = early as { status?: string; run?: { result: Promise<{ stop: string }> } }
    expect(outcome.status).toBe('continued')
    const done = (await (outcome.run as NonNullable<typeof outcome.run>).result) as {
      stop: string
      error?: unknown
    }
    expect(done.error).toBeUndefined()
    expect(done.stop).toBe('complete')
  })

  test('a result recorded by an instance that died before continuing: the next operation continues', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'picked up' },
    ])
    const tools = { build: build() }
    const first = await instance(shared, { model, tools }).agent.session('s1').send('go').result
    // the recording instance wrote the result and died before its continuation committed
    const snapshot = await shared.state.get('s1')
    const pending = snapshot?.core.pending as PendingState
    const entry = pending.externals?.[0]
    if (entry === undefined || snapshot === null) throw new Error('expected a parked wait')
    entry.result = { output: { ok: true }, by: 'result' }
    await shared.state.set('s1', { ...snapshot, rev: snapshot.rev + 1 })
    const session = instance(shared, { model, tools }).agent.session('s1')
    const swept = await session.expireWaits()
    expect(swept.expired).toEqual([])
    expect(swept.run).toBeDefined()
    const result = await swept.run?.result
    expect(result?.stop).toBe('complete')
    expect(result?.messageId).toBe(first.messageId)
    const message = (await stored(shared)).find((m) => m.id === first.messageId)
    expect(toolPart(message, 'build')?.output).toEqual({ ok: true })
  })

  test('a throwing start is W_HOOK_FAILED and the wait stays parked', async () => {
    const shared = storage()
    const broken = externalTool({
      description: 'Cannot start',
      inputSchema: z.object({ ref: z.string() }),
      start: () => {
        throw new Error('ci is down')
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'broken', input: { ref: 'a' } }] },
      { text: 'later' },
    ])
    const a = instance(shared, { model, tools: { broken } })
    const first = await a.agent.session('s1').send('go').result
    expect(first.stop).toBe('tool-pending')
    expect(a.warnings.map((w) => w.code)).toContain('W_HOOK_FAILED')
    const entry = (await pendingOf(shared))?.externals?.[0]
    expect(entry?.started).toBe(true)
    expect(entry?.result).toBeUndefined()
  })

  test('0.4 pending state (no v, no externals) is still answered by respond()', async () => {
    const shared = storage()
    const client = tool({
      description: 'Ask the browser',
      inputSchema: z.object({ q: z.string() }),
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'client', input: { q: 'where?' } }] },
      { text: 'thanks' },
    ])
    const session = instance(shared, { model, tools: { client } }).agent.session('s1')
    const first = await session.send('ask').result
    const snapshot = await shared.state.get('s1')
    if (snapshot === null) throw new Error('expected state')
    const legacy = snapshot.core.pending as PendingState
    delete legacy.v
    await shared.state.set('s1', { ...snapshot, rev: snapshot.rev + 1 })
    const other = instance(shared, { model, tools: { client } }).agent.session('s1')
    const result = await other.respond({
      toolOutputs: [
        { toolCallId: first.pending?.clientTools[0]?.toolCallId as string, output: 'here' },
      ],
    }).result
    expect(result.stop).toBe('complete')
  })

  test('an unknown pending version authorizes nothing', async () => {
    const shared = storage()
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
      { text: 'never' },
    ])
    const tools = { build: build() }
    await instance(shared, { model, tools }).agent.session('s1').send('go').result
    const snapshot = await shared.state.get('s1')
    if (snapshot === null) throw new Error('expected state')
    ;(snapshot.core.pending as PendingState).v = 99
    await shared.state.set('s1', { ...snapshot, rev: snapshot.rev + 1 })
    const session = instance(shared, { model, tools }).agent.session('s1')
    expect(await session.resolveWait(waitFor, { output: { ok: true } })).toEqual({
      status: 'not-pending',
    })
    expect(await session.pendingWaits()).toEqual([])
    const refused = await session.respond({
      externals: [{ waitId: waitFor, output: { ok: true } }],
    }).result
    expect(refused.stop).toBe('error')
    expect(refused.error?.details?.reason).toBe('stale')
    expect(model.calls).toHaveLength(1)
  })
})
