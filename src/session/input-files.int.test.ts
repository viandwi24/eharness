import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isHarnessError } from '../errors.ts'
import type { ModelInfo } from '../models/types.ts'
import { inMemoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'
import { spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  config: Omit<Partial<HarnessAgentConfig>, 'model'> & Pick<HarnessAgentConfig, 'model'>,
) {
  const messages = spyMessages()
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state: spyState() },
    logger: silent,
    ...config,
  })
  return { agent, messages }
}

const withFile = (url: string, text = 'look') => ({
  text,
  files: [{ type: 'file' as const, mediaType: 'image/png', url, filename: 'x.png' }],
})

describe('item 20: client file URLs', () => {
  test('javascript:, http: and ftp: URLs are rejected (EH_INVALID_INPUT), nothing persisted', async () => {
    for (const url of ['javascript:alert(1)', 'http://example.com/x.png', 'ftp://x/y.png']) {
      const model = scriptedModel([{ text: 'never' }])
      const { agent, messages } = setup({ model })
      const result = await agent.session('s1').send(withFile(url)).result
      expect({ url, stop: result.stop, code: result.error?.code }).toEqual({
        url,
        stop: 'error',
        code: 'EH_INVALID_INPUT',
      })
      expect(model.calls).toHaveLength(0)
      expect(messages.saves).toHaveLength(0)
    }
  })

  test('a data URL over inputFiles.maxBytes is rejected; protocols can be opted in', async () => {
    const big = `data:image/png;base64,${'A'.repeat(4_000)}` // 3 000 bytes
    const model = scriptedModel([{ text: 'ok' }, { text: 'ok' }])
    const { agent } = setup({ model, inputFiles: { maxBytes: 2_000 } })
    const result = await agent.session('s1').send(withFile(big)).result
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    const small = `data:image/png;base64,${'A'.repeat(400)}`
    expect((await agent.session('s1').send(withFile(small)).result).stop).toBe('complete')

    const http = setup({
      model: scriptedModel([{ text: 'ok' }]),
      inputFiles: { protocols: ['data:', 'https:', 'http:'] },
    })
    // http: is allowed now (AI SDK then decides how to fetch it; it refuses localhost before any
    // network access, so the test never waits on the internet)
    const run = http.agent.session('s1').send(withFile('http://localhost/x.png'))
    expect((await run.result).error?.code).not.toBe('EH_INVALID_INPUT')
  })

  test('send() throws nothing for a bad URL; ifBusy queue / steer report it as a run error', async () => {
    const model = scriptedModel([{ text: 'slow', delayMs: 5 }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const first = session.send('one')
    const queued = session.send(withFile('javascript:x'), { ifBusy: 'queue' })
    const result = await queued.result
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    await first.result
  })

  test('a historical file whose download fails does not break later turns', async () => {
    // AI SDK refuses to download from localhost (DownloadError) before any network access
    const url = 'https://localhost/expired.png'
    const model = scriptedModel([{ text: 'saw it' }, { text: 'second answer' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const first = await session.send(withFile(url)).result
    // the current turn's own file: the error stays an error
    expect(first.stop).toBe('error')
    const second = await session.send('and now?').result
    expect(second.stop).toBe('complete')
    const prompt = JSON.stringify(model.prompts.at(-1))
    expect(prompt).toContain('[file unavailable: image/png x.png]')
    expect(prompt).not.toContain('localhost')
    expect(isHarnessError(second.error)).toBe(false)
  })
})

describe('R15: inputFiles.resolve', () => {
  const stored = (messages: ReturnType<typeof spyMessages>) =>
    JSON.stringify(messages.saves.flat().map((m) => m))

  test('a library: reference stays in storage and is resolved to bytes for the model', async () => {
    const seen: Array<{ url: string; mediaType: string; sessionId: string }> = []
    const model = scriptedModel([{ text: 'saw it' }, { text: 'again' }])
    const { agent, messages } = setup({
      model,
      inputFiles: {
        protocols: ['data:', 'https:', 'library:'],
        resolve: (url, ctx) => {
          seen.push({ url, mediaType: ctx.mediaType, sessionId: ctx.sessionId })
          return { data: new Uint8Array([104, 105]), mediaType: 'text/plain' }
        },
      },
    })
    const session = agent.session('s1')
    const first = await session.send(withFile('library://uploads/7')).result
    expect(first.stop).toBe('complete')
    expect(stored(messages)).toContain('library://uploads/7')
    expect(stored(messages)).not.toContain('aGk=')
    const wire = JSON.stringify(model.prompts[0])
    expect(wire).toContain('text/plain')
    expect(wire).not.toContain('library://')
    expect(seen[0]).toEqual({ url: 'library://uploads/7', mediaType: 'image/png', sessionId: 's1' })
    // the next turn resolves the historical file again
    await session.send('and now?').result
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(model.prompts[1])).not.toContain('library://')
  })

  test('{ url } hands a signed URL to the provider; undefined leaves the part untouched', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const logs: string[] = []
    const collect = (message: string, data?: unknown) =>
      logs.push(`${message} ${String((data as { error?: unknown } | undefined)?.error)}`)
    const { agent } = setup({
      model,
      logger: { debug() {}, info: collect, warn: collect, error: collect },
      inputFiles: {
        protocols: ['data:', 'https:', 'library:'],
        resolve: (url) =>
          url.startsWith('library:') ? { url: 'https://signed.localhost/a.png?sig=1' } : undefined,
      },
    })
    const result = await agent.session('s1').send(withFile('library://uploads/9')).result
    // AI SDK downloads the resolved URL (the mock provider supports none): it is the one it tried.
    // A localhost URL is refused before any network access, so the test never waits on DNS.
    expect(result.stop).toBe('error')
    expect(logs.join('\n')).toContain('signed.localhost')
  })

  test('null (or a throw) degrades the file to FILE_UNAVAILABLE and the turn continues', async () => {
    for (const resolve of [() => null, () => Promise.reject(new Error('gone'))]) {
      const model = scriptedModel([{ text: 'ok' }])
      const { agent } = setup({
        model,
        inputFiles: { protocols: ['data:', 'https:', 'library:'], resolve },
      })
      const result = await agent.session('s1').send(withFile('library://uploads/404')).result
      expect(result.stop).toBe('complete')
      expect(JSON.stringify(model.prompts[0])).toContain('file unavailable')
    }
  })
})

describe('inputFiles.describe', () => {
  const config = {
    protocols: ['data:', 'https:', 'library:'],
    resolve: () => ({ data: 'aGk=' }),
    describe: (f: { url: string; filename?: string }) =>
      `[attachment ${f.filename ?? ''} path: ${f.url}]`,
  }

  test('a note with the reference follows each referenced file of the user message', async () => {
    const model = scriptedModel([{ text: 'ok' }, { text: 'ok' }])
    const { agent, messages } = setup({ model, inputFiles: config })
    const session = agent.session('s1')
    await session.send(withFile('library:///uploads/a.png')).result
    const content = (model.prompts[0]?.find((m) => m.role === 'user')?.content ?? []) as Array<{
      type: string
      text?: string
    }>
    expect(content.map((p) => p.type)).toEqual(['text', 'file', 'text'])
    expect(content[2]?.text).toBe('[attachment x.png path: library:///uploads/a.png]')
    // storage keeps only the reference: no note, no bytes
    const stored = JSON.stringify(await session.messages())
    expect(stored).not.toContain('attachment x.png')
    expect(stored).not.toContain('aGk=')
    void messages
  })

  test('data URLs get no note, and without describe nothing is added', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { agent } = setup({ model, inputFiles: config })
    await agent.session('s1').send(withFile('data:image/png;base64,aGk=')).result
    const content = (model.prompts[0]?.find((m) => m.role === 'user')?.content ?? []) as unknown[]
    expect(content).toHaveLength(2)
    const plain = scriptedModel([{ text: 'ok' }])
    const other = setup({
      model: plain,
      inputFiles: { protocols: config.protocols, resolve: config.resolve },
    })
    await other.agent.session('s1').send(withFile('library:///uploads/a.png')).result
    expect(plain.prompts[0]?.find((m) => m.role === 'user')?.content).toHaveLength(2)
  })
})

describe('input modalities of the model catalog', () => {
  const png = withFile('data:image/png;base64,aGk=')

  test('an image for a text-only model is refused before anything is stored, with a readable error', async () => {
    const model = scriptedModel([{ text: 'never' }])
    const { agent, messages } = setup({
      model,
      models: { 'mock/scripted': { inputModalities: ['text'] } },
    })
    const result = await agent.session('s1').send(png).result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
    expect(result.error?.message).toContain('does not accept image input')
    expect(result.error?.message).toContain('mock/scripted')
    expect(model.calls).toHaveLength(0)
    expect(messages.saves).toHaveLength(0)
  })

  test('unknown or supported modalities and text files pass', async () => {
    const catalogs: Array<Record<string, ModelInfo> | undefined> = [
      undefined,
      {},
      { scripted: {} },
      { 'mock/scripted': { inputModalities: ['text', 'image'] } },
    ]
    for (const models of catalogs) {
      const model = scriptedModel([{ text: 'ok' }])
      const { agent } = setup({ model, ...(models === undefined ? {} : { models }) })
      expect((await agent.session('s1').send(png).result).stop).toBe('complete')
    }
    const model = scriptedModel([{ text: 'ok' }])
    const { agent } = setup({ model, models: { scripted: { inputModalities: ['text'] } } })
    const csv = {
      text: 'look',
      files: [{ type: 'file' as const, mediaType: 'text/csv', url: 'data:text/csv;base64,YSxi' }],
    }
    expect((await agent.session('s1').send(csv).result).stop).toBe('complete')
  })
})

describe('files the current model cannot take (history, enqueue, steer)', () => {
  const textOnly = { 'mock/scripted': { inputModalities: ['text'] } }
  const png = withFile('data:image/png;base64,aGk=', 'what is this?')
  const note = (id: string) =>
    `[Attachment x.png (image/png) not shown: the model ${id} does not accept image input. Tell the person in one sentence that you cannot see images with the current model and ask them to describe it or switch to a model that can. Do not try OCR or other workarounds.]`
  const userContent = (prompt: unknown): Array<{ type: string; text?: string }> =>
    ((prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
      ?.content ?? []) as Array<{ type: string; text?: string }>

  /** The image went in while the model took images; the session then runs on a text-only model. */
  async function brokenHistory(files: Partial<HarnessAgentConfig> = {}, input = png) {
    const storage = { messages: defaultMemoryMessages(), state: defaultMemoryState() }
    const first = defineHarnessAgent({
      model: scriptedModel([{ text: 'a picture' }]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      ...files,
    })
    expect((await first.session('s1').send(input).result).stop).toBe('complete')
    return storage
  }

  test('history: an old image becomes a note for a text-only model; storage stays intact', async () => {
    const storage = await brokenHistory()
    const model = scriptedModel([{ text: 'ok' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage,
      logger: silent,
      models: textOnly,
    })
    const session = agent.session('s1')
    const result = await session.send('and now?').result
    expect(result.stop).toBe('complete')
    const first = userContent(model.prompts[0])
    expect(first.map((p) => p.type)).toEqual(['text', 'text'])
    expect(first[1]?.text).toBe(note('mock/scripted'))
    expect(JSON.stringify(model.prompts[0])).not.toContain('aGk=')
    const stored = JSON.stringify(await session.messages())
    expect(stored).toContain('data:image/png;base64,aGk=')
    expect(stored).not.toContain('not shown')
  })

  test('history: unknown modalities and accepting models keep the file', async () => {
    const catalogs: Array<Record<string, ModelInfo> | undefined> = [
      undefined,
      {},
      { 'mock/scripted': { contextWindow: 1000 } },
      { 'mock/scripted': { inputModalities: ['text', 'image'] } },
    ]
    for (const models of catalogs) {
      const storage = await brokenHistory()
      const model = scriptedModel([{ text: 'ok' }])
      const agent = defineHarnessAgent({
        model,
        contextWindow: 100_000,
        storage,
        logger: silent,
        ...(models === undefined ? {} : { models }),
      })
      await agent.session('s1').send('and now?').result
      expect(userContent(model.prompts[0]).map((p) => p.type)).toEqual(['text', 'file'])
    }
  })

  test('history: a library reference is replaced before it is resolved', async () => {
    const inputFiles = {
      protocols: ['data:', 'https:', 'library:'],
      resolve: () => ({ data: new Uint8Array([104, 105]), mediaType: 'image/png' }),
    }
    const storage = await brokenHistory({ inputFiles }, withFile('library://uploads/7'))
    const seen: string[] = []
    const model = scriptedModel([{ text: 'ok' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage,
      logger: silent,
      models: textOnly,
      inputFiles: {
        ...inputFiles,
        resolve: (url) => {
          seen.push(url)
          return { data: 'aGk=' }
        },
      },
    })
    const result = await agent.session('s1').send('and now?').result
    expect(result.stop).toBe('complete')
    expect(seen).toEqual([])
    expect(userContent(model.prompts[0])[1]?.text).toBe(note('mock/scripted'))
  })

  test('send() still refuses a new file (the caller reads the error)', async () => {
    const { agent } = setup({ model: scriptedModel([{ text: 'x' }]), models: textOnly })
    const result = await agent.session('s1').send(png).result
    expect(result.error?.code).toBe('EH_INVALID_INPUT')
  })

  for (const durable of [false, true]) {
    for (const mode of ['queue', 'collect'] as const) {
      test(`enqueue(${mode}, ${durable ? 'durable' : 'local'}) keeps the text and shows the model a note`, async () => {
        const model = scriptedModel([{ text: 'ok' }, { text: 'ok' }])
        const storage = {
          messages: defaultMemoryMessages(),
          state: defaultMemoryState(),
          ...(durable ? { inbox: inMemoryInbox() } : {}),
        }
        const agent = defineHarnessAgent({
          model,
          contextWindow: 100_000,
          storage,
          logger: silent,
          models: textOnly,
          inbox: { pollMs: 0 },
        })
        const session = agent.session('s1')
        await session.enqueue(png, { mode })
        await until('turn ran', () => model.prompts.length === 1)
        const content = userContent(model.prompts[0])
        expect(content[0]?.text).toBe('what is this?')
        expect(content.at(-1)?.text).toBe(note('mock/scripted'))
        expect(content.some((p) => p.type === 'file')).toBe(false)
        // the next turn works too
        const next = await session.send('and now?').result
        expect(next.stop).toBe('complete')
      })
    }
  }

  test('steer: an image delivered at a step boundary reaches the model as a note', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'noop', input: {} }], delayMs: 20 },
      { text: 'done' },
    ])
    const { agent } = setup({
      model,
      models: textOnly,
      tools: {
        noop: tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' }),
      },
    })
    const session = agent.session('s1')
    const main = session.send('go')
    await new Promise((r) => setTimeout(r, 5))
    const steer = session.send(png, { ifBusy: 'steer' })
    expect(await steer.delivery).toBe('step')
    expect((await main.result).stop).toBe('complete')
    const wire = JSON.stringify(model.prompts[1])
    expect(wire).toContain('what is this?')
    expect(wire).toContain('not shown')
    expect(wire).not.toContain('aGk=')
  })
})

