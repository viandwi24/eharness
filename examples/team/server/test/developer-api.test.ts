/**
 * Developer API (docs/plans/P56-developer-api.md) through `app.request()` with scripted models:
 * isolation of API agents, key auth / revoke / expiry, per-key limits, both modes, the SSE format,
 * retention and cost per key.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { DefaultChatTransport } from 'ai'
import { createHarnessClient, createHarnessTransport } from 'eharness/client'
import { type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { libraryFs } from '../src/infra/eh/library-fs.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

/** $1 per token: a scripted call (10 in, 5 out) costs $15, so limits are easy to hit. */
const PRICED = { scripted: { pricing: { input: 1_000_000, output: 1_000_000 } } }

function boot(
  steps: ScriptedStepInput[],
  opts: { token?: string; priced?: boolean; catalog?: Record<string, unknown> } = {},
): { server: Server; model: ReturnType<typeof scriptedModel> } {
  const model = scriptedModel(steps)
  server = compose({
    dbFile: ':memory:',
    seed: false,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    models: scriptedModelConfig(model as never),
    ...(opts.priced === true ? { catalog: PRICED } : {}),
    ...(opts.catalog === undefined ? {} : { catalog: opts.catalog as never }),
    tuning: { modelMaxRetries: 0 },
  })
  return { server, model }
}

const owner = (s: Server, method: string, path: string, body?: unknown, token?: string) =>
  s.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const asKey = (
  s: Server,
  key: string,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
) =>
  s.app.request(path, {
    method,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function makeAgent(
  s: Server,
  body: Record<string, unknown> = {},
): Promise<{ id: string; slug: string }> {
  const res = await owner(s, 'POST', '/developer/agents', {
    name: 'Support bot',
    instructions: 'Answer support questions.',
    ...body,
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; slug: string }
}

async function makeKey(
  s: Server,
  body: Record<string, unknown> = {},
): Promise<{ key: string; id: string }> {
  const res = await owner(s, 'POST', '/developer/keys', {
    name: 'Site',
    agents: ['support-bot'],
    ...body,
  })
  expect(res.status).toBe(201)
  const out = (await res.json()) as { key: string; view: { id: string } }
  return { key: out.key, id: out.view.id }
}

const seed = async (s: Server, files: Record<string, string>): Promise<void> => {
  const fs = libraryFs(s.conn.sqlite)
  for (const [path, text] of Object.entries(files)) await fs.write(path, text)
}

const toolNames = (model: ReturnType<typeof scriptedModel>, call = 0): string[] =>
  ((model.calls[call]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

const promptText = (model: ReturnType<typeof scriptedModel>, call: number): string =>
  JSON.stringify(model.prompts[call])

describe('isolation of API agents', () => {
  test('no grants means no tools at all, and no sign of the team or the library', async () => {
    const { server: s, model } = boot([{ text: 'Hello.' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const res = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'hi' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { output: string }).output).toBe('Hello.')
    expect(toolNames(model)).toEqual([])
    const wire = promptText(model, 0)
    expect(wire).toContain('untrusted data')
    expect(wire).not.toContain('/library')
    expect(wire).not.toContain('memory')
  })

  test('reads only inside granted folders; everything else reads as missing', async () => {
    const { server: s, model } = boot([
      {
        toolCalls: [
          { toolName: 'read_file', input: { path: '/library/public/cs/faq.md' } },
          { toolName: 'read_file', input: { path: '/library/internal/secret.md' } },
          { toolName: 'write_file', input: { path: '/library/public/cs/new.md', content: 'x' } },
        ],
      },
      { text: 'done' },
    ])
    await seed(s, {
      '/library/public/cs/faq.md': 'Refunds take 5 days.',
      '/library/internal/secret.md': 'TOP-SECRET-PLAN',
    })
    await makeAgent(s, { readFolders: ['/library/public/cs/**'] })
    const { key } = await makeKey(s)
    const res = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'refund?' })
    expect(res.status).toBe(200)
    expect(toolNames(model).sort()).toEqual(['glob', 'grep', 'list_files', 'read_file'])
    const second = promptText(model, 1)
    expect(second).toContain('Refunds take 5 days.')
    expect(second).not.toContain('TOP-SECRET-PLAN')
    // a write tool does not even exist for a read-only agent
    expect(second).toMatch(/write_file/)
    const files = libraryFs(s.conn.sqlite)
    expect(await files.read('/library/public/cs/new.md')).toBeNull()
  })

  test('one write folder: writes inside it work, outside it fail with a readable error', async () => {
    const { server: s, model } = boot([
      {
        toolCalls: [
          {
            toolName: 'write_file',
            input: { path: '/library/tickets/t1.md', content: 'ticket 1' },
          },
          {
            toolName: 'write_file',
            input: { path: '/library/public/cs/faq.md', content: 'hacked' },
          },
          { toolName: 'write_file', input: { path: '/library/other/x.md', content: 'hacked' } },
        ],
      },
      { text: 'ok' },
    ])
    await seed(s, { '/library/public/cs/faq.md': 'original' })
    await makeAgent(s, { readFolders: ['/library/public/cs'], writeFolder: '/library/tickets' })
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'open a ticket' })
    expect(toolNames(model)).toContain('write_file')
    expect(toolNames(model)).not.toContain('delete_file')
    const files = libraryFs(s.conn.sqlite)
    expect((await files.read('/library/tickets/t1.md'))?.content).toBe('ticket 1')
    expect((await files.read('/library/public/cs/faq.md'))?.content).toBe('original')
    expect(promptText(model, 1)).toContain('read-only')
    expect(promptText(model, 1)).toContain('only write inside /library/tickets')
    expect(await files.read('/library/other/x.md')).toBeNull()
  })

  test('a grant must be a folder inside the library, never the whole library', async () => {
    const { server: s } = boot([])
    for (const bad of [
      '/library',
      '/library/**',
      '/etc',
      '/library/../x',
      '/library/.eharness/tool-media',
    ]) {
      const res = await owner(s, 'POST', '/developer/agents', {
        name: 'x',
        instructions: 'y',
        readFolders: [bad],
      })
      expect(res.status).toBe(400)
    }
  })

  test('web search is a tool only when the owner turned it on and the server can search', async () => {
    const { server: s, model } = boot([{ text: 'a' }])
    await makeAgent(s, { webSearch: true })
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'hi' })
    // a scripted model has no search provider: the tool is not offered
    expect(toolNames(model)).not.toContain('web_search')
  })

  test('API agents and their conversations are invisible to team routes', async () => {
    const { server: s } = boot([{ text: 'hello' }])
    const agent = await makeAgent(s)
    const { key } = await makeKey(s)
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    await asKey(s, key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'hi',
      stream: false,
    })
    // not a team agent
    const agents = (await (await owner(s, 'GET', '/agents?includeArchived=true')).json()) as {
      agents: Array<{ slug: string }>
    }
    expect(agents.agents.map((a) => a.slug)).not.toContain('support-bot')
    expect((await owner(s, 'GET', '/agents/support-bot')).status).toBe(404)
    // its sessions do not resolve in the web chat routes
    const sessionId = `api:${agent.id}:${conv.id}`
    expect(
      (await owner(s, 'GET', `/sessions/${encodeURIComponent(sessionId)}/messages`)).status,
    ).toBe(404)
    // a chat POST is refused (404, or 409 for a session that is not a chat) and stores nothing
    const chat = await owner(s, 'POST', `/sessions/${encodeURIComponent(sessionId)}/chat`, {
      id: sessionId,
      messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    })
    expect([404, 409]).toContain(chat.status)
    const stored = s.conn.sqlite
      .query('SELECT COUNT(*) AS n FROM eh_messages WHERE session_id = ?')
      .get(sessionId)
    expect(stored).toEqual({ n: 2 })
  })

  test('the prompt of an API agent names no team agent', async () => {
    const model = scriptedModel([{ text: 'x' }])
    server = compose({
      dbFile: ':memory:',
      seedAgents: true,
      models: scriptedModelConfig(model as never),
      tuning: { modelMaxRetries: 0 },
    })
    await makeAgent(server)
    const { key } = await makeKey(server)
    await asKey(server, key, 'POST', '/v1/agents/support-bot/run', { input: 'who is on the team?' })
    const wire = promptText(model, 0).toLowerCase()
    for (const name of ['researcher', 'analyst', 'writer', 'lead']) expect(wire).not.toContain(name)
  })
})

