/**
 * Resumable streams (spec 04 §6.2, ADR-0039): two agent instances ("processes") share storage and
 * a stream log; instance 2 replays and follows the turn that instance 1 runs.
 */
import { describe, expect, test } from 'bun:test'
import type { UIMessageChunk } from 'ai'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { StreamLogAdapter } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { defaultMemoryMessages, defaultMemoryState } from '../session/memory-storage.ts'
import { inMemoryStreamLog } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { handleResumeRequest } from './chat-request.ts'
import { createStreamLogWriter, resolveStreamLogOptions } from './log-writer.ts'
import { createTurnBuffer } from './run.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const collect = async (stream: ReadableStream<unknown>): Promise<UIMessageChunk[]> => {
  const out: UIMessageChunk[] = []
  for await (const chunk of stream) out.push(chunk as UIMessageChunk)
  return out
}

function world(streams: StreamLogAdapter = inMemoryStreamLog()) {
  const messages = defaultMemoryMessages()
  const state = defaultMemoryState()
  const warnings: HarnessWarning[] = []
  const make = (
    config: Omit<Partial<HarnessAgentConfig>, 'model'> & Pick<HarnessAgentConfig, 'model'>,
  ) =>
    defineHarnessAgent({
      contextWindow: 100_000,
      storage: { messages, state, streams },
      streams: { flushMs: 5, pollMs: 10 },
      logger: silent,
      onWarning: (w) => warnings.push(w),
      ...config,
    })
  return { make, streams, warnings }
}

function gatedTool() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const step = tool({
    inputSchema: z.object({}),
    execute: async () => {
      markStarted()
      await gate
      return 'ok'
    },
  })
  return { step, release, started }
}
const stepCall = { toolCalls: [{ toolName: 'step', input: {} }] }

describe('attachRemote across instances', () => {
  test('instance 2 sees the full ordered sequence and the end', async () => {
    const w = world()
    const g = gatedTool()
    const one = w.make({
      model: scriptedModel([stepCall, { text: 'all done' }]),
      tools: { step: g.step },
    })
    const two = w.make({ model: scriptedModel([]) })
    const run = one.session('s1').send('go')
    const local = collect(run.stream)
    await g.started
    await sleep(30) // let the drainer flush the first part
    const remote = await two.session('s1').attachRemote()
    expect(remote).toBeDefined()
    expect(remote?.turnId).toBe(run.turnId)
    const remoteChunks = collect((remote as NonNullable<typeof remote>).stream)
    await sleep(20)
    g.release()
    const [a, b] = await Promise.all([local, remoteChunks])
    expect(b).toEqual(a)
    expect(a.at(-1)?.type).toBe('finish')
    expect((await (remote as NonNullable<typeof remote>).result).stop).toBe('complete')
    expect(w.warnings.filter((x) => x.code === 'W_STREAM_LOG_FAILED')).toEqual([])
    await one.close()
    await two.close()
  })

  test('reconnect from a cursor mid-stream', async () => {
    const w = world()
    const g = gatedTool()
    const one = w.make({
      model: scriptedModel([stepCall, { text: 'fin' }]),
      tools: { step: g.step },
    })
    const two = w.make({ model: scriptedModel([]) })
    const run = one.session('s1').send('go')
    const local = collect(run.stream)
    await g.started
    await sleep(30)
    const first = await two.session('s1').attachRemote()
    const reader = (first as NonNullable<typeof first>).stream.getReader()
    const seen: UIMessageChunk[] = []
    for (let i = 0; i < 3; i++) seen.push((await reader.read()).value as UIMessageChunk)
    await reader.cancel() // the client disconnects: the turn goes on
    const resumed = await two.session('s1').attachRemote({ from: 3 })
    g.release()
    const rest = await collect((resumed as NonNullable<typeof resumed>).stream)
    const all = await local
    expect([...seen, ...rest]).toEqual(all)
    expect((await run.result).stop).toBe('complete')
    await one.close()
    await two.close()
  })

  test('a turn of this process is served from the turn buffer', async () => {
    const w = world()
    const g = gatedTool()
    const one = w.make({ model: scriptedModel([stepCall, { text: 'x' }]), tools: { step: g.step } })
    const run = one.session('s1').send('go')
    await g.started
    const same = await one.session('s1').attachRemote({ from: 1 })
    g.release()
    const all = await collect(run.stream)
    expect(await collect((same as NonNullable<typeof same>).stream)).toEqual(all.slice(1))
    await one.close()
  })

  test('undefined when idle, and when no log is configured', async () => {
    const w = world()
    const one = w.make({ model: scriptedModel([{ text: 'hi' }]) })
    expect(await one.session('s1').attachRemote()).toBeUndefined()
    await one.session('s1').send('hello').result
    expect(
      await w
        .make({ model: scriptedModel([]) })
        .session('s1')
        .attachRemote(),
    ).toBeUndefined()
    const plain = defineHarnessAgent({ model: scriptedModel([]), logger: silent })
    expect(await plain.session('s1').attachRemote()).toBeUndefined()
  })

  test('a failing adapter warns and never fails the turn', async () => {
    const inner = inMemoryStreamLog()
    const broken: StreamLogAdapter = {
      ...inner,
      append: async () => {
        throw new Error('down')
      },
    }
    const w = world(broken)
    const one = w.make({ model: scriptedModel([{ text: 'hi' }]) })
    const result = await one.session('s1').send('hello').result
    expect(result.stop).toBe('complete')
    await sleep(50)
    expect(w.warnings.filter((x) => x.code === 'W_STREAM_LOG_FAILED').length).toBe(1)
    await one.close()
  })
})

