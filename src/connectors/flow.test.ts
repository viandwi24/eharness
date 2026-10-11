import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { ehMeta, webCryptoVault } from '../providers/index.ts'
import { defineConnector } from './definition.ts'
import { advanceFlow, completeOAuth, flowCompletion, publicFlow, startFlow } from './flow.ts'
import { remoteMcpConnector } from './remote-mcp.ts'
import { inMemoryFlowStore } from './store.ts'
import { fakeAuthServer } from './test-kit.ts'
import type { FlowDeps, FlowState, FlowView } from './types.ts'

const vault = webCryptoVault(new Uint8Array(32).fill(7))

const apiKey = defineConnector({
  id: 'crm',
  version: '1',
  name: 'CRM',
  description: 'A CRM.',
  category: 'sales',
  source: 'curated',
  scopes: ['workspace', 'agent'],
  auth: {
    type: 'apiKey',
    fields: z.object({
      apiKey: z
        .string()
        .min(8)
        .meta({ title: 'API key', ...ehMeta({ secret: true }) }),
    }),
  },
  settings: z.object({ region: z.enum(['eu', 'us']).default('eu') }),
  capabilities: [],
  test: async (ctx) => ({
    ok: ctx.settings.apiKey !== 'bad-key-0000',
    accountLabel: 'acme',
    message: 'Rejected.',
  }),
})

function deps(extra: Partial<FlowDeps> = {}): FlowDeps {
  let t = 1_000_000
  let n = 0
  return {
    definitions: [apiKey],
    vault,
    now: () => t++,
    newId: () => `flow-${++n}`,
    redirectUri: 'https://app.example.com/oauth/callback',
    ...extra,
  }
}

const must = <T>(r: { ok: boolean } & T): Extract<typeof r, { ok: true }> => {
  expect(r.ok).toBe(true)
  return r as never
}

