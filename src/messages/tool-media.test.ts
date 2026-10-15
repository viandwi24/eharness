import { describe, expect, test } from 'bun:test'
import type { ToolSet } from 'ai'
import { tool } from 'ai'
import { z } from 'zod/v4'
import type { HarnessWarning } from '../errors.ts'
import { offloadToolMedia, type ToolMediaSink } from '../registry/tool-media.ts'
import { project } from './project.ts'
import { createCoreMessageRegistry } from './registry.ts'
import {
  EXPIRED_OFFLOADED_MEDIA_NOTE,
  OLDER_OFFLOADED_MEDIA_NOTE,
  rehydrateToolMedia,
} from './tool-media.ts'
import type { HarnessUIMessage } from './types.ts'

const b64 = (s: string): string => btoa(s)
const ref = (n: number) => ({
  type: 'image',
  mimeType: 'image/png',
  ref: {
    type: 'media-ref',
    path: `/m/${n}.png`,
    version: `v${n}`,
    mediaType: 'image/png',
    bytes: 3,
  },
})
const part = (id: string, content: unknown[]) => ({
  type: 'tool-shot',
  toolCallId: id,
  state: 'output-available',
  input: {},
  output: { content },
})
const assistant = (id: string, parts: unknown[]): HarnessUIMessage =>
  ({
    id,
    role: 'assistant',
    metadata: { eharness: { v: 1, createdAt: 1 } },
    parts,
  }) as unknown as HarnessUIMessage
const user = (id: string): HarnessUIMessage =>
  ({
    id,
    role: 'user',
    metadata: { eharness: { v: 1, createdAt: 1 } },
    parts: [{ type: 'text', text: 'go' }],
  }) as unknown as HarnessUIMessage

const files = new Map<string, string>([
  ['/m/1.png', 'AAA1'],
  ['/m/2.png', 'AAA2'],
  // /m/3.png is gone
  ['/m/4.png', 'AAA4'],
])
const read = async (r: { path: string }): Promise<string | null> => {
  const v = files.get(r.path)
  return v === undefined ? null : b64(v)
}

describe('rehydrateToolMedia', () => {
  const messages = [
    user('01'),
    assistant('02', [
      part('c1', [{ type: 'text', text: 'one' }, ref(1)]),
      part('c2', [ref(2)]),
      part('c3', [ref(3)]),
      part('c4', [ref(4)]),
    ]),
  ]

  test('newest N get their data back; older ones and missing files become notes', async () => {
    const out = await rehydrateToolMedia(messages, { keep: 2, read })
    const outs = (out[1] as HarnessUIMessage).parts.map(
      (p) => (p as unknown as { output: { content: unknown[] } }).output.content,
    )
    expect(outs[3]).toEqual([{ type: 'image', mimeType: 'image/png', data: b64('AAA4') }])
    expect(outs[2]).toEqual([{ type: 'text', text: EXPIRED_OFFLOADED_MEDIA_NOTE }])
    expect(outs[1]).toEqual([{ type: 'text', text: OLDER_OFFLOADED_MEDIA_NOTE }])
    expect(outs[0]?.[0]).toEqual({ type: 'text', text: 'one' })
    expect(outs[0]?.[1]).toEqual({ type: 'text', text: OLDER_OFFLOADED_MEDIA_NOTE })
    // stored messages are untouched
    expect(JSON.stringify(messages)).not.toContain('"data"')
  })

  test('keep undefined rehydrates all; no refs returns the same array', async () => {
    const all = await rehydrateToolMedia(messages, { keep: undefined, read })
    expect(JSON.stringify(all)).toContain(b64('AAA1'))
    const plain = [user('01')]
    expect(await rehydrateToolMedia(plain, { keep: 1, read })).toBe(plain)
  })

  test('project() without readMedia notes every offloaded image; with it the tool converter sees data', async () => {
    const tools = {
      shot: tool({
        inputSchema: z.object({}),
        toModelOutput: ({ output }: { output: unknown }) => ({
          type: 'content' as const,
          value: (
            output as { content: Array<{ type: string; data?: string; text?: string }> }
          ).content.map((c) =>
            c.type === 'image'
              ? { type: 'image-data' as const, data: c.data as string, mediaType: 'image/png' }
              : { type: 'text' as const, text: c.text as string },
          ),
        }),
      }),
    } as unknown as ToolSet
    const base = { registry: createCoreMessageRegistry(), sessionId: 's', tools }
    const missing = JSON.stringify(await project(messages, base))
    expect(missing).not.toContain('image-data')
    const withRead = JSON.stringify(
      await project(messages, { ...base, readMedia: read, keepToolImages: 1 }),
    )
    expect(withRead).toContain(b64('AAA4'))
    expect(withRead).not.toContain(b64('AAA2'))
    const first = JSON.stringify(
      await project(messages, { ...base, readMedia: read, keepToolImages: 1 }),
    )
    expect(first).toBe(withRead)
  })
})

describe('offloadToolMedia', () => {
  const warnings: HarnessWarning[] = []
  const sink = (fail = false): ToolMediaSink & { puts: Array<{ index: number; type: string }> } => {
    const puts: Array<{ index: number; type: string }> = []
    return {
      puts,
      async put(_s, _c, index, bytes, mediaType) {
        if (fail) throw new Error('disk full')
        puts.push({ index, type: mediaType })
        return { path: `/m/${index}.png`, version: 'v', bytes: bytes.length }
      },
      async read() {
        return null
      },
    }
  }
  const output = {
    content: [
      { type: 'text', text: 'Screenshot' },
      { type: 'image', data: b64('PNG'), mimeType: 'image/png' },
    ],
  }
  const run = (toolMedia: ToolMediaSink | undefined) =>
    offloadToolMedia('phone_screenshot', 'c1', output, {
      sessionId: 's',
      toolMedia,
      warn: (w) => warnings.push(w),
    })

  test('writes the bytes and stores a reference without data', async () => {
    const s = sink()
    const out = (await run(s)) as { content: Array<Record<string, unknown>> }
    expect(s.puts).toEqual([{ index: 1, type: 'image/png' }])
    expect(out.content[0]).toEqual({ type: 'text', text: 'Screenshot' })
    expect(out.content[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      ref: { type: 'media-ref', path: '/m/1.png', version: 'v', mediaType: 'image/png', bytes: 3 },
    })
  })

  test('without the service the output is unchanged; a failing write keeps the part and warns', async () => {
    expect(await run(undefined)).toBe(output)
    expect(await run(sink(true))).toEqual(output)
    expect(warnings[0]?.code).toBe('W_TOOL_MEDIA_OFFLOAD')
  })
})
