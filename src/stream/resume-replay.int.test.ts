/**
 * Resume replay of a continuation (spec 04 §6.3, ADR-0045): AI SDK's real `AbstractChat.resumeStream()`
 * against `handleResumeRequest`, for a `respond()` continuation (client tool, approval), a normal
 * turn, and a cursor.
 */
import { describe, expect, test } from 'bun:test'
import {
  AbstractChat,
  type ChatState,
  type ChatStatus,
  DefaultChatTransport,
  tool,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessSession } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { messageToChunks } from '../messages/replay.ts'
import { defaultMemoryMessages, defaultMemoryState } from '../session/memory-storage.ts'
import { memoryStreamLog } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { handleChatRequest, handleResumeRequest } from './chat-request.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class TestChat extends AbstractChat<UIMessage> {
  constructor(init: {
    id: string
    messages: UIMessage[]
    transport: DefaultChatTransport<UIMessage>
  }) {
    const state: ChatState<UIMessage> = {
      status: 'ready' as ChatStatus,
      error: undefined,
      messages: init.messages,
      pushMessage(message) {
        state.messages = [...state.messages, message]
      },
      popMessage() {
        state.messages = state.messages.slice(0, -1)
      },
      replaceMessage(index, message) {
        state.messages = state.messages.map((m, i) => (i === index ? message : m))
      },
      snapshot: (thing) => structuredClone(thing),
    }
    super({ ...init, state })
  }
}

function world() {
  const messages = defaultMemoryMessages()
  const state = defaultMemoryState()
  const streams = memoryStreamLog()
  const make = (config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>) =>
    defineHarnessAgent({
      contextWindow: 100_000,
      storage: { messages, state, streams },
      streams: { flushMs: 5, pollMs: 10 },
      logger: silent,
      ...config,
    })
  return { make }
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

type Sess = HarnessSession<UIMessage>
const sessionOf = (
  agent: ReturnType<typeof world>['make'] extends (c: never) => infer A ? A : never,
  id: string,
) => agent.session(id) as unknown as Sess

/** A fresh client ("page reload") holding `messages`, whose resume GET goes to `session`. */
function clientOf(session: Sess, messages: UIMessage[], query = ''): TestChat {
  const transport = new DefaultChatTransport<UIMessage>({
    api: 'http://test.local/api/chat',
    prepareReconnectToStreamRequest: () => ({ api: `http://test.local/api/chat/stream${query}` }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handleResumeRequest(session, new Request(input, init))) as typeof fetch,
  })
  return new TestChat({ id: 's1', messages, transport })
}

async function sseChunks(res: Response): Promise<UIMessageChunk[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .map((e) => e.replace(/^data: /, '').trim())
    .filter((e) => e !== '' && e !== '[DONE]')
    .map((e) => JSON.parse(e) as UIMessageChunk)
}

async function settled(chat: TestChat): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await sleep(5)
    if (chat.status === 'ready' || chat.status === 'error') return
  }
  throw new Error(`chat did not settle (status ${chat.status})`)
}

const asAssistant = async (session: Sess): Promise<UIMessage> =>
  (await session.messages()).filter((m) => m.role === 'assistant').at(-1) as UIMessage

