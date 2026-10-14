import { describe, expect, test } from 'bun:test'
import { fakeCdpPeer } from '../testing/browser-fake-peer.ts'
import { createBrowserRegistry } from './adapter.ts'
import { createBrowserManager } from './manager.ts'
import { memoryBrowserProfileStore } from './profiles.ts'
import { fakeAdapter, fakeRuntime, installWorld, quad, TINY_JPEG } from './test-kit.ts'
import type { BrowserEvent, Lease, LeaseRefusal } from './types.ts'

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))
const SESSION = 'S-T1'

async function setup(
  over: {
    limits?: Parameters<typeof createBrowserManager>[0]['limits']
    runtime?: ReturnType<typeof fakeRuntime>
  } = {},
) {
  const peer = fakeCdpPeer({ url: 'https://example.test/login', title: 'Login' })
  installWorld(peer, { boxes: { 14: quad(100, 200, 80, 40) }, hit: () => ({ backendNodeId: 14 }) })
  const registry = createBrowserRegistry([
    fakeAdapter(peer, over.runtime === undefined ? {} : { runtime: over.runtime }),
  ])
  const profiles = memoryBrowserProfileStore()
  const manager = createBrowserManager({
    registry,
    profiles,
    limits: { idleMs: 0, ...over.limits },
    systemMemory: async () => ({ totalBytes: 8_000, freeBytes: 3_000 }),
  })
  const events: BrowserEvent[] = []
  manager.on((e) => events.push(e))
  const manual = await profiles.create({
    name: 'Work',
    adapter: 'fake',
    mode: 'manual',
    settings: { cdpUrl: 'ws://fake.test/devtools', token: 'SECRET-TOKEN-1' },
  })
  const managed =
    over.runtime === undefined
      ? undefined
      : await profiles.create({ name: 'Local', adapter: 'fake', mode: 'managed', settings: {} })
  return { peer, manager, profiles, manual, managed, events }
}

const session = (id: string): { kind: 'session'; id: string } => ({ kind: 'session', id })
const lease = (r: Lease | LeaseRefusal): Lease => {
  if ('refused' in r) throw new Error(r.text)
  return r
}

describe('leases', () => {
  test('one holder per profile; the same holder gets the lease back; others get BUSY', async () => {
    const { manager, manual } = await setup()
    const a = lease(await manager.lease(manual.id, session('s1')))
    expect(a.open).toBe(true)
    expect(a.controller()).toMatchObject({ by: 'agent' })
    const again = lease(await manager.lease(manual.id, session('s1')))
    expect(again.connection).toBe(a.connection)
    const other = await manager.lease(manual.id, session('s2'))
    expect('refused' in other && other.kind).toBe('busy')
    expect('refused' in other && other.text).toBe(
      'BUSY: profile "Work" is used by another session.',
    )
    await a.release()
    expect(a.open).toBe(false)
    expect(lease(await manager.lease(manual.id, session('s2'))).open).toBe(true)
    await manager.close()
  })

  test('maxLeases and unknown profiles answer readable refusals', async () => {
    const { manager, profiles, manual } = await setup({ limits: { maxLeases: 1 } })
    const second = await profiles.create({
      name: 'Two',
      adapter: 'fake',
      mode: 'manual',
      settings: { cdpUrl: 'ws://fake.test/devtools' },
    })
    const missing = await manager.lease('nope', session('s3'))
    expect('refused' in missing && missing.text).toMatch(
      /^ERROR: this browser profile does not exist/,
    )
    lease(await manager.lease(manual.id, session('s1')))
    const full = await manager.lease(second.id, session('s2'))
    expect(full).toMatchObject({ refused: true, kind: 'limit' })
    expect('refused' in full && full.text).toMatch(/^BUSY: 1 browsers are open/)
    await manager.close()
  })

  test('a start failure is an ERROR text without secrets, and the profile is free again', async () => {
    const { manager, manual, profiles } = await setup()
    await profiles.update(manual.id, { settings: { cdpUrl: 'ws://fake.test/devtools', token: 5 } })
    const bad = await manager.lease(manual.id, session('s1'))
    expect('refused' in bad && bad.text).toMatch(/^ERROR: the browser could not start/)
    await profiles.update(manual.id, {
      settings: { cdpUrl: 'ws://fake.test/devtools', token: 'SECRET-TOKEN-1' },
    })
    expect(lease(await manager.lease(manual.id, session('s1'))).open).toBe(true)
    await manager.close()
  })

  test('idle release closes the lease and stops a managed engine; a call resets the timer', async () => {
    const runtime = fakeRuntime()
    const { manager, managed, events } = await setup({ limits: { idleMs: 60 }, runtime })
    const l = lease(await manager.lease((managed as { id: string }).id, session('s1')))
    expect(runtime.calls).toEqual([`start:${l.profileId}`])
    await tick(40)
    l.touch()
    await tick(40)
    expect(l.open).toBe(true) // the touch moved the deadline
    await tick(80)
    expect(l.open).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'release', profileId: l.profileId, reason: 'idle' })
    expect(runtime.calls).toContain(`stop:${l.profileId}`)
    await manager.close()
  })

  test('a lease is not released at the end of a turn: nothing but idle releases it', async () => {
    const { manager, manual } = await setup({ limits: { idleMs: 100_000 } })
    const l = lease(await manager.lease(manual.id, session('s1')))
    await tick(30) // a turn ended, a checkpoint passed: no call
    expect(l.open).toBe(true)
    expect((await manager.status()).map((s) => s.profileId)).toEqual([manual.id])
    await manager.close()
  })

  test('explicit release keeps a managed engine running; stop() stops it', async () => {
    const runtime = fakeRuntime()
    const { manager, managed } = await setup({ runtime })
    const id = (managed as { id: string }).id
    const l = lease(await manager.lease(id, session('s1')))
    await l.release()
    expect(runtime.calls).toEqual([`start:${id}`])
    expect((await manager.usage()).profiles).toEqual([
      { profileId: id, adapter: 'fake', rssBytes: 1000, cpuPercent: 5 },
    ])
    await manager.stop(id)
    expect(runtime.calls).toContain(`stop:${id}`)
    await manager.close()
  })

  test('usage reports memory and CPU per running profile plus the machine memory', async () => {
    const runtime = fakeRuntime()
    const { manager, managed } = await setup({ runtime })
    const id = (managed as { id: string }).id
    expect(await manager.usage()).toMatchObject({ profiles: [], totals: { rssBytes: 0 } })
    expect(await manager.start(id)).toEqual({ ok: true })
    const usage = await manager.usage()
    expect(usage.profiles).toHaveLength(1)
    expect(usage.totals).toEqual({ rssBytes: 1000, cpuPercent: 5 })
    expect(usage.system).toEqual({ totalBytes: 8_000, freeBytes: 3_000 })
    await manager.close()
    expect(runtime.calls).toContain(`stop:${id}`) // close stops what the manager started
  })

  test('a lost connection drops the lease; the next lease reopens', async () => {
    const { manager, manual, peer, events } = await setup()
    const l = lease(await manager.lease(manual.id, session('s1')))
    peer.closeFromPeer()
    await tick()
    expect(l.open).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'release', reason: 'lost' })
    expect(lease(await manager.lease(manual.id, session('s1'))).open).toBe(true)
    await manager.close()
  })
})