describe('keys', () => {
  test('the key is shown once, stored hashed, and works as a bearer on /v1 only', async () => {
    const { server: s } = boot([{ text: 'ok' }], { token: 'owner-token-0123456789' })
    await makeAgentAs(s)
    const created = await owner(
      s,
      'POST',
      '/developer/keys',
      { name: 'Site', agents: ['support-bot'] },
      'owner-token-0123456789',
    )
    const { key, view } = (await created.json()) as { key: string; view: { id: string } }
    expect(key).toMatch(/^ehk_[a-z0-9]{8}_[a-z0-9]{32}$/)
    expect(key.startsWith(view.id)).toBe(true)
    const row = s.conn.sqlite
      .query<{ hash: string }, [string]>('SELECT hash FROM api_keys WHERE id = ?')
      .get(view.id)
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(s.conn.sqlite.query('SELECT * FROM api_keys').all())).not.toContain(
      key.split('_')[2] as string,
    )
    // listing never returns the hash or the secret
    const list = await owner(s, 'GET', '/developer/keys', undefined, 'owner-token-0123456789')
    expect(JSON.stringify(await list.json())).not.toContain('hash')
    // the key opens /v1, not the owner API
    expect(
      (await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'hi' })).status,
    ).toBe(200)
    expect((await asKey(s, key, 'GET', '/developer/keys')).status).toBe(401)
    expect((await asKey(s, key, 'GET', '/agents')).status).toBe(401)
    // the owner token does not open /v1
    const asOwner = await s.app.request('/v1/agents', {
      headers: { authorization: 'Bearer owner-token-0123456789' },
    })
    expect(asOwner.status).toBe(401)
    expect((await s.app.request('/v1/agents')).status).toBe(401)
  })

  async function makeAgentAs(s: Server): Promise<void> {
    const res = await owner(
      s,
      'POST',
      '/developer/agents',
      { name: 'Support bot', instructions: 'Help.' },
      'owner-token-0123456789',
    )
    expect(res.status).toBe(201)
  }

  test('revoked, expired, wrong and malformed keys are all the same 401', async () => {
    const { server: s } = boot([{ text: 'a' }, { text: 'b' }])
    await makeAgent(s)
    const a = await makeKey(s)
    const b = await makeKey(s, { name: 'Short', expiresAt: Date.now() + 60_000 })
    expect(
      (await asKey(s, a.key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })).status,
    ).toBe(200)
    // revoke
    const revoked = await owner(s, 'POST', `/developer/keys/${a.id}/revoke`)
    expect(revoked.status).toBe(200)
    const gone = await asKey(s, a.key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })
    expect(gone.status).toBe(401)
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('INVALID_API_KEY')
    // expiry
    s.conn.sqlite
      .query('UPDATE api_keys SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, b.id)
    expect(
      (await asKey(s, b.key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })).status,
    ).toBe(401)
    // wrong secret of a real id, and junk
    expect((await asKey(s, `${b.id}_${'a'.repeat(32)}`, 'GET', '/v1/agents')).status).toBe(401)
    expect((await asKey(s, 'nonsense', 'GET', '/v1/agents')).status).toBe(401)
  })

  test('a key reaches only the agents it lists; others read as 404', async () => {
    const { server: s } = boot([{ text: 'a' }])
    await makeAgent(s)
    await makeAgent(s, { name: 'Sales bot' })
    const { key } = await makeKey(s)
    const list = (await (await asKey(s, key, 'GET', '/v1/agents')).json()) as {
      agents: Array<{ slug: string }>
    }
    expect(list.agents.map((x) => x.slug)).toEqual(['support-bot'])
    expect((await asKey(s, key, 'POST', '/v1/agents/sales-bot/run', { input: 'x' })).status).toBe(
      404,
    )
    expect((await asKey(s, key, 'POST', '/v1/agents/nope/run', { input: 'x' })).status).toBe(404)
  })

  test('an archived agent stops answering', async () => {
    const { server: s } = boot([{ text: 'a' }])
    const agent = await makeAgent(s)
    const { key } = await makeKey(s)
    await owner(s, 'DELETE', `/developer/agents/${agent.id}`)
    expect((await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })).status).toBe(
      404,
    )
  })

  test('CORS follows the origins of the key', async () => {
    const { server: s } = boot([{ text: 'a' }])
    await makeAgent(s)
    const withOrigin = await makeKey(s, { origins: ['https://app.example.com'] })
    const serverOnly = await makeKey(s, { name: 'Server' })
    // preflight: known only when some live key lists the origin
    const ok = await s.app.request('/v1/agents/support-bot/run', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' },
    })
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    const no = await s.app.request('/v1/agents', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    })
    expect(no.status).toBe(403)
    // the request itself
    const good = await asKey(
      s,
      withOrigin.key,
      'POST',
      '/v1/agents/support-bot/run',
      { input: 'x' },
      { origin: 'https://app.example.com' },
    )
    expect(good.status).toBe(200)
    expect(good.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    const other = await asKey(
      s,
      withOrigin.key,
      'POST',
      '/v1/agents/support-bot/run',
      { input: 'x' },
      { origin: 'https://evil.example' },
    )
    expect(other.status).toBe(403)
    // the web app of the server itself (same host) needs no listing: the Try it console
    const sameHost = await asKey(s, serverOnly.key, 'GET', '/v1/agents', undefined, {
      origin: 'http://localhost',
      host: 'localhost',
    })
    expect(sameHost.status).toBe(200)
    const browserOnServerKey = await asKey(s, serverOnly.key, 'GET', '/v1/agents', undefined, {
      origin: 'https://app.example.com',
    })
    expect(browserOnServerKey.status).toBe(403)
    expect((await asKey(s, serverOnly.key, 'GET', '/v1/agents')).status).toBe(200)
  })
})