for (const where of ['same process', 'other instance'] as const) {
  describe(`resume of a respond() continuation (${where})`, () => {
    test('client tool: AbstractChat rebuilds the message and applies the continuation', async () => {
      const w = world()
      const g = gatedTool()
      const tools = {
        location: tool({ description: 'Browser location', inputSchema: z.object({}) }),
        step: g.step,
      }
      const one = w.make({
        model: scriptedModel([
          { toolCalls: [{ toolName: 'location', input: {} }] },
          stepCall,
          { text: 'Oslo it is.' },
        ]),
        tools,
      })
      const two = w.make({ model: scriptedModel([]), tools })
      await sessionOf(one, 's1').send('where am I?').result
      const pending = await asAssistant(sessionOf(one, 's1'))
      const before = structuredClone(pending)
      const answered = structuredClone(pending) as { parts: Array<Record<string, unknown>> }
      for (const p of answered.parts) {
        if (p.type === 'tool-location')
          Object.assign(p, { state: 'output-available', output: 'Oslo' })
      }
      const run = handleChatRequest(sessionOf(one, 's1'), {
        messages: [answered as unknown as UIMessage],
      })
      await g.started
      await sleep(30)
      const reader = where === 'same process' ? one : two
      const chat = clientOf(sessionOf(reader, 's1'), [before])
      const resuming = chat.resumeStream()
      g.release()
      await resuming
      await settled(chat)
      expect(chat.error).toBeUndefined()
      expect(chat.messages).toHaveLength(1)
      const final = chat.messages[0] as UIMessage
      expect(final.id).toBe(pending.id)
      expect(final.parts.find((p) => p.type === 'tool-location')).toMatchObject({
        state: 'output-available',
        output: 'Oslo',
      })
      expect(
        final.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text),
      ).toEqual(['Oslo it is.'])
      expect(final.parts.filter((p) => p.type === 'step-start')).toHaveLength(3)
      await run.result
      await one.close()
      await two.close()
    })

    test('approval: AbstractChat rebuilds the message and applies the continuation', async () => {
      const w = world()
      const g = gatedTool()
      const config = {
        tools: { step: g.step },
        approval: { policy: { step: 'user-approval' as const } },
      }
      const one = w.make({ model: scriptedModel([stepCall, { text: 'Done.' }]), ...config })
      const two = w.make({ model: scriptedModel([]), ...config })
      await sessionOf(one, 's1').send('go').result
      const pending = await asAssistant(sessionOf(one, 's1'))
      const before = structuredClone(pending)
      const part = pending.parts.find((p) => p.type === 'tool-step') as { approval: { id: string } }
      const approved = structuredClone(pending) as { parts: Array<Record<string, unknown>> }
      for (const p of approved.parts) {
        if (p.type === 'tool-step') {
          Object.assign(p, {
            state: 'approval-responded',
            approval: { id: part.approval.id, approved: true },
          })
        }
      }
      const run = handleChatRequest(sessionOf(one, 's1'), {
        messages: [approved as unknown as UIMessage],
      })
      await g.started
      await sleep(30)
      const chat = clientOf(sessionOf(where === 'same process' ? one : two, 's1'), [before])
      const resuming = chat.resumeStream()
      g.release()
      await resuming
      await settled(chat)
      expect(chat.error).toBeUndefined()
      const final = chat.messages[0] as UIMessage
      expect(final.id).toBe(pending.id)
      expect(final.parts.find((p) => p.type === 'tool-step')).toMatchObject({
        state: 'output-available',
        output: 'ok',
      })
      expect(final.parts.some((p) => p.type === 'text' && p.text === 'Done.')).toBe(true)
      await run.result
      await one.close()
      await two.close()
    })

    test('a normal running turn replays in full, unchanged', async () => {
      const w = world()
      const g = gatedTool()
      const one = w.make({
        model: scriptedModel([stepCall, { text: 'fin' }]),
        tools: { step: g.step },
      })
      const two = w.make({ model: scriptedModel([]), tools: { step: g.step } })
      const run = sessionOf(one, 's1').send('go')
      const raw: UIMessageChunk[] = []
      void (async () => {
        for await (const c of run.stream) raw.push(c)
      })()
      await g.started
      await sleep(30)
      const reader = sessionOf(where === 'same process' ? one : two, 's1')
      const res = await handleResumeRequest(reader, new Request('http://x/stream'))
      g.release()
      const replay = await sseChunks(res)
      await run.result
      await sleep(20)
      expect(replay).toEqual(JSON.parse(JSON.stringify(raw)))
      expect(replay[0]?.type).toBe('start')
      await one.close()
      await two.close()
    })

    test('from > 0 continues the replay view; from=0 is the full replay', async () => {
      const w = world()
      const g = gatedTool()
      const config = {
        tools: { step: g.step },
        approval: { policy: { step: 'user-approval' as const } },
      }
      const one = w.make({ model: scriptedModel([stepCall, { text: 'Done.' }]), ...config })
      const two = w.make({ model: scriptedModel([]), ...config })
      await sessionOf(one, 's1').send('go').result
      const pending = await asAssistant(sessionOf(one, 's1'))
      const part = pending.parts.find((p) => p.type === 'tool-step') as { approval: { id: string } }
      const approved = structuredClone(pending) as { parts: Array<Record<string, unknown>> }
      for (const p of approved.parts) {
        if (p.type === 'tool-step') {
          Object.assign(p, {
            state: 'approval-responded',
            approval: { id: part.approval.id, approved: true },
          })
        }
      }
      const run = handleChatRequest(sessionOf(one, 's1'), {
        messages: [approved as unknown as UIMessage],
      })
      await g.started
      await sleep(30)
      const reader = sessionOf(where === 'same process' ? one : two, 's1')
      const full = handleResumeRequest(reader, new Request('http://x/stream'))
      const tail = handleResumeRequest(reader, new Request('http://x/stream?from=3'))
      g.release()
      const fullChunks = await sseChunks(await full)
      const tailChunks = await sseChunks(await tail)
      await run.result
      expect(fullChunks[0]).toMatchObject({ type: 'start', messageId: pending.id })
      expect(fullChunks.some((c) => c.type === 'tool-input-available')).toBe(true)
      expect(fullChunks.filter((c) => c.type === 'start')).toHaveLength(1)
      expect(tailChunks).toEqual(fullChunks.slice(3))
      await one.close()
      await two.close()
    })
  })
}

describe('messageToChunks', () => {
  test('starts with the message id and metadata, never replays transient parts', () => {
    const chunks = messageToChunks({
      id: 'a',
      role: 'assistant',
      metadata: { x: 1 },
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'hi', state: 'done' },
        { type: 'data-note', id: 'n', data: 1 },
        {
          type: 'tool-t',
          toolCallId: 'c',
          state: 'approval-responded',
          input: {},
          approval: { id: 'ap', approved: true },
        },
      ],
    } as unknown as UIMessage)
    expect(chunks.map((c) => c.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'data-note',
      'tool-input-available',
      'tool-approval-request',
      'tool-approval-response',
      'finish-step',
    ])
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'a', messageMetadata: { x: 1 } })
  })
})
