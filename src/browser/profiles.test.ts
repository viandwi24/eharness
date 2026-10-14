import { describe, expect, test } from 'bun:test'
import { plaintextVault } from '../providers/index.ts'
import { browserProfileStoreConformance } from '../testing/browser.conformance.ts'
import { fakeCdpPeer } from '../testing/browser-fake-peer.ts'
import { createBrowserRegistry } from './adapter.ts'
import { chromeAdapter } from './adapters/chrome.ts'
import { lightpandaAdapter } from './adapters/lightpanda.ts'
import { memoryBrowserProfileStore, publicProfile, sealedBrowserProfiles } from './profiles.ts'
import { fakeAdapter, fakeRuntime } from './test-kit.ts'

describe('memoryBrowserProfileStore conformance', () => {
  for (const c of browserProfileStoreConformance(() => memoryBrowserProfileStore())) {
    test(c.name, c.run)
  }
})

const registry = createBrowserRegistry([
  chromeAdapter({ managed: fakeRuntime() }),
  lightpandaAdapter(),
])

describe('sealedBrowserProfiles', () => {
  const settings = {
    cdpUrl: 'wss://connect.example.test/?apiKey=SECRET-KEY-123',
    headers: { Authorization: 'Bearer TOKEN-ABC' },
    liveUrl: 'https://live.example.test/view',
  }

  test('the inner store holds ciphertext, callers see plain settings', async () => {
    const inner = memoryBrowserProfileStore()
    const store = sealedBrowserProfiles({ store: inner, vault: plaintextVault(), registry })
    const created = await store.create({
      name: 'Hosted',
      adapter: 'chrome',
      mode: 'manual',
      settings,
    })
    expect(created.settings).toEqual(settings)
    const raw = await inner.get(created.id)
    const text = JSON.stringify(raw?.settings)
    expect(text).toContain('~sealed')
    expect(text).not.toContain('SECRET-KEY-123')
    expect(text).not.toContain('TOKEN-ABC')
    expect(raw?.settings.liveUrl).toBe('https://live.example.test/view')
    expect((await store.get(created.id))?.settings).toEqual(settings)
    expect((await store.list()).items[0]?.settings).toEqual(settings)
  })

  test('update re-seals new settings and keeps the rest', async () => {
    const inner = memoryBrowserProfileStore()
    const store = sealedBrowserProfiles({ store: inner, vault: plaintextVault(), registry })
    const created = await store.create({
      name: 'Hosted',
      adapter: 'chrome',
      mode: 'manual',
      settings,
    })
    const next = { ...settings, cdpUrl: 'wss://other.example.test/?apiKey=NEW-KEY-999' }
    const res = await store.update(created.id, { settings: next, trusted: true })
    expect(res.ok && res.profile.settings.cdpUrl).toBe(next.cdpUrl)
    expect(JSON.stringify((await inner.get(created.id))?.settings)).not.toContain('NEW-KEY-999')
    expect((await store.get(created.id))?.trusted).toBe(true)
  })

  test('a blob cannot be moved to another profile', async () => {
    const inner = memoryBrowserProfileStore()
    const store = sealedBrowserProfiles({ store: inner, vault: plaintextVault(), registry })
    const a = await store.create({ name: 'A', adapter: 'chrome', mode: 'manual', settings })
    const b = await store.create({
      name: 'B',
      adapter: 'chrome',
      mode: 'manual',
      settings: { ...settings, cdpUrl: 'wss://b.example.test/' },
    })
    const rawA = await inner.get(a.id)
    await inner.update(b.id, { settings: rawA?.settings as Record<string, unknown> })
    await expect(store.get(b.id)).rejects.toThrow()
  })
})