describe('form flow (api key)', () => {
  test('start shows the settings form without secret values', async () => {
    const state = await startFlow({ definition: apiKey, scope: 'workspace' }, deps())
    expect(state.status).toBe('active')
    expect(state.view.type).toBe('form')
    const view = state.view as Extract<FlowView, { type: 'form' }>
    expect(view.fields.map((f) => f.path)).toEqual(['apiKey', 'region'])
    expect(view.fields[0]?.secret).toBe(true)
    expect(view.step).toBe('settings')
    expect(view.viewId).toMatch(/^[0-9a-f]{24}$/)
  })

  test('validation errors keep the form, change the viewId and never echo values; stale viewIds are rejected', async () => {
    const d = deps()
    const s0 = await startFlow({ definition: apiKey, scope: 'workspace' }, d)
    const s1 = must(
      await advanceFlow(
        s0,
        { viewId: s0.view.viewId, action: 'submit', data: { apiKey: 'short' } },
        d,
      ),
    ).state
    const v1 = s1.view as Extract<FlowView, { type: 'form' }>
    expect(v1.type).toBe('form')
    expect(v1.errors?.apiKey).toBeDefined()
    expect(v1.viewId).not.toBe(s0.view.viewId)
    expect(JSON.stringify(s1.view)).not.toContain('short')
    // answering the old view
    const stale = await advanceFlow(
      s1,
      { viewId: s0.view.viewId, action: 'submit', data: { apiKey: 'long-enough-key' } },
      d,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error).toBe('stale-view')
      expect(stale.state.view.viewId).toBe(v1.viewId)
    }
  })

  test('a valid submit runs the test and finishes; secrets never appear in public shapes or the sealed blob', async () => {
    const d = deps()
    const s0 = await startFlow({ definition: apiKey, scope: 'workspace', label: 'Sales CRM' }, d)
    const secret = 'super-secret-key-123'
    const s1 = must(
      await advanceFlow(
        s0,
        { viewId: s0.view.viewId, action: 'submit', data: { apiKey: secret, region: 'us' } },
        d,
      ),
    ).state
    expect(s1.status).toBe('done')
    expect(s1.view).toMatchObject({ type: 'status', state: 'success', account: 'acme' })
    expect(JSON.stringify(publicFlow(s1))).not.toContain(secret)
    expect(JSON.stringify(s1)).not.toContain(secret) // sealed with AES-GCM
    const done = await flowCompletion(s1, d)
    expect(done).toMatchObject({
      definitionId: 'crm',
      label: 'Sales CRM',
      accountLabel: 'acme',
      settings: { apiKey: secret, region: 'us' },
    })
    expect((await advanceFlow(s1, { viewId: s1.view.viewId, action: 'cancel' }, d)).ok).toBe(false)
  })

  test('a failing test shows a retryable error; back returns to the form and the secret can be kept', async () => {
    const d = deps()
    const s0 = await startFlow({ definition: apiKey, scope: 'workspace' }, d)
    const s1 = must(
      await advanceFlow(
        s0,
        { viewId: s0.view.viewId, action: 'submit', data: { apiKey: 'bad-key-0000' } },
        d,
      ),
    ).state
    expect(s1.view).toMatchObject({
      type: 'error',
      retryable: true,
      message: 'Rejected.',
      step: 'test',
    })
    const retried = must(
      await advanceFlow(s1, { viewId: s1.view.viewId, action: 'retry' }, d),
    ).state
    expect(retried.view.type).toBe('error')
    const back = must(
      await advanceFlow(retried, { viewId: retried.view.viewId, action: 'back' }, d),
    ).state
    expect(back.view.type).toBe('form')
    const values = (back.view as Extract<FlowView, { type: 'form' }>).values
    expect(values.apiKey).toEqual({ set: true, hint: '…0000' })
    // submit without resending the secret keeps it (only the region changes) and still fails the test
    const again = must(
      await advanceFlow(
        back,
        {
          viewId: back.view.viewId,
          action: 'submit',
          data: { region: 'eu', apiKey: { keep: true } },
        },
        d,
      ),
    ).state
    expect(again.view).toMatchObject({ type: 'error', step: 'test' })
  })

  test('the state survives a JSON round trip (resume) and invalid actions are refused', async () => {
    const d = deps()
    const s0 = await startFlow({ definition: apiKey, scope: 'workspace' }, d)
    const resumed = JSON.parse(JSON.stringify(s0)) as FlowState
    expect(
      await advanceFlow(resumed, { viewId: resumed.view.viewId, action: 'poll' }, d),
    ).toMatchObject({ ok: false, error: 'invalid-action' })
    const ok = await advanceFlow(
      resumed,
      { viewId: resumed.view.viewId, action: 'submit', data: { apiKey: 'long-enough-key' } },
      d,
    )
    expect(ok.ok).toBe(true)
  })

  test('cancel ends the flow; expired flows are refused; wrong scope throws', async () => {
    let t = 0
    const d = deps({ now: () => t, ttlMs: 100 })
    const s0 = await startFlow({ definition: apiKey, scope: 'agent', scopeId: 'a1' }, d)
    const cancelled = must(
      await advanceFlow(s0, { viewId: s0.view.viewId, action: 'cancel' }, d),
    ).state
    expect(cancelled.status).toBe('cancelled')
    t = 1000
    expect(
      await advanceFlow(s0, { viewId: s0.view.viewId, action: 'submit', data: {} }, d),
    ).toMatchObject({ ok: false, error: 'expired' })
    await expect(startFlow({ definition: apiKey, scope: 'agent' }, d)).rejects.toMatchObject({
      details: { reason: 'scope-invalid' },
    })
    await expect(
      startFlow({ definition: apiKey, scope: 'user', scopeId: 'u' }, d),
    ).rejects.toMatchObject({ details: { reason: 'scope-invalid' } })
  })

  test('reconnect skips the settings form when the stored settings are valid', async () => {
    const d = deps()
    const state = await startFlow(
      {
        definition: apiKey,
        scope: 'workspace',
        connection: {
          id: 'c1',
          kind: 'connection',
          definitionId: 'crm',
          label: 'CRM',
          settings: { apiKey: 'stored-key-1234', region: 'eu' },
          enabled: true,
          updatedAt: 0,
          scope: 'workspace',
          status: 'needs-auth',
          defaultEnabled: false,
          createdAt: 0,
        },
      },
      d,
    )
    expect(state.status).toBe('done')
    expect(state.connectionId).toBe('c1')
  })
})

