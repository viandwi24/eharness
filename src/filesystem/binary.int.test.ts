/**
 * Binary files and images (spec 08 §12): tools, storage of the media reference, projection after
 * a reload, `compaction.prune` of old images and the model-visible texts.
 */
import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type HarnessAgentConfig } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import {
  type ScriptedPrompt,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { bytesToBase64, detectMediaType, imageDimensions, looksBinary } from './media.ts'
import { memoryFs } from './memory.ts'
import { filesystem } from './plugin.ts'
import { isFileMediaRef } from './tools.ts'
import type { FileSystem, FilesystemOptions } from './types.ts'
import { bytesVersion } from './version.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** A PNG header with the given size (enough for detection and dimensions). */
function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  for (let i = 33; i < bytes.length; i++) bytes[i] = i % 251
  return bytes
}
const pdf = (): Uint8Array => new TextEncoder().encode('%PDF-1.4\n\u0000ÿþ binary tail')
const blob = (): Uint8Array => new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10])

const call = (toolName: string, input: unknown) => ({ toolName, input })
function setup(
  steps: ScriptedStepInput[],
  fs: FileSystem,
  options: Partial<FilesystemOptions> = {},
  config: Partial<HarnessAgentConfig> = {},
  storage = { messages: memoryMessages(), state: memoryState() },
) {
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage,
    logger: silent,
    ...config,
    plugins: [filesystem({ fs, ...options })],
  })
  return { agent, model, storage }
}

type Result = Awaited<
  ReturnType<ReturnType<ReturnType<typeof setup>['agent']['session']>['send']>['result']
>
const outputs = (result: Result): unknown[] => {
  const message = result.messages.find((m) => m.id === result.messageId)
  return (message?.parts ?? [])
    .filter((p) => p.type.startsWith('tool-'))
    .map((p) => {
      const part = p as { output?: unknown; errorText?: string }
      return part.output ?? part.errorText
    })
}

/** A tool result output as the provider receives it. */
type WireOutput = {
  type: string
  // biome-ignore lint/suspicious/noExplicitAny: test helper over a loosely typed wire
  value: any
}

/** Content of the tool results in a prompt. */
function toolResults(prompt: ScriptedPrompt): Array<{ toolName: string; output: WireOutput }> {
  const out: Array<{ toolName: string; output: WireOutput }> = []
  for (const message of prompt) {
    if (message.role !== 'tool') continue
    for (const part of message.content as unknown as Array<{
      type: string
      toolName: string
      output: WireOutput
    }>) {
      if (part.type === 'tool-result') out.push({ toolName: part.toolName, output: part.output })
    }
  }
  return out
}

describe('media helpers', () => {
  test('detectMediaType by magic bytes, then extension', () => {
    expect(detectMediaType(png(1, 1), '/x.dat')).toBe('image/png')
    expect(detectMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), '/x')).toBe('image/jpeg')
    expect(detectMediaType(pdf(), '/x')).toBe('application/pdf')
    expect(detectMediaType(new Uint8Array(), '/a/B.WEBP')).toBe('image/webp')
    expect(detectMediaType(blob(), '/x.unknown')).toBeUndefined()
    expect(detectMediaType(blob(), '/noext')).toBeUndefined()
  })
  test('imageDimensions of PNG, GIF and JPEG headers', () => {
    expect(imageDimensions(png(640, 480), 'image/png')).toEqual({ width: 640, height: 480 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x0a, 0, 0x14, 0, 0, 0])
    expect(imageDimensions(gif, 'image/gif')).toEqual({ width: 10, height: 20 })
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 100, 3, 1, 0x22, 0,
    ])
    expect(imageDimensions(jpeg, 'image/jpeg')).toEqual({ width: 100, height: 50 })
    expect(imageDimensions(new Uint8Array([1]), 'image/png')).toBeUndefined()
  })
  test('looksBinary and bytesToBase64 (large input)', () => {
    expect(looksBinary(new TextEncoder().encode('héllo\n'))).toBe(false)
    expect(looksBinary(new Uint8Array([0x61, 0, 0x62]))).toBe(true)
    expect(looksBinary(new Uint8Array([0xc3, 0x28]))).toBe(true)
    const big = new Uint8Array(300_000).fill(65)
    expect(bytesToBase64(big)).toBe(Buffer.from(big).toString('base64'))
  })
})