describe('test()', () => {
  test('manual: connects; secrets are scrubbed from errors; bad settings are an error', async () => {
    const { manager, peer } = await setup()
    expect(
      await manager.test({
        adapter: 'fake',
        mode: 'manual',
        settings: { cdpUrl: 'ws://fake.test/x' },
      }),
    ).toEqual({ ok: true, version: 'unknown' })
    const bad = await manager.test({ adapter: 'fake', mode: 'manual', settings: {} })
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/cdpUrl/)
    expect((await manager.test({ adapter: 'nope', mode: 'manual', settings: {} })).ok).toBe(false)
    expect(peer.readyState).toBeDefined()
    await manager.close()
  })

  test('managed: needs a runtime that is installed', async () => {
    const none = await setup()
    expect(
      await none.manager.test({ adapter: 'fake', mode: 'managed', settings: {} }),
    ).toMatchObject({
      ok: false,
    })
    const missing = await setup({ runtime: fakeRuntime({ state: 'missing' }) })
    expect(await missing.manager.test({ adapter: 'fake', mode: 'managed', settings: {} })).toEqual({
      ok: false,
      error: 'The browser is not downloaded yet.',
    })
    const ready = await setup({ runtime: fakeRuntime() })
    expect(await ready.manager.test({ adapter: 'fake', mode: 'managed', settings: {} })).toEqual({
      ok: true,
      version: '1.0.0',
    })
  })
})

