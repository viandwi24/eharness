/** Model call log: repo (filters, cursors, neighbours, stats, retention, truncation) and routes. */
import { afterEach, describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import type { NewModelCall } from '../src/domain/model-calls.ts'
import { type Connection, openDatabase } from '../src/infra/db/client.ts'
import { sqliteModelCallStore } from '../src/infra/db/model-calls-repo.ts'
import { sqliteTaskStore } from '../src/infra/db/tasks-repo.ts'
import { createActivityLog } from '../src/infra/eh/activity-log.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const T0 = 1_700_000_000_000
const MIN = 60_000

let conn: Connection | undefined
let server: Server | undefined
afterEach(async () => {
  conn?.close()
  conn = undefined
  await server?.close()
  server = undefined
})

const call = (id: string, over: Partial<NewModelCall> = {}): NewModelCall => ({
  id,
  createdAt: T0,
  kind: 'step',
  agentId: 'a1',
  sessionId: 'dm:a1',
  turnId: 't1',
  stepIndex: 0,
  messageId: 'm1',
  taskId: null,
  provider: 'openrouter',
  modelId: 'anthropic/claude-x',
  status: 'ok',
  finishReason: 'stop',
  inputTokens: 100,
  outputTokens: 20,
  reasoningTokens: null,
  cachedTokens: null,
  costUsd: 0.01,
  startedAt: T0,
  firstChunkMs: 100,
  durationMs: 1000,
  errorName: null,
  errorMessage: null,
  requestOptions: { prompt: [] },
  requestBody: { big: true },
  response: { id: 'r' },
  output: { text: 'hi', reasoning: '', toolCalls: [] },
  providerMetadata: undefined,
  usageRaw: { total: 120 },
  ...over,
})

function store(jsonCap?: number) {
  conn = openDatabase(':memory:')
  return sqliteModelCallStore(conn.sqlite, jsonCap === undefined ? {} : { jsonCap })
}

describe('model call store', () => {
  test('old calls lose their full request and response but keep tokens and cost', () => {
    const s = store()
    s.insert(call('old', { startedAt: T0 }), T0)
    s.insert(call('new', { startedAt: T0 + 2 * 24 * 60 * MIN }), T0 + 2 * 24 * 60 * MIN)
    s.prune({ maxRows: 100, olderThan: 0, bodiesOlderThan: T0 + 24 * 60 * MIN })
    const old = s.get('old', {}) as unknown as Record<string, unknown>
    expect(old.requestBody ?? null).toBeNull()
    expect(old.response ?? null).toBeNull()
    expect(old).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 0.01, status: 'ok' })
    const fresh = s.get('new', {}) as unknown as Record<string, unknown>
    expect(fresh.requestBody).toEqual({ big: true })
    expect(s.count()).toBe(2)
  })

  test('list is newest first, paged by cursor, without JSON columns', () => {
    const s = store()
    for (let i = 0; i < 5; i++) s.insert(call(`c${i}`, { startedAt: T0 + i * MIN }), T0)
    const first = s.list({ limit: 2 })
    expect(first.items.map((r) => r.id)).toEqual(['c4', 'c3'])
    expect(first.items[0]).not.toHaveProperty('requestBody')
    expect(first.nextCursor).not.toBeNull()
    const second = s.list({
      limit: 2,
      ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }),
    })
    expect(second.items.map((r) => r.id)).toEqual(['c2', 'c1'])
    const last = s.list({ limit: 2, cursor: second.nextCursor as string })
    expect(last.items.map((r) => r.id)).toEqual(['c0'])
    expect(last.nextCursor).toBeNull()
  })

  test('filters: range, agent, session, kind, status, model, q', () => {
    const s = store()
    conn?.sqlite.run(
      "INSERT INTO agents (id, workspace_id, slug, name, role, color, instructions, tools, skills, mcp, mcp_servers, permission_mode, rules, version, created_at, updated_at) VALUES ('a2','w','writer','Wanda Writer','role','#000','x','[]','[]','[]','[]','default','{}',1,0,0)",
    )
    s.insert(call('a', { startedAt: T0 }), T0)
    s.insert(
      call('b', {
        startedAt: T0 + MIN,
        agentId: 'a2',
        kind: 'compaction',
        status: 'error',
        modelId: 'openai/gpt-z',
        sessionId: 'dm:a2',
      }),
      T0,
    )
    s.insert(call('c', { startedAt: T0 + 2 * MIN, status: 'aborted' }), T0)
    const ids = (f: Parameters<typeof s.list>[0]) => s.list(f).items.map((r) => r.id)
    expect(ids({ limit: 10, from: T0 + MIN })).toEqual(['c', 'b'])
    expect(ids({ limit: 10, to: T0 + MIN })).toEqual(['b', 'a'])
    expect(ids({ limit: 10, agentId: 'a2' })).toEqual(['b'])
    expect(ids({ limit: 10, sessionId: 'dm:a2' })).toEqual(['b'])
    expect(ids({ limit: 10, kind: 'compaction' })).toEqual(['b'])
    expect(ids({ limit: 10, status: 'aborted' })).toEqual(['c'])
    expect(ids({ limit: 10, model: 'GPT' })).toEqual(['b'])
    expect(ids({ limit: 10, q: 'wanda' })).toEqual(['b'])
    expect(ids({ limit: 10, q: 'claude' })).toEqual(['c', 'a'])
    expect(ids({ limit: 10, q: '100%' })).toEqual([])
  })

  test('get returns JSON columns and neighbours under the same filter', () => {
    const s = store()
    s.insert(call('a', { startedAt: T0 }), T0)
    s.insert(call('b', { startedAt: T0 + MIN, status: 'error' }), T0)
    s.insert(call('c', { startedAt: T0 + 2 * MIN }), T0)
    const all = s.get('b', {})
    expect(all?.prevId).toBe('c')
    expect(all?.nextId).toBe('a')
    expect(all?.requestBody).toEqual({ big: true })
    expect(all?.usageRaw).toEqual({ total: 120 })
    expect(all?.providerMetadata).toBeNull()
    const ok = s.get('c', { status: 'ok' })
    expect(ok?.prevId).toBeNull()
    expect(ok?.nextId).toBe('a')
    expect(s.get('missing', {})).toBeUndefined()
  })

  test('stats: buckets include empty ones, errors and totals add up', () => {
    const s = store()
    s.insert(call('a', { startedAt: T0 }), T0)
    s.insert(
      call('b', { startedAt: T0 + 5 * MIN, status: 'error', inputTokens: 10, outputTokens: 1 }),
      T0,
    )
    s.insert(call('c', { startedAt: T0 + 5 * MIN + 1, status: 'aborted' }), T0)
    const stats = s.stats({ from: T0, to: T0 + 10 * MIN - 1, bucketMs: 5 * MIN })
    expect(stats.bucketMs).toBe(5 * MIN)
    expect(stats.buckets.map((b) => b.count)).toEqual([1, 2])
    expect(stats.buckets[1]?.errors).toBe(1)
    expect(stats.totals).toMatchObject({ count: 3, errors: 1, aborted: 1, inputTokens: 210 })
    expect(stats.totals.costUsd).toBeCloseTo(0.03)
    expect(stats.models).toEqual(['anthropic/claude-x'])
    expect(s.stats({ from: T0, to: T0 + 10 * MIN, status: 'error' }).totals.count).toBe(1)
  })

  test('stats: series by source and agent, tokens, previous range, percentiles, breakdowns', () => {
    const s = store()
    const day = 24 * 60 * MIN
    // previous range (one day before T0): two calls
    s.insert(call('p1', { startedAt: T0 - day + MIN, costUsd: 0.5 }), T0)
    s.insert(call('p2', { startedAt: T0 - day + 2 * MIN, status: 'error', costUsd: 0.5 }), T0)
    // current range: 10 ok calls of 100..1000 ms, plus an error and an aborted one
    for (let i = 1; i <= 10; i++) {
      s.insert(
        call(`c${i}`, {
          startedAt: T0 + i,
          durationMs: i * 100,
          cachedTokens: 40,
          reasoningTokens: 5,
          costUsd: 0.1,
        }),
        T0,
      )
    }
    s.insert(
      call('hb', {
        startedAt: T0 + 90 * MIN,
        agentId: 'a2',
        sessionId: 'heartbeat:a2',
        status: 'error',
        durationMs: 5000,
        costUsd: 0.2,
        modelId: 'other/model',
      }),
      T0,
    )
    s.insert(
      call('ab', {
        startedAt: T0 + 91 * MIN,
        status: 'aborted',
        durationMs: 99_999,
        costUsd: null,
      }),
      T0,
    )
    s.insert(
      call('cmp', {
        startedAt: T0 + 100 * MIN,
        kind: 'compaction',
        sessionId: 'dm:a1',
        costUsd: 0.3,
      }),
      T0,
    )
    s.insert(
      call('api', {
        startedAt: T0 + 100 * MIN,
        sessionId: 'api:a1:x',
        agentId: null,
        costUsd: 0.4,
      }),
      T0,
    )
    const hour = 60 * MIN
    const stats = s.stats({ from: T0, to: T0 + day - 1, bucketMs: hour })
    expect(stats.buckets).toHaveLength(24)
    expect(stats.buckets[0]).toMatchObject({ count: 10, cachedTokens: 400, reasoningTokens: 50 })
    expect(stats.buckets[0]?.costBySource.chat).toBeCloseTo(1)
    expect(stats.buckets[1]).toMatchObject({ count: 4, errors: 1, aborted: 1 })
    expect(stats.buckets[1]?.costBySource.heartbeat).toBeCloseTo(0.2)
    expect(stats.buckets[1]?.costBySource.compaction).toBeCloseTo(0.3)
    expect(stats.buckets[1]?.costBySource.api).toBeCloseTo(0.4)
    expect(stats.buckets[1]?.costByAgent).toMatchObject({ none: 0.4 })
    expect(stats.buckets[1]?.costByAgent.a2).toBeCloseTo(0.2)
    // totals add up; percentiles skip the aborted call (nearest rank over 13 timed calls)
    expect(stats.totals).toMatchObject({ count: 14, errors: 1, aborted: 1, cachedTokens: 400 })
    expect(stats.totals.costUsd).toBeCloseTo(1.9)
    expect(stats.totals.p50Ms).toBe(700) // sorted: 100..900,1000x3,5000 -> rank 7 of 13
    expect(stats.totals.p95Ms).toBe(5000)
    // previous: the equal range right before
    expect(stats.previous).toMatchObject({ count: 2, errors: 1 })
    expect(stats.previous.costUsd).toBeCloseTo(1)
    // breakdowns: most expensive first, errors counted
    expect(stats.byModel.map((r) => r.key)).toEqual(['anthropic/claude-x', 'other/model'])
    expect(stats.byModel[0]).toMatchObject({ calls: 13, errors: 0 })
    expect(stats.byAgent.map((r) => r.key)).toEqual(['a1', null, 'a2'])
    expect(stats.byAgent[2]).toMatchObject({ calls: 1, errors: 1, avgDurationMs: 5000 })
    // filters by source apply to the totals, buckets and previous
    const hb = s.stats({ from: T0, to: T0 + day - 1, bucketMs: hour, source: 'heartbeat' })
    expect(hb.totals.count).toBe(1)
    expect(hb.previous.count).toBe(0)
    expect(hb.previous.p50Ms).toBeNull()
    expect(s.list({ limit: 50, source: 'api' }).items.map((r) => r.id)).toEqual(['api'])
  })

  test('a JSON column over the cap is replaced by a marker and flagged', () => {
    const s = store(300)
    s.insert(call('big', { requestBody: { text: 'x'.repeat(5000) } }), T0)
    const row = s.get('big', {})
    expect(row?.truncated).toBe(true)
    const marker = row?.requestBody as { _truncated: boolean; bytes: number; preview: string }
    expect(marker._truncated).toBe(true)
    expect(marker.bytes).toBeGreaterThan(5000)
    expect(JSON.stringify(row?.requestBody).length).toBeLessThan(300)
    expect(row?.output).toEqual({ text: 'hi', reasoning: '', toolCalls: [] })
    expect(s.list({ limit: 1 }).items[0]?.truncated).toBe(true)
  })

  test('prune drops rows by age, then the oldest beyond the cap', () => {
    const s = store()
    s.insert(call('old', { startedAt: T0 }), T0 - 10 * MIN)
    for (let i = 1; i <= 4; i++) s.insert(call(`n${i}`, { startedAt: T0 + i * MIN }), T0)
    expect(s.prune({ maxRows: 3, olderThan: T0 - MIN })).toBe(2) // 1 by age, 1 by count
    expect(s.list({ limit: 10 }).items.map((r) => r.id)).toEqual(['n4', 'n3', 'n2'])
    expect(s.count()).toBe(3)
  })
})