describe('OAuth flow with MCP discovery and dynamic registration', () => {
  test('authorize, callback by state, token exchange; the state works once', async () => {
    const server = fakeAuthServer()
    const connector = remoteMcpConnector({
      listTools: async () => [
        { name: 'search', annotations: { readOnlyHint: true } },
        { name: 'delete', annotations: { destructiveHint: true } },
      ],
    })
    const store = inMemoryFlowStore()
    const d = deps({ definitions: [connector], fetch: server.fetch })
    const s0 = await startFlow({ definition: connector, scope: 'workspace', label: 'Docs' }, d)
    expect(s0.view.type).toBe('form')
    const s1 = must(
      await advanceFlow(
        s0,
        {
          viewId: s0.view.viewId,
          action: 'submit',
          data: { url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
        },
        d,
      ),
    ).state
    expect(s1.view.type).toBe('oauth')
    const view = s1.view as Extract<FlowView, { type: 'oauth' }>
    const url = new URL(view.authorizeUrl)
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize')
    expect(url.searchParams.get('client_id')).toBe('dcr-client')
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/oauth/callback')
    expect(server.registrations[0]?.redirect_uris).toEqual([
      'https://app.example.com/oauth/callback',
    ])
    expect(s1.stateHash).toBeDefined()
    expect(JSON.stringify(publicFlow(s1))).not.toContain('stateHash')
    await store.put(s1)

    // poll while nothing happened: unchanged
    const polled = must(await advanceFlow(s1, { viewId: view.viewId, action: 'poll' }, d)).state
    expect(polled.view.viewId).toBe(view.viewId)

    // wrong state
    expect(await completeOAuth({ state: 'nope', code: 'good-code' }, store, d)).toMatchObject({
      ok: false,
      error: 'unknown-state',
    })
    const state = url.searchParams.get('state') as string
    const result = await completeOAuth({ state, code: 'good-code' }, store, d)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.state.status).toBe('done')
    // PKCE: the verifier sent at the token endpoint hashes to the challenge in the URL
    const body = server.tokenRequests[0] as URLSearchParams
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(body.get('code_verifier') as string),
      ),
    )
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    expect(challenge).toBe(url.searchParams.get('code_challenge') as string)
    expect(body.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(body.get('client_id')).toBe('dcr-client')
    const done = await flowCompletion(result.state, d)
    expect(done.credentials?.tokens?.accessToken).toBe('access-1')
    expect(done.credentials?.client?.clientId).toBe('dcr-client')
    expect(done.credentials?.endpoints?.resource).toBe('https://mcp.example.com/mcp')
    expect(done.capabilities?.map((c) => c.id)).toEqual(['read', 'destructive'])
    expect(JSON.stringify(result.state)).not.toContain('access-1')
    // single use
    expect(await completeOAuth({ state, code: 'good-code' }, store, d)).toMatchObject({
      ok: false,
      error: 'unknown-state',
    })
  })

  test('an authorization error from the server shows a retryable error view', async () => {
    const server = fakeAuthServer()
    const connector = remoteMcpConnector()
    const store = inMemoryFlowStore()
    const d = deps({ definitions: [connector], fetch: server.fetch })
    const s0 = await startFlow({ definition: connector, scope: 'workspace' }, d)
    const s1 = must(
      await advanceFlow(
        s0,
        {
          viewId: s0.view.viewId,
          action: 'submit',
          data: { url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
        },
        d,
      ),
    ).state
    await store.put(s1)
    const state = new URL(
      (s1.view as Extract<FlowView, { type: 'oauth' }>).authorizeUrl,
    ).searchParams.get('state') as string
    const result = await completeOAuth(
      { state, error: 'access_denied', errorDescription: 'No.' },
      store,
      d,
    )
    expect(result.ok && result.state.view).toMatchObject({ type: 'error', retryable: true })
    // retry starts a fresh authorization with a new state
    if (!result.ok) return
    const retried = must(
      await advanceFlow(result.state, { viewId: result.state.view.viewId, action: 'retry' }, d),
    ).state
    expect(retried.view.type).toBe('oauth')
  })

  test('authMode headers and none skip authorization', async () => {
    const connector = remoteMcpConnector()
    const d = deps({ definitions: [connector] })
    const s0 = await startFlow({ definition: connector, scope: 'workspace' }, d)
    const s1 = must(
      await advanceFlow(
        s0,
        {
          viewId: s0.view.viewId,
          action: 'submit',
          data: {
            url: 'https://mcp.example.com/mcp',
            authMode: 'headers',
            headers: { Authorization: 'Bearer abc123456' },
          },
        },
        d,
      ),
    ).state
    expect(s1.status).toBe('done')
    expect(JSON.stringify(s1)).not.toContain('abc123456')
    const done = await flowCompletion(s1, d)
    expect(done.settings.headers).toEqual({ Authorization: 'Bearer abc123456' })
    expect(done.credentials).toBeUndefined()
  })
})

