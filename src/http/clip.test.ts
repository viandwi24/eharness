import { describe, expect, test } from 'bun:test'
import { type UIMessage, validateUIMessages } from 'ai'
import { isClippedPart } from '../client/chat-helpers.ts'
import { defineHarnessAgent } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { createHarnessHttp, openAccess } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const big = 'x'.repeat(5000)

const tool = (id: string, output: unknown, input: unknown = { q: 1 }) =>
  ({
    type: 'tool-read',
    toolCallId: id,
    state: 'output-available',
    input,
    output,
  }) as never

const seed = [
  { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  {
    id: 'm2',
    role: 'assistant',
    parts: [
      { type: 'text', text: big },
      tool('a', big),
      tool('b', { small: true }),
      tool('c', { rows: [big] }, { huge: big }),
      { type: 'data-snap', data: { v: big } } as never,
    ],
  },
  { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'bye' }] },
] as UIMessage[]

async function setup() {
  const messages = inMemoryMessages()
  await messages.save('s1', seed)
  const agent = defineHarnessAgent({
    model: scriptedModel([]),
    contextWindow: 100_000,
    storage: { messages, state: inMemoryState() },
    logger: silent,
  })
  const http = createHarnessHttp(agent, { authorize: openAccess })
  const get = async (path: string) => http.fetch(new Request(`http://x${path}`))
  return { http, get, messages }
}

describe('clipped reads', () => {
  test('clips tool input/output and data over the limit, keeps small parts identical', async () => {
    const { get } = await setup()
    const plain = (await (await get('/sessions/s1/messages')).json()) as {
      messages: UIMessage[]
    }
    const res = (await (await get('/sessions/s1/messages?clip=1000')).json()) as {
      messages: UIMessage[]
      nextBefore?: string
    }
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(res.messages[0]).toEqual(plain.messages[0] as UIMessage)
    // biome-ignore lint/suspicious/noExplicitAny: loosely typed wire parts
    const parts = res.messages[1]?.parts as unknown as Array<Record<string, any>>
    expect(parts[0]).toEqual({ type: 'text', text: big })
    expect(parts[1]?.state).toBe('output-available')
    expect(parts[1]?.output).toEqual({
      eharnessClipped: true,
      chars: 5000,
      preview: big.slice(0, 1000),
    })
    expect(JSON.stringify(parts[2])).toBe(
      JSON.stringify((plain.messages[1]?.parts as never[] | undefined)?.[2]),
    )
    expect(parts[3]?.output.eharnessClipped).toBe(true)
    expect(parts[3]?.input.eharnessClipped).toBe(true)
    expect(parts[4]?.data.eharnessClipped).toBe(true)
    expect(isClippedPart(parts[1])).toBe(true)
    expect(isClippedPart(parts[2])).toBe(false)
    expect(isClippedPart(parts[0])).toBe(false)
  })

  test('a limit above every payload changes nothing; storage is untouched; nextBefore is the same', async () => {
    const { get, messages } = await setup()
    const a = (await (await get('/sessions/s1/messages?limit=2')).json()) as Record<string, unknown>
    const b = (await (await get('/sessions/s1/messages?limit=2&clip=100000')).json()) as Record<
      string,
      unknown
    >
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    const c = (await (await get('/sessions/s1/messages?limit=2&clip=200')).json()) as {
      nextBefore?: string
    }
    expect(c.nextBefore).toBe((a as { nextBefore?: string }).nextBefore)
    const stored = await messages.load({ sessionId: 's1' })
    expect(JSON.stringify(stored)).toBe(JSON.stringify(seed))
  })

  test('rejects an invalid clip', async () => {
    const { get } = await setup()
    for (const v of ['5', '100001', 'abc', '-1']) {
      expect((await get(`/sessions/s1/messages?clip=${v}`)).status).toBe(400)
    }
  })

  test('the single-message route returns the full message or 404', async () => {
    const { get } = await setup()
    const res = await get('/sessions/s1/messages/m2')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(seed[1] as never)
    expect(((await (await get('/sessions/s1/messages/m1')).json()) as UIMessage).id).toBe('m1')
    expect((await get('/sessions/s1/messages/nope')).status).toBe(404)
    expect((await get('/sessions/s1/messages/m')).status).toBe(404)
    expect((await get('/sessions/other/messages/m2')).status).toBe(404)
  })

  test('AI SDK validateUIMessages accepts clipped messages', async () => {
    const { get } = await setup()
    const res = (await (await get('/sessions/s1/messages?clip=300')).json()) as {
      messages: UIMessage[]
    }
    expect((await validateUIMessages({ messages: res.messages })).length).toBe(3)
  })
})

describe('clipped reasoning', () => {
  test('a long reasoning part keeps a preview and is marked; a short one is identical', async () => {
    const { clipMessages } = await import('./clip.ts')
    const long = {
      type: 'reasoning' as const,
      text: 'x'.repeat(5000),
      state: 'done' as const,
      providerMetadata: { openrouter: { reasoning_details: [{ data: 'y'.repeat(9000) }] } },
    }
    const short = { type: 'reasoning' as const, text: 'short', state: 'done' as const }
    const [m] = clipMessages(
      [{ id: 'm1', role: 'assistant', parts: [long, short] } as UIMessage],
      1000,
    )
    const [a, b] = m?.parts ?? []
    expect(a).toMatchObject({ type: 'reasoning', state: 'done', text: 'x'.repeat(1000) })
    expect((a as { providerMetadata: unknown }).providerMetadata).toEqual({
      eharness: { clipped: true, chars: JSON.stringify(long).length },
    })
    expect(isClippedPart(a)).toBe(true)
    expect(b).toBe(short)
    expect(isClippedPart(b)).toBe(false)
    await validateUIMessages({ messages: [m as UIMessage] })
  })
})
