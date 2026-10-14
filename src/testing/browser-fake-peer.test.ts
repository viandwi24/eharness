import { describe, expect, test } from 'bun:test'
import { cdpConnection } from '../browser/cdp/client.ts'
import { FAKE_PASS, fakeCdpError, fakeCdpPeer } from './browser-fake-peer.ts'

const open = async (peer: ReturnType<typeof fakeCdpPeer>) =>
  cdpConnection({ url: 'ws://x/y' }, { webSocket: peer.socketFactory, autoAttach: false })

describe('fakeCdpPeer', () => {
  test('records commands and answers from the newest handler, falling through on FAKE_PASS', async () => {
    const peer = fakeCdpPeer()
    peer.handle('Test.a', { from: 'old' })
    peer.handle('Test.a', (p) => (p.pass ? FAKE_PASS : { from: 'new' }))
    const cdp = await open(peer)
    expect(await cdp.send<object>('Test.a')).toEqual({ from: 'new' })
    expect(await cdp.send<object>('Test.a', { pass: true })).toEqual({ from: 'old' })
    expect(peer.commands('Test.a').map((c) => c.params)).toEqual([{}, { pass: true }])
    expect(peer.last('Test.a')?.id).toBe(2)
  })

  test('sequences repeat the last reply; errors and silence are scriptable', async () => {
    const peer = fakeCdpPeer({ strict: true })
    peer.handleSequence('Test.seq', [{ n: 1 }, fakeCdpError('second fails')])
    peer.handle('Test.silent', undefined)
    const cdp = await open(peer)
    expect(await cdp.send<object>('Test.seq')).toEqual({ n: 1 })
    await expect(cdp.send('Test.seq')).rejects.toThrow('second fails')
    await expect(cdp.send('Test.seq')).rejects.toThrow('second fails')
    await expect(cdp.send('Test.silent', {}, { timeoutMs: 10 })).rejects.toThrow('timed out')
    await expect(cdp.send('Test.unknown')).rejects.toThrow("wasn't found")
  })

  test('the default world has one tab and can create more', async () => {
    const peer = fakeCdpPeer()
    const cdp = await open(peer)
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string }> }>(
      'Target.getTargets',
    )
    expect(targetInfos.map((t) => t.targetId)).toEqual(['T1'])
    const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    })
    expect(created.targetId).toBe('T2')
    peer.clearSent()
    expect(peer.commands()).toEqual([])
  })
})