describe('memoryFs binary support', () => {
  test('seed with bytes, readBytes/writeBytes, read throws for binary, grep skips it', async () => {
    const fs = memoryFs({ '/a.png': png(2, 2), '/t.txt': 'needle\n' })
    const entry = await fs.readBytes?.('/a.png')
    expect(entry?.meta.binary).toBe(true)
    expect(entry?.mediaType).toBe('image/png')
    expect(entry?.meta.version).toBe(await bytesVersion(png(2, 2)))
    await expect(fs.read('/a.png')).rejects.toThrow('binary file')
    expect((await fs.list()).map((m) => [m.path, m.binary ?? false])).toEqual([
      ['/a.png', true],
      ['/t.txt', false],
    ])
    expect(await fs.grep?.(/./)).toEqual([{ path: '/t.txt', line: 1, text: 'needle' }])
  })
})

describe('read_file on binary files', () => {
  test('an image is stored as a compact reference and the model receives the image', async () => {
    const image = png(640, 480, 5000)
    const fs = memoryFs({ '/shots/a.png': image })
    const { agent, model } = setup(
      [{ toolCalls: [call('read_file', { path: '/shots/a.png' })] }, { text: 'seen' }],
      fs,
    )
    const result = await agent.session('s').send('look').result
    expect(result.stop).toBe('complete')
    const [output] = outputs(result)
    expect(isFileMediaRef(output)).toBe(true)
    expect(output).toEqual({
      type: 'media-ref',
      path: '/shots/a.png',
      version: await bytesVersion(image),
      mediaType: 'image/png',
      bytes: image.length,
      text: `Image /shots/a.png (640x480, ${image.length} bytes, image/png)`,
    })
    // storage never holds the base64
    expect(JSON.stringify(result.messages)).not.toContain(bytesToBase64(image).slice(0, 60))
    const [tool] = toolResults(model.prompts[1] as ScriptedPrompt)
    expect(tool?.output.type).toBe('content')
    expect(tool?.output.value[0]).toEqual({
      type: 'text',
      text: `Image /shots/a.png (640x480, ${image.length} bytes, image/png)`,
    })
    expect(tool?.output.value[1]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: bytesToBase64(image) },
    })
  })

  test('a reload projects the same model input; a changed file gives the text note', async () => {
    const image = png(8, 8, 100)
    const fs = memoryFs({ '/a.png': image })
    const storage = { messages: memoryMessages(), state: memoryState() }
    const first = setup(
      [{ toolCalls: [call('read_file', { path: '/a.png' })] }, { text: 'one' }],
      fs,
      {},
      {},
      storage,
    )
    await first.agent.session('s').send('look').result
    await first.agent.close()
    const withImage = (model: ReturnType<typeof setup>['model'], index: number) =>
      toolResults(model.prompts[index] as ScriptedPrompt)[0]?.output

    // a new agent over the same storage and file system (a restart)
    const second = setup([{ text: 'two' }, { text: 'three' }], fs, {}, {}, storage)
    await second.agent.session('s').send('again').result
    expect(withImage(second.model, 0)).toEqual(
      withImage(
        // the original wire of the first turn's second step
        first.model,
        1,
      ),
    )
    // the file changes: the reference stays, the bytes are no longer sent
    await fs.writeBytes?.('/a.png', png(9, 9, 10))
    await second.agent.close()
    const third = setup([{ text: 'four' }], fs, {}, {}, storage)
    await third.agent.session('s').send('and now').result
    const output = withImage(third.model, 0)
    expect(output?.type).toBe('text')
    expect(output?.value).toContain('Image /a.png (8x8,')
    expect(output?.value).toContain('is no longer available')
  })

  test('pdf is off by default, sent as a file part with media.pdf', async () => {
    const fs = memoryFs({ '/d.pdf': pdf() })
    const off = setup([{ toolCalls: [call('read_file', { path: '/d.pdf' })] }, { text: 'x' }], fs)
    const r1 = await off.agent.session('s').send('go').result
    expect(outputs(r1)).toEqual([
      `ERROR: binary file /d.pdf (application/pdf, ${pdf().length} bytes); it cannot be shown as text.`,
    ])
    const on = setup([{ toolCalls: [call('read_file', { path: '/d.pdf' })] }, { text: 'x' }], fs, {
      media: { pdf: true },
    })
    await on.agent.session('s').send('go').result
    const [tool] = toolResults(on.model.prompts[1] as ScriptedPrompt)
    expect(tool?.output.value[0].text).toBe(`PDF /d.pdf (${pdf().length} bytes, application/pdf)`)
    expect(tool?.output.value[1]).toMatchObject({
      type: 'file',
      mediaType: 'application/pdf',
      filename: 'd.pdf',
      data: { type: 'data', data: bytesToBase64(pdf()) },
    })
  })

  test('other binaries, disabled images and oversized images give ERROR: texts', async () => {
    const big = png(1, 1, 200)
    const fs = memoryFs({ '/b.dat': blob(), '/a.png': png(1, 1), '/big.png': big })
    const { agent } = setup(
      [
        {
          toolCalls: [
            call('read_file', { path: '/b.dat' }),
            call('read_file', { path: '/a.png' }),
            call('read_file', { path: '/big.png' }),
          ],
        },
        { text: 'x' },
      ],
      fs,
      { media: { maxBytes: 100 } },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      'ERROR: binary file /b.dat (unknown, 6 bytes); it cannot be shown as text.',
      expect.objectContaining({ type: 'media-ref' }),
      `ERROR: image /big.png is too large (${big.length} bytes; the limit is 100 bytes).`,
    ])
    const noImages = setup(
      [{ toolCalls: [call('read_file', { path: '/a.png' })] }, { text: 'x' }],
      fs,
      { media: { images: false } },
    )
    expect(outputs(await noImages.agent.session('s').send('go').result)).toEqual([
      'ERROR: binary file /a.png (image/png, 33 bytes); it cannot be shown as text.',
    ])
  })

  test('write_file / edit_file refuse binary files, delete_file needs a read, grep skips them', async () => {
    const fs = memoryFs({ '/b.dat': blob(), '/t.txt': 'findme\n' })
    const { agent } = setup(
      [
        {
          toolCalls: [
            call('write_file', { path: '/b.dat', content: 'x' }),
            call('edit_file', { path: '/b.dat', old_string: 'a', new_string: 'b' }),
            call('grep', { pattern: '.' }),
            call('list_files', {}),
            call('delete_file', { path: '/b.dat' }),
          ],
        },
        { toolCalls: [call('read_file', { path: '/b.dat' })] },
        { toolCalls: [call('delete_file', { path: '/b.dat' })] },
        { text: 'x' },
      ],
      fs,
    )
    const result = await agent.session('s').send('go').result
    const out = outputs(result)
    expect(out[0]).toBe(
      'ERROR: /b.dat is a binary file; write_file only handles text files. Delete it first to replace it.',
    )
    expect(out[1]).toBe(
      'ERROR: /b.dat is a binary file; edit_file only handles text files. Delete it first to replace it.',
    )
    expect(out[2]).toBe('/t.txt:1: findme')
    expect(out[3]).toBe('/b.dat (6 bytes)\n/t.txt (7 bytes)')
    expect(out[4]).toBe('ERROR: read /b.dat with read_file before deleting it.')
    expect(out[5]).toBe('ERROR: binary file /b.dat (unknown, 6 bytes); it cannot be shown as text.')
    expect(out[6]).toBe('Deleted /b.dat.')
    expect(await fs.readBytes?.('/b.dat')).toBeNull()
  })
})