describe('text-like files are projected as text', () => {
  const csv = (data: string, filename = 'sales.csv') => ({
    text: 'sum it',
    files: [{ type: 'file' as const, mediaType: 'text/csv', url: data, filename }],
  })
  const content = (prompt: unknown) =>
    ((prompt as Array<{ role: string; content: unknown }>).find((m) => m.role === 'user')
      ?.content ?? []) as Array<{ type: string; text?: string }>

  test('a data URL becomes a text part with a header; storage keeps the file part', async () => {
    const model = scriptedModel([{ text: 'ok' }, { text: 'ok' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    await session.send(csv(`data:text/csv;base64,${btoa('a,b\n1,2')}`)).result
    await session.send('again').result
    for (const prompt of model.prompts) {
      const parts = content(prompt)
      expect(parts.some((p) => p.type === 'file')).toBe(false)
      expect(parts[1]?.text).toBe('[Attachment sales.csv (text/csv, 7 bytes)]\na,b\n1,2')
    }
    expect(JSON.stringify(await session.messages())).toContain('data:text/csv;base64,')
  })

  test('a library reference resolved to bytes is inlined; long text is cut with a note', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { agent } = setup({
      model,
      inputFiles: {
        protocols: ['data:', 'library:'],
        resolve: () => ({ data: new TextEncoder().encode('x'.repeat(100_050)) }),
      },
    })
    await agent.session('s1').send(csv('library://uploads/big.csv')).result
    const text = content(model.prompts[0])[1]?.text ?? ''
    expect(text.startsWith('[Attachment sales.csv (text/csv, 100050 bytes)]\nxxx')).toBe(true)
    expect(text).toContain('[truncated: showing the first 100000 of 100050 characters]')
  })

  test('images stay file parts', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { agent } = setup({ model })
    await agent.session('s1').send(withFile('data:image/png;base64,aGk=')).result
    expect(content(model.prompts[0]).map((p) => p.type)).toEqual(['text', 'file'])
  })
})
