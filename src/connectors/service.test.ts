import { describe, expect, test } from 'bun:test'
import { webCryptoVault } from '../providers/index.ts'
import { remoteMcpConnector } from './remote-mcp.ts'
import { createConnectorService } from './service.ts'
import {
  inMemoryConnectionStore,
  inMemoryCredentialStore,
  inMemoryEnablementStore,
  inMemoryFlowStore,
} from './store.ts'
import { fakeAuthServer } from './test-kit.ts'
import type { FlowView, McpSourceSpec } from './types.ts'

function make() {
  const server = fakeAuthServer()
  const vault = webCryptoVault(new Uint8Array(32).fill(9))
  const connector = remoteMcpConnector({
    listTools: async () => [
      { name: 'search', annotations: { readOnlyHint: true } },
      { name: 'create' },
    ],
  })
  const service = createConnectorService({
    definitions: [connector],
    connections: inMemoryConnectionStore(),
    credentials: inMemoryCredentialStore({ vault }),
    enablement: inMemoryEnablementStore(),
    flows: inMemoryFlowStore(),
    vault,
    fetch: server.fetch,
    redirectUri: 'https://app.example.com/oauth/callback',
  })
  return { server, service }
}

describe('connector service', () => {
  test('connect with OAuth from start to an activated, redacted connection; no token leaves', async () => {
    const { server, service } = make()
    expect(service.catalog()[0]?.id).toBe('mcp-remote')
    const started = await service.startConnect({
      definitionId: 'mcp-remote',
      scope: 'workspace',
      label: 'Docs',
      defaultEnabled: true,
    })
    const s1 = await service.advance(started.flow.id, {
      viewId: started.flow.view.viewId,
      action: 'submit',
      data: { url: 'https://mcp.example.com/mcp', authMode: 'oauth' },
    })
    expect(s1.ok && s1.flow.view.type).toBe('oauth')
    if (!s1.ok) return
    const state = new URL(
      (s1.flow.view as Extract<FlowView, { type: 'oauth' }>).authorizeUrl,
    ).searchParams.get('state') as string
    // a reload resumes at the same view
    expect((await service.getFlow(s1.flow.id))?.flow.view.viewId).toBe(s1.flow.view.viewId)
    const cb = await service.completeOAuth({ state, code: 'good-code' })
    expect(cb.ok).toBe(true)
    if (!cb.ok) return
    expect(cb.connection).toMatchObject({
      label: 'Docs',
      status: 'connected',
      authorized: true,
      defaultEnabled: true,
      scope: 'workspace',
    })
    // the polling tab learns the outcome from the finished flow
    const poll = await service.advance(s1.flow.id, { viewId: s1.flow.view.viewId, action: 'poll' })
    expect(poll).toMatchObject({ ok: false, error: 'finished' })
    expect(poll.connection?.id).toBe(cb.connection?.id)
    const everything = JSON.stringify([
      cb,
      poll,
      await service.list(),
      await service.getFlow(s1.flow.id),
    ])
    for (const secret of ['access-1', 'refresh-1', 'good-code'])
      expect(everything).not.toContain(secret)

    // activation: OAuth bearer per request, tools grouped by annotation, pinned ask for the write tool
    const specs: McpSourceSpec[] = []
    const out = await service.activate({
      agent: { id: 'a1' },
      mcp: (spec) => {
        specs.push(spec)
        return { id: 'x', list: () => ({}), '~toolSource': true } as never
      },
    })
    expect(await specs[0]?.getAccessToken?.()).toBe('access-1')
    expect(specs[0]?.allow).toEqual(['search', 'create'])
    // read tools of a custom server ask too: readOnlyHint is untrusted
    expect(out.rules).toMatchObject({ allow: [], ask: ['search', 'create'], pinnedAsk: ['create'] })
    expect(server.tokenRequests.length).toBe(1)

    // opting an agent out, per-capability and per-tool overrides
    await service.setEnablement('a2', cb.connection?.id as string, { enabled: 'off' })
    expect(
      (await service.activate({ agent: { id: 'a2' }, mcp: () => ({}) as never })).connections,
    ).toEqual([])
    // removing the connection removes credentials and enablement
    await service.remove(cb.connection?.id as string)
    expect(await service.list()).toEqual([])
    expect(await service.enablement('a2')).toEqual({})
    await expect(service.accessToken(cb.connection?.id as string)).rejects.toMatchObject({
      details: { reason: 'needs-auth' },
    })
  })

  test('update keeps secrets that the patch does not resend and rejects invalid settings', async () => {
    const { service } = make()
    const started = await service.startConnect({
      definitionId: 'mcp-remote',
      scope: 'agent',
      scopeId: 'a1',
    })
    const done = await service.advance(started.flow.id, {
      viewId: started.flow.view.viewId,
      action: 'submit',
      data: {
        url: 'https://mcp.example.com/mcp',
        authMode: 'headers',
        headers: { Authorization: 'Bearer secret-token-1' },
      },
    })
    expect(done.ok && done.connection?.settings.headers).toEqual({
      Authorization: { set: true, hint: '…en-1' },
    })
    if (!done.ok || done.connection === undefined) return
    const updated = await service.update(done.connection.id, {
      label: 'Renamed',
      settings: { url: 'https://mcp.example.com/mcp', headers: { Authorization: '' } },
    })
    expect(updated.label).toBe('Renamed')
    expect(updated.settings.headers).toEqual({ Authorization: { set: true, hint: '…en-1' } })
    // a new URL never inherits the stored header values
    const moved = await service.update(done.connection.id, {
      settings: { url: 'https://mcp.example.com/v2', headers: { Authorization: '' } },
    })
    expect(moved.settings.url).toBe('https://mcp.example.com/v2')
    expect(moved.settings.headers).toEqual({})
    await service.update(done.connection.id, {
      settings: {
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer secret-token-1' },
      },
    })
    await expect(
      service.update(done.connection.id, { settings: { url: 'not a url' } }),
    ).rejects.toMatchObject({ details: { reason: 'settings-invalid' } })
    const result = await service.test(done.connection.id)
    expect(result.ok).toBe(true)
    expect((await service.get(done.connection.id))?.capabilities?.map((c) => c.id)).toEqual([
      'read',
      'write',
    ])
  })

  test('an unknown flow is not-found', async () => {
    const { service } = make()
    expect(await service.advance('nope', { viewId: 'x', action: 'poll' })).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })
})