describe('compaction.prune and binary outputs', () => {
  test('an old image output is replaced by the placeholder, the newest stays', async () => {
    const image = png(4, 4, 3000)
    const fs = memoryFs({ '/a.png': image, '/b.png': png(5, 5, 3000) })
    const turns: ScriptedStepInput[] = []
    for (const path of ['/a.png', '/b.png']) {
      turns.push({ toolCalls: [call('read_file', { path })] }, { text: `done ${path}` })
    }
    for (let i = 0; i < 3; i++) turns.push({ text: `filler ${i}` })
    const { agent, model } = setup(
      turns,
      fs,
      {},
      {
        compaction: {
          model: scriptedModel([{ text: 'S' }]),
          keepLast: 2,
          prune: { keepTurns: 1, minChars: 500 },
        },
      },
    )
    const session = agent.session('s')
    for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) await session.send(q).result
    const wire = JSON.stringify(model.prompts.at(-1))
    expect(wire).not.toContain(bytesToBase64(image).slice(0, 80))
    expect(wire).toMatch(/\[output of read_file pruned: \d+ chars\]/)
  })
})

describe('plugin options', () => {
  test('invalid media options fail at definition time', () => {
    const fs = memoryFs()
    expect(() => filesystem({ fs, media: { maxBytes: 0 } })).toThrow('media.maxBytes')
  })
  test('adapters without readBytes stay text only', async () => {
    const inner = memoryFs({ '/t.txt': 'hello\n' })
    const fs: FileSystem = {
      read: inner.read,
      write: inner.write,
      delete: inner.delete,
      list: inner.list,
    }
    const { agent } = setup(
      [{ toolCalls: [call('read_file', { path: '/t.txt' })] }, { text: 'x' }],
      fs,
    )
    expect(outputs(await agent.session('s').send('go').result)).toEqual(['     1\thello'])
  })
})
