/**
 * `close({ inFlight: 'interrupt' })` (spec 05 §1, P62 E1): a graceful stop leaves a running turn
 * exactly as `session.recover()` leaves a crashed one (§9.2).
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { uuidv7 } from '../messages/ids.ts'
import { INTERRUPTED_CRASH } from '../messages/texts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { normalizeVolatile, spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function holdingAgent(storage: { messages: unknown; state: unknown }, lock?: unknown) {
  let started!: () => void
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const hold = tool({
    inputSchema: z.object({ amount: z.number() }),
    execute: () =>
      new Promise<string>(() => {
        started()
      }),
  })
  const agent = defineHarnessAgent({
    model: scriptedModel([
      {
        text: 'Charging now.',
        toolCalls: [{ toolName: 'hold', input: { amount: 5 }, toolCallId: 'c1' }],
      },
    ]),
    contextWindow: 100_000,
    tools: { hold },
    storage: storage as never,
    ...(lock === undefined ? {} : { lock }),
    logger: silent,
  } as never)
  return { agent, toolStarted }
}

/** What the same turn looks like after a crash: the stored shape a dead process leaves. */
async function crashed(): Promise<{
  messages: ReturnType<typeof spyMessages>
  state: ReturnType<typeof spyState>
}> {
  const messages = spyMessages()
  const state = spyState()
  const userId = uuidv7()
  const assistantId = uuidv7()
  const turnId = uuidv7()
  await messages.save('s1', [
    {
      id: userId,
      role: 'user',
      metadata: { eharness: { v: 1, createdAt: 1, turnId } },
      parts: [{ type: 'text', text: 'Charge it.' }],
    } as HarnessUIMessage,
    {
      id: assistantId,
      role: 'assistant',
      metadata: { eharness: { v: 1, createdAt: 2, turnId } },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'Charging now.', state: 'streaming' },
        { type: 'tool-hold', toolCallId: 'c1', state: 'input-available', input: { amount: 5 } },
      ],
    } as unknown as HarnessUIMessage,
  ])
  await state.set('s1', {
    v: 1,
    rev: 1,
    core: {
      activeTurn: {
        turnId,
        kind: 'send',
        messageId: assistantId,
        userMessageId: userId,
        owner: 'srv',
        startedAt: 1,
        heartbeatAt: 1,
      },
    },
    plugins: {},
  })
  const agent = defineHarnessAgent({
    model: scriptedModel([{ text: 'unused' }]),
    contextWindow: 100_000,
    storage: { messages, state },
    recovery: { instanceId: 'srv' },
    logger: silent,
  } as never)
  expect((await agent.session('s1').recover()).recovered).toBe(true)
  await agent.close()
  return { messages, state }
}

const assistantOf = (all: HarnessUIMessage[]): HarnessUIMessage =>
  all.find(
    (m) => m.role === 'assistant' && m.metadata?.eharness?.kind === undefined,
  ) as HarnessUIMessage
const noticeOf = (all: HarnessUIMessage[]): HarnessUIMessage | undefined =>
  all.find((m) => m.metadata?.eharness?.kind === 'eh.notice')

describe('close({ inFlight: "interrupt" })', () => {
  test('leaves the stored turn like session.recover() after a crash', async () => {
    const messages = spyMessages()
    const state = spyState()
    const { agent, toolStarted } = holdingAgent({ messages, state })
    const session = agent.session('s1')
    const run = session.send('Charge it.')
    await toolStarted
    const events: unknown[] = []
    const reader = session.events().getReader()
    const pump = (async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }
    })()
    await session.close({ inFlight: 'interrupt' })
    const result = await run.result
    await pump
    expect(result.stop).toBe('interrupted')

    const after = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const message = assistantOf(after)
    expect(message.metadata?.eharness?.stop).toBe('interrupted')
    expect(message.parts.find((p) => p.type === 'tool-hold')).toMatchObject({
      state: 'output-error',
      errorText: INTERRUPTED_CRASH,
    })
    expect(message.parts.some((p) => (p as { state?: string }).state === 'streaming')).toBe(false)
    const notice = noticeOf(after)
    expect(notice?.parts[0]).toMatchObject({
      data: { level: 'warning', code: 'EH_TURN_INTERRUPTED' },
    })
    expect(notice?.metadata?.eharness?.turnId).toBe(message.metadata?.eharness?.turnId)
    expect(notice?.metadata?.eharness?.parentId).toBe(message.id)
    expect((await state.get('s1'))?.core.activeTurn).toBeUndefined()
    expect(events).toContainEqual({
      type: 'turn-end',
      turnId: result.turnId,
      messageId: message.id,
      stop: 'interrupted',
    })

    // the same shape as the recovery of a crashed turn
    const reference = await crashed()
    const refAfter = (await reference.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    const refMessage = assistantOf(refAfter)
    expect(normalizeVolatile(message.parts)).toEqual(normalizeVolatile(refMessage.parts))
    expect(message.metadata?.eharness?.stop).toBe(refMessage.metadata?.eharness?.stop)
    expect(normalizeVolatile(notice?.parts)).toEqual(normalizeVolatile(noticeOf(refAfter)?.parts))
    expect(Object.keys(notice?.metadata?.eharness ?? {}).sort()).toEqual(
      Object.keys(noticeOf(refAfter)?.metadata?.eharness ?? {}).sort(),
    )
    expect((await reference.state.get('s1'))?.core.activeTurn).toBeUndefined()
  })

  test('the next instance finds nothing to recover and the lock is free', async () => {
    const messages = spyMessages()
    const state = spyState()
    const { agent, toolStarted } = holdingAgent({ messages, state })
    const run = agent.session('s1').send('Charge it.')
    await toolStarted
    await agent.close({ inFlight: 'interrupt' })
    expect((await run.result).stop).toBe('interrupted')
    const next = defineHarnessAgent({
      model: scriptedModel([{ text: 'ok' }]),
      contextWindow: 100_000,
      storage: { messages, state },
      logger: silent,
    } as never)
    expect(await next.session('s1').recover()).toEqual({ recovered: false, reason: 'idle' })
    expect((await next.session('s1').send('again').result).stop).toBe('complete')
    await next.close()
  })

  test('the default still aborts: stop aborted, no notice', async () => {
    const messages = spyMessages()
    const state = spyState()
    const { agent, toolStarted } = holdingAgent({ messages, state })
    const run = agent.session('s1').send('Charge it.')
    await toolStarted
    await agent.close()
    expect((await run.result).stop).toBe('aborted')
    const after = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
    expect(noticeOf(after)).toBeUndefined()
  })

  test('agent.closeSession accepts the option and an idle session is unaffected', async () => {
    const messages = spyMessages()
    const state = spyState()
    const { agent, toolStarted } = holdingAgent({ messages, state })
    await agent.closeSession('nothing', { inFlight: 'interrupt' })
    const run = agent.session('s1').send('Charge it.')
    await toolStarted
    await agent.closeSession('s1', { inFlight: 'interrupt' })
    expect((await run.result).stop).toBe('interrupted')
    await until('idle', async () => true)
    await agent.close({ inFlight: 'interrupt' })
  })
})
