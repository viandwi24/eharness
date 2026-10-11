import { describe, expect, test } from 'bun:test'
import { webCryptoVault } from '../providers/index.ts'
import { defineConnector } from './definition.ts'
import { advanceFlow, flowCompletion, publicFlow, startFlow } from './flow.ts'
import { createConnectorService } from './service.ts'
import {
  inMemoryConnectionStore,
  inMemoryCredentialStore,
  inMemoryEnablementStore,
  inMemoryFlowStore,
} from './store.ts'
import type { FlowDeps, FlowState, FlowView } from './types.ts'

const vault = webCryptoVault(new Uint8Array(32).fill(3))
const SESSION = 'mtcute-session-SECRET-0123456789'

function deps(): FlowDeps {
  let t = 1_000_000
  let n = 0
  return { definitions: [login], vault, now: () => t++, newId: () => `f-${++n}` }
}

/** A user-account login: a code form with resend, or a rotating QR code. */
const login = defineConnector({
  id: 'tg-user',
  version: '1',
  name: 'Telegram account',
  description: 'A user session.',
  category: 'chat',
  source: 'custom',
  scopes: ['workspace'],
  auth: { type: 'none' },
  capabilities: [],
  flow: [
    {
      id: 'method',
      view: () => ({
        type: 'confirm',
        title: 'Sign in',
        message: 'Use a QR code?',
        confirmLabel: 'QR',
        cancelLabel: 'Code',
      }),
      advance: (ctx, { action }) => {
        if (action !== 'submit') return { pending: true }
        ctx.scratch.sent = 0
        return { next: true }
      },
    },
    {
      id: 'qr',
      enter: (ctx) => {
        ctx.scratch.polls = 0
      },
      view: (ctx) => ({
        type: 'qr',
        title: 'Scan',
        url: `tg://login?token=t${String(ctx.scratch.polls)}`,
        expiresAt: ctx.now() + 30_000,
        pollIntervalMs: 2000,
      }),
      advance: (ctx, { action }) => {
        if (action !== 'poll') return { pending: true }
        ctx.scratch.polls = Number(ctx.scratch.polls) + 1
        if (ctx.scratch.polls === 3) {
          ctx.scratch.credentials = { session: { format: 'mtcute-string', data: SESSION } }
          return { next: true }
        }
        return { pending: true }
      },
    },
  ],
})

const codeLogin = defineConnector({
  id: 'tg-code',
  version: '1',
  name: 'Telegram code',
  description: 'A user session.',
  category: 'chat',
  source: 'custom',
  scopes: ['workspace'],
  auth: { type: 'none' },
  capabilities: [],
  flow: [
    {
      id: 'code',
      enter: (ctx) => {
        ctx.scratch.sent = 1
      },
      view: (ctx) => ({
        type: 'form',
        title: 'Enter the code',
        fields: [],
        values: {},
        message: `Code sent ${String(ctx.scratch.sent)} time(s).`,
        submitLabel: 'Sign in',
      }),
      advance: (ctx, { action, data }) => {
        if (action === 'resend') {
          ctx.scratch.sent = Number(ctx.scratch.sent) + 1
          return { stay: true, message: `Code sent ${String(ctx.scratch.sent)} time(s).` }
        }
        if (data.code !== '12345') return { stay: true, errors: { code: 'Wrong code.' } }
        ctx.scratch.credentials = { session: { format: 'mtcute-string', data: SESSION } }
        return { next: true }
      },
    },
  ],
})

const must = (r: Awaited<ReturnType<typeof advanceFlow>>): FlowState => {
  expect(r.ok).toBe(true)
  return (r as { state: FlowState }).state
}
const urlOf = (s: FlowState): string => (s.view as Extract<FlowView, { type: 'qr' }>).url