describe('handleResumeRequest', () => {
  test('204 when idle; the SSE stream when a turn is active', async () => {
    const w = world()
    const g = gatedTool()
    const one = w.make({
      model: scriptedModel([stepCall, { text: 'yo' }]),
      tools: { step: g.step },
    })
    const two = w.make({ model: scriptedModel([]) })
    const idle = await handleResumeRequest(two.session('s1'), new Request('http://x/s1/stream'))
    expect(idle.status).toBe(204)
    const run = one.session('s1').send('go')
    void collect(run.stream)
    await g.started
    await sleep(30)
    const res = await handleResumeRequest(
      two.session('s1'),
      new Request('http://x/s1/stream?from=2'),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    g.release()
    const text = await res.text()
    expect(text).toContain('[DONE]')
    expect(text.startsWith('data: {"type":"start"')).toBe(false) // from=2 skipped the head
    const bad = await handleResumeRequest(two.session('s1'), new Request('http://x/?from=abc'))
    expect(bad.status).toBe(400)
    await run.result
    await one.close()
    await two.close()
  })
})

describe('stream log writer', () => {
  const key = { sessionId: 's', turnId: 't' }
  const options = resolveStreamLogOptions({ flushMs: 5, batchSize: 2 })

  test('batches by batchSize and closes after the last chunk', async () => {
    const calls: number[][] = []
    const inner = inMemoryStreamLog()
    const adapter: StreamLogAdapter = {
      ...inner,
      append: async (k, chunks, o) => {
        calls.push([o?.at ?? -1, chunks.length])
        return inner.append(k, chunks, o)
      },
    }
    const buffer = createTurnBuffer()
    const writer = createStreamLogWriter({ adapter, key, buffer, options, warn() {} })
    writer.start()
    for (let i = 0; i < 5; i++) buffer.push({ type: 'text-delta', id: 'a', delta: String(i) })
    buffer.close()
    await writer.finish('done')
    expect(calls).toEqual([
      [0, 2],
      [2, 2],
      [4, 1],
    ])
    const read = await inner.read(key, 0)
    expect(read.chunks.length).toBe(5)
    expect(read.status).toBe('done')
  })

  test('a failed append is retried with the same cursor and warns once', async () => {
    const inner = inMemoryStreamLog()
    let failures = 2
    const warnings: HarnessWarning[] = []
    const adapter: StreamLogAdapter = {
      ...inner,
      append: async (k, chunks, o) => {
        // the write lands, but the caller sees a failure (unknown outcome)
        await inner.append(k, chunks, o)
        if (failures-- > 0) throw new Error('timeout')
        return 0
      },
    }
    const buffer = createTurnBuffer()
    const writer = createStreamLogWriter({
      adapter,
      key,
      buffer,
      options: resolveStreamLogOptions({ flushMs: 5, batchSize: 10 }),
      warn: (w) => warnings.push(w),
    })
    writer.start()
    for (let i = 0; i < 3; i++) buffer.push({ type: 'text-delta', id: 'a', delta: String(i) })
    await sleep(30)
    buffer.close()
    await writer.finish('done')
    const read = await inner.read(key, 0)
    expect(read.chunks.length).toBe(3) // no duplicates
    expect(read.status).toBe('done')
    expect(warnings.map((w) => w.code)).toEqual(['W_STREAM_LOG_FAILED'])
  })

  test('never closes a log it could not complete, and does nothing when never started', async () => {
    const inner = inMemoryStreamLog()
    const adapter: StreamLogAdapter = {
      ...inner,
      append: async () => {
        throw new Error('down')
      },
    }
    const warnings: HarnessWarning[] = []
    const buffer = createTurnBuffer()
    const writer = createStreamLogWriter({
      adapter,
      key,
      buffer,
      options,
      warn: (w) => warnings.push(w),
    })
    writer.start()
    buffer.push({ type: 'text-delta', id: 'a', delta: 'x' })
    buffer.close()
    await writer.finish('done')
    expect((await inner.read(key, 0)).status).toBe('missing')
    const idle = createStreamLogWriter({
      adapter: inner,
      key: { sessionId: 'n', turnId: 'n' },
      buffer,
      options,
      warn() {},
    })
    await idle.finish('done')
    expect((await inner.read({ sessionId: 'n', turnId: 'n' }, 0)).status).toBe('missing')
  })
})
