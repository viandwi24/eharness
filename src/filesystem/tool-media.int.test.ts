/**
 * The `toolMedia` service (spec 08 §2, spec 09 §4): media of MCP-style tool results are written as
 * files, the stored output keeps a reference, the model still gets the newest images, and the
 * newest `keep` files of a session stay.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { inMemoryFs } from './memory.ts'
import { filesystem } from './plugin.ts'
import type { FilesystemOptions } from './types.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const PNG = (n: number): string => btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, n))

function setup(options: Partial<FilesystemOptions>, calls: number, fsOverride = inMemoryFs()) {
  const mcp = definePlugin({
    name: 'fake-mcp',
    session: () => ({
      tools: {
        shot: tool({
          inputSchema: z.object({ n: z.number() }),
          // like the AI SDK MCP conversion: the image `data` becomes a media item of the result
          toModelOutput: ({ output }: { output: unknown }) => ({
            type: 'content' as const,
            value: (
              output as { content: Array<{ type: string; text?: string; data?: string }> }
            ).content.map((c) =>
              c.type === 'image'
                ? { type: 'image-data' as const, data: c.data as string, mediaType: 'image/png' }
                : { type: 'text' as const, text: c.text as string },
            ),
          }),
          execute: async ({ n }) => ({
            content: [
              { type: 'text', text: `screen ${n}` },
              { type: 'image', data: PNG(n), mimeType: 'image/png' },
            ],
          }),
        }),
      },
    }),
  })
  const steps = [
    ...Array.from({ length: calls }, (_, i) => ({
      toolCalls: [{ toolName: 'shot', input: { n: i + 1 }, toolCallId: `c${i + 1}` }],
    })),
    { text: 'done' },
  ]
  const model = scriptedModel(steps)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: inMemoryMessages(), state: inMemoryState() },
    logger: silent,
    plugins: [filesystem({ fs: fsOverride, ...options }), mcp],
  })
  return { agent, fs: fsOverride, model }
}

describe('toolMedia', () => {
  test('offloads media to a file, stores a reference and keeps only the newest keep files', async () => {
    const { agent, fs, model } = setup({ toolMedia: { keep: 2 } }, 3)
    const result = await agent.session('s1').send('go').result
    const message = result.messages.find((m) => m.id === result.messageId)
    const outputs = (message?.parts ?? [])
      .filter((p) => p.type === 'tool-shot')
      .map((p) => (p as unknown as { output: { content: Array<Record<string, unknown>> } }).output)
    expect(outputs).toHaveLength(3)
    for (const output of outputs) {
      expect(output.content[0]).toMatchObject({ type: 'text' })
      expect(JSON.stringify(output)).not.toContain('"data"')
      expect(output.content[1]).toMatchObject({
        type: 'image',
        mimeType: 'image/png',
        ref: { type: 'media-ref', mediaType: 'image/png', bytes: 5 },
      })
    }
    const last = outputs[2] as { content: Array<Record<string, unknown>> }
    const ref = (last.content[1] as { ref: { path: string; version: string } }).ref
    expect(ref.path).toBe('/.eharness/tool-media/s1-c3-1.png')
    const file = await fs.readBytes?.(ref.path)
    expect(Array.from(file?.bytes ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47, 3])
    expect(file?.meta.version).toBe(ref.version)
    // the model of the last step gets the bytes back (base64 data), not the reference
    const wire = JSON.stringify(model.prompts[3])
    expect(wire).toContain(PNG(3))
    expect(wire).toContain(PNG(1))
    expect(wire).not.toContain('media-ref')
    await new Promise((r) => setTimeout(r, 10))
    const left = (await fs.list('/.eharness/tool-media/')).map((f) => f.path)
    expect(left).toEqual(['/.eharness/tool-media/s1-c2-1.png', '/.eharness/tool-media/s1-c3-1.png'])
  })

  test('toolMedia: false leaves the media in the output', async () => {
    const { agent, fs } = setup({ toolMedia: false }, 1)
    const result = await agent.session('s1').send('go').result
    expect(JSON.stringify(result.messages)).toContain('"data"')
    expect(await fs.list('/.eharness/')).toEqual([])
  })

  test('an adapter without writeBytes leaves the media in the output', async () => {
    const inner = inMemoryFs()
    const plain = {
      read: inner.read.bind(inner),
      write: inner.write.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
    }
    const { agent } = setup({}, 1, plain as never)
    const result = await agent.session('s1').send('go').result
    expect(JSON.stringify(result.messages)).toContain('"data"')
  })
})