describe('activity log plugin and routes', () => {
  test('a turn writes step rows, events and the routes serve them', async () => {
    server = compose({
      dbFile: ':memory:',
      models: scriptedModelConfig(scriptedModel([{ text: 'Hello there' }]) as never),
    })
    const res = await server.app.request('/sessions/dm:researcher/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'dm:researcher',
        messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    await res.text()
    // the hook may finish after the stream ends
    let list: { items: Array<{ id: string; kind: string; agentId: string; sessionId: string }> } = {
      items: [],
    }
    for (let i = 0; i < 50 && list.items.length === 0; i++) {
      list = (await (await server.app.request('/logs')).json()) as typeof list
      if (list.items.length === 0) await new Promise((r) => setTimeout(r, 20))
    }
    expect(list.items).toHaveLength(1)
    const row = list.items[0]
    expect(row?.kind).toBe('step')
    expect(row?.sessionId).toMatch(/^dm:/)
    const agents = (await (await server.app.request('/agents')).json()) as {
      agents: Array<{ id: string; slug: string }>
    }
    expect(row?.agentId).toBe(agents.agents.find((a) => a.slug === 'researcher')?.id as string)

    const detail = (await (await server.app.request(`/logs/${row?.id}`)).json()) as {
      output: { text: string }
      requestOptions: { prompt: unknown[] }
      prevId: null
    }
    expect(detail.output.text).toBe('Hello there')
    expect(Array.isArray(detail.requestOptions.prompt)).toBe(true)
    expect(detail.prevId).toBeNull()

    const stats = (await (await server.app.request('/logs/stats')).json()) as {
      totals: { count: number }
      buckets: unknown[]
    }
    expect(stats.totals.count).toBe(1)
    expect(stats.buckets.length).toBeGreaterThan(0)

    const events = (await (await server.app.request('/activity?after=0')).json()) as {
      events: Array<{ type: string; sessionId: string; payload: { id: string; status: string } }>
    }
    const ev = events.events.find((e) => e.type === 'model-call')
    expect(ev?.payload.id).toBe(row?.id as string)
    expect(ev?.payload.status).toBe('ok')

    const missing = await server.app.request('/logs/nope')
    expect(missing.status).toBe(404)
    const bad = await server.app.request('/logs?kind=weird')
    expect(bad.status).toBe(400)
  })

  test('the writer never throws and the plugin keeps going after a failure', () => {
    conn = openDatabase(':memory:')
    const real = sqliteModelCallStore(conn.sqlite)
    const warnings: string[] = []
    const tasks = sqliteTaskStore(conn.sqlite)
    const log = createActivityLog({
      store: {
        ...real,
        insert: () => {
          throw new Error('disk full')
        },
      },
      tasks,
      events: { append: () => undefined },
      agentOf: () => undefined,
      log: { warn: (m) => warnings.push(m) },
    })
    expect(() =>
      log.record(
        {
          id: 'x',
          model: { provider: 'p', modelId: 'm' },
          startedAt: new Date(T0).toISOString(),
          durationMs: 1,
          status: 'ok',
          usage: {} as never,
          request: { options: {} },
          response: {},
          output: { text: '', reasoning: '', toolCalls: [] },
        },
        { sessionId: 's' },
      ),
    ).not.toThrow()
    expect(warnings[0]).toContain('disk full')
  })

  test('the activity log prunes by count while writing', () => {
    conn = openDatabase(':memory:')
    const real = sqliteModelCallStore(conn.sqlite)
    const log = createActivityLog({
      store: real,
      tasks: sqliteTaskStore(conn.sqlite),
      events: { append: () => undefined },
      agentOf: () => undefined,
      maxRows: 3,
      pruneEvery: 1,
      pruneMinMs: 0,
    })
    for (let i = 0; i < 6; i++) {
      log.record(
        {
          id: `id${i}`,
          model: { provider: 'p', modelId: 'm' },
          startedAt: new Date(T0 + i).toISOString(),
          durationMs: 1,
          status: 'ok',
          usage: {} as never,
          request: { options: {} },
          response: {},
          output: { text: '', reasoning: '', toolCalls: [] },
        },
        { sessionId: 's' },
      )
    }
    expect(real.count()).toBe(3)
    expect(real.list({ limit: 10 }).items.map((r) => r.id)).toEqual(['id5', 'id4', 'id3'])
  })
})
