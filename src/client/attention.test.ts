import { describe, expect, test } from 'bun:test'
import type { ActivityRecord, AttentionItem } from '../activity/index.ts'
import { ATTENTION_EVENTS, createAttentionList } from './attention.ts'
import type { Clock } from './clock.ts'
import { createHarnessClient } from './http-client.ts'

const item = (id: string, sessionId = 's1', extra: Partial<AttentionItem> = {}): AttentionItem =>
  ({
    id,
    kind: 'approval',
    sessionId,
    parentSessionId: null,
    rootSessionId: sessionId,
    toolCallId: `tc-${id}`,
    toolName: 'write',
    input: null,
    risk: null,
    messageId: 'm',
    createdAt: 1,
    ...extra,
  }) as AttentionItem

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const record = (
  type: string,
  payload: Record<string, unknown> = {},
  sessionId: string | null = 's1',
): ActivityRecord => ({
  seq: 1,
  type,
  sessionId,
  agentId: null,
  payload,
  createdAt: 1,
})

/** A manual clock: timers run when the test says so. */
function manualClock(): Partial<Clock> & { run(): void; pending(): number } {
  let next = 1
  const tasks = new Map<number, () => void>()
  return {
    setTimeout(fn) {
      const id = next++
      tasks.set(id, fn)
      return id
    },
    clearTimeout(handle) {
      tasks.delete(handle as number)
    },
    run() {
      for (const [id, fn] of [...tasks]) {
        tasks.delete(id)
        fn()
      }
    },
    pending: () => tasks.size,
  }
}

function setup(options: { sessionId?: string } = {}) {
  const w = {
    items: [item('a'), item('b'), item('c')],
    answer: (_id: string, _body: unknown): Response =>
      json({ status: 'resumed', id: 'a', sessionId: 's1' }),
    lists: 0,
    /** Held list responses, released by the test. */
    hold: undefined as undefined | Array<() => void>,
  }
  const client = createHarnessClient({
    baseUrl: '/api',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/attention')) {
        w.lists++
        const snapshot = [...w.items]
        if (w.hold !== undefined) await new Promise<void>((r) => w.hold?.push(r))
        return json({ items: snapshot })
      }
      return w.answer(url, JSON.parse(String(init?.body)))
    }) as typeof fetch,
  })
  const clock = manualClock()
  const list = createAttentionList({ client, clock, ...options })
  const ids = (): string[] => list.get().items.map((i) => i.id)
  return { w, list, clock, ids }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 2))