describe('registry', () => {
  test('lists adapters, modes and capabilities', () => {
    const list = registry.list()
    expect(list.map((a) => a.id)).toEqual(['chrome', 'lightpanda'])
    expect(list[0]?.modes).toEqual(['manual', 'managed'])
    expect(list[1]?.modes).toEqual(['manual'])
    expect(list[0]?.capabilities.managed?.persistentProfile).toBe(true)
    expect(list[0]?.capabilities.manual?.persistentProfile).toBe(false)
    expect(list[1]?.capabilities.manual).toMatchObject({ liveView: 'poll', tabs: false })
  })

  test('forms come from the settings schemas, secrets as password fields', () => {
    const forms = registry.forms('chrome')
    const url = forms.manual?.fields.find((f) => f.path === 'cdpUrl')
    expect(url).toMatchObject({ secret: true, widget: 'password', endpoint: true, required: true })
    const headers = forms.manual?.fields.find((f) => f.path === 'headers')
    expect(headers).toMatchObject({ secretValues: true, widget: 'keyvalue' })
    expect(forms.managed?.fields.map((f) => f.path)).toContain('windowSize')
    expect(registry.forms('lightpanda').managed).toBeUndefined()
    expect(registry.forms('nope')).toEqual({})
  })

  test('duplicate ids and adapters without a mode throw EH_CONFIG_INVALID', () => {
    const peer = fakeCdpPeer()
    expect(() => createBrowserRegistry([fakeAdapter(peer), fakeAdapter(peer)])).toThrow(
      /duplicate adapter/,
    )
    expect(() => lightpandaAdapter({ managed: undefined })).not.toThrow()
  })

  test('validate applies defaults and rejects bad settings without echoing values', () => {
    const ok = registry.validate('chrome', 'managed', {})
    expect(ok.windowSize).toBe('1280x800')
    expect(() => registry.validate('chrome', 'manual', { cdpUrl: '' })).toThrow(/cdpUrl/)
    expect(() => registry.validate('chrome', 'managed', { windowSize: 'big' })).toThrow(
      /windowSize/,
    )
    expect(() => registry.validate('lightpanda', 'managed', {})).toThrow(/does not offer/)
  })

  test('merge keeps stored secrets unless resent; changing the endpoint drops them', () => {
    const stored = {
      cdpUrl: 'wss://a.example.test/?k=1',
      headers: { Authorization: 'Bearer old-secret-token' },
    }
    const kept = registry.merge('chrome', 'manual', stored, {
      cdpUrl: { keep: true },
      headers: { Authorization: '' },
      liveUrl: 'https://live.example.test/',
    })
    expect(kept.cdpUrl).toBe(stored.cdpUrl)
    expect((kept.headers as Record<string, string>).Authorization).toBe('Bearer old-secret-token')
    expect(kept.liveUrl).toBe('https://live.example.test/')
    expect(() =>
      registry.merge('chrome', 'manual', stored, { cdpUrl: 'wss://b.example.test/?k=2' }),
    ).not.toThrow()
    const moved = registry.merge('chrome', 'manual', stored, {
      cdpUrl: 'wss://b.example.test/?k=2',
    })
    expect(moved.headers).toBeUndefined()
  })

  test('publicProfile contains no secret', async () => {
    const store = memoryBrowserProfileStore()
    const created = await store.create({
      name: 'Hosted',
      adapter: 'chrome',
      mode: 'manual',
      settings: {
        cdpUrl: 'wss://connect.example.test/?apiKey=SECRET-KEY-123',
        headers: { Authorization: 'Bearer TOKEN-ABC-123456' },
        liveUrl: 'https://live.example.test/view',
      },
    })
    const pub = publicProfile(registry, created)
    const text = JSON.stringify(pub)
    expect(text).not.toContain('SECRET-KEY-123')
    expect(text).not.toContain('TOKEN-ABC')
    expect(pub.settings).toMatchObject({
      cdpUrl: { set: true },
      headers: { Authorization: { set: true } },
      liveUrl: 'https://live.example.test/view',
    })
    expect(pub.name).toBe('Hosted')
  })

  test('chrome managed settings map to runtime flags', () => {
    const runtimeCalls: Array<Record<string, unknown> | undefined> = []
    const runtime = fakeRuntime({
      start: async (_p, s) => {
        runtimeCalls.push(s)
        return { cdpUrl: 'ws://x' }
      },
    })
    const adapter = createBrowserRegistry([chromeAdapter({ managed: runtime })]).get('chrome')
    const parsed = createBrowserRegistry([chromeAdapter({ managed: runtime })]).validate(
      'chrome',
      'managed',
      { proxy: 'http://p:3128', locale: 'de-DE', headless: false, extraArgs: ['--disable-gpu'] },
    )
    expect(adapter?.runtimeSettings(parsed)).toEqual({
      headless: false,
      extraArgs: [
        '--window-size=1280,800',
        '--proxy-server=http://p:3128',
        '--lang=de-DE',
        '--disable-gpu',
      ],
    })
  })
})
