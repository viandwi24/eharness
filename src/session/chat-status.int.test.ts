import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { handleChatRequest } from '../stream/chat-request.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages, spyState } from './int-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function shared() {
  return { messages: spyMessages(), state: spyState() }
}

function agentOn(
  storage: ReturnType<typeof shared>,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  return defineHarnessAgent({ contextWindow: 100_000, storage, logger: silent, ...config })
}

const body = (text: string) => ({
  messages: [{ id: 'u1', role: 'user' as const, parts: [{ type: 'text' as const, text }] }],
})

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('condition not reached')
}

describe('R14: busy() and HTTP status of pre-start failures', () => {
  test('busy() reports local, remote (other instance) and idle', async () => {
    const storage = shared()
    const a = agentOn(storage, { model: scriptedModel([{ text: 'slow', delayMs: 150 }]) })
    const b = agentOn(storage, { model: scriptedModel([{ text: 'x' }]) })
    const sa = a.session('s1')
    const sb = b.session('s1')
    expect(await sa.busy()).toBeNull()
    const run = sa.send('hi')
    await until(async () => (await sa.busy()) !== null)
    expect(await sa.busy()).toEqual({ scope: 'local', turnId: run.turnId })
    await until(async () => (await sb.busy()) !== null)
    const remote = await sb.busy()
    expect(remote?.scope).toBe('remote')
    expect(remote?.turnId).toBe(run.turnId)
    expect(typeof remote?.heartbeatAt).toBe('number')
    await run.result
    expect(await sa.busy()).toBeNull()
    expect(await sb.busy()).toBeNull()
  })

  test('a stale foreign turn is not busy (recovery.staleMs)', async () => {
    const storage = shared()
    const a = agentOn(storage, { model: scriptedModel([{ text: 'slow', delayMs: 100 }]) })
    const b = agentOn(storage, { model: scriptedModel([{ text: 'x' }]), recovery: { staleMs: 1 } })
    const run = a.session('s1').send('hi')
    const sb = b.session('s1')
    await until(async () => (await a.session('s1').busy()) !== null)
    await new Promise((r) => setTimeout(r, 10))
    expect(await sb.busy()).toBeNull()
    await run.result
  })

  test('another instance running the turn answers 409 with a JSON body', async () => {
    const storage = shared()
    const a = agentOn(storage, { model: scriptedModel([{ text: 'slow', delayMs: 150 }]) })
    const b = agentOn(storage, { model: scriptedModel([{ text: 'x' }]) })
    const first = a.session('s1').send('hi')
    await until(async () => (await b.session('s1').busy()) !== null)
    const response = await handleChatRequest(b.session('s1'), body('again')).toHttpResponse()
    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect((await response.json()).error.code).toBe('EH_SESSION_BUSY')
    await first.result
  })

  test('a lock held by another instance answers 409', async () => {
    const storage = shared()
    const agent = agentOn(storage, { model: scriptedModel([{ text: 'x' }]) })
    const session = agent.session('s1', {
      lock: {
        acquire: async () => {
          throw new Error('locked elsewhere')
        },
      },
    })
    const run = handleChatRequest(session, body('hi'))
    expect(await run.accepted).toMatchObject({ code: 'EH_SESSION_BUSY' })
    const response = await run.toHttpResponse()
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('EH_SESSION_BUSY')
    expect(storage.messages.saves).toHaveLength(0)
  })

  test('invalid input answers 400; nothing is persisted', async () => {
    const storage = shared()
    const agent = agentOn(storage, { model: scriptedModel([{ text: 'x' }]) })
    const response = await handleChatRequest(agent.session('s1'), {
      messages: [
        {
          id: 'u1',
          role: 'user',
          parts: [{ type: 'file', mediaType: 'image/png', url: 'javascript:alert(1)' }],
        },
      ],
    }).toHttpResponse()
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('EH_INVALID_INPUT')
    expect(storage.messages.saves).toHaveLength(0)
  })

  test('a successful turn streams with 200; a failure after the stream started stays in-stream', async () => {
    const storage = shared()
    const ok = agentOn(storage, { model: scriptedModel([{ text: 'fine' }]) })
    const good = await handleChatRequest(ok.session('s1'), body('hi')).toHttpResponse()
    expect(good.status).toBe(200)
    expect(await good.text()).toContain('fine')

    const failing = agentOn(shared(), {
      model: scriptedModel([{ streamError: new Error('provider down') }]),
    })
    const run = handleChatRequest(failing.session('s2'), body('hi'))
    expect(await run.accepted).toBeUndefined()
    const response = await run.toHttpResponse()
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"error"')
    expect((await run.result).stop).toBe('error')
  })

  test('toHttpResponse of the in-process busy run keeps 409', async () => {
    const agent = agentOn(shared(), { model: scriptedModel([{ text: 'slow', delayMs: 50 }]) })
    const session = agent.session('s1')
    const first = session.send('hi')
    const response = await handleChatRequest(session, body('again')).toHttpResponse()
    expect(response.status).toBe(409)
    await first.result
  })
})

describe('R16: cumulative usage in stats()', () => {
  test('stats().usage sums finished turns', async () => {
    const agent = agentOn(shared(), {
      model: scriptedModel([{ text: 'a' }, { text: 'b' }]),
    })
    const session = agent.session('s1')
    expect((await session.stats()).usage).toEqual({ inputTokens: 0, outputTokens: 0, turns: 0 })
    const one = await session.send('one').result
    const two = await session.send('two').result
    const usage = (await session.stats()).usage
    expect(usage.turns).toBe(2)
    expect(usage.inputTokens).toBe((one.usage.inputTokens ?? 0) + (two.usage.inputTokens ?? 0))
    expect(usage.outputTokens).toBe((one.usage.outputTokens ?? 0) + (two.usage.outputTokens ?? 0))
  })
})
