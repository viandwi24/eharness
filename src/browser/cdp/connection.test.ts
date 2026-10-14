import { describe, expect, test } from 'bun:test'
import { fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { cdpBrowserConnection } from './connection.ts'
import { FAST_LIMITS, installWorld, openConnection, quad } from './test-kit.ts'

describe('cdpBrowserConnection', () => {
  test('open -> snapshot -> act -> screenshot over one connection', async () => {
    const peer = fakeCdpPeer({ url: 'about:blank', title: '' })
    installWorld(peer, {
      boxes: { 14: quad(100, 200, 80, 40) },
      hit: () => ({ backendNodeId: 14 }),
    })
    const conn = await openConnection(peer)

    const opened = await conn.navigate({ url: 'https://example.test/login' })
    expect(opened.error).toBeUndefined()
    expect(opened.url).toBe('https://example.test/login')

    const snap = await conn.snapshot({})
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.text).toContain('- button "Submit" [ref=e3]')

    const res = await conn.act({ kind: 'click', ref: 'e3' })
    expect(res.summary).toBe('Clicked e3 (button "Submit")')

    const shot = await conn.screenshot({})
    expect(typeof shot).toBe('object')
    await conn.close()
    expect(conn.client.closed).toBe(true)
  })

  test('navigate: bad load, back with no history, and missing input are strings', async () => {
    const peer = fakeCdpPeer()
    const conn = await openConnection(peer)
    peer.handle('Page.navigate', { errorText: 'net::ERR_NAME_NOT_RESOLVED' })
    expect((await conn.navigate({ url: 'https://nope.invalid/' })).error).toBe(
      'ERROR: could not load https://nope.invalid/ (net::ERR_NAME_NOT_RESOLVED).',
    )
    peer.handle('Page.getNavigationHistory', { currentIndex: 0, entries: [{ id: 1 }] })
    expect((await conn.navigate({ action: 'back' })).error).toBe(
      'ERROR: there is no page to go back to.',
    )
    expect((await conn.navigate({})).error).toMatch(/needs a url or an action/)
  })

  test('back and reload wait for load', async () => {
    const peer = fakeCdpPeer()
    const conn = await openConnection(peer)
    peer.handle('Page.getNavigationHistory', { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }] })
    peer.handle('Page.navigateToHistoryEntry', (_p, ctx) => {
      queueMicrotask(() => peer.emit('Page.loadEventFired', {}, ctx.sessionId))
      return {}
    })
    expect((await conn.navigate({ action: 'back' })).error).toBeUndefined()
    expect(peer.last('Page.navigateToHistoryEntry')?.params).toEqual({ entryId: 1 })
    expect((await conn.navigate({ action: 'reload' })).error).toBeUndefined()
    expect(peer.last('Page.reload')).toBeDefined()
  })

  test('a lost connection answers ERROR strings from every operation', async () => {
    const peer = fakeCdpPeer()
    const conn = await openConnection(peer)
    await conn.tabs({ action: 'list' })
    peer.closeFromPeer(1006, 'gone')
    expect(await conn.snapshot({})).toMatch(/^ERROR: .*closed/)
    expect(await conn.screenshot({})).toMatch(/^ERROR:/)
    expect(await conn.read({})).toMatch(/^ERROR:/)
    expect(await conn.tabs({ action: 'list' })).toMatch(/^ERROR:/)
    expect((await conn.act({ kind: 'press', key: 'Enter' })).error).toMatch(/^ERROR:/)
    expect((await conn.navigate({ url: 'https://a.test/' })).error).toMatch(/^ERROR:/)
  })

  test('opens through an http endpoint and clears refs on request', async () => {
    const peer = fakeCdpPeer()
    installWorld(peer)
    const fetcher = (async () =>
      Response.json({
        webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
      })) as unknown as typeof fetch
    const conn = await cdpBrowserConnection(
      { url: 'http://box.test:9222' },
      { limits: FAST_LIMITS, cdp: { fetch: fetcher, webSocket: peer.socketFactory } },
    )
    expect(peer.connectedUrl).toBe('ws://box.test:9222/devtools/browser/x')
    await conn.snapshot({})
    conn.clearRefs()
    expect((await conn.act({ kind: 'click', ref: 'e3' })).error).toStartWith('STALE:')
    const live = await conn.live()
    expect(live.info.liveView).toBe('screencast')
    await live.close()
    await conn.close()
  })
})
