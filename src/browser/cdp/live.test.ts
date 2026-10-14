import { describe, expect, test } from 'bun:test'
import { fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { comboCommands, mapLiveInput, startLive } from './live.ts'
import { FAST_LIMITS, openPage, TINY_JPEG } from './test-kit.ts'

const frameEvent = (peer: ReturnType<typeof fakeCdpPeer>, ack: number, sid: string): void =>
  peer.emit(
    'Page.screencastFrame',
    { data: TINY_JPEG, sessionId: ack, metadata: { deviceWidth: 1000, deviceHeight: 600 } },
    sid,
  )

const acks = (peer: ReturnType<typeof fakeCdpPeer>): unknown[] =>
  peer.commands('Page.screencastFrameAck').map((c) => c.params.sessionId)

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('screencast', () => {
  test('starts JPEG q60 at 1280 wide and acks a frame only after the consumer read the previous one', async () => {
    const peer = fakeCdpPeer()
    const { page } = await openPage(peer)
    const live = await startLive(page, { mode: 'screencast' })
    expect(peer.last('Page.startScreencast')?.params).toMatchObject({
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
    })
    const reader = live.frames.getReader()

    frameEvent(peer, 11, page.sessionId)
    await tick()
    expect(acks(peer)).toEqual([]) // nobody read it yet: Chrome is held back

    const first = await reader.read()
    expect(first.value).toMatchObject({ seq: 1, mediaType: 'image/jpeg', width: 1000, height: 600 })
    expect(first.value?.data.length).toBeGreaterThan(10)
    await tick()
    expect(acks(peer)).toEqual([11]) // read -> acked

    frameEvent(peer, 12, page.sessionId)
    frameEvent(peer, 13, page.sessionId) // an unexpected extra frame is acked and dropped
    const second = await reader.read()
    expect(second.value?.seq).toBe(2)
    await tick()
    expect(acks(peer)).toEqual([11, 13, 12])
    await live.close()
    expect(peer.last('Page.stopScreencast')).toBeDefined()
    expect((await reader.read()).done).toBe(true)
  })

  test('frames of other sessions are ignored and a closing browser ends the stream', async () => {
    const peer = fakeCdpPeer()
    const { page } = await openPage(peer)
    const live = await startLive(page, { mode: 'screencast' })
    frameEvent(peer, 1, 'someone-else')
    const reader = live.frames.getReader()
    const next = reader.read()
    peer.closeFromPeer()
    expect((await next).done).toBe(true)
  })
})

describe('poll mode', () => {
  test('sends a frame only when the screenshot hash changed', async () => {
    const peer = fakeCdpPeer()
    const { page } = await openPage(peer, { ...FAST_LIMITS })
    const shots = ['AAAA', 'AAAA', 'BBBB']
    let i = 0
    peer.handle('Page.captureScreenshot', () => ({ data: shots[Math.min(i++, shots.length - 1)] }))
    const live = await startLive(page, { mode: 'poll', pollMs: 10 })
    const reader = live.frames.getReader()
    const a = await reader.read()
    const b = await reader.read()
    expect(a.value?.seq).toBe(1)
    expect(b.value?.seq).toBe(2)
    expect(b.value?.data).not.toEqual(a.value?.data)
    expect(i).toBeGreaterThanOrEqual(3) // the unchanged one was captured but not sent
    await live.close()
  })
})

describe('input mapping', () => {
  test('mouse events map to Input.dispatchMouseEvent', () => {
    expect(
      mapLiveInput({ type: 'mouse', event: 'down', x: 10, y: 20, button: 'right', clickCount: 2 }),
    ).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          x: 10,
          y: 20,
          modifiers: 0,
          pointerType: 'mouse',
          button: 'right',
          buttons: 2,
          clickCount: 2,
        },
      },
    ])
    expect(mapLiveInput({ type: 'mouse', event: 'wheel', x: 1, y: 2, deltaY: 120 })).toMatchObject([
      { params: { type: 'mouseWheel', deltaX: 0, deltaY: 120 } },
    ])
    expect(mapLiveInput({ type: 'mouse', event: 'up', x: 1, y: 2 })).toMatchObject([
      { params: { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 } },
    ])
    expect(mapLiveInput({ type: 'mouse', event: 'move', x: 1, y: 2 })).toMatchObject([
      { params: { type: 'mouseMoved', button: 'none' } },
    ])
    expect(mapLiveInput({ type: 'mouse', event: 'move', x: Number.NaN, y: 2 })).toBe(
      'ERROR: mouse input needs numeric x and y.',
    )
  })

  test('key, text and navigate events', () => {
    expect(mapLiveInput({ type: 'key', event: 'down', key: 'Enter' })).toMatchObject([
      {
        method: 'Input.dispatchKeyEvent',
        params: { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13 },
      },
    ])
    expect(
      mapLiveInput({ type: 'key', event: 'down', key: 'a', text: 'a', modifiers: 8 }),
    ).toMatchObject([{ params: { type: 'keyDown', text: 'a', modifiers: 8 } }])
    expect(mapLiveInput({ type: 'key', event: 'char', key: 'é' })).toMatchObject([
      { params: { type: 'char', text: 'é' } },
    ])
    expect(mapLiveInput({ type: 'key', event: 'up', key: 'Tab' })).toMatchObject([
      { params: { type: 'keyUp', key: 'Tab' } },
    ])
    expect(mapLiveInput({ type: 'text', text: 'こんにちは' })).toEqual([
      { method: 'Input.insertText', params: { text: 'こんにちは' } },
    ])
    expect(mapLiveInput({ type: 'navigate', url: 'https://a.test/' })).toEqual([
      { method: 'Page.navigate', params: { url: 'https://a.test/' } },
    ])
    expect(mapLiveInput({ type: 'navigate', url: '' })).toBe('ERROR: navigate needs a url.')
    expect(comboCommands('Shift+Tab')).toMatchObject([{ params: { modifiers: 8, key: 'Tab' } }, {}])
  })

  test('input() sends to the page and answers an ERROR string for bad events', async () => {
    const peer = fakeCdpPeer()
    const { page } = await openPage(peer)
    const live = await startLive(page, { mode: 'screencast' })
    expect(await live.input({ type: 'text', text: 'hi' })).toBeUndefined()
    expect(peer.last('Input.insertText')).toMatchObject({
      params: { text: 'hi' },
      sessionId: page.sessionId,
    })
    expect(await live.input({ type: 'navigate', url: '' })).toStartWith('ERROR:')
    await live.close()
  })
})
