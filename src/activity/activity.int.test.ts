import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, externalTool, type HarnessAgent, type StateAdapter } from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { subagentChild, subagents } from '../subagent/index.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  activity,
  activityStream,
  answerAttention,
  handleActivityStream,
  listAttention,
  memoryActivityStore,
  readActivityPage,
} from './index.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(5)
  }
}

type Storage = { messages: ReturnType<typeof memoryMessages>; state: StateAdapter }
const shared = (): Storage => ({ messages: memoryMessages(), state: memoryState() })
// biome-ignore lint/suspicious/noExplicitAny: loosely typed agents in tests
type Agent = HarnessAgent<any>

const pay = (log: string[] = []) =>
  tool({
    description: 'Pays',
    inputSchema: z.object({ amount: z.number() }),
    execute: async ({ amount }) => {
      log.push(`paid ${amount}`)
      return `paid ${amount}`
    },
  })

function payAgent(
  storage: Storage,
  steps: Parameters<typeof scriptedModel>[0],
  store: ReturnType<typeof memoryActivityStore>,
  log: string[] = [],
  extra: unknown[] = [],
): Agent {
  return defineHarnessAgent({
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage,
    logger: silent,
    onWarning() {},
    tools: { pay: pay(log) },
    approval: { policy: { pay: 'user-approval' } },
    plugins: [activity({ store }), ...extra] as never,
  }) as Agent
}

const types = async (store: ReturnType<typeof memoryActivityStore>, sessionId?: string) =>
  (
    await store.read({ after: 0, limit: 500, ...(sessionId === undefined ? {} : { sessionId }) })
  ).map((r) => r.type)

describe('activity() plugin', () => {
  test('a plain turn: turn-started, step-finished, message-saved, turn-ended', async () => {
    const store = memoryActivityStore()
    const agent = payAgent(shared(), [{ text: 'hello' }], store)
    const run = agent.session('s1').send('hi')
    await run.result
    const records = await store.read({ after: 0, limit: 100 })
    const seen = records.map((r) => r.type)
    expect(seen[0]).toBe('message-saved') // the user message is saved before the turn starts
    expect(seen).toContain('turn-started')
    expect(seen).toContain('step-finished')
    expect(seen.at(-1)).toBe('turn-ended')
    const started = records.find((r) => r.type === 'turn-started')
    expect(started?.sessionId).toBe('s1')
    expect(started?.payload).toMatchObject({ kind: 'send', source: 'user', queued: false })
    const ended = records.find((r) => r.type === 'turn-ended')
    expect(ended?.payload).toMatchObject({ kind: 'send', stop: 'complete' })
    const saved = records.filter((r) => r.type === 'message-saved').map((r) => r.payload.role)
    expect(saved).toContain('user')
    expect(saved).toContain('assistant')
    for (let i = 1; i < records.length; i++) {
      expect((records[i] as { seq: number }).seq).toBeGreaterThan(
        (records[i - 1] as { seq: number }).seq,
      )
    }
    await agent.close()
  })

  test('an approval opens a pending item; answering resolves it and records the decision', async () => {
    const store = memoryActivityStore()
    const agent = payAgent(
      shared(),
      [{ toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] }, { text: 'done' }],
      store,
    )
    const first = await agent.session('s1').send('pay').result
    expect(first.stop).toBe('tool-pending')
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const opened = (await store.read({ after: 0, limit: 100, types: ['pending-changed'] }))[0]
    expect(opened?.payload.waiting).toEqual([
      { kind: 'approval', id: approvalId, toolCallId: expect.any(String), toolName: 'pay' },
    ])
    await agent
      .session('s1')
      .respond({ approvals: [{ id: approvalId, approved: true, actor: { id: 'u1' } }] }).result
    const all = await store.read({ after: 0, limit: 100 })
    const decided = all.find((r) => r.type === 'approval-decided')
    expect(decided?.payload).toMatchObject({
      id: approvalId,
      approved: true,
      by: 'user',
      actor: 'u1',
    })
    const last = all.filter((r) => r.type === 'pending-changed').at(-1)
    expect(last?.payload).toMatchObject({ waiting: [], answered: [] })
    expect(all.filter((r) => r.type === 'turn-started').map((r) => r.payload.source)).toEqual([
      'user',
      'respond',
    ])
    await agent.close()
  })

  test('types and sessions options narrow the feed', async () => {
    const store = memoryActivityStore()
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'a' }, { text: 'b' }]),
      contextWindow: 100_000,
      storage: shared(),
      logger: silent,
      plugins: [
        activity({ store, types: ['turn-ended'], sessions: (id) => id.startsWith('keep:') }),
      ] as never,
    }) as Agent
    await agent.session('keep:1').send('x').result
    await agent.session('drop:1').send('x').result
    expect(await types(store)).toEqual(['turn-ended'])
    await agent.close()
  })

  test('a crashed turn that was recovered emits session-recovered', async () => {
    const storage = shared()
    const store = memoryActivityStore()
    const a = payAgent(storage, [{ text: 'never' }], store)
    const s = a.session('s1')
    await s.ready()
    // simulate a dead process: an active turn with an old heartbeat
    await storage.state.set('s1', {
      v: 1,
      rev: 1,
      core: {
        activeTurn: {
          turnId: 't-dead',
          messageId: '018f0000-0000-7000-8000-000000000001',
          owner: 'dead-instance',
          startedAt: 1,
          heartbeatAt: 1,
        },
      },
      plugins: {},
    } as never)
    const b = payAgent(storage, [{ text: 'x' }], store)
    const r = await b.session('s1').recover()
    expect(r.recovered).toBe(true)
    expect(await types(store, 's1')).toContain('session-recovered')
    await a.close()
    await b.close()
  })
})

