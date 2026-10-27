import { describe, expect, test } from 'bun:test'
import type { UIMessage, UIMessageChunk } from 'ai'
import { isClippedPart } from './chat-helpers.ts'
import { followSessionStream } from './follow.ts'
import { createHarnessClient } from './http-client.ts'

const sse = (chunks: unknown[]): Response =>
  new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  })

const turn = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'hel' },
  { type: 'text-delta', id: 't', delta: 'lo' },
  { type: 'text-end', id: 't' },
  { type: 'finish-step' },
  { type: 'finish' },
]

function setup(handler: (url: string) => Response | Promise<Response>) {
  const urls: string[] = []
  const client = createHarnessClient({
    baseUrl: '/api',
    headers: () => ({ authorization: 'Bearer t' }),
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return handler(String(input))
    }) as typeof fetch,
  })
  return { client, urls }
}

describe('followSessionStream', () => {
  test('builds the streamed message from the resume route', async () => {
    const { client, urls } = setup(() => sse(turn))
    const seen: UIMessage[] = []
    const chunks: UIMessageChunk[] = []
    const result = await followSessionStream(client, 'dm:a', {
      onMessage: (m) => seen.push(structuredClone(m)),
      onChunk: (c) => chunks.push(c),
    })
    expect(result).toBe('streamed')
    expect(urls).toEqual(['/api/sessions/dm%3Aa/chat/stream'])
    expect(chunks).toHaveLength(turn.length)
    expect(seen.at(-1)?.id).toBe('m1')
    expect(seen.at(-1)?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'hello' })
  })

  test('204 is idle', async () => {
    const { client } = setup(() => new Response(null, { status: 204 }))
    expect(await followSessionStream(client, 's1')).toBe('idle')
  })

  test('a failed request is an error, reported once', async () => {
    const { client } = setup(() => new Response('boom', { status: 500 }))
    const errors: unknown[] = []
    expect(await followSessionStream(client, 's1', { onError: (e) => errors.push(e) })).toBe(
      'error',
    )
    expect(errors).toHaveLength(1)
  })

  test('an abort ends with error', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.throwIfAborted()
        return sse(turn)
      }) as typeof fetch,
    })
    expect(await followSessionStream(client, 's1', { signal: ctl.signal })).toBe('error')
  })
})

/** A long worker turn: many small reasoning deltas per step, two tools with big outputs. */
function longTurn(steps: number): UIMessageChunk[] {
  const out: UIMessageChunk[] = [{ type: 'start', messageId: 'm1' }]
  for (let s = 0; s < steps; s++) {
    out.push({ type: 'start-step' })
    out.push({ type: 'reasoning-start', id: `r${s}` })
    for (let d = 0; d < 60; d++)
      out.push({ type: 'reasoning-delta', id: `r${s}`, delta: 'thinking about the data ' })
    out.push({ type: 'reasoning-end', id: `r${s}` })
    for (let t = 0; t < 2; t++) {
      const id = `c${s}_${t}`
      out.push({ type: 'tool-input-start', toolCallId: id, toolName: 'call_api' })
      out.push({
        type: 'tool-input-available',
        toolCallId: id,
        toolName: 'call_api',
        input: { page: s },
      })
      const rows = Array.from({ length: 80 }, (_, i) => ({
        id: i,
        name: `customer ${i}`,
        delay: i * 3,
      }))
      out.push({ type: 'tool-output-available', toolCallId: id, output: { rows } })
    }
    out.push({ type: 'finish-step' })
  }
  out.push({ type: 'finish' })
  return out
}

async function follow(
  chunks: unknown[],
  options: Parameters<typeof followSessionStream>[2] = {},
): Promise<{ states: number; last: UIMessage | undefined; ms: number }> {
  const { client } = setup(() => sse(chunks))
  let states = 0
  let last: UIMessage | undefined
  const t0 = performance.now()
  await followSessionStream(client, 's1', {
    ...options,
    onMessage: (m) => {
      states++
      last = m
    },
  })
  return { states, last, ms: performance.now() - t0 }
}