describe('qr view', () => {
  test('re-renders under the same viewId while the url rotates, then completes with a sealed session', async () => {
    const d = { ...deps(), definitions: [login] }
    let s = await startFlow({ definition: login, scope: 'workspace' }, d)
    s = must(await advanceFlow(s, { viewId: s.view.viewId, action: 'submit' }, d))
    expect(s.view).toMatchObject({ type: 'qr', step: 'qr', pollIntervalMs: 2000 })
    const id = s.view.viewId
    expect(urlOf(s)).toBe('tg://login?token=t0')
    s = must(await advanceFlow(s, { viewId: id, action: 'poll' }, d))
    expect(s.view.viewId).toBe(id)
    expect(urlOf(s)).toBe('tg://login?token=t1')
    s = must(await advanceFlow(s, { viewId: id, action: 'poll' }, d))
    expect(urlOf(s)).toBe('tg://login?token=t2')
    // submit does not apply to a qr view
    const bad = await advanceFlow(s, { viewId: id, action: 'submit' }, d)
    expect(bad).toMatchObject({ ok: false, error: 'invalid-action' })
    s = must(await advanceFlow(s, { viewId: id, action: 'poll' }, d))
    expect(s.status).toBe('done')
    // the session is in the sealed scratch only
    expect(JSON.stringify(s)).not.toContain(SESSION)
    expect(JSON.stringify(publicFlow(s))).not.toContain(SESSION)
    const completion = await flowCompletion(s, d)
    expect(completion.credentials?.session).toEqual({ format: 'mtcute-string', data: SESSION })
  })

  test('cancel works from a qr view', async () => {
    const d = { ...deps(), definitions: [login] }
    let s = await startFlow({ definition: login, scope: 'workspace' }, d)
    s = must(await advanceFlow(s, { viewId: s.view.viewId, action: 'submit' }, d))
    s = must(await advanceFlow(s, { viewId: s.view.viewId, action: 'cancel' }, d))
    expect(s.status).toBe('cancelled')
  })
})

describe('resend', () => {
  test('reaches the step, keeps the form and changes the viewId; a wrong code never echoes secrets', async () => {
    const d = { ...deps(), definitions: [codeLogin] }
    let s = await startFlow({ definition: codeLogin, scope: 'workspace' }, d)
    expect(s.view).toMatchObject({ type: 'form', message: 'Code sent 1 time(s).' })
    const first = s.view.viewId
    s = must(await advanceFlow(s, { viewId: first, action: 'resend' }, d))
    expect(s.view).toMatchObject({ type: 'form', message: 'Code sent 2 time(s).' })
    expect(s.view.viewId).not.toBe(first)
    // the old view is stale
    expect(await advanceFlow(s, { viewId: first, action: 'resend' }, d)).toMatchObject({
      ok: false,
      error: 'stale-view',
    })
    s = must(
      await advanceFlow(s, { viewId: s.view.viewId, action: 'submit', data: { code: '1' } }, d),
    )
    expect(s.status).toBe('active')
    s = must(
      await advanceFlow(s, { viewId: s.view.viewId, action: 'submit', data: { code: '12345' } }, d),
    )
    expect(s.status).toBe('done')
  })

  test('is not accepted by views that do not offer it', async () => {
    const d = { ...deps(), definitions: [login] }
    const s = await startFlow({ definition: login, scope: 'workspace' }, d)
    expect(s.view.type).toBe('confirm')
    expect(await advanceFlow(s, { viewId: s.view.viewId, action: 'resend' }, d)).toMatchObject({
      ok: false,
      error: 'invalid-action',
    })
  })
})