describe('limits and cost per key', () => {
  test('requests per minute: the next one is a 429 with a readable error and Retry-After', async () => {
    const { server: s } = boot([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
    await makeAgent(s)
    const { key, id } = await makeKey(s, { rateLimitPerMin: 2 })
    expect((await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: '1' })).status).toBe(
      200,
    )
    expect((await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: '2' })).status).toBe(
      200,
    )
    const limited = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: '3' })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    const body = (await limited.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.error.message).toContain('2 requests per minute')
    // another key is not affected, and the refusal is in the log without counting as a request
    const other = await makeKey(s, { name: 'Other' })
    expect(
      (await asKey(s, other.key, 'POST', '/v1/agents/support-bot/run', { input: '4' })).status,
    ).toBe(200)
    const log = (await (await owner(s, 'GET', `/developer/requests?keyId=${id}`)).json()) as {
      requests: Array<{ status: number; errorCode: string | null }>
    }
    expect(log.requests.map((r) => r.status).sort()).toEqual([200, 200, 429])
  })

  test('daily cost: model calls are priced per key and the key stops at its limit', async () => {
    const { server: s } = boot([{ text: 'a' }, { text: 'b' }], { priced: true })
    await makeAgent(s)
    const { key, id } = await makeKey(s, { dailyCostLimitUsd: 10 })
    const first = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })
    expect(first.status).toBe(200)
    const out = (await first.json()) as {
      costUsd: number
      usage: { inputTokens: number; outputTokens: number }
    }
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(out.costUsd).toBeCloseTo(15, 6)
    // the call row carries the key id
    const call = s.conn.sqlite
      .query<{ key_id: string; cost_usd: number }, []>('SELECT key_id, cost_usd FROM api_calls')
      .all()
    expect(call).toHaveLength(1)
    expect(call[0]?.key_id).toBe(id)
    expect(call[0]?.cost_usd).toBeCloseTo(15, 6)
    // over the limit now
    const second = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'y' })
    expect(second.status).toBe(429)
    const err = (await second.json()) as { error: { code: string; message: string } }
    expect(err.error.code).toBe('DAILY_COST_LIMIT')
    expect(err.error.message).toContain('$10.00 per day')
    // usage per key in the owner API
    const keys = (await (await owner(s, 'GET', '/developer/keys')).json()) as {
      keys: Array<{ id: string; today: { costUsd: number } }>
    }
    expect(keys.keys.find((k) => k.id === id)?.today.costUsd).toBeCloseTo(15, 6)
    const usage = (await (await owner(s, 'GET', `/developer/usage?keyId=${id}&days=7`)).json()) as {
      totals: { requests: number; costUsd: number }
      days: Array<{ costUsd: number }>
    }
    expect(usage.totals.requests).toBe(1)
    expect(usage.totals.costUsd).toBeCloseTo(15, 6)
    expect(usage.days.at(-1)?.costUsd).toBeCloseTo(15, 6)
  })

  test('the workspace budget still applies: an API call stops with a 429 when it is used up', async () => {
    const model = scriptedModel([{ text: 'never' }])
    server = compose({
      dbFile: ':memory:',
      seed: false,
      models: scriptedModelConfig(model as never),
      catalog: PRICED,
      budgetUsd: 1,
      tuning: { modelMaxRetries: 0 },
    })
    await makeAgent(server)
    const { key } = await makeKey(server)
    const res = await asKey(server, key, 'POST', '/v1/agents/support-bot/run', { input: 'x' })
    expect(res.status).toBe(429)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('WORKSPACE_BUDGET')
  })

  test('the request log has metadata only', async () => {
    const { server: s } = boot([{ text: 'secret answer' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'a very private question' })
    const raw = JSON.stringify(s.conn.sqlite.query('SELECT * FROM api_requests').all())
    expect(raw).not.toContain('private question')
    expect(raw).not.toContain('secret answer')
    const res = (await (await owner(s, 'GET', '/developer/requests')).json()) as {
      requests: Array<{ mode: string; status: number; inputTokens: number }>
    }
    expect(res.requests[0]).toMatchObject({ mode: 'run', status: 200, inputTokens: 10 })
  })

  test('API calls reach the Logs page with tokens and cost, never the prompt or the answer', async () => {
    const { server: s } = boot([{ text: 'secret answer' }, { text: 'second secret' }], {
      priced: true,
    })
    const agent = await makeAgent(s)
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'a very private question' })
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    await asKey(s, key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'another private question',
      stream: false,
    })
    const logs = (await (await owner(s, 'GET', '/logs?source=api')).json()) as {
      items: Array<{ kind: string; agentId: string; sessionId: string; costUsd: number }>
    }
    expect(logs.items).toHaveLength(2)
    for (const item of logs.items) {
      expect(item).toMatchObject({ kind: 'step', agentId: agent.id })
      expect(item.sessionId.startsWith(`api:${agent.id}:`)).toBe(true)
      expect(item.costUsd).toBeCloseTo(15, 6)
    }
    const raw = JSON.stringify(s.conn.sqlite.query('SELECT * FROM model_calls').all())
    for (const text of ['private question', 'secret answer', 'second secret', 'Support bot'])
      expect(raw).not.toContain(text)
  })
})