describe('attention queue', () => {
  const setup = async () => {
    const store = memoryActivityStore()
    const log: string[] = []
    const storage = shared()
    const agent = payAgent(
      storage,
      [{ toolCalls: [{ toolName: 'pay', input: { amount: 7 } }] }, { text: 'done' }],
      store,
      log,
    )
    const first = await agent.session('s1').send('pay').result
    return { store, log, storage, agent, first }
  }

  test('listAttention lists the item with routing info', async () => {
    const { agent, first } = await setup()
    const items = await listAttention({
      roots: [{ sessionId: 's1', agent: 'main' }],
      peek: (id) => agent.peek(id),
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: first.pending?.approvals[0]?.approvalId,
      kind: 'approval',
      sessionId: 's1',
      parentSessionId: null,
      rootSessionId: 's1',
      agent: 'main',
      toolName: 'pay',
      input: { amount: 7 },
      answeredWaiting: 0,
    })
    expect(typeof items[0]?.createdAt).toBe('number')
    await agent.close()
  })

  test('answerAttention resumes; a second answer is already-answered; unknown ids are not-found', async () => {
    const { agent, store, log, first } = await setup()
    const id = first.pending?.approvals[0]?.approvalId as string
    const opts = {
      sessionId: 's1',
      open: (s: string) => agent.session(s) as never,
      peek: (s: string) => agent.peek(s),
      store,
      actor: { id: 'u1' },
    }
    const r = await answerAttention(id, { ...opts, answer: { kind: 'approval', approved: true } })
    expect(r.status).toBe('resumed')
    expect((await r.done)?.stop).toBe('complete')
    expect(log).toEqual(['paid 7'])
    const again = await answerAttention(id, {
      ...opts,
      answer: { kind: 'approval', approved: true },
    })
    expect(again.status).toBe('already-answered')
    const other = await answerAttention(id, {
      ...opts,
      answer: { kind: 'approval', approved: false },
    })
    expect(other.status).toBe('already-answered')
    expect(log).toEqual(['paid 7'])
    const none = await answerAttention('nope', {
      ...opts,
      answer: { kind: 'approval', approved: true },
    })
    expect(none.status).toBe('not-found')
    const events = await store.read({ after: 0, limit: 100, types: ['attention-answered'] })
    expect(events.map((e) => e.payload.status)).toEqual([
      'resumed',
      'already-answered',
      'already-answered',
      'not-found',
    ])
    expect(events[0]?.payload).toMatchObject({ id, kind: 'approval', approved: true, actor: 'u1' })
    await agent.close()
  })

  test('the wrong kind of answer is EH_INVALID_INPUT and changes nothing', async () => {
    const { agent, first } = await setup()
    const id = first.pending?.approvals[0]?.approvalId as string
    await expect(
      answerAttention(id, {
        sessionId: 's1',
        open: (s) => agent.session(s) as never,
        peek: (s) => agent.peek(s),
        answer: { kind: 'client-tool', output: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'EH_INVALID_INPUT' })
    expect((await agent.peek('s1').pending())?.approvals).toHaveLength(1)
    await agent.close()
  })

  test('the same item answered from two instances at once: one resumes, the other is late', async () => {
    const store = memoryActivityStore()
    const storage = shared()
    const log: string[] = []
    const a = payAgent(
      storage,
      [{ toolCalls: [{ toolName: 'pay', input: { amount: 1 } }] }, { text: 'done' }],
      store,
      log,
    )
    const b = payAgent(storage, [{ text: 'done by b' }], store, log)
    const first = await a.session('s1').send('pay').result
    const id = first.pending?.approvals[0]?.approvalId as string
    const call = (agent: Agent) =>
      answerAttention(id, {
        sessionId: 's1',
        open: (s) => agent.session(s) as never,
        peek: (s) => agent.peek(s),
        answer: { kind: 'approval', approved: true },
      })
    const results = await Promise.all([call(a), call(b)])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual(['already-answered', 'resumed'])
    await until('continuation ran', () => log.length > 0)
    expect(log).toEqual(['paid 1'])
    await a.close()
    await b.close()
  })

  test('a partial batch is recorded (remaining), the last answer resumes', async () => {
    const store = memoryActivityStore()
    const agent = payAgent(
      shared(),
      [
        {
          toolCalls: [
            { toolName: 'pay', input: { amount: 1 }, toolCallId: 'c1' },
            { toolName: 'pay', input: { amount: 2 }, toolCallId: 'c2' },
          ],
        },
        { text: 'done' },
      ],
      store,
    )
    const first = await agent.session('s1').send('pay both').result
    const [x, y] = (first.pending?.approvals ?? []).map((a) => a.approvalId) as [string, string]
    const base = {
      sessionId: 's1',
      open: (s: string) => agent.session(s) as never,
      peek: (s: string) => agent.peek(s),
    }
    const one = await answerAttention(x, { ...base, answer: { kind: 'approval', approved: true } })
    expect(one).toMatchObject({ status: 'recorded', remaining: 1 })
    const listed = await listAttention({ roots: ['s1'], peek: (id) => agent.peek(id) })
    expect(listed.map((i) => i.id)).toEqual([y])
    expect(listed[0]?.answeredWaiting).toBe(1)
    const dup = await answerAttention(x, { ...base, answer: { kind: 'approval', approved: true } })
    expect(dup.status).toBe('already-answered')
    const two = await answerAttention(y, { ...base, answer: { kind: 'approval', approved: true } })
    expect(two.status).toBe('resumed')
    await two.done
    expect(await agent.peek('s1').pending()).toBeNull()
    await agent.close()
  })

  test('client tool questions are answered with an output', async () => {
    const store = memoryActivityStore()
    const ask = tool({ description: 'Ask', inputSchema: z.object({ q: z.string() }) })
    const agent = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'ask', input: { q: 'ok?' } }] },
        { text: 'thanks' },
      ]),
      contextWindow: 100_000,
      storage: shared(),
      logger: silent,
      tools: { ask },
      plugins: [activity({ store })] as never,
    }) as Agent
    const first = await agent.session('s1').send('go').result
    expect(first.stop).toBe('tool-pending')
    const items = await listAttention({ roots: ['s1'], peek: (id) => agent.peek(id) })
    expect(items[0]).toMatchObject({ kind: 'client-tool', toolName: 'ask', input: { q: 'ok?' } })
    const r = await answerAttention(items[0]?.id as string, {
      sessionId: 's1',
      open: (s) => agent.session(s) as never,
      peek: (s) => agent.peek(s),
      answer: { kind: 'client-tool', output: 'yes' },
    })
    expect(r.status).toBe('resumed')
    expect((await r.done)?.stop).toBe('complete')
    await agent.close()
  })

  test('external waits are listed on request and resolved through answerAttention', async () => {
    const store = memoryActivityStore()
    const approve = externalTool({
      description: 'Waits for a person outside',
      inputSchema: z.object({ what: z.string() }),
      outputSchema: z.string(),
      onTimeout: { errorText: 'timed out' },
    })
    const agent = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'outside', input: { what: 'x' } }] },
        { text: 'done' },
      ]),
      contextWindow: 100_000,
      storage: shared(),
      logger: silent,
      tools: { outside: approve },
      plugins: [activity({ store })] as never,
    }) as Agent
    const first = await agent.session('s1').send('go').result
    expect(first.stop).toBe('tool-pending')
    expect(await listAttention({ roots: ['s1'], peek: (id) => agent.peek(id) })).toEqual([])
    const items = await listAttention({ roots: ['s1'], peek: (id) => agent.peek(id), waits: true })
    expect(items[0]).toMatchObject({ kind: 'wait', toolName: 'outside' })
    const base = {
      sessionId: 's1',
      open: (s: string) => agent.session(s) as never,
      peek: (s: string) => agent.peek(s),
    }
    const r = await answerAttention(items[0]?.id as string, {
      ...base,
      answer: { kind: 'wait', output: 'fine' },
    })
    expect(r.status).toBe('resumed')
    await r.done
    const again = await answerAttention(items[0]?.id as string, {
      ...base,
      answer: { kind: 'wait', output: 'fine' },
    })
    expect(again.status).toBe('already-answered')
    await agent.close()
  })
})