describe('session slot through the service', () => {
  function make() {
    const connections = inMemoryConnectionStore()
    const service = createConnectorService({
      definitions: [codeLogin],
      connections,
      credentials: inMemoryCredentialStore({ vault }),
      enablement: inMemoryEnablementStore(),
      flows: inMemoryFlowStore(),
      vault,
    })
    return { service, connections }
  }

  async function connect(service: ReturnType<typeof make>['service'], principal?: string) {
    const started = await service.startConnect({
      definitionId: 'tg-code',
      scope: 'workspace',
      ...(principal === undefined ? {} : { principal }),
    })
    const done = await service.advance(started.flow.id, {
      viewId: started.flow.view.viewId,
      action: 'submit',
      data: { code: '12345' },
      ...(principal === undefined ? {} : { principal }),
    })
    expect(done.ok).toBe(true)
    return done
  }

  test('saved with the connection, read server side, never in public shapes', async () => {
    const { service } = make()
    const done = await connect(service)
    if (!done.ok || done.connection === undefined) throw new Error('not connected')
    expect(done.connection.authorized).toBe(true)
    const everything = JSON.stringify([
      done,
      await service.list(),
      await service.get(done.connection.id),
    ])
    expect(everything).not.toContain(SESSION)
    const creds = await service.credentials(done.connection.id)
    expect(creds?.session).toEqual({ format: 'mtcute-string', data: SESSION })
    expect(await service.credentials('nope')).toBeUndefined()
    // the read is a copy
    if (creds?.session !== undefined) creds.session.data = 'changed'
    expect((await service.credentials(done.connection.id))?.session?.data).toBe(SESSION)
  })

  test('markNeedsAuth records the message and keeps the credentials; reconnect replaces the session', async () => {
    const { service } = make()
    const done = await connect(service)
    if (!done.ok || done.connection === undefined) throw new Error('not connected')
    const id = done.connection.id
    await service.markNeedsAuth(id, 'The session was revoked.')
    expect(await service.get(id)).toMatchObject({
      status: 'needs-auth',
      statusMessage: 'The session was revoked.',
    })
    expect((await service.credentials(id))?.session?.data).toBe(SESSION)
    await service.markNeedsAuth('missing') // no-op
    const again = await service.reconnect(id)
    const finished = await service.advance(again.flow.id, {
      viewId: again.flow.view.viewId,
      action: 'submit',
      data: { code: '12345' },
    })
    expect(finished.ok && finished.connection?.status).toBe('connected')
    expect(finished.ok && finished.connection?.statusMessage).toBeUndefined()
  })

  test('principal binding still applies to resend and qr actions', async () => {
    const { service } = make()
    const started = await service.startConnect({
      definitionId: 'tg-code',
      scope: 'workspace',
      principal: 'admin-1',
    })
    const viewId = started.flow.view.viewId
    expect(await service.advance(started.flow.id, { viewId, action: 'resend' })).toMatchObject({
      ok: false,
      error: 'principal-mismatch',
    })
    expect(
      await service.advance(started.flow.id, { viewId, action: 'resend', principal: 'other' }),
    ).toMatchObject({ ok: false, error: 'principal-mismatch' })
    const ok = await service.advance(started.flow.id, {
      viewId,
      action: 'resend',
      principal: 'admin-1',
    })
    expect(ok.ok).toBe(true)
    await connect(service, 'admin-1')
  })
})

describe('workspace client config for custom steps', () => {
  test('a custom step reads api id and hash through deps.clientConfig, without leaking them', async () => {
    const seen: string[] = []
    const def = defineConnector({
      id: 'tg-cfg',
      version: '1',
      name: 'Telegram config',
      description: 'd',
      category: 'chat',
      source: 'custom',
      scopes: ['workspace'],
      auth: { type: 'none' },
      capabilities: [],
      flow: [
        {
          id: 'app',
          auto: true,
          view: () => ({ type: 'status', state: 'running', message: 'Checking…' }),
          advance: async (ctx) => {
            const cfg = await ctx.deps.clientConfig(ctx.definition.id, {
              flowId: ctx.flowId,
              scope: ctx.scope,
              scopeId: ctx.scopeId,
              reconnect: ctx.reconnect,
              settings: {},
            })
            seen.push(`${String(cfg?.apiId)}:${String(cfg?.apiHash)}`)
            return cfg === undefined ? { error: 'No API id configured.' } : { next: true }
          },
        },
      ],
    })
    const d: FlowDeps = {
      ...deps(),
      definitions: [def],
      clientConfig: (id) =>
        id === 'tg-cfg' ? { apiId: 12345, apiHash: 'HASH-SECRET' } : undefined,
    }
    const s = await startFlow({ definition: def, scope: 'workspace' }, d)
    expect(s.status).toBe('done')
    expect(seen).toEqual(['12345:HASH-SECRET'])
    expect(JSON.stringify(publicFlow(s))).not.toContain('HASH-SECRET')
  })
})