describe('followSessionStream on long turns', () => {
  test('merged deltas build the same message with fewer states', async () => {
    const chunks = longTurn(4)
    const merged = await follow(chunks)
    const plain = await follow(chunks, { deltaHoldMs: 0 })
    expect(merged.last).toEqual(plain.last)
    expect(merged.states).toBeLessThan(plain.states / 5)
    expect(plain.states).toBeGreaterThan(240) // 0 = one state per delta, as before
  })

  test('the last providerMetadata of merged deltas wins, as in the SDK reducer', async () => {
    const chunks = [
      { type: 'start', messageId: 'm1' },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'a', providerMetadata: { p: { sig: '1' } } },
      { type: 'reasoning-delta', id: 'r', delta: 'b' },
      { type: 'reasoning-delta', id: 'r', delta: 'c', providerMetadata: { p: { sig: '2' } } },
      { type: 'reasoning-delta', id: 'r', delta: 'd' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'finish' },
    ]
    const merged = await follow(chunks)
    const plain = await follow(chunks, { deltaHoldMs: 0 })
    expect(merged.last).toEqual(plain.last)
    expect(merged.last?.parts[0]).toMatchObject({
      text: 'abcd',
      providerMetadata: { p: { sig: '2' } },
    })
  })

  test('clip replaces big tool payloads by ?clip= previews; onChunk still sees them whole', async () => {
    const big = { text: 'x'.repeat(5000) }
    const chunks = [
      { type: 'start', messageId: 'm1' },
      { type: 'tool-input-start', toolCallId: 'c', toolName: 'read' },
      { type: 'tool-input-available', toolCallId: 'c', toolName: 'read', input: big },
      { type: 'tool-output-available', toolCallId: 'c', output: { ok: true } },
      { type: 'data-note', id: 'n', data: big },
      { type: 'data-eh.usage', data: { steps: 1, blob: 'y'.repeat(5000) }, transient: true },
      { type: 'finish' },
    ]
    const raw: UIMessageChunk[] = []
    const { last } = await follow(chunks, { clip: 2000, onChunk: (c) => raw.push(c) })
    const tool = last?.parts.find((p) => p.type === 'tool-read') as {
      input: unknown
      output: unknown
    }
    expect(isClippedPart(tool)).toBe(true)
    const input = tool.input as { eharnessClipped: boolean; chars: number; preview: string }
    expect(input.eharnessClipped).toBe(true)
    expect(input.chars).toBe(JSON.stringify(big).length)
    expect(input.preview).toBe(JSON.stringify(big).slice(0, 2000))
    expect(tool.output).toEqual({ ok: true })
    const note = last?.parts.find((p) => p.type === 'data-note')
    expect(isClippedPart(note)).toBe(true)
    expect(raw.find((c) => c.type === 'tool-input-available')).toMatchObject({ input: big })
  })

  test('a held delta reaches onMessage while the stream stays open', async () => {
    let push: (c: unknown) => void = () => {}
    let end: () => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        push = (c) => controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`))
        end = () => {
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        }
      },
    })
    const { client } = setup(
      () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
        }),
    )
    const texts: string[] = []
    const done = followSessionStream(client, 's1', {
      deltaHoldMs: 10,
      onMessage: (m) => {
        const t = m.parts.find((p) => p.type === 'text')
        if (t?.type === 'text') texts.push(t.text)
      },
    })
    push({ type: 'start', messageId: 'm1' })
    push({ type: 'text-start', id: 't' })
    push({ type: 'text-delta', id: 't', delta: 'hi' })
    for (let i = 0; i < 50 && !texts.includes('hi'); i++)
      await new Promise((r) => setTimeout(r, 10))
    expect(texts).toContain('hi')
    push({ type: 'text-end', id: 't' })
    push({ type: 'finish' })
    end()
    expect(await done).toBe('streamed')
  })

  // Reproduction: with one state per chunk (`deltaHoldMs: 0`, the old behaviour) 120 such steps
  // took ~29 s of main thread and 200 steps ~83 s, each state being a full copy of the message.
  test('300 steps with big tool outputs stay fast', async () => {
    const chunks = longTurn(300)
    const r = await follow(chunks, { clip: 2000 })
    expect(r.states).toBeLessThan(chunks.length / 5)
    expect(r.ms).toBeLessThan(5_000)
  }, 30_000)
})