describe('attention list', () => {
  test('refresh loads the items; the snapshot is stable and frozen', async () => {
    const t = setup()
    expect(t.list.get()).toMatchObject({ items: [], loaded: false })
    await t.list.refresh()
    expect(t.ids()).toEqual(['a', 'b', 'c'])
    expect(t.list.get().loaded).toBe(true)
    expect(t.list.get()).toBe(t.list.get())
    expect(Object.isFrozen(t.list.get().items)).toBe(true)
  })

  test('a failed refresh keeps the items and reports the error', async () => {
    const t = setup()
    await t.list.refresh()
    const failing = createAttentionList({
      client: createHarnessClient({
        baseUrl: '/api',
        fetch: (async () =>
          json(
            { error: { code: 'EH_HTTP_FORBIDDEN', message: 'no' } },
            403,
          )) as unknown as typeof fetch,
      }),
    })
    await failing.refresh()
    expect(failing.get().error).toMatchObject({ status: 403 })
    expect(failing.get().loaded).toBe(false)
  })

  test('answer is optimistic: the item leaves at once, the answer carries the session id', async () => {
    const t = setup()
    await t.list.refresh()
    let sent: unknown
    let url = ''
    t.w.answer = (u, body) => {
      url = u
      sent = body
      return json({ status: 'resumed', id: 'b', sessionId: 's1' })
    }
    const pending = t.list.answer(item('b'), { kind: 'approval', approved: true })
    expect(t.ids()).toEqual(['a', 'c']) // before the request finished
    const result = await pending
    expect(result.status).toBe('resumed')
    expect(url).toBe('/api/attention/b/answer')
    expect(sent).toEqual({ sessionId: 's1', answer: { kind: 'approval', approved: true } })
    expect(t.clock.pending()).toBe(1) // a debounced refetch confirms
  })

  test('a failed answer puts the item back at its place and rethrows', async () => {
    const t = setup()
    await t.list.refresh()
    t.w.answer = () => json({ error: { code: 'EH_INTERNAL', message: 'boom' } }, 500)
    const failure = await t.list
      .answer(item('b'), { kind: 'approval', approved: false })
      .catch((e) => e)
    expect(failure).toMatchObject({ status: 500 })
    expect(t.ids()).toEqual(['a', 'b', 'c'])
  })

  test('a network failure also restores the item', async () => {
    const t = setup()
    await t.list.refresh()
    t.w.answer = () => {
      throw new TypeError('Failed to fetch')
    }
    await t.list.answer(item('a'), { kind: 'approval', approved: true }).catch(() => {})
    expect(t.ids()).toEqual(['a', 'b', 'c'])
  })

  test('already answered (409) and not found (404) keep the item gone', async () => {
    for (const [status, code] of [
      [409, 'EH_HTTP_ALREADY_ANSWERED'],
      [404, 'EH_HTTP_NOT_FOUND'],
    ] as const) {
      const t = setup()
      await t.list.refresh()
      t.w.answer = () => json({ error: { code, message: 'gone' } }, status)
      const failure = await t.list
        .answer(item('b'), { kind: 'approval', approved: true })
        .catch((e) => e)
      expect(failure.status).toBe(status)
      expect(t.ids()).toEqual(['a', 'c'])
    }
  })

  test('the 200 already-answered status is a result, not an error', async () => {
    const t = setup()
    await t.list.refresh()
    t.w.answer = () => json({ status: 'already-answered', id: 'b', sessionId: 's1' })
    expect((await t.list.answer(item('b'), { kind: 'approval', approved: true })).status).toBe(
      'already-answered',
    )
    expect(t.ids()).toEqual(['a', 'c'])
  })

  test('generation guard: a list fetched before a newer event refetches and never overwrites it', async () => {
    const t = setup()
    t.w.hold = []
    const first = t.list.refresh() // fetched with [a, b, c], held
    await flush()
    t.list.handleActivity(record('approval-decided', { id: 'a' }))
    expect(t.ids()).toEqual([]) // nothing loaded yet: nothing to remove
    t.w.items = [item('b'), item('c')]
    t.w.hold[0]?.() // the stale response arrives now
    await first
    // it wrote (it is the newest request) but saw a later event: a refetch is scheduled
    expect(t.clock.pending()).toBeGreaterThanOrEqual(1)
    t.w.hold = undefined
    t.clock.run()
    await flush()
    expect(t.ids()).toEqual(['b', 'c'])
  })

  test('only the newest request may write', async () => {
    const t = setup()
    t.w.hold = []
    const older = t.list.refresh()
    await flush()
    t.w.items = [item('x')]
    const newer = t.list.refresh()
    await flush()
    t.w.hold[1]?.()
    await newer
    expect(t.ids()).toEqual(['x'])
    t.w.hold[0]?.() // the older response (a, b, c) comes back last
    await older
    expect(t.ids()).toEqual(['x'])
  })

  test('approval-decided removes the card at once; list events are debounced into one refetch', async () => {
    const t = setup()
    await t.list.refresh()
    const before = t.w.lists
    t.list.handleActivity(record('approval-decided', { id: 'b' }))
    expect(t.ids()).toEqual(['a', 'c'])
    t.list.handleActivity(record('pending-changed'))
    t.list.handleActivity(record('turn-ended'))
    t.list.handleActivity(record('message-saved')) // not a list event
    expect(t.clock.pending()).toBe(1)
    t.w.items = [item('a'), item('c')]
    t.clock.run()
    await flush()
    expect(t.w.lists).toBe(before + 1)
    expect(t.ids()).toEqual(['a', 'c'])
  })

  test('approval-decided of another session does not remove an item with the same id', async () => {
    const t = setup()
    t.w.items = [item('x', 's1'), item('x', 's2')]
    await t.list.refresh()
    t.list.handleActivity(record('approval-decided', { id: 'x' }, 's2'))
    expect(t.list.get().items.map((i) => i.sessionId)).toEqual(['s1'])
  })

  test('handleResync refetches now', async () => {
    const t = setup()
    t.list.handleResync()
    await flush()
    expect(t.ids()).toEqual(['a', 'b', 'c'])
  })

  test('sessionId keeps the items of that session and of the sessions below it', async () => {
    const t = setup({ sessionId: 'lead' })
    t.w.items = [
      item('a', 'lead'),
      item('b', 'child', { parentSessionId: 'lead', rootSessionId: 'lead' }),
      item('c', 'other'),
    ]
    await t.list.refresh()
    expect(t.ids()).toEqual(['a', 'b'])
  })

  test('attach wires a feed (events and resyncs) and detaches', async () => {
    const t = setup()
    const eventFns = new Set<(r: ActivityRecord) => void>()
    const resyncFns = new Set<() => void>()
    const feed = {
      subscribeEvents(fn: (r: ActivityRecord) => void) {
        eventFns.add(fn)
        return () => eventFns.delete(fn)
      },
      subscribeResync(fn: () => void) {
        resyncFns.add(fn)
        return () => resyncFns.delete(fn)
      },
    }
    const detach = t.list.attach(feed as never)
    for (const fn of eventFns) fn(record('pending-changed'))
    expect(t.clock.pending()).toBe(1)
    for (const fn of resyncFns) fn()
    await flush()
    expect(t.ids()).toEqual(['a', 'b', 'c'])
    detach()
    expect(eventFns.size + resyncFns.size).toBe(0)
  })
})