describe('mode A: run', () => {
  test('stores no history', async () => {
    const { server: s } = boot([{ text: 'hello' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'remember this phrase' })
    expect(s.conn.sqlite.query('SELECT COUNT(*) AS n FROM eh_messages').get()).toEqual({ n: 0 })
    expect(
      s.conn.sqlite.query("SELECT COUNT(*) AS n FROM eh_state WHERE session_id LIKE 'api:%'").get(),
    ).toEqual({ n: 0 })
  })

  test('context is framed as untrusted data and a transcript becomes history', async () => {
    const { server: s, model } = boot([{ text: 'ok' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const res = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', {
      input: [
        { role: 'user', content: 'My name is Ada.' },
        { role: 'assistant', content: 'Hi Ada.' },
        { role: 'user', content: 'What is my name?' },
      ],
      context: { plan: 'pro' },
    })
    expect(res.status).toBe(200)
    const wire = promptText(model, 0)
    expect(wire).toContain('My name is Ada.')
    expect(wire).toContain('<untrusted-content')
    expect(wire).toContain('plan')
    expect(wire).toContain('pro')
  })

  test('outputSchema: a valid object comes back as JSON', async () => {
    const { server: s } = boot([
      { toolCalls: [{ toolName: 'final_answer', input: { intent: 'refund', urgent: true } }] },
    ])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const res = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', {
      input: 'I want my money back now',
      outputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', enum: ['refund', 'shipping'] },
          urgent: { type: 'boolean' },
        },
        required: ['intent', 'urgent'],
      },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { output: unknown }).output).toEqual({
      intent: 'refund',
      urgent: true,
    })
  })

  test('outputSchema: an answer that never matches is a 502, a bad schema a 400', async () => {
    const bad = { toolName: 'final_answer', input: { intent: 'unknown', urgent: 'yes' } }
    const { server: s } = boot([
      { toolCalls: [bad] },
      { toolCalls: [bad] },
      { toolCalls: [bad] },
      { toolCalls: [bad] },
    ])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const schema = {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['refund', 'shipping'] },
        urgent: { type: 'boolean' },
      },
      required: ['intent', 'urgent'],
    }
    const res = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', {
      input: 'x',
      outputSchema: schema,
    })
    expect(res.status).toBe(502)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OUTPUT_INVALID')
    const notObject = await asKey(s, key, 'POST', '/v1/agents/support-bot/run', {
      input: 'x',
      outputSchema: { type: 'string' },
    })
    expect(notObject.status).toBe(400)
  })

  test('validation: empty input, wrong transcript and bad JSON are 400s', async () => {
    const { server: s } = boot([])
    await makeAgent(s)
    const { key } = await makeKey(s)
    expect((await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: '' })).status).toBe(
      400,
    )
    expect(
      (
        await asKey(s, key, 'POST', '/v1/agents/support-bot/run', {
          input: [{ role: 'assistant', content: 'x' }],
        })
      ).status,
    ).toBe(400)
    const junk = await s.app.request('/v1/agents/support-bot/run', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: '{nope',
    })
    expect(junk.status).toBe(400)
    expect(((await junk.json()) as { error: { code: string } }).error.code).toBe('INVALID_JSON')
  })
})