describe('child approvals while the parent is parked', () => {
  test('listAttention finds the child through the parent; the answer goes to the child, the parent resumes', async () => {
    const storage = shared()
    const store = memoryActivityStore()
    const log: string[] = []
    const holder: { main?: Agent } = {}
    const worker = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'danger', input: { what: 'rm' } }] },
        { text: 'child report' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      tools: {
        danger: tool({
          description: 'danger',
          inputSchema: z.object({ what: z.string() }),
          execute: async ({ what }) => {
            log.push(what)
            return `did ${what}`
          },
        }),
      },
      approval: { policy: { danger: 'user-approval' } },
      plugins: [
        activity({ store }),
        subagentChild({ parent: () => holder.main as Agent }),
      ] as never,
    }) as Agent
    const main = defineHarnessAgent({
      model: scriptedModel([
        {
          toolCalls: [
            {
              toolName: 'agent',
              input: { subagent_type: 'worker', description: 'task', prompt: 'do it' },
              toolCallId: 'call-0-0',
            },
          ],
        },
        { text: 'parent done' },
      ]),
      contextWindow: 100_000,
      storage,
      logger: silent,
      plugins: [
        activity({ store }),
        subagents({
          agents: { worker: { agent: worker, description: 'works' } },
          approvals: 'park',
        }),
      ] as never,
    }) as Agent
    holder.main = main

    const first = await main.session('p1').send('go').result
    expect(first.stop).toBe('tool-pending')
    const agentFor = (id: string): Agent => (id === 'p1' ? main : worker)
    const items = await listAttention({
      roots: [{ sessionId: 'p1', agent: 'main' }],
      peek: (id) => agentFor(id).peek(id),
    })
    // the parked parent's own wait is not an item; the child's approval is
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'approval',
      toolName: 'danger',
      parentSessionId: 'p1',
      rootSessionId: 'p1',
      agent: 'worker',
    })
    const childId = items[0]?.sessionId as string
    expect(childId).not.toBe('p1')

    const r = await answerAttention(items[0]?.id as string, {
      sessionId: childId, // the child, never the parent
      open: (s) => agentFor(s).session(s) as never,
      peek: (s) => agentFor(s).peek(s),
      store,
      actor: { id: 'u1' },
      answer: { kind: 'approval', approved: true },
    })
    expect(r.status).toBe('resumed')
    expect((await r.done)?.stop).toBe('complete')
    expect(log).toEqual(['rm'])
    await until('parent continued', async () =>
      JSON.stringify(await main.session('p1').messages()).includes('parent done'),
    )
    expect(await listAttention({ roots: ['p1'], peek: (id) => agentFor(id).peek(id) })).toEqual([])
    const again = await answerAttention(items[0]?.id as string, {
      sessionId: childId,
      open: (s) => agentFor(s).session(s) as never,
      peek: (s) => agentFor(s).peek(s),
      answer: { kind: 'approval', approved: true },
    })
    expect(again.status).toBe('already-answered')
    const reported = await store.read({ after: 0, limit: 200, types: ['child-reported'] })
    expect(reported[0]).toMatchObject({
      sessionId: 'p1',
      payload: { childSessionId: childId, status: 'completed' },
    })
    await main.close()
    await worker.close()
  })
})