describe('attention list: decided while a fetch is in flight', () => {
  test('an item decided during the fetch does not flash back from the stale response', async () => {
    const t = setup()
    await t.list.refresh()
    t.w.hold = []
    const inflight = t.list.refresh() // the server still lists a, b, c
    await flush()
    t.list.handleActivity(record('approval-decided', { id: 'b' }))
    expect(t.ids()).toEqual(['a', 'c'])
    t.w.hold[0]?.()
    await inflight
    expect(t.ids()).toEqual(['a', 'c'])
  })
})

describe('attention list: list source, events, answers', () => {
  type Row = { id: string; sessionId: string; agentName: string }
  const rows: Row[] = [
    { id: 'a', sessionId: 's1', agentName: 'Ann' },
    { id: 'b', sessionId: 's2', agentName: 'Bo' },
  ]

  test('a custom list source gives typed rows and an extensible answer', async () => {
    let answered: unknown
    const client = createHarnessClient({
      baseUrl: '/api',
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        answered = JSON.parse(String(init?.body))
        return json({ status: 'resumed', id: 'a', sessionId: 's1' })
      }) as typeof fetch,
    })
    const list = createAttentionList<Row, { kind: 'question'; answers: string[][] }>({
      client,
      list: async () => rows,
      clock: manualClock(),
    })
    await list.refresh()
    const first: Row | undefined = list.get().items[0]
    expect(first?.agentName).toBe('Ann')
    await list.answer(rows[0] as Row, { kind: 'question', answers: [['x']] })
    expect(answered).toEqual({ sessionId: 's1', answer: { kind: 'question', answers: [['x']] } })
    expect(list.get().items.map((i) => i.id)).toEqual(['b'])
  })

  test('events replaces the refetch triggers', async () => {
    const clock = manualClock()
    let lists = 0
    const list = createAttentionList<Row>({
      client: createHarnessClient({
        baseUrl: '/api',
        fetch: (async (_i: RequestInfo | URL) => json({})) as typeof fetch,
      }),
      list: async () => {
        lists++
        return rows
      },
      events: [...ATTENTION_EVENTS, 'task-changed'],
      clock,
    })
    list.handleActivity(record('message-added'))
    expect(clock.pending()).toBe(0)
    list.handleActivity(record('task-changed'))
    expect(clock.pending()).toBe(1)
    clock.run()
    await flush()
    expect(lists).toBe(1)
  })
})