describe('mode B: conversations', () => {
  test('history continues across messages and endUserId reuses the open conversation', async () => {
    const { server: s, model } = boot([{ text: 'Hi Ada.' }, { text: 'Your name is Ada.' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const opened = await asKey(s, key, 'POST', '/v1/conversations', {
      agent: 'support-bot',
      endUserId: 'user-42',
      metadata: { page: 'pricing' },
    })
    expect(opened.status).toBe(201)
    const conv = (await opened.json()) as { id: string; reused?: boolean }
    // the same end user gets the same conversation
    const again = await asKey(s, key, 'POST', '/v1/conversations', {
      agent: 'support-bot',
      endUserId: 'user-42',
    })
    expect(again.status).toBe(200)
    const reused = (await again.json()) as { id: string; reused: boolean }
    expect(reused).toMatchObject({ id: conv.id, reused: true })
    // another end user does not
    const other = (await (
      await asKey(s, key, 'POST', '/v1/conversations', {
        agent: 'support-bot',
        endUserId: 'user-43',
      })
    ).json()) as { id: string }
    expect(other.id).not.toBe(conv.id)

    const m1 = await asKey(s, key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'My name is Ada.',
      stream: false,
    })
    expect(m1.status).toBe(200)
    expect(((await m1.json()) as { text: string }).text).toBe('Hi Ada.')
    const m2 = await asKey(s, key, 'POST', `/v1/conversations/${reused.id}/messages`, {
      text: 'What is my name?',
      stream: false,
    })
    expect(((await m2.json()) as { text: string }).text).toBe('Your name is Ada.')
    // the second model call saw the first exchange
    expect(promptText(model, 1)).toContain('My name is Ada.')
    expect(promptText(model, 1)).toContain('Hi Ada.')

    const history = (await (
      await asKey(s, key, 'GET', `/v1/conversations/${conv.id}/messages`)
    ).json()) as {
      messages: Array<{ role: string; text: string }>
    }
    expect(history.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'My name is Ada.'],
      ['assistant', 'Hi Ada.'],
      ['user', 'What is my name?'],
      ['assistant', 'Your name is Ada.'],
    ])
    const page = (await (
      await asKey(s, key, 'GET', `/v1/conversations/${conv.id}/messages?limit=2`)
    ).json()) as {
      messages: unknown[]
      nextBefore?: string
    }
    expect(page.messages).toHaveLength(2)
    expect(page.nextBefore).toBeDefined()
    const older = (await (
      await asKey(
        s,
        key,
        'GET',
        `/v1/conversations/${conv.id}/messages?limit=2&before=${page.nextBefore}`,
      )
    ).json()) as {
      messages: Array<{ text: string }>
    }
    expect(older.messages.map((m) => m.text)).toEqual(['My name is Ada.', 'Hi Ada.'])
  })

  test('a conversation belongs to its key; closing and deleting work', async () => {
    const { server: s } = boot([{ text: 'a' }])
    await makeAgent(s)
    const one = await makeKey(s)
    const two = await makeKey(s, { name: 'Two' })
    const conv = (await (
      await asKey(s, one.key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    expect((await asKey(s, two.key, 'GET', `/v1/conversations/${conv.id}`)).status).toBe(404)
    expect(
      (
        await asKey(s, two.key, 'POST', `/v1/conversations/${conv.id}/messages`, {
          text: 'x',
          stream: false,
        })
      ).status,
    ).toBe(404)
    await asKey(s, one.key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'x',
      stream: false,
    })
    const closed = await asKey(s, one.key, 'POST', `/v1/conversations/${conv.id}/close`)
    expect(((await closed.json()) as { status: string }).status).toBe('closed')
    const after = await asKey(s, one.key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'y',
      stream: false,
    })
    expect(after.status).toBe(409)
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe(
      'CONVERSATION_CLOSED',
    )
    // a closed conversation is not reused for its end user
    const del = await asKey(s, one.key, 'DELETE', `/v1/conversations/${conv.id}`)
    expect(del.status).toBe(200)
    expect((await asKey(s, one.key, 'GET', `/v1/conversations/${conv.id}`)).status).toBe(404)
    expect(
      s.conn.sqlite
        .query("SELECT COUNT(*) AS n FROM eh_messages WHERE session_id LIKE 'api:%'")
        .get(),
    ).toEqual({ n: 0 })
  })

  test('the stream is the AI SDK UI message stream and carries no tool calls', async () => {
    const { server: s } = boot([
      { toolCalls: [{ toolName: 'read_file', input: { path: '/library/public/cs/faq.md' } }] },
      { text: 'Refunds take 5 days.' },
    ])
    await seed(s, { '/library/public/cs/faq.md': 'Refunds take 5 days.' })
    await makeAgent(s, { readFolders: ['/library/public/cs'] })
    const { key } = await makeKey(s)
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    const res = await asKey(s, key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'refunds?',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    const text = await res.text()
    expect(text).toContain('"type":"text-delta"')
    expect(text).toContain('[DONE]')
    expect(text).not.toContain('tool-input')
    expect(text).not.toContain('read_file')
    expect(text).not.toContain('/library')
  })

  test('a useChat transport reads the stream (the body of useChat is accepted as is)', async () => {
    const { server: s } = boot([{ text: 'Hello from the agent.' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    const transport = new DefaultChatTransport({
      api: `http://localhost/v1/conversations/${conv.id}/messages`,
      headers: { authorization: `Bearer ${key}` },
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        s.app.request(String(url).replace('http://localhost', ''), init)) as typeof fetch,
    })
    const stream = await transport.sendMessages({
      chatId: conv.id,
      messageId: undefined,
      trigger: 'submit-message',
      abortSignal: undefined,
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    })
    const chunks: Array<{ type: string; delta?: string }> = []
    for await (const chunk of stream as unknown as AsyncIterable<{ type: string; delta?: string }>)
      chunks.push(chunk)
    expect(chunks.map((c) => c.type)).toContain('finish')
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join(''),
    ).toBe('Hello from the agent.')
  })

  test('eharness/client reads the stream through the /v1/sessions alias', async () => {
    const { server: s } = boot([{ text: 'Hello via the client.' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    const client = createHarnessClient({
      baseUrl: 'http://localhost/v1',
      headers: { authorization: `Bearer ${key}` },
      fetch: ((url: string | URL | Request, init?: RequestInit) =>
        s.app.request(String(url).replace('http://localhost', ''), init)) as typeof fetch,
    })
    const transport = createHarnessTransport({ client })
    const stream = await transport.sendMessages({
      chatId: conv.id,
      messageId: undefined,
      trigger: 'submit-message',
      abortSignal: undefined,
      messages: [
        { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ],
    })
    const chunks: Array<{ type: string; delta?: string }> = []
    for await (const chunk of stream as unknown as AsyncIterable<{ type: string; delta?: string }>)
      chunks.push(chunk)
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join(''),
    ).toBe('Hello via the client.')
  })

  test('conversation cost is tagged with the key too', async () => {
    const { server: s } = boot([{ text: 'a' }], { priced: true })
    await makeAgent(s)
    const { key, id } = await makeKey(s)
    const conv = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot' })
    ).json()) as { id: string }
    const res = await asKey(s, key, 'POST', `/v1/conversations/${conv.id}/messages`, {
      text: 'x',
      stream: false,
    })
    expect(((await res.json()) as { costUsd: number }).costUsd).toBeCloseTo(15, 6)
    const log = (await (await owner(s, 'GET', `/developer/requests?keyId=${id}`)).json()) as {
      requests: Array<{ mode: string; costUsd: number; conversationId: string | null }>
    }
    expect(log.requests[0]).toMatchObject({ mode: 'conversation', conversationId: conv.id })
    expect(log.requests[0]?.costUsd).toBeCloseTo(15, 6)
  })
})

describe('retention', () => {
  test('idle conversations of an agent are deleted with their messages; fresh ones stay', async () => {
    const { server: s } = boot([{ text: 'a' }, { text: 'b' }])
    await makeAgent(s, { retentionDays: 7 })
    const { key } = await makeKey(s)
    const old = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot', endUserId: 'old' })
    ).json()) as { id: string }
    const fresh = (await (
      await asKey(s, key, 'POST', '/v1/conversations', { agent: 'support-bot', endUserId: 'fresh' })
    ).json()) as { id: string }
    await asKey(s, key, 'POST', `/v1/conversations/${old.id}/messages`, {
      text: 'x',
      stream: false,
    })
    await asKey(s, key, 'POST', `/v1/conversations/${fresh.id}/messages`, {
      text: 'y',
      stream: false,
    })
    const eightDays = Date.now() - 8 * 86_400_000
    s.conn.sqlite
      .query('UPDATE api_conversations SET last_message_at = ? WHERE id = ?')
      .run(eightDays, old.id)
    const swept = s.developer.sweep()
    expect(swept.conversations).toBe(1)
    expect((await asKey(s, key, 'GET', `/v1/conversations/${old.id}`)).status).toBe(404)
    expect((await asKey(s, key, 'GET', `/v1/conversations/${fresh.id}`)).status).toBe(200)
    expect(
      s.conn.sqlite
        .query('SELECT COUNT(*) AS n FROM eh_messages WHERE session_id LIKE ?')
        .get(`%${old.id}`),
    ).toEqual({ n: 0 })
    expect(
      (
        s.conn.sqlite
          .query('SELECT COUNT(*) AS n FROM eh_messages WHERE session_id LIKE ?')
          .get(`%${fresh.id}`) as { n: number }
      ).n,
    ).toBeGreaterThan(0)
  })

  test('retention days is validated and stored per agent (default 30)', async () => {
    const { server: s } = boot([])
    const a = (await (
      await owner(s, 'POST', '/developer/agents', { name: 'A', instructions: 'x' })
    ).json()) as { retentionDays: number }
    expect(a.retentionDays).toBe(30)
    expect(
      (
        await owner(s, 'POST', '/developer/agents', {
          name: 'B',
          instructions: 'x',
          retentionDays: 0,
        })
      ).status,
    ).toBe(400)
  })
})

describe('owner API', () => {
  test('agents: slug conflict, patch bumps the version, editing applies to the next request', async () => {
    const { server: s, model } = boot([{ text: 'one' }, { text: 'two' }])
    const agent = await makeAgent(s)
    expect(
      (await owner(s, 'POST', '/developer/agents', { name: 'Support bot', instructions: 'x' }))
        .status,
    ).toBe(409)
    const { key } = await makeKey(s)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'a' })
    const patched = await owner(s, 'PATCH', `/developer/agents/${agent.id}`, {
      instructions: 'Always answer in French.',
      rules: ['Never give legal advice.'],
    })
    expect(((await patched.json()) as { version: number }).version).toBe(2)
    await asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'b' })
    expect(promptText(model, 1)).toContain('Always answer in French.')
    expect(promptText(model, 1)).toContain('Never give legal advice.')
    expect(promptText(model, 0)).not.toContain('Always answer in French.')
  })

  test('a key must name existing API agents', async () => {
    const { server: s } = boot([])
    await makeAgent(s)
    expect(
      (await owner(s, 'POST', '/developer/keys', { name: 'k', agents: ['ghost'] })).status,
    ).toBe(400)
    expect((await owner(s, 'POST', '/developer/keys', { name: 'k', agents: [] })).status).toBe(400)
    expect(
      (
        await owner(s, 'POST', '/developer/keys', {
          name: 'k',
          agents: ['support-bot'],
          origins: ['nope'],
        })
      ).status,
    ).toBe(400)
  })

  test('the OpenAPI document describes /v1 with the ApiKey scheme', async () => {
    const { server: s } = boot([])
    const doc = (await (await s.app.request('/openapi.json')).json()) as {
      paths: Record<string, unknown>
      components: { securitySchemes: Record<string, unknown> }
    }
    for (const path of [
      '/v1/agents/{slug}/run',
      '/v1/conversations',
      '/v1/conversations/{id}/messages',
      '/developer/keys',
      '/developer/agents',
    ]) {
      expect(doc.paths[path]).toBeDefined()
    }
    expect(doc.components.securitySchemes.ApiKey).toBeDefined()
  })
})

