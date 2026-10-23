/**
 * OpenRouter routing and billed cost: the profile settings round-trip through the routes, reach the
 * wire of the real provider package (`usage.include`, `provider.order`, `allow_fallbacks`), the
 * upstream provider and the billed cost land in the model call log, and the additive migration
 * keeps the rows of an existing database.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { generateText } from 'ai'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { observeModel } from 'eharness'
import { openRouterProvider, webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteModelCallStore } from '../src/infra/db/model-calls-repo.ts'
import { createActivityLog } from '../src/infra/eh/activity-log.ts'
import { compose, type Server } from '../src/main.ts'

const DRIZZLE = new URL('../drizzle', import.meta.url).pathname
const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe('profile routing settings', () => {
  test('the form describes them and a profile keeps them across a round-trip', async () => {
    const server = compose({
      dbFile: ':memory:',
      env: {},
      offline: true,
      vault: webCryptoVault(new Uint8Array(32).fill(7)),
      changePollMs: 0,
      models: undefined,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
    })
    servers.push(server)
    await server.providersReady
    const defs = (await (await server.app.request('/providers')).json()) as {
      providers: Array<{ id: string; fields: Array<{ path: string; default?: unknown }> }>
    }
    const fields = defs.providers.find((p) => p.id === 'openrouter')?.fields ?? []
    expect(fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(['providerOrder', 'allowFallbacks', 'stickyProvider']),
    )
    expect(fields.find((f) => f.path === 'allowFallbacks')?.default).toBe(true)

    const created = await server.app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'openrouter',
        settings: {
          apiKey: 'sk-or-v1-test-key-0123456789',
          providerOrder: 'anthropic, amazon-bedrock',
          allowFallbacks: false,
          stickyProvider: true,
        },
      }),
    )
    expect(created.status).toBe(201)
    const patched = await server.app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { settings: { providerOrder: 'anthropic' } }),
    )
    const profile = (await patched.json()) as { settings: Record<string, unknown> }
    expect(profile.settings).toMatchObject({
      providerOrder: 'anthropic',
      allowFallbacks: false,
      stickyProvider: true,
    })
  })

  test('the options reach the wire of the real OpenRouter provider; the cost is read back', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          id: 'gen-1',
          provider: 'Amazon Bedrock',
          model: 'anthropic/claude-x',
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.0042 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const def = openRouterProvider({
      createOpenRouter: (s) => createOpenRouter({ ...s, fetch: fakeFetch }),
    })
    const instance = def.create(
      def.settings.parse({
        apiKey: 'sk-or-v1-test-key-0123456789',
        providerOrder: 'Anthropic, amazon-bedrock',
        allowFallbacks: false,
      }),
    )
    const result = await generateText({
      model: instance.languageModel('anthropic/claude-x'),
      prompt: 'hi',
    })
    expect(bodies[0]?.usage).toEqual({ include: true })
    expect(bodies[0]?.provider).toEqual({
      order: ['anthropic', 'amazon-bedrock'],
      allow_fallbacks: false,
    })
    const meta = result.providerMetadata?.openrouter as {
      provider?: string
      usage?: { cost?: number }
    }
    expect(meta.provider).toBe('Amazon Bedrock')
    expect(meta.usage?.cost).toBe(0.0042)
  })

  test('defaults send no provider key', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fakeFetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const def = openRouterProvider({
      createOpenRouter: (s) => createOpenRouter({ ...s, fetch: fakeFetch }),
    })
    const instance = def.create(def.settings.parse({ apiKey: 'sk-or-v1-test-key-0123456789' }))
    await generateText({ model: instance.languageModel('m/x'), prompt: 'hi' })
    expect('provider' in (bodies[0] ?? {})).toBe(false)
  })
})

describe('model call log: upstream provider and cost source', () => {
  test('the activity log stores both from the call', async () => {
    const conn = openDatabase(':memory:')
    try {
      const store = sqliteModelCallStore(conn.sqlite)
      const log = createActivityLog({
        store,
        tasks: { getBySession: () => undefined },
        events: { append() {} },
        agentOf: () => undefined,
      })
      const model = observeModel(
        scriptedModel([
          {
            text: 'a',
            providerMetadata: { openrouter: { provider: 'Fireworks', usage: { cost: 0.5 } } },
          },
        ]),
        (record) => log.record(record, { costUsd: 0.5, costSource: 'provider' }),
      )
      await generateText({ model, prompt: 'hi' })
      await new Promise((r) => setTimeout(r, 10))
      const row = store.list({ limit: 5 }).items[0]
      expect(row).toMatchObject({
        costUsd: 0.5,
        costSource: 'provider',
        upstreamProvider: 'Fireworks',
      })
    } finally {
      conn.close()
    }
  })

  test('the 0045 migration is additive: an existing database keeps its rows', () => {
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
      [k: string]: unknown
    }
    const tmp = mkdtempSync(join(tmpdir(), 'team-mig45-'))
    dirs.push(tmp)
    const folder = (upTo: number): string => {
      const dir = join(tmp, `to-${upTo}`)
      mkdirSync(join(dir, 'meta'), { recursive: true })
      const entries = journal.entries.filter((e) => e.idx <= upTo)
      for (const e of entries) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
      writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
      return dir
    }
    const db = new Database(join(tmp, 'old.db'), { create: true, strict: true })
    migrate(drizzle({ client: db }), { migrationsFolder: folder(44) })
    db.query(
      `INSERT INTO model_calls (id, created_at, kind, provider, model_id, status, started_at, duration_ms, cost_usd)
       VALUES ('old-1', 1, 'step', 'openrouter.chat', 'm', 'ok', 1, 5, 0.25)`,
    ).run()
    migrate(drizzle({ client: db }), { migrationsFolder: folder(Number.MAX_SAFE_INTEGER) })
    const store = sqliteModelCallStore(db)
    const old = store.get('old-1', {})
    expect(old).toMatchObject({ costUsd: 0.25, costSource: null, upstreamProvider: null })
    store.insert(
      {
        id: 'new-1',
        createdAt: 2,
        kind: 'step',
        agentId: null,
        sessionId: null,
        turnId: null,
        stepIndex: null,
        messageId: null,
        taskId: null,
        provider: 'openrouter.chat',
        modelId: 'm',
        status: 'ok',
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedTokens: null,
        costUsd: 0.1,
        costSource: 'provider',
        upstreamProvider: 'Amazon Bedrock',
        startedAt: 2,
        firstChunkMs: null,
        durationMs: 1,
        errorName: null,
        errorMessage: null,
        requestOptions: null,
        requestBody: null,
        response: null,
        output: null,
        providerMetadata: null,
        usageRaw: null,
      },
      2,
    )
    expect(store.get('new-1', {})).toMatchObject({
      costSource: 'provider',
      upstreamProvider: 'Amazon Bedrock',
    })
    expect(store.list({ limit: 10, q: 'bedrock' }).items.map((c) => c.id)).toEqual(['new-1'])
    expect(store.count()).toBe(2)
    db.close()
  })
})