describe('device code, choose and custom steps', () => {
  const device = defineConnector({
    id: 'dev',
    version: '1',
    name: 'Dev',
    description: 'd',
    category: 'x',
    source: 'curated',
    scopes: ['workspace'],
    auth: {
      type: 'deviceCode',
      deviceAuthorizationUrl: 'https://auth.example.com/device',
      tokenUrl: 'https://auth.example.com/token',
      scopes: ['read'],
      client: z.object({ clientId: z.string() }),
    },
    capabilities: [],
    choose: async (ctx) => ({
      key: 'repos',
      title: 'Pick repositories',
      multiple: true,
      options:
        ctx.accessToken === undefined
          ? []
          : [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
    }),
  })

  test('clientConfig receives the flow context (flow id, scope)', async () => {
    const seen: unknown[] = []
    const d = deps({
      definitions: [device],
      fetch: fakeAuthServer().fetch,
      clientConfig: (id, flow) => {
        seen.push([id, flow])
        return { clientId: 'cid' }
      },
    })
    const s0 = await startFlow({ definition: device, scope: 'workspace' }, d)
    expect(seen).toEqual([
      [
        'dev',
        { flowId: s0.id, scope: 'workspace', scopeId: undefined, reconnect: false, settings: {} },
      ],
    ])
  })

  test('device code view, poll respects the interval, then choose validates', async () => {
    const server = fakeAuthServer()
    server.devicePolls = ['authorization_pending', 'slow_down']
    let t = 0
    const d = deps({
      definitions: [device],
      fetch: server.fetch,
      now: () => t,
      clientConfig: () => ({ clientId: 'cid' }),
    })
    const s0 = await startFlow({ definition: device, scope: 'workspace' }, d)
    expect(s0.view).toMatchObject({
      type: 'deviceCode',
      userCode: 'ABCD-EFGH',
      pollIntervalMs: 5000,
    })
    // too early: no request
    const early = must(await advanceFlow(s0, { viewId: s0.view.viewId, action: 'poll' }, d)).state
    expect(server.tokenRequests.length).toBe(0)
    t = 5000
    const p1 = must(
      await advanceFlow(early, { viewId: early.view.viewId, action: 'poll' }, d),
    ).state
    expect(server.tokenRequests.length).toBe(1)
    expect(p1.view.type).toBe('deviceCode')
    t = 10_000
    const p2 = must(await advanceFlow(p1, { viewId: p1.view.viewId, action: 'poll' }, d)).state
    expect((p2.view as Extract<FlowView, { type: 'deviceCode' }>).pollIntervalMs).toBe(10_000)
    t = 25_000
    const p3 = must(await advanceFlow(p2, { viewId: p2.view.viewId, action: 'poll' }, d)).state
    expect(p3.view).toMatchObject({ type: 'choose', multiple: true, min: 1 })
    const bad = must(
      await advanceFlow(
        p3,
        { viewId: p3.view.viewId, action: 'submit', data: { selected: ['zzz'] } },
        d,
      ),
    ).state
    expect((bad.view as Extract<FlowView, { type: 'choose' }>).errors?.selected).toBeDefined()
    const none = must(
      await advanceFlow(
        bad,
        { viewId: bad.view.viewId, action: 'submit', data: { selected: [] } },
        d,
      ),
    ).state
    expect(none.view.type).toBe('choose')
    const ok = must(
      await advanceFlow(
        none,
        { viewId: none.view.viewId, action: 'submit', data: { selected: ['a', 'b'] } },
        d,
      ),
    ).state
    expect(ok.status).toBe('done')
    const done = await flowCompletion(ok, d)
    expect(done.choices.repos).toEqual(['a', 'b'])
    expect(done.credentials?.tokens?.accessToken).toBe('device-access-1')
  })

  test('a custom flow can add a confirm step', async () => {
    const custom = defineConnector({
      id: 'conf',
      version: '1',
      name: 'Conf',
      description: 'd',
      category: 'x',
      source: 'custom',
      scopes: ['workspace'],
      auth: { type: 'none' },
      capabilities: [],
      flow: () => [
        {
          id: 'confirm',
          view: () => ({
            type: 'confirm',
            title: 'Sure?',
            message: 'This shares data.',
            confirmLabel: 'Yes',
            cancelLabel: 'No',
          }),
          advance: (_ctx, { action }) => (action === 'submit' ? { next: true } : { pending: true }),
        },
      ],
    })
    const d = deps({ definitions: [custom] })
    const s0 = await startFlow({ definition: custom, scope: 'workspace' }, d)
    expect(s0.view).toMatchObject({ type: 'confirm', step: 'confirm' })
    const s1 = must(await advanceFlow(s0, { viewId: s0.view.viewId, action: 'submit' }, d)).state
    expect(s1.status).toBe('done')
  })

  test('a connector with nothing to ask finishes at start', async () => {
    const plain = defineConnector({
      id: 'plain',
      version: '1',
      name: 'P',
      description: 'd',
      category: 'x',
      source: 'builtin',
      scopes: ['workspace'],
      auth: { type: 'none' },
      capabilities: [],
    })
    expect(
      (await startFlow({ definition: plain, scope: 'workspace' }, deps({ definitions: [plain] })))
        .status,
    ).toBe('done')
  })
})