describe('mode A: images', () => {
  /** A 1x1 transparent PNG. */
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
  const run = (s: Server, key: string, body: Record<string, unknown>) =>
    asKey(s, key, 'POST', '/v1/agents/support-bot/run', { input: 'What is in the photo?', ...body })
  const codeOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code

  test('images reach the model as file parts of the input, in order, and are not stored', async () => {
    const { server: s, model } = boot([{ text: 'A pixel.' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const res = await run(s, key, {
      context: { order: '1042' },
      images: [
        { mediaType: 'image/png', data: PNG },
        { mediaType: 'image/jpeg', data: 'AAAA' },
      ],
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { output: string }).output).toBe('A pixel.')
    const prompt = model.prompts[0] as Array<{
      role: string
      content: string | Array<{ type: string; mediaType?: string; text?: string }>
    }>
    const user = prompt.findLast((m) => m.role === 'user')
    const parts = Array.isArray(user?.content) ? user.content : []
    expect(parts.filter((p) => p.type === 'file').map((p) => p.mediaType)).toEqual([
      'image/png',
      'image/jpeg',
    ])
    const text = parts.find((p) => p.type === 'text')?.text ?? ''
    expect(text).toContain('What is in the photo?')
    expect(text).toContain('<untrusted-content')
    expect(s.conn.sqlite.query('SELECT COUNT(*) AS n FROM eh_messages').get()).toEqual({ n: 0 })
    const log = JSON.stringify(s.conn.sqlite.query('SELECT * FROM api_requests').all())
    expect(log).not.toContain(PNG.slice(0, 20))
  })

  test('a bad type, bad base64 or more than 4 images is 400 INVALID_IMAGES', async () => {
    const { server: s } = boot([])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const badType = await run(s, key, { images: [{ mediaType: 'image/bmp', data: PNG }] })
    expect(badType.status).toBe(400)
    expect(await codeOf(badType)).toBe('INVALID_IMAGES')
    for (const data of [`data:image/png;base64,${PNG}`, 'abc', 'a b=', '****']) {
      const bad = await run(s, key, { images: [{ mediaType: 'image/png', data }] })
      expect(bad.status).toBe(400)
      expect(await codeOf(bad)).toBe('INVALID_IMAGES')
    }
    const five = await run(s, key, {
      images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: PNG })),
    })
    expect(five.status).toBe(400)
    expect(await codeOf(five)).toBe('INVALID_IMAGES')
  })

  test('an image over 1.5 MB is 413 IMAGE_TOO_LARGE; the run body may be up to 9 MB', async () => {
    const { server: s } = boot([{ text: 'ok' }])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const exact = 'A'.repeat((1_572_864 / 3) * 4)
    const over = await run(s, key, { images: [{ mediaType: 'image/png', data: `${exact}AAAA` }] })
    expect(over.status).toBe(413)
    expect(await codeOf(over)).toBe('IMAGE_TOO_LARGE')
    // 4 images of exactly 1.5 MB (an 8 MB body) pass the body limit and the size check
    const four = await run(s, key, {
      images: Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data: exact })),
    })
    expect(four.status).toBe(200)
  })

  test('other /v1 routes keep the 1 MB body limit', async () => {
    const { server: s } = boot([])
    await makeAgent(s)
    const { key } = await makeKey(s)
    const big = { agent: 'support-bot', metadata: { blob: 'x'.repeat(1024 * 1024 + 10) } }
    const res = await asKey(s, key, 'POST', '/v1/conversations', big)
    expect(res.status).toBe(413)
    expect(await codeOf(res)).toBe('PAYLOAD_TOO_LARGE')
  })

  test('a model without image input is 400 IMAGES_UNSUPPORTED with the core message', async () => {
    const { server: s, model } = boot([{ text: 'never' }], {
      catalog: { scripted: { inputModalities: ['text'] } },
    })
    await makeAgent(s)
    const { key } = await makeKey(s)
    const res = await run(s, key, { images: [{ mediaType: 'image/png', data: PNG }] })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('IMAGES_UNSUPPORTED')
    expect(body.error.message).toContain('does not accept image input')
    expect(body.error.message).not.toContain(PNG.slice(0, 20))
    expect(model.prompts.length).toBe(0)
  })
})