describe('sse', () => {
  const read = async (response: Response, until: (text: string) => boolean): Promise<string> => {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    const end = Date.now() + 3000
    while (Date.now() < end && !until(text)) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    await reader.cancel()
    return text
  }

  test('first flush has retry, a comment and the boot event; new events follow with id: seq', async () => {
    const store = memoryActivityStore()
    const ac = new AbortController()
    const response = handleActivityStream(new Request('http://x/events', { signal: ac.signal }), {
      store,
      bootId: 'boot-1',
      pollMs: 10,
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    setTimeout(() => void store.append({ type: 'settings-changed', payload: { a: 1 } }), 30)
    const text = await read(response, (t) => t.includes('settings-changed'))
    ac.abort()
    expect(
      text.startsWith('retry: 3000\n: connected\nevent: boot\ndata: {"boot":"boot-1"}\n\n'),
    ).toBe(true)
    expect(text).toContain('id: 1\nevent: settings-changed\ndata: {"seq":1,')
  })

  test('Last-Event-ID resumes after the cursor; a cursor from before the prune mark gets resync', async () => {
    const store = memoryActivityStore()
    for (let i = 0; i < 8; i++) await store.append({ type: 'e', payload: { i } })
    const resumed = handleActivityStream(
      new Request('http://x/events', { headers: { 'last-event-id': '6' } }),
      { store, pollMs: 10 },
    )
    const t1 = await read(resumed, (t) => t.includes('id: 8'))
    expect(t1).toContain('id: 7\n')
    expect(t1).toContain('id: 8\n')
    expect(t1).not.toContain('id: 6\n')
    expect(t1).not.toContain('resync')

    await store.prune({ keepLast: 3 }) // prunedThrough = 5
    const behind = handleActivityStream(new Request('http://x/events?after=2'), {
      store,
      pollMs: 10,
    })
    const t2 = await read(behind, (t) => t.includes('id: 8'))
    expect(t2).toContain('event: resync\ndata: {"seq":5}')
    expect(t2.indexOf('resync')).toBeLessThan(t2.indexOf('id: 6'))
    expect(t2).toContain('id: 6\n')
    // a fresh client (no cursor) starts at the head and never resyncs
    const fresh = handleActivityStream(new Request('http://x/events'), { store, pollMs: 10 })
    setTimeout(() => void store.append({ type: 'later' }), 30)
    const t3 = await read(fresh, (t) => t.includes('later'))
    expect(t3).not.toContain('resync')
    expect(t3).not.toContain('id: 8\n')
    expect(t3).toContain('id: 9\n')
  })

  test('a cursor ahead of the head (the log was reset) gets resync; an invalid cursor is a 400', async () => {
    const store = memoryActivityStore()
    await store.append({ type: 'e' })
    const ahead = handleActivityStream(new Request('http://x/events?after=99'), {
      store,
      pollMs: 10,
    })
    const text = await read(ahead, (t) => t.includes('resync'))
    expect(text).toContain('event: resync\ndata: {"seq":1}')
    const bad = handleActivityStream(new Request('http://x/events?after=abc'), { store })
    expect(bad.status).toBe(400)
  })

  test('filter hides records but the cursor advances; keep-alive comments flow while quiet', async () => {
    const store = memoryActivityStore()
    const stream = activityStream({
      store,
      after: 0,
      pollMs: 5,
      keepAliveMs: 20,
      filter: (r) => r.type !== 'hidden',
    })
    await store.append([{ type: 'hidden' }, { type: 'shown' }])
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const end = Date.now() + 3000
    while (Date.now() < end && !text.includes(': keep-alive')) {
      text += decoder.decode((await reader.read()).value)
    }
    await reader.cancel()
    expect(text).toContain('event: shown')
    expect(text).not.toContain('hidden')
    expect(text).toContain(': keep-alive')
  })

  test('readActivityPage mirrors the stream: lastSeq, resync flag', async () => {
    const store = memoryActivityStore()
    for (let i = 0; i < 6; i++) await store.append({ type: 'e' })
    await store.prune({ keepLast: 2 }) // mark 4
    const page = await readActivityPage(store, { after: 1, limit: 10 })
    expect(page.resync).toBe(true)
    expect(page.events.map((e) => e.seq)).toEqual([5, 6])
    expect(page.lastSeq).toBe(6)
    const ok = await readActivityPage(store, { after: 5, limit: 10 })
    expect(ok.resync).toBeUndefined()
    const idle = await readActivityPage(store, { after: 6, limit: 10 })
    expect(idle).toEqual({ events: [], lastSeq: 6 })
    expect((await readActivityPage(store, { after: 0, limit: 10 })).resync).toBeUndefined()
  })
})
