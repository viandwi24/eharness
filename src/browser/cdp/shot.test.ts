import { describe, expect, test } from 'bun:test'
import { fakeCdpError, fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { READ_EXTRACTOR, readPage } from './read.ts'
import { base64ToBytes, sha1Hex, takeScreenshot } from './shot.ts'
import { takeSnapshot } from './snapshot.ts'
import { FAST_LIMITS, installWorld, openPage, quad, TINY_JPEG } from './test-kit.ts'

async function setup() {
  const peer = fakeCdpPeer()
  installWorld(peer, { boxes: { 14: quad(100, 200, 80, 40) } })
  const { page } = await openPage(peer)
  return { peer, page }
}

describe('takeScreenshot', () => {
  test('viewport shot: JPEG q70, scaled down to maxWidth, hashed', async () => {
    const { peer, page } = await setup()
    const shot = await takeScreenshot(page, { maxWidth: 640 })
    if (typeof shot === 'string') throw new Error(shot)
    expect(peer.last('Page.captureScreenshot')?.params).toMatchObject({
      format: 'jpeg',
      quality: 70,
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 },
      captureBeyondViewport: false,
    })
    expect(shot).toMatchObject({ mediaType: 'image/jpeg', width: 640, height: 400 })
    expect(shot.bytes).toEqual(base64ToBytes(TINY_JPEG))
    expect(shot.hash).toBe(await sha1Hex(shot.bytes))
    expect(shot.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(await sha1Hex(new TextEncoder().encode('abc'))).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d',
    )
  })

  test('never scales up', async () => {
    const { peer, page } = await setup()
    peer.state.viewport = { width: 800, height: 600 }
    const shot = await takeScreenshot(page, { maxWidth: 1280 })
    if (typeof shot === 'string') throw new Error(shot)
    expect(shot.width).toBe(800)
    expect(peer.last('Page.captureScreenshot')?.params).toMatchObject({ clip: { scale: 1 } })
  })

  test('full page is capped in height and captures beyond the viewport', async () => {
    const { peer, page } = await setup()
    peer.state.content = { width: 1280, height: 30_000 }
    const shot = await takeScreenshot(page, { fullPage: true })
    if (typeof shot === 'string') throw new Error(shot)
    expect(peer.last('Page.captureScreenshot')?.params).toMatchObject({
      clip: { width: 1280, height: 8000, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(shot.height).toBe(8000)
  })

  test('an element ref clips to its box; PNG for engines without JPEG', async () => {
    const { peer, page } = await setup()
    await takeSnapshot(page, {})
    const shot = await takeScreenshot(page, { ref: 'e3', format: 'png' })
    if (typeof shot === 'string') throw new Error(shot)
    const params = peer.last('Page.captureScreenshot')?.params as Record<string, unknown>
    expect(params.clip).toMatchObject({ x: 100, y: 200, width: 80, height: 40 })
    expect(params.format).toBe('png')
    expect(params.quality).toBeUndefined()
    expect(shot.mediaType).toBe('image/png')
  })

  test('a stale ref and a failing browser are strings', async () => {
    const { peer, page } = await setup()
    await takeSnapshot(page, {})
    peer.state.loaderId = 'L2'
    expect(await takeScreenshot(page, { ref: 'e3' })).toStartWith('STALE:')
    peer.handle('Page.captureScreenshot', { data: '' })
    expect(await takeScreenshot(page, {})).toBe('ERROR: the browser returned no image.')
  })
})

describe('takeScreenshot on a PNG-only engine (Lightpanda)', () => {
  test('a refused JPEG is retried as PNG, and later shots ask for PNG directly', async () => {
    const { peer, page } = await setup()
    peer.handle('Page.captureScreenshot', (params) =>
      params.format === 'jpeg'
        ? fakeCdpError('unsupported screenshot format.')
        : { data: TINY_JPEG },
    )
    const shot = await takeScreenshot(page, {})
    if (typeof shot === 'string') throw new Error(shot)
    expect(shot.mediaType).toBe('image/png')
    const formats = peer
      .commands('Page.captureScreenshot')
      .map((c) => (c.params as { format?: string }).format)
    expect(formats).toEqual(['jpeg', 'png'])
    await takeScreenshot(page, {})
    const last = peer.last('Page.captureScreenshot')
    expect((last?.params as { format?: string } | undefined)?.format).toBe('png')
  })
})

describe('readPage', () => {
  test('returns the extractor text with a cap and an offset', async () => {
    const { peer, page } = await setup()
    const body = `# Title\n\n${'word '.repeat(100)}\n\n- [Docs](https://example.test/docs)`
    peer.handle('Runtime.evaluate', (p) =>
      p.expression === READ_EXTRACTOR
        ? { result: { type: 'string', value: body } }
        : { result: { type: 'object', value: { url: 'https://example.test/', title: 'T' } } },
    )
    const first = await readPage(page, { maxChars: 200 })
    if (typeof first === 'string') throw new Error(first)
    expect(first.text).toBe(body.slice(0, 200))
    expect(first.nextOffset).toBe(200)
    const last = await readPage(page, { offset: 200, maxChars: 10_000 })
    if (typeof last === 'string') throw new Error(last)
    expect(last.text).toBe(body.slice(200))
    expect(last.nextOffset).toBeUndefined()
    const past = await readPage(page, { offset: 99_999 })
    if (typeof past === 'string') throw new Error(past)
    expect(past.text).toContain('nothing at offset 99999')
  })

  test('the extractor is a constant, parseable script that does not touch page globals', () => {
    expect(() => new Function(`return ${READ_EXTRACTOR}`)).not.toThrow()
    expect(READ_EXTRACTOR).toContain('[')
    expect(READ_EXTRACTOR).not.toMatch(/\bfetch\b|XMLHttpRequest|eval\(/)
  })

  test('a page that throws answers an ERROR string', async () => {
    const { peer, page } = await setup()
    peer.handle('Runtime.evaluate', { exceptionDetails: { text: 'boom' } })
    expect(await readPage(page, {})).toStartWith('ERROR: the page could not be read')
    page.limits = FAST_LIMITS
  })
})