describe('live view and takeover', () => {
  async function liveSetup() {
    const ctx = await setup()
    const l = lease(await ctx.manager.lease(ctx.manual.id, session('s1')))
    const channel = await ctx.manager.live(ctx.manual.id, { id: 'ana' })
    if ('refused' in channel) throw new Error(channel.text)
    await tick()
    return { ...ctx, l, channel }
  }

  test('frames reach the viewer, newest wins', async () => {
    const { peer, channel } = await liveSetup()
    expect(channel.info.liveView).toBe('screencast')
    const reader = channel.frames.getReader()
    const frame = (ack: number): void =>
      peer.emit(
        'Page.screencastFrame',
        { data: TINY_JPEG, sessionId: ack, metadata: { deviceWidth: 1000, deviceHeight: 600 } },
        SESSION,
      )
    frame(1)
    const first = await reader.read()
    expect(first.value).toMatchObject({ seq: 1, width: 1000, height: 600 })
    channel.close()
    expect((await reader.read()).done).toBe(true)
  })

  test('input is refused until the viewer took over; navigate obeys the domain rules', async () => {
    const { peer, channel, l, manager } = await liveSetup()
    expect(await channel.input({ type: 'mouse', event: 'move', x: 1, y: 1 })).toMatch(
      /^ERROR: take control/,
    )
    expect(peer.commands('Input.dispatchMouseEvent')).toHaveLength(0)
    expect(await channel.takeOver()).toBeUndefined()
    expect(l.controller()).toMatchObject({ by: 'human', holder: 'ana' })
    expect(await channel.input({ type: 'mouse', event: 'move', x: 5, y: 6 })).toBeUndefined()
    expect(peer.last('Input.dispatchMouseEvent')?.params).toMatchObject({ x: 5, y: 6 })
    expect(await channel.input({ type: 'navigate', url: 'http://127.0.0.1:8080/' })).toMatch(
      /^BLOCKED: 127\.0\.0\.1 is a private/,
    )
    expect(peer.commands('Page.navigate')).toHaveLength(0)
    await manager.close()
  })

  test('while a person controls, the lease says BUSY; hand back clears refs and tells who', async () => {
    const { channel, l, events, manager } = await liveSetup()
    let cleared = 0
    const original = l.connection.clearRefs
    l.connection.clearRefs = () => {
      cleared++
      original?.()
    }
    expect(l.busyText()).toBeUndefined()
    await channel.takeOver()
    expect(l.busyText()).toMatch(/^BUSY: a person is controlling the browser since \d{4}-/)
    expect(await channel.handBack()).toBeUndefined()
    expect(l.busyText()).toBeUndefined()
    expect(cleared).toBe(1)
    const handback = events.find((e) => e.type === 'handback')
    expect(handback).toMatchObject({
      type: 'handback',
      info: {
        by: 'ana',
        reason: 'handed-back',
        page: { url: 'https://example.test/login', title: 'Login' },
      },
    })
    await manager.close()
  })

  test('a second person cannot take over while the first controls', async () => {
    const { manager, manual, channel } = await liveSetup()
    const other = await manager.live(manual.id, { id: 'bob' })
    if ('refused' in other) throw new Error(other.text)
    await channel.takeOver()
    expect(await other.takeOver()).toMatch(/^BUSY: ana is already controlling/)
    expect(await other.handBack()).toMatch(/not controlling/)
    expect(await other.input({ type: 'text', text: 'x' })).toMatch(/take control/)
    await manager.close()
  })

  test('a request for a human is taken by a viewer; leaving while in control hands back', async () => {
    const { l, channel, events, manager } = await liveSetup()
    l.requestHuman('log in please')
    expect(l.controller()).toMatchObject({ by: 'human', reason: 'log in please' })
    expect(l.controller().holder).toBeUndefined()
    expect(l.busyText()).toMatch(/^BUSY:/)
    await channel.takeOver()
    expect(l.controller()).toMatchObject({ holder: 'ana', reason: 'log in please' })
    channel.close()
    await tick()
    expect(l.controller().by).toBe('agent')
    expect(events.find((e) => e.type === 'handback')).toMatchObject({
      info: { by: 'ana', reason: 'viewer-left' },
    })
    await manager.close()
  })

  test('manager.handBack resolves a request without a channel', async () => {
    const { l, manager, manual } = await liveSetup()
    l.requestHuman('captcha')
    const info = await manager.handBack(manual.id, 'bob')
    expect(info).toMatchObject({ by: 'bob', reason: 'handed-back' })
    expect(l.controller().by).toBe('agent')
    expect(await manager.handBack(manual.id, 'bob')).toBeUndefined()
    await manager.close()
  })

  test('a person can open the browser for logging in; a session takes it over while the agent controls', async () => {
    const { manager, manual } = await setup()
    const channel = await manager.live(manual.id, { id: 'ana' })
    if ('refused' in channel) throw new Error(channel.text)
    expect((await manager.status())[0]?.holder).toEqual({ kind: 'person', id: 'ana' })
    const l = lease(await manager.lease(manual.id, session('s1')))
    expect(l.open).toBe(true)
    expect((await manager.status())[0]).toMatchObject({
      holder: { kind: 'session', id: 's1' },
      viewers: 1,
    })
    channel.close()
    await tick()
    expect(l.open).toBe(true) // a session holds it: the viewer leaving does not release
    await manager.close()
  })

  test('closing the last viewer releases a lease only a person held', async () => {
    const { manager, manual, events } = await setup()
    const channel = await manager.live(manual.id, { id: 'ana' })
    if ('refused' in channel) throw new Error(channel.text)
    channel.close()
    await tick()
    expect(await manager.status()).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'release', reason: 'idle' })
  })

  test('a person cannot take a lease a session is controlled-by-human', async () => {
    const { manager, manual, l, channel } = await liveSetup()
    await channel.takeOver()
    const other = await manager.lease(manual.id, session('s2'))
    expect(other).toMatchObject({ refused: true, kind: 'busy' })
    expect(l.open).toBe(true)
    await manager.close()
  })
})
