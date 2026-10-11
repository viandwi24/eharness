import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type HarnessAgent } from '../index.ts'
import { inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { type SubagentOptions, subagent } from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

function setup(files: SubagentOptions['files'], approvals: 'inline' | 'policy' = 'policy') {
  const storage = { messages: inMemoryMessages(), state: inMemoryState() }
  const childModel = scriptedModel([{ text: 'child saw it' }])
  const worker = defineHarnessAgent({
    model: childModel,
    contextWindow: 100_000,
    storage,
    logger: silent,
    inputFiles: {
      protocols: ['data:', 'https:', 'library:'],
      resolve: (url) =>
        url.startsWith('library:') ? { data: 'aGk=', mediaType: 'image/png' } : undefined,
    },
  }) as Agent
  const parentModel = (calls: unknown[]) =>
    scriptedModel([
      {
        toolCalls: calls.map((input, i) => ({
          toolName: 'agent',
          toolCallId: `c${i}`,
          input: {
            subagent_type: 'worker',
            description: 'look',
            prompt: 'describe the photo',
            ...(input as object),
          },
        })),
      },
      { text: 'parent done' },
    ])
  const parents: ReturnType<typeof scriptedModel>[] = []
  const main = (calls: unknown[]) => {
    const model = parentModel(calls)
    parents.push(model)
    return defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage,
      logger: silent,
      plugins: [
        subagent({
          agents: { worker: { agent: worker, description: 'does work' } },
          approvals,
          ...(files === undefined ? {} : { files }),
        }),
      ] as never,
    }) as Agent
  }
  return { main, childModel, worker, parents }
}

const okFiles: SubagentOptions['files'] = {
  max: 2,
  resolve: (ref) =>
    ref === 'library:///uploads/a.png'
      ? { url: ref, mediaType: 'image/png', filename: 'a.png' }
      : ref === 'big'
        ? { error: 'the file "big" is 30 MB; the limit is 10 MB.' }
        : (() => {
            throw new Error('boom')
          })(),
}

function agentResult(messages: Array<{ parts: unknown[] }>) {
  return messages
    .flatMap((m) => m.parts as Array<{ type: string; output?: unknown; errorText?: string }>)
    .find((p) => p.type === 'tool-agent')
}

describe('agent tool: files', () => {
  test('files become file parts of the child first message, resolved for its model', async () => {
    const { main, childModel } = setup(okFiles)
    const agent = main([{ files: ['library:///uploads/a.png'] }])
    const session = agent.session('p1')
    expect((await session.send('go').result).stop).toBe('complete')
    const user = childModel.prompts[0]?.find((m) => m.role === 'user')
    const parts = (user?.content ?? []) as Array<{ type: string; mediaType?: string }>
    expect(parts.map((p) => p.type)).toEqual(['text', 'file'])
    expect(parts[1]?.mediaType).toBe('image/png')
    // stored in the child as a reference, not as bytes
    const stored = JSON.stringify(await agent.session('p1:agent:c0').messages())
    expect(stored).toContain('library:///uploads/a.png')
    await agent.close()
  })

  test('the files field exists only with the option', async () => {
    const withFiles = setup(okFiles)
    const plain = setup(undefined)
    await withFiles.main([{}]).session('s').send('go').result
    await plain.main([{}]).session('s').send('go').result
    const props = (m: ReturnType<typeof scriptedModel> | undefined): string[] => {
      const t = m?.calls[0]?.tools?.find((x) => x.name === 'agent') as
        | { inputSchema?: { properties?: Record<string, unknown> } }
        | undefined
      return Object.keys(t?.inputSchema?.properties ?? {})
    }
    expect(props(withFiles.parents[0])).toContain('files')
    expect(props(plain.parents[0])).not.toContain('files')
  })

  test.each([
    [['big'], 'the limit is 10 MB'],
    [['other'], 'could not read the file "other": boom'],
    [['library:///uploads/a.png', 'x', 'y'], 'at most 2 files'],
  ])('a bad reference %p is a readable error and no child starts', async (refs, text) => {
    const { main, childModel } = setup(okFiles)
    const agent = main([{ files: refs }])
    const session = agent.session('p1')
    await session.send('go').result
    const part = agentResult((await session.messages()) as never)
    expect(String(part?.output ?? part?.errorText)).toContain(text)
    expect(String(part?.output ?? part?.errorText)).toStartWith('ERROR')
    expect(childModel.calls).toHaveLength(0)
    await agent.close()
  })
})
