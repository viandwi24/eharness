import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isHarnessError } from '../errors.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages, spyState } from './test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>) {
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
    // http: is allowed now (AI SDK then decides how to fetch it)
    const run = http.agent.session('s1').send(withFile('http://example.com/x.png'))
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
          url.startsWith('library:') ? { url: 'https://cdn.test/a.png?sig=1' } : undefined,
      },
    })
    const result = await agent.session('s1').send(withFile('library://uploads/9')).result
    // AI SDK downloads the resolved URL (the mock provider supports none): it is the one it tried
    expect(result.stop).toBe('error')
    expect(logs.join('\n')).toContain('cdn.test/a.png')
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
