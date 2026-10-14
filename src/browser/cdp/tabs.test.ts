import { describe, expect, test } from 'bun:test'
import { fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { attachPage, createTabSet } from './tabs.ts'
import { connect, FAST_LIMITS } from './test-kit.ts'

describe('attachPage', () => {
  test('attaches flat, enables domains and tolerates engines that lack some', async () => {
    const peer = fakeCdpPeer()
    peer.handle('Accessibility.enable', { __unused: 1 })
    const cdp = await connect(peer)
    const page = await attachPage(cdp, 'T1', FAST_LIMITS)
    expect(page.sessionId).toBe('S-T1')
    expect(peer.last('Target.attachToTarget')?.params).toEqual({ targetId: 'T1', flatten: true })
    expect(peer.commands('Page.enable')[0]?.sessionId).toBe('S-T1')
    expect(peer.commands('Target.setAutoAttach').at(-1)?.sessionId).toBe('S-T1')
    page.dispose()
  })

  test('tracks in-flight requests of its own session only', async () => {
    const peer = fakeCdpPeer()
    const cdp = await connect(peer)
    const page = await attachPage(cdp, 'T1', FAST_LIMITS)
    peer.emit('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch' }, 'S-T1')
    peer.emit('Network.requestWillBeSent', { requestId: 'b', type: 'Fetch' }, 'other')
    peer.emit('Network.requestWillBeSent', { requestId: 'ws', type: 'WebSocket' }, 'S-T1')
    expect([...page.net.inflight.keys()]).toEqual(['a'])
    peer.emit('Network.loadingFailed', { requestId: 'a' }, 'S-T1')
    expect(page.net.inflight.size).toBe(0)
  })
})

describe('tab set', () => {
  test('list, open, switch and close with stable ids', async () => {
    const peer = fakeCdpPeer()
    const cdp = await connect(peer)
    const tabs = createTabSet(cdp, FAST_LIMITS)
    const first = await tabs.tabs({ action: 'list' })
    expect(first).toEqual([
      { id: 't1', url: 'https://example.test/', title: 'Example', active: true },
    ])

    const opened = await tabs.tabs({ action: 'open', url: 'https://other.test/' })
    expect(opened).toHaveLength(2)
    expect((opened as { id: string; active: boolean }[]).map((t) => [t.id, t.active])).toEqual([
      ['t1', false],
      ['t2', true],
    ])
    expect(peer.last('Page.navigate')?.sessionId).toBe('S-T2')
    expect(peer.last('Page.navigate')?.params).toEqual({ url: 'https://other.test/' })

    const switched = await tabs.tabs({ action: 'switch', tab: 't1' })
    expect((switched as { active: boolean }[])[0]?.active).toBe(true)
    expect(peer.last('Target.activateTarget')?.params).toEqual({ targetId: 'T1' })
    expect((await tabs.current()).targetId).toBe('T1')

    const closed = await tabs.tabs({ action: 'close', tab: 't2' })
    expect(closed).toHaveLength(1)
    expect(peer.last('Target.closeTarget')?.params).toEqual({ targetId: 'T2' })
  })

  test('bad requests are ERROR strings listing the open tabs', async () => {
    const peer = fakeCdpPeer()
    const cdp = await connect(peer)
    const tabs = createTabSet(cdp, FAST_LIMITS)
    await tabs.tabs({ action: 'list' })
    expect(await tabs.tabs({ action: 'switch', tab: 't9' })).toBe(
      'ERROR: unknown tab "t9". Open tabs: t1.',
    )
    expect(await tabs.tabs({ action: 'close' })).toBe('ERROR: close needs a tab id such as t1.')
  })

  test('closing the current tab makes the next call pick another one', async () => {
    const peer = fakeCdpPeer()
    const cdp = await connect(peer)
    const tabs = createTabSet(cdp, FAST_LIMITS)
    await tabs.tabs({ action: 'list' })
    await tabs.tabs({ action: 'open' })
    await tabs.tabs({ action: 'close', tab: 't2' })
    expect(tabs.peek()).toBeUndefined()
    expect((await tabs.current()).targetId).toBe('T1')
  })

  test('a browser with no page gets a blank one', async () => {
    const peer = fakeCdpPeer()
    peer.state.targets.length = 0
    const cdp = await connect(peer)
    const tabs = createTabSet(cdp, FAST_LIMITS)
    expect((await tabs.current()).targetId).toBe('T2')
    expect(peer.last('Target.createTarget')?.params).toEqual({ url: 'about:blank' })
  })
})
