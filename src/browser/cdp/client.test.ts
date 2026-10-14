import { describe, expect, test } from 'bun:test'
import { fakeCdpError, fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { CdpError, cdpConnection, resolveCdpUrl } from './client.ts'
import { connect } from './test-kit.ts'

describe('resolveCdpUrl', () => {
  test('ws urls pass through; http urls go through /json/version', async () => {
    expect(await resolveCdpUrl({ url: 'wss://host/x' })).toBe('wss://host/x')
    const seen: string[] = []
    const fetcher = (async (url: URL | string) => {
      seen.push(String(url))
      return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' })
    }) as unknown as typeof fetch
    const ws = await resolveCdpUrl({ url: 'http://box.test:9222' }, { fetch: fetcher })
    expect(seen).toEqual(['http://box.test:9222/json/version'])
    expect(ws).toBe('ws://box.test:9222/devtools/browser/abc')
  })

  test('a bad scheme is a programmer error, an unreachable host a readable CdpError', async () => {
    await expect(resolveCdpUrl({ url: 'ftp://x' })).rejects.toMatchObject({
      code: 'EH_INVALID_INPUT',
    })
    const down = (async () => {
      throw new TypeError('connection refused')
    }) as unknown as typeof fetch
    await expect(resolveCdpUrl({ url: 'http://nowhere.test' }, { fetch: down })).rejects.toThrow(
      /could not reach the browser at http:\/\/nowhere.test \(connection refused\)/,
    )
  })
})

describe('cdpConnection', () => {
  test('attach reuses the session the browser attached by itself (Lightpanda routes events there)', async () => {
    const peer = fakeCdpPeer()
    const cdp = await cdpConnection({ url: 'ws://h/x' }, { webSocket: peer.socketFactory })
    peer.emit('Target.attachedToTarget', { sessionId: 'AUTO-1', targetInfo: { targetId: 'T1' } })
    expect(await cdp.attach('T1')).toBe('AUTO-1')
    expect(peer.last('Target.attachToTarget')).toBeUndefined()
    await cdp.close()
  })

  test('sets flattened auto attach and passes headers to the socket factory', async () => {
    const peer = fakeCdpPeer()
    const cdp = await cdpConnection(
      { url: 'ws://h/x', headers: { 'x-key': 'secret' } },
      { webSocket: peer.socketFactory },
    )
    expect(peer.last('Target.setAutoAttach')?.params).toMatchObject({
      flatten: true,
      autoAttach: true,
    })
    expect(peer.connectedHeaders).toEqual({ 'x-key': 'secret' })
    await cdp.close()
  })

  test('correlates ids, carries the session id, and maps errors to readable text', async () => {
    const peer = fakeCdpPeer()
    peer.handle('Test.echo', (p) => ({ echo: p.value }))
    peer.handle('Test.fail', fakeCdpError('nope'))
    const cdp = await connect(peer)
    const [a, b] = await Promise.all([
      cdp.send('Test.echo', { value: 1 }, { sessionId: 'S1' }),
      cdp.send('Test.echo', { value: 2 }),
    ])
    expect(a).toEqual({ echo: 1 })
    expect(b).toEqual({ echo: 2 })
    expect(peer.commands('Test.echo')[0]?.sessionId).toBe('S1')
    await expect(cdp.send('Test.fail')).rejects.toThrow('Test.fail failed: nope')
    await cdp.close()
  })

  test('per-call timeout and abort reject with readable errors', async () => {
    const peer = fakeCdpPeer()
    peer.handle('Test.hang', undefined)
    const cdp = await connect(peer)
    await expect(cdp.send('Test.hang', {}, { timeoutMs: 20 })).rejects.toThrow(
      'Test.hang timed out after 20 ms',
    )
    const ctl = new AbortController()
    const p = cdp.send('Test.hang', {}, { signal: ctl.signal })
    ctl.abort()
    await expect(p).rejects.toBeInstanceOf(CdpError)
    await expect(cdp.send('Test.hang', {}, { signal: ctl.signal })).rejects.toThrow('aborted')
    await cdp.close()
  })

  test('events reach subscribers; waitFor filters by session and predicate', async () => {
    const peer = fakeCdpPeer()
    const cdp = await connect(peer)
    const got: Array<[unknown, string | undefined]> = []
    const off = cdp.on('Page.loadEventFired', (p, sid) => got.push([p.timestamp, sid]))
    const wait = cdp.waitFor('Page.frameNavigated', {
      sessionId: 'S1',
      predicate: (p) => p.n === 2,
    })
    peer.emit('Page.loadEventFired', { timestamp: 5 }, 'S1')
    peer.emit('Page.frameNavigated', { n: 2 }, 'S2')
    peer.emit('Page.frameNavigated', { n: 1 }, 'S1')
    peer.emit('Page.frameNavigated', { n: 2 }, 'S1')
    expect(await wait).toEqual({ n: 2 })
    off()
    peer.emit('Page.loadEventFired', { timestamp: 6 })
    expect(got).toEqual([[5, 'S1']])
    await cdp.close()
  })

  test('a closing socket rejects pending calls with the close reason and later calls fail fast', async () => {
    const peer = fakeCdpPeer()
    peer.handle('Test.hang', undefined)
    const cdp = await connect(peer)
    const reasons: string[] = []
    cdp.onClose((r) => reasons.push(r))
    const pending = cdp.send('Test.hang')
    const waiting = cdp.waitFor('Never.happens')
    peer.closeFromPeer(1006, 'crashed')
    await expect(pending).rejects.toThrow('the browser connection closed (code 1006: crashed)')
    await expect(waiting).rejects.toThrow('closed')
    expect(cdp.closed).toBe(true)
    expect(reasons).toHaveLength(1)
    await expect(cdp.send('Target.getTargets')).rejects.toThrow('closed')
  })

  test('does not open when the signal is already aborted', async () => {
    const peer = fakeCdpPeer()
    await expect(
      cdpConnection(
        { url: 'ws://h/x' },
        { webSocket: peer.socketFactory, signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow('aborted')
  })
})
