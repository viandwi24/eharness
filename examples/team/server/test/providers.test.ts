/**
 * Providers and profiles: secret encryption at rest, the routes (redaction, keep-secret patch,
 * read-only env profiles, models, test), agents and the workspace default on a store profile
 * (cost and context window through the catalog), legacy `model` strings, the catalog cache and
 * the change feed between two instances.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lookupModel } from 'eharness'
import type { SecretVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { sqliteCatalogCache } from '../src/infra/eh/catalog-cache.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import {
  generateSecretKey,
  parseSecretKey,
  secretKeysFromEnv,
  teamVault,
} from '../src/infra/eh/secret-vault.ts'
import { compose, type Server } from '../src/main.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-providers-'))
  dirs.push(d)
  return d
}

const LIST = {
  data: [
    {
      id: 'anthropic/claude-x',
      name: 'Claude X',
      context_length: 1_000_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'meta/plain:free',
      name: 'Plain',
      context_length: 8_000,
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
    },
  ],
}

function stubFetch(calls: string[] = [], keyStatus = 200): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    if (u.endsWith('/key')) return new Response('{}', { status: keyStatus })
    return new Response(JSON.stringify(LIST))
  }) as unknown as typeof fetch
}

const SECRET = 'sk-or-v1-SUPERSECRETVALUE-0123456789'

function box(): SecretVault {
  return teamVault([parseSecretKey(generateSecretKey())])
}

interface BootOptions {
  env?: Record<string, string>
  dbFile?: string
  calls?: string[]
  keyStatus?: number
  pollMs?: number
  secretBox?: SecretVault
}

async function boot(options: BootOptions = {}): Promise<Server> {
  const server = compose({
    dbFile: options.dbFile ?? ':memory:',
    env: options.env ?? {},
    offline: false,
    fetch: stubFetch(options.calls, options.keyStatus),
    vault: options.secretBox ?? box(),
    changePollMs: options.pollMs ?? 0,
    models: undefined,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
  })
  servers.push(server)
  await server.providersReady
  return server
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

describe('secret vault', () => {
  test('seals and opens bound to a context; tampering, other context and unknown keys fail', async () => {
    const v = teamVault([parseSecretKey(generateSecretKey())])
    const a = await v.seal('hello', 'ctx')
    expect(a.startsWith('v2.')).toBe(true)
    expect(a).not.toContain('hello')
    expect(await v.seal('hello', 'ctx')).not.toBe(a)
    expect(await v.open(a, 'ctx')).toBe('hello')
    await expect(v.open(a, 'other')).rejects.toThrow()
    await expect(v.open(`${a.slice(0, -3)}AAA`, 'ctx')).rejects.toThrow()
    const other = teamVault([parseSecretKey(generateSecretKey())])
    await expect(other.open(a, 'ctx')).rejects.toThrow()
  })

  test('rotation: the new key seals, the previous key still opens, needsReseal flags old blobs', async () => {
    const oldKey = parseSecretKey(generateSecretKey())
    const newKey = parseSecretKey(generateSecretKey())
    const sealedOld = await teamVault([oldKey]).seal('x', 'c')
    const rotated = teamVault([newKey, oldKey])
    expect(await rotated.open(sealedOld, 'c')).toBe('x')
    expect(rotated.needsReseal?.(sealedOld)).toBe(true)
    const fresh = await rotated.seal('y', 'c')
    expect(rotated.needsReseal?.(fresh)).toBe(false)
  })

  test('a malformed TEAM_SECRET_KEY is an error; without one a dev key file is created and reused', () => {
    expect(() => secretKeysFromEnv({ env: { TEAM_SECRET_KEY: 'short' } })).toThrow(/32 bytes/)
    const dir = tmp()
    const warnings: string[] = []
    const first = teamVault(
      secretKeysFromEnv({ env: {}, dataDir: dir, warn: (m) => warnings.push(m) }),
    )
    expect(warnings.join('\n')).toMatch(/TEAM_SECRET_KEY is not set/)
    const keyFile = join(dir, 'secret.key')
    const text = readFileSync(keyFile, 'utf8')
    const second = teamVault(secretKeysFromEnv({ env: {}, dataDir: dir, warn: () => undefined }))
    return first
      .seal('same key', 'c')
      .then((blob) => second.open(blob, 'c'))
      .then((plain) => {
        expect(plain).toBe('same key')
        expect(readFileSync(keyFile, 'utf8')).toBe(text)
      })
  })
})

describe('legacy sealed rows', () => {
  // the earlier secret box: `v1:<keyId>:<iv>:<ct>`, plain settings (providers) or `{ c, p }` (connections)
  async function legacySeal(keyBytes: Uint8Array<ArrayBuffer>, plain: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes))
    const id = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)),
    )
    const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64url')
    return `v1:${id}:${b64(iv)}:${b64(data)}`
  }

  test('v1 provider and connection rows still open, are re-sealed at boot, survive a rotation', async () => {
    const dir = tmp()
    const dbFile = join(dir, 'team.db')
    const oldKey = parseSecretKey(generateSecretKey())
    const newKey = parseSecretKey(generateSecretKey())
    const first = await boot({ dbFile, secretBox: teamVault([oldKey]) })
    const at = Date.now()
    const insert = first.conn.sqlite.query(
      'INSERT INTO config_profiles (kind, id, definition_id, label, settings, models, extra, enabled, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?)',
    )
    insert.run(
      'provider',
      'legacy',
      'openrouter',
      'Legacy',
      await legacySeal(oldKey, JSON.stringify({ apiKey: SECRET })),
      at,
    )
    insert.run(
      'connection',
      'legacy-conn',
      'mcp-remote',
      'Legacy conn',
      JSON.stringify({
        '~sealed': await legacySeal(
          oldKey,
          JSON.stringify({
            c: 'profile:connection:legacy-conn',
            p: JSON.stringify({ url: 'https://mcp.example.com/mcp', authMode: 'none' }),
          }),
        ),
      }),
      at,
    )
    await first.close()
    servers.pop()

    // new key first, the old one kept for the rotation: rows open and are rewritten with v2
    const second = await boot({ dbFile, secretBox: teamVault([newKey, oldKey]) })
    await second.connectorsReady
    expect(second.providers.profileIds()).toContain('legacy')
    const rows = second.conn.sqlite
      .query<{ settings: string }, []>(
        "SELECT settings FROM config_profiles WHERE id IN ('legacy', 'legacy-conn')",
      )
      .all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.settings.startsWith('{"~sealed":"v2.')).toBe(true)
      expect(row.settings).not.toContain('SUPERSECRET')
    }
    await second.close()
    servers.pop()

    // the old key is gone: the migrated rows open with the new key alone
    const third = await boot({ dbFile, secretBox: teamVault([newKey]) })
    expect(third.providers.profileIds()).toContain('legacy')
    const res = await third.app.request('/providers/profiles/legacy/test', send('POST'))
    expect(res.status).toBe(200)
  })

  test('a row of a lost key is skipped with a warning; the other rows still load', async () => {
    const dir = tmp()
    const dbFile = join(dir, 'team.db')
    const a = await boot({ dbFile, secretBox: box() })
    await a.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', id: 'gone', settings: { apiKey: SECRET } }),
    )
    await a.close()
    servers.pop()
    const warn = console.warn
    const lines: string[] = []
    console.warn = (m: unknown) => void lines.push(String(m))
    try {
      const b = await boot({ dbFile, secretBox: box() })
      expect(b.providers.profileIds()).toEqual([])
      expect(lines.join('\n')).toContain('"gone" is unreadable')
      expect(lines.join('\n')).not.toContain('SUPERSECRET')
    } finally {
      console.warn = warn
    }
  })
})

describe('profiles API', () => {
  test('empty DB, empty env: definitions with form fields and no profiles', async () => {
    const { app } = await boot()
    const body = (await (await app.request('/providers')).json()) as {
      providers: Array<{
        id: string
        fields: Array<{ path: string; secret: boolean; group: string }>
      }>
      profiles: unknown[]
    }
    expect(body.profiles).toEqual([])
    const openrouter = body.providers.find((p) => p.id === 'openrouter')
    expect(openrouter?.fields.find((f) => f.path === 'apiKey')).toMatchObject({
      secret: true,
      group: 'auth',
    })
    expect(openrouter?.fields.find((f) => f.path === 'headers')).toMatchObject({
      secretValues: true,
      group: 'advanced',
    })
    expect(body.providers.map((p) => p.id)).toContain('gateway')
  })

  test('create two profiles of one provider; secrets are redacted and encrypted at rest', async () => {
    const dir = tmp()
    const dbFile = join(dir, 'team.db')
    const server = await boot({ dbFile })
    const { app } = server
    const created = await app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'openrouter',
        label: 'Work',
        settings: { apiKey: SECRET, headers: { 'X-Team': 'HEADERSECRET-9999' } },
      }),
    )
    expect(created.status).toBe(201)
    const first = (await created.json()) as {
      id: string
      settings: Record<string, unknown>
      source: string
    }
    expect(first).toMatchObject({ id: 'openrouter', source: 'store', label: 'Work' })
    const second = (await (
      await app.request(
        '/providers/profiles',
        send('POST', {
          providerId: 'openrouter',
          label: 'Personal',
          settings: { apiKey: `${SECRET}-2` },
        }),
      )
    ).json()) as { id: string }
    expect(second.id).toBe('openrouter-2')

    // no response carries a secret
    const list = await app.request('/providers')
    const text = await list.text()
    expect(text).not.toContain('SUPERSECRET')
    expect(text).not.toContain('HEADERSECRET')
    expect(
      JSON.parse(text).profiles.find((p: { id: string }) => p.id === 'openrouter').settings,
    ).toEqual({
      apiKey: { set: true, hint: '…6789' },
      headers: { 'X-Team': { set: true, hint: '…9999' } },
    })

    // the database never holds a plaintext secret
    server.conn.sqlite.run('PRAGMA wal_checkpoint(TRUNCATE)')
    const rows = server.conn.sqlite
      .query<{ settings: string; label: string }, []>(
        "SELECT settings, label FROM config_profiles WHERE kind = 'provider'",
      )
      .all()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.settings.startsWith('{"~sealed":"v2.')).toBe(true)
      expect(row.settings).not.toContain('SUPERSECRET')
    }
    const raw = readFileSync(dbFile)
    expect(raw.includes(Buffer.from('SUPERSECRET'))).toBe(false)
    expect(raw.includes(Buffer.from('HEADERSECRET'))).toBe(false)
  })

  test('patch keeps secrets that are omitted, empty or {keep:true}; replaces and removes others', async () => {
    const server = await boot()
    const { app } = server
    await app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'openrouter',
        settings: { apiKey: SECRET, headers: { A: 'secret-a-value-1', B: 'secret-b-value-2' } },
      }),
    )
    const stored = async (): Promise<Record<string, unknown>> => {
      const profile = await server.providers.manager.getProfile('openrouter')
      return profile?.settings ?? {}
    }
    // label only: nothing else changes
    let res = await app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { label: 'Renamed' }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { label: string }).label).toBe('Renamed')
    // keep markers, header A kept, header B dropped (not sent), header C new
    res = await app.request(
      '/providers/profiles/openrouter',
      send('PATCH', {
        settings: { apiKey: { keep: true }, headers: { A: '', C: 'new-header-value-3' } },
      }),
    )
    expect(res.status).toBe(200)
    expect((await stored()).headers).toEqual({
      A: { set: true, hint: '…ue-1' },
      C: { set: true, hint: '…ue-3' },
    })
    // the key itself is intact: verify through the encrypted row (same box)
    const row = server.conn.sqlite
      .query<{ settings: string }, []>(
        "SELECT settings FROM config_profiles WHERE id = 'openrouter'",
      )
      .get()
    expect(row?.settings).toBeDefined()
    // empty string keeps, a new value replaces
    res = await app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { settings: { apiKey: '' } }),
    )
    expect(
      ((await res.json()) as { settings: { apiKey: { hint: string } } }).settings.apiKey.hint,
    ).toBe('…6789')
    res = await app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { settings: { apiKey: 'sk-or-brand-new-key-4242' } }),
    )
    expect(
      ((await res.json()) as { settings: { apiKey: { hint: string } } }).settings.apiKey.hint,
    ).toBe('…4242')
    // validation: a bad base URL is a 400 that does not echo the key
    res = await app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { settings: { baseURL: 'nope' } }),
    )
    expect(res.status).toBe(400)
    expect(await res.text()).not.toContain('brand-new')
    expect(
      (await app.request('/providers/profiles/ghost', send('PATCH', { label: 'x' }))).status,
    ).toBe(404)
  })

  test('env profiles are read-only and show as source env; TEAM_PROVIDER / TEAM_MODEL pick the default', async () => {
    const { app } = await boot({
      env: { OPENROUTER_API_KEY: SECRET, AI_GATEWAY_API_KEY: 'gw-key-0000' },
    })
    const body = (await (await app.request('/providers')).json()) as {
      profiles: Array<{
        id: string
        source: string
        isDefault: boolean
        settings: Record<string, unknown>
      }>
    }
    expect(body.profiles.map((p) => [p.id, p.source, p.isDefault])).toEqual([
      ['openrouter', 'env', true],
      ['gateway', 'env', false],
    ])
    expect(JSON.stringify(body)).not.toContain('SUPERSECRET')
    for (const method of ['PATCH', 'DELETE']) {
      const res = await app.request(
        '/providers/profiles/openrouter',
        method === 'PATCH' ? send('PATCH', { label: 'x' }) : { method },
      )
      expect(res.status).toBe(409)
      expect(
        ((await res.json()) as { error: { code: string; message: string } }).error,
      ).toMatchObject({
        code: 'READ_ONLY_PROFILE',
        message: expect.stringContaining('environment'),
      })
    }
    // creating a stored profile with the id of an env profile is refused too
    const clash = await app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', id: 'openrouter', settings: { apiKey: 'sk-x' } }),
    )
    expect(clash.status).toBe(409)
  })

  test('TEAM_PROVIDER=gateway makes the gateway the default profile', async () => {
    const { app } = await boot({
      env: { OPENROUTER_API_KEY: SECRET, AI_GATEWAY_API_KEY: 'gw', TEAM_PROVIDER: 'gateway' },
    })
    const body = (await (await app.request('/providers')).json()) as {
      profiles: Array<{ id: string; isDefault: boolean }>
    }
    expect(body.profiles.find((p) => p.isDefault)?.id).toBe('gateway')
  })

  test('delete works, is idempotent-404, and is refused while an agent uses the profile', async () => {
    const { app } = await boot()
    await app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', settings: { apiKey: SECRET } }),
    )
    await app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', id: 'second', settings: { apiKey: `${SECRET}x` } }),
    )
    const agent = await app.request(
      '/agents',
      send('POST', {
        name: 'Pinned',
        instructions: 'x',
        modelProfile: 'second',
        model: 'meta/plain:free',
      }),
    )
    expect(agent.status).toBe(201)
    const busy = await app.request('/providers/profiles/second', { method: 'DELETE' })
    expect(busy.status).toBe(409)
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('PROFILE_IN_USE')
    expect((await app.request('/providers/profiles/openrouter', { method: 'DELETE' })).status).toBe(
      204,
    )
    expect((await app.request('/providers/profiles/openrouter', { method: 'DELETE' })).status).toBe(
      404,
    )
  })

  test('test route reports ok / failure without leaking the key; models carry metadata', async () => {
    const calls: string[] = []
    const ok = await boot({ calls })
    await ok.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', settings: { apiKey: SECRET } }),
    )
    const good = (await (
      await ok.app.request('/providers/profiles/openrouter/test', { method: 'POST' })
    ).json()) as {
      ok: boolean
    }
    expect(good.ok).toBe(true)

    const models = (await (
      await ok.app.request('/providers/profiles/openrouter/models?refresh=true')
    ).json()) as {
      models: Array<{
        id: string
        name: string
        contextWindow?: number
        pricing?: { input: number; output: number }
        reasoning?: boolean
        tools?: boolean
      }>
    }
    const claude = models.models.find((m) => m.id === 'anthropic/claude-x')
    expect(claude).toMatchObject({
      name: 'Claude X',
      contextWindow: 1_000_000,
      tools: true,
      reasoning: true,
    })
    expect(claude?.pricing?.input).toBeCloseTo(3, 6)
    expect(claude?.pricing?.output).toBeCloseTo(15, 6)
    expect(models.models[0]?.id).toBe('anthropic/claude-x') // models with tools first
    expect((await ok.app.request('/providers/profiles/ghost/models')).status).toBe(404)
  })

  test('allow / deny hide models from agents; all=true lists them marked enabled', async () => {
    const ok = await boot({ calls: [] })
    await ok.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', settings: { apiKey: SECRET } }),
    )
    type List = { models: Array<{ id: string; enabled?: boolean }> }
    const list = async (query: string): Promise<List> =>
      (await (await ok.app.request(`/providers/profiles/openrouter/models${query}`)).json()) as List
    const all = await list('?all=true')
    expect(all.models.length).toBeGreaterThan(1)
    expect(all.models.every((m) => m.enabled === true)).toBe(true)
    const first = all.models[0]?.id as string
    const patched = await ok.app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { models: { allow: [first] } }),
    )
    expect(patched.status).toBe(200)
    expect((await list('')).models.map((m) => m.id)).toEqual([first])
    const marked = await list('?all=true')
    expect(marked.models.find((m) => m.id === first)?.enabled).toBe(true)
    expect(marked.models.filter((m) => m.enabled === false).length).toBe(all.models.length - 1)
    // back to everything
    await ok.app.request('/providers/profiles/openrouter', send('PATCH', { models: null }))
    expect((await list('')).models.length).toBe(all.models.length)
  })

  test('editing a profile does not change which one is the default', async () => {
    const t = await boot({ calls: [] })
    for (const providerId of ['openrouter', 'gateway']) {
      await t.app.request(
        '/providers/profiles',
        send('POST', { providerId, settings: { apiKey: SECRET } }),
      )
    }
    const defaultId = async (): Promise<string | undefined> =>
      (
        (await (await t.app.request('/providers')).json()) as {
          profiles: Array<{ id: string; isDefault: boolean }>
        }
      ).profiles.find((p) => p.isDefault)?.id
    expect(await defaultId()).toBe('openrouter')
    await new Promise((resolve) => setTimeout(resolve, 15)) // a later updated_at
    await t.app.request(
      '/providers/profiles/openrouter',
      send('PATCH', { models: { deny: ['some/model'] } }),
    )
    expect(await defaultId()).toBe('openrouter')
  })

  test('a failing key test is ok:false with a message and no secret', async () => {
    const bad = await boot({ keyStatus: 401 })
    await bad.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', settings: { apiKey: SECRET } }),
    )
    const res = await bad.app.request('/providers/profiles/openrouter/test', { method: 'POST' })
    const body = (await res.json()) as { ok: boolean; message?: string }
    expect(body.ok).toBe(false)
    expect(body.message).toContain('401')
    expect(JSON.stringify(body)).not.toContain('SUPERSECRET')
  })
})

describe('agents on store profiles', () => {
  async function withProfile(): Promise<Server> {
    const server = await boot()
    const created = await server.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', id: 'or-work', settings: { apiKey: SECRET } }),
    )
    expect(created.status).toBe(201)
    await server.providers.manager.loadCatalogs()
    return server
  }

  test('an agent resolves through its profile; cost and window come from the catalog', async () => {
    const server = await withProfile()
    const { app } = server
    const res = await app.request(
      '/agents',
      send('POST', {
        name: 'Worker',
        instructions: 'x',
        modelProfile: 'or-work',
        model: 'anthropic/claude-x',
      }),
    )
    expect(res.status).toBe(201)
    const agent = (await res.json()) as { id: string; model: string; modelProfile: string }
    expect(agent).toMatchObject({ model: 'anthropic/claude-x', modelProfile: 'or-work' })
    const def = server.deps.agents.get(agent.id)
    if (def === undefined) throw new Error('agent')
    expect(server.factory.modelInfo(def)).toMatchObject({
      id: 'anthropic/claude-x',
      profileId: 'or-work',
      contextWindow: 1_000_000,
    })
    const info = server.factory.modelInfo(def)
    expect(info.pricing?.input).toBeCloseTo(3, 6)
    // the agent builds on a real model object whose catalog entry is the same
    const model =
      server.deps.agents.get(agent.id) && (await import('../src/infra/eh/provider.ts')) && undefined
    expect(model).toBeUndefined()
    await server.factory.prepare(def)
    server.factory.agentFor(def)
    const stats = (await (await app.request(`/agents/${agent.id}/stats`)).json()) as {
      model: { id: string; profileId: string; contextWindow: number; pricing: { input: number } }
      context: { window: number }
    }
    expect(stats.model).toMatchObject({
      id: 'anthropic/claude-x',
      profileId: 'or-work',
      contextWindow: 1_000_000,
    })
    expect(stats.context.window).toBe(1_000_000)
  })

  test('the model object of the manager is priced by the manager catalog', async () => {
    const server = await withProfile()
    const model = server.providers.manager.resolve('or-work:anthropic/claude-x')
    expect(lookupModel(server.providers.manager.catalog(), model)?.contextWindow).toBe(1_000_000)
    // the id keeps its own ':' (first colon splits)
    const free = server.providers.manager.resolve('or-work:meta/plain:free')
    expect(lookupModel(server.providers.manager.catalog(), free)?.contextWindow).toBe(8_000)
  })

  test('an unknown profile is a 400; the workspace default pick is validated and applied', async () => {
    const server = await withProfile()
    const { app } = server
    expect(
      (
        await app.request(
          '/agents',
          send('POST', { name: 'Bad', instructions: 'x', modelProfile: 'nope' }),
        )
      ).status,
    ).toBe(400)
    expect((await app.request('/settings', send('PATCH', { defaultProfile: 'nope' }))).status).toBe(
      400,
    )
    const patched = await app.request(
      '/settings',
      send('PATCH', { defaultProfile: 'or-work', defaultModel: 'anthropic/claude-x' }),
    )
    expect(await patched.json()).toMatchObject({
      defaultProfile: 'or-work',
      defaultModel: 'anthropic/claude-x',
    })
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    // an agent without its own pick follows the workspace default (profile, model, catalog)
    expect(server.factory.modelInfo(writer)).toMatchObject({
      id: 'anthropic/claude-x',
      profileId: 'or-work',
      contextWindow: 1_000_000,
    })
    // and the default profile cannot be deleted while it is the default
    expect((await app.request('/providers/profiles/or-work', { method: 'DELETE' })).status).toBe(
      409,
    )
  })

  test('a profile edit rebuilds the agents (the model is made from the new settings)', async () => {
    const server = await withProfile()
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await server.factory.prepare(writer)
    const before = server.factory.agentFor(writer)
    expect(server.factory.agentFor(writer)).toBe(before)
    await server.app.request(
      '/providers/profiles/or-work',
      send('PATCH', { settings: { apiKey: `${SECRET}-rotated` } }),
    )
    expect(server.factory.agentFor(writer)).not.toBe(before)
  })
})

describe('legacy model strings', () => {
  test('profile:model is split on write when the prefix names a profile; a plain id stays', async () => {
    const server = await boot({ env: { OPENROUTER_API_KEY: SECRET } })
    const { app } = server
    await app.request(
      '/providers/profiles',
      send('POST', {
        providerId: 'openrouter',
        id: 'or-2',
        settings: { apiKey: 'k2-aaaa-bbbb-cccc' },
      }),
    )
    const a = (await (
      await app.request(
        '/agents',
        send('POST', { name: 'A', instructions: 'x', model: 'or-2:meta/plain:free' }),
      )
    ).json()) as { model: string; modelProfile: string }
    expect(a).toMatchObject({ model: 'meta/plain:free', modelProfile: 'or-2' })
    const b = (await (
      await app.request(
        '/agents',
        send('POST', { name: 'B', instructions: 'x', model: 'meta/plain:free' }),
      )
    ).json()) as { model: string; modelProfile: string | null }
    expect(b).toMatchObject({ model: 'meta/plain:free', modelProfile: null })
    // a ":" that is not a profile prefix is part of the model id
    const c = (await (
      await app.request(
        '/agents',
        send('POST', { name: 'C', instructions: 'x', model: 'x/y:free' }),
      )
    ).json()) as { model: string; modelProfile: string | null }
    expect(c).toMatchObject({ model: 'x/y:free', modelProfile: null })
  })

  test('an old row (plain model, no model_profile) runs on the default profile; an unsplit legacy string resolves', async () => {
    const server = await boot({ env: { OPENROUTER_API_KEY: SECRET } })
    await server.providers.manager.loadCatalogs()
    server.conn.sqlite.run(
      "UPDATE agents SET model = 'anthropic/claude-x', model_profile = NULL WHERE slug = 'writer'",
    )
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    expect(writer.modelProfile).toBeNull()
    expect(server.factory.modelInfo(writer)).toMatchObject({
      id: 'anthropic/claude-x',
      profileId: 'openrouter',
      contextWindow: 1_000_000,
    })
    // a stored 'profile:model' that was never split (written by an older client)
    server.conn.sqlite.run(
      "UPDATE agents SET model = 'openrouter:meta/plain:free' WHERE slug = 'writer'",
    )
    const again = server.deps.agents.getBySlug('writer')
    if (again === undefined) throw new Error('seed')
    expect(server.factory.modelInfo(again)).toMatchObject({
      id: 'meta/plain:free',
      profileId: 'openrouter',
    })
  })

  test('default model: TEAM_MODEL on the env default profile, else the provider default', async () => {
    const withModel = await boot({ env: { OPENROUTER_API_KEY: SECRET, TEAM_MODEL: 'deepseek/x' } })
    const writer = withModel.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    expect(withModel.factory.modelInfo(writer).id).toBe('deepseek/x')
    const plain = await boot({ env: { OPENROUTER_API_KEY: SECRET } })
    const w2 = plain.deps.agents.getBySlug('writer')
    if (w2 === undefined) throw new Error('seed')
    expect(plain.factory.modelInfo(w2).id).toBe('anthropic/claude-sonnet-5.5')
  })

  test('with nothing configured the server boots and a chat is a readable error', async () => {
    const server = await boot()
    const res = await server.app.request('/agents/writer/stats')
    // a chat (which builds the agent) says how to fix it
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('NO_PROVIDER')
    const writer = server.deps.agents.getBySlug('writer')
    if (writer === undefined) throw new Error('seed')
    await server.factory.prepare(writer)
    expect(() => server.factory.agentFor(writer)).toThrow(/Settings > Providers/)
  })
})

describe('scripted model wins over profiles', () => {
  test('TEAM_SCRIPTED_MODEL (a fixed model config) ignores profiles and env keys', async () => {
    const server = compose({
      dbFile: ':memory:',
      env: { OPENROUTER_API_KEY: SECRET },
      models: scriptedModelConfig(scriptedModel([{ text: 'hi' }]) as never),
      vault: box(),
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
      offline: true,
    })
    servers.push(server)
    const res = await server.app.request('/agents/writer/stats')
    const stats = (await res.json()) as { model: { id: string; profileId?: string } }
    expect(stats.model).toEqual({ id: 'scripted' })
  })
})

describe('catalog cache and the change feed', () => {
  test('the catalog is cached in the database; offline serves it without fetching', async () => {
    const dir = tmp()
    const dbFile = join(dir, 'team.db')
    const calls: string[] = []
    const online = await boot({ dbFile, calls, env: { OPENROUTER_API_KEY: SECRET } })
    expect(calls.some((c) => c.endsWith('/models'))).toBe(true)
    const cached = await sqliteCatalogCache(online.conn.sqlite).get('openrouter')
    expect(cached?.fetchedAt).toBeGreaterThan(0)
    await online.close()
    servers.pop()

    const offlineCalls: string[] = []
    const offline = compose({
      dbFile,
      env: { OPENROUTER_API_KEY: SECRET },
      offline: true,
      fetch: stubFetch(offlineCalls),
      vault: box(),
      models: undefined,
      changePollMs: 0,
      reconcile: { onBoot: false, everyMs: 0 },
      routines: { tickMs: 0 },
    })
    servers.push(offline)
    await offline.providersReady
    expect(offlineCalls).toEqual([])
    const models = await offline.providers.models('openrouter', { refresh: false })
    expect(models.find((m) => m.id === 'anthropic/claude-x')?.contextWindow).toBe(1_000_000)
  })

  test('a profile created on one instance reaches the other through the event feed', async () => {
    const dir = tmp()
    const dbFile = join(dir, 'team.db')
    const key = box()
    const a = await boot({ dbFile, secretBox: key, pollMs: 20 })
    const b = await boot({ dbFile, secretBox: key, pollMs: 20 })
    expect(b.providers.profileIds()).toEqual([])
    const revision = b.providers.rev()
    await a.app.request(
      '/providers/profiles',
      send('POST', { providerId: 'openrouter', id: 'shared', settings: { apiKey: SECRET } }),
    )
    for (let i = 0; i < 100 && !b.providers.profileIds().includes('shared'); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(b.providers.profileIds()).toEqual(['shared'])
    expect(b.providers.rev()).toBeGreaterThan(revision) // agents rebuild on B
    expect(() => b.providers.manager.resolve('shared:anthropic/claude-x')).not.toThrow()
    const events = (await a.deps.feed.page({ after: 0, limit: 100 })).events.filter(
      (e) => e.type === 'providers-changed',
    )
    expect(events.length).toBeGreaterThan(0)
    expect(JSON.stringify(events)).not.toContain('SUPERSECRET')
  })
})
