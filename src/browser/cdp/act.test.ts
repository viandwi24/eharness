import { describe, expect, test } from 'bun:test'
import { FAKE_PASS, fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { act } from './act.ts'
import { takeSnapshot } from './snapshot.ts'
import { FAST_LIMITS, installWorld, openPage, quad } from './test-kit.ts'

// Refs of the login fixture: e1 textbox, e2 checkbox, e3 button, e4 link, e5 inner button, e6 combobox.
async function setup(world: Parameters<typeof installWorld>[1] = {}) {
  const peer = fakeCdpPeer({ url: 'https://example.test/login', title: 'Login' })
  installWorld(peer, {
    boxes: {
      14: quad(100, 200, 80, 40),
      12: quad(10, 10, 200, 30),
      31: quad(5, 5, 50, 20),
      16: quad(300, 400, 400, 300),
    },
    hit: (_x, _y) => ({ backendNodeId: 14 }),
    ...world,
  })
  const { page } = await openPage(peer)
  await takeSnapshot(page, {})
  peer.clearSent()
  return { peer, page }
}

const mouseTypes = (peer: ReturnType<typeof fakeCdpPeer>): string[] =>
  peer.commands('Input.dispatchMouseEvent').map((c) => String(c.params.type))

describe('act: pointer', () => {
  test('click scrolls into view, hit-tests the box centre, then moved -> pressed -> released', async () => {
    const { peer, page } = await setup()
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.error).toBeUndefined()
    expect(res.summary).toBe('Clicked e3 (button "Submit")')
    expect(peer.last('DOM.scrollIntoViewIfNeeded')?.params).toEqual({ backendNodeId: 14 })
    expect(peer.last('DOM.getNodeForLocation')?.params).toMatchObject({ x: 140, y: 220 })
    expect(mouseTypes(peer)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(peer.commands('Input.dispatchMouseEvent')[1]?.params).toMatchObject({
      x: 140,
      y: 220,
      button: 'left',
      clickCount: 1,
    })
    expect(res.page.url).toBe('https://example.test/login')
  })

  test('double_click sends two press/release pairs with click counts 1 and 2', async () => {
    const { peer, page } = await setup()
    await act(page, { kind: 'double_click', ref: 'e3' })
    expect(mouseTypes(peer)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
      'mousePressed',
      'mouseReleased',
    ])
    expect(peer.commands('Input.dispatchMouseEvent')[3]?.params.clickCount).toBe(2)
  })

  test('hover only moves the mouse', async () => {
    const { peer, page } = await setup()
    expect((await act(page, { kind: 'hover', ref: 'e3' })).summary).toBe(
      'Hovered e3 (button "Submit")',
    )
    expect(mouseTypes(peer)).toEqual(['mouseMoved'])
  })

  test('an element inside an iframe gets the frame offset', async () => {
    const { peer, page } = await setup()
    await act(page, { kind: 'click', ref: 'e5' })
    // inner centre (30,15) + iframe box origin (300,400)
    expect(peer.last('Input.dispatchMouseEvent')?.params).toMatchObject({ x: 330, y: 415 })
  })

  test('a covering element answers BLOCKED and nothing is clicked', async () => {
    const { peer, page } = await setup({ hit: () => ({ backendNodeId: 99 }) })
    peer.handle('Runtime.callFunctionOn', { result: { type: 'boolean', value: false } })
    peer.handle('Accessibility.getPartialAXTree', {
      nodes: [
        { ignored: false, role: { value: 'generic' }, backendDOMNodeId: 99 },
        {
          ignored: false,
          role: { value: 'dialog' },
          name: { value: 'Cookie settings' },
          backendDOMNodeId: 98,
        },
      ],
    })
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.error).toBe(
      'BLOCKED: dialog "Cookie settings" covers e3 (a dialog or banner). Close it first.',
    )
    expect(res.changed).toBe(false)
    expect(mouseTypes(peer)).toEqual([])
  })

  test('an element that contains the hit node is not blocked', async () => {
    const { peer, page } = await setup({ hit: () => ({ backendNodeId: 17 }) })
    peer.handle('Runtime.callFunctionOn', { result: { type: 'boolean', value: true } })
    expect((await act(page, { kind: 'click', ref: 'e3' })).error).toBeUndefined()
    expect(mouseTypes(peer)).toHaveLength(3)
  })

  test('an empty box falls back to the element click()', async () => {
    const { peer, page } = await setup()
    peer.handle('Runtime.callFunctionOn', (p) =>
      String(p.functionDeclaration).includes('.click()')
        ? { result: { type: 'boolean', value: true } }
        : FAKE_PASS,
    )
    const res = await act(page, { kind: 'click', ref: 'e2' }) // checkbox: no box in the fixture
    expect(res.error).toBeUndefined()
    expect(res.note).toContain('own click()')
    expect(mouseTypes(peer)).toEqual([])
  })

  test('a stale ref answers STALE without touching the page', async () => {
    const { peer, page } = await setup()
    peer.state.loaderId = 'L2'
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.error).toBe('STALE: the page changed since snapshot s1. Take a new snapshot.')
    expect(mouseTypes(peer)).toEqual([])
  })

  test('a ref is required for pointer actions', async () => {
    const { page } = await setup()
    expect((await act(page, { kind: 'click' })).error).toBe(
      'ERROR: click needs a ref from browser_snapshot.',
    )
  })
})

describe('act: text and keys', () => {
  test('fill selects the field and inserts the text', async () => {
    const { peer, page } = await setup()
    peer.handle('Runtime.callFunctionOn', { result: { type: 'string', value: 'ok' } })
    const res = await act(page, { kind: 'fill', ref: 'e1', text: 'me@example.com' })
    expect(res.summary).toBe('Filled e1 (textbox "Email") with "me@example.com"')
    expect(peer.last('Input.insertText')?.params).toEqual({ text: 'me@example.com' })
  })

  test('fill refuses a non-editable element and an empty text clears with Backspace', async () => {
    const { peer, page } = await setup()
    peer.handle('Runtime.callFunctionOn', { result: { type: 'string', value: 'not-editable' } })
    expect((await act(page, { kind: 'fill', ref: 'e3', text: 'x' })).error).toMatch(
      /not a text field/,
    )
    peer.handle('Runtime.callFunctionOn', { result: { type: 'string', value: 'ok' } })
    expect((await act(page, { kind: 'fill', ref: 'e1', text: '' })).summary).toBe(
      'Cleared e1 (textbox "Email")',
    )
    expect(peer.last('Input.dispatchKeyEvent')?.params).toMatchObject({
      type: 'keyUp',
      key: 'Backspace',
    })
  })

  test('type sends key events per character', async () => {
    const { peer, page } = await setup()
    const res = await act(page, { kind: 'type', text: 'hi' })
    expect(res.summary).toBe('Typed 2 characters')
    const keys = peer
      .commands('Input.dispatchKeyEvent')
      .map((c) => `${c.params.type}:${c.params.key}`)
    expect(keys).toEqual(['keyDown:h', 'keyUp:h', 'keyDown:i', 'keyUp:i'])
  })

  test('press understands names and Control+a', async () => {
    const { peer, page } = await setup()
    await act(page, { kind: 'press', key: 'Control+a' })
    expect(peer.commands('Input.dispatchKeyEvent')[0]?.params).toMatchObject({
      type: 'rawKeyDown',
      key: 'a',
      modifiers: 2,
      commands: ['selectAll'],
    })
    peer.clearSent()
    await act(page, { kind: 'press', key: 'Enter' })
    expect(peer.commands('Input.dispatchKeyEvent')[0]?.params).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      text: '\r',
      windowsVirtualKeyCode: 13,
    })
    expect((await act(page, { kind: 'press', key: 'Hyper+x' })).error).toMatch(
      /unknown modifier "Hyper"/,
    )
    expect((await act(page, { kind: 'press', key: 'Banana' })).error).toMatch(
      /unknown key "Banana"/,
    )
  })

  test('select reports the chosen option or the options on a miss', async () => {
    const { peer, page } = await setup()
    peer.handle('Runtime.callFunctionOn', {
      result: { type: 'object', value: { selected: ['Indonesia'] } },
    })
    expect((await act(page, { kind: 'select', ref: 'e6', values: ['ID'] })).summary).toBe(
      'Selected "Indonesia" in e6 (combobox "Country")',
    )
    peer.handle('Runtime.callFunctionOn', {
      result: { type: 'object', value: { error: 'no-match', options: ['A', 'B'] } },
    })
    expect((await act(page, { kind: 'select', ref: 'e6', values: ['Z'] })).error).toContain(
      'Options: A, B.',
    )
  })
})

describe('act: check, scroll, wait, settle', () => {
  test('check does nothing when already checked, clicks otherwise and reports a failed toggle', async () => {
    const { peer, page } = await setup({
      boxes: { 13: quad(10, 100, 20, 20) },
      hit: () => ({ backendNodeId: 13 }),
    })
    peer.handle('Runtime.callFunctionOn', {
      result: { type: 'object', value: { checked: true, radio: false } },
    })
    expect((await act(page, { kind: 'check', ref: 'e2' })).summary).toContain('already checked')
    expect(mouseTypes(peer)).toEqual([])
    const states = [{ checked: false }, { checked: false }]
    peer.handle('Runtime.callFunctionOn', () => ({
      result: { type: 'object', value: states.shift() },
    }))
    const res = await act(page, { kind: 'check', ref: 'e2' })
    expect(mouseTypes(peer)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(res.note).toContain('did not become checked')
  })

  test('scroll sends a wheel event at the viewport centre', async () => {
    const { peer, page } = await setup()
    const res = await act(page, { kind: 'scroll', direction: 'down', amount: 300 })
    expect(res.summary).toBe('Scrolled down 300px')
    expect(peer.last('Input.dispatchMouseEvent')?.params).toEqual({
      type: 'mouseWheel',
      x: 640,
      y: 400,
      deltaX: 0,
      deltaY: 300,
    })
  })

  test('wait untilText polls until the text appears, or times out with an error string', async () => {
    const { peer, page } = await setup()
    let calls = 0
    peer.handle('Runtime.evaluate', (p) =>
      String(p.expression).includes('innerText.includes')
        ? { result: { type: 'boolean', value: ++calls >= 3 } }
        : FAKE_PASS,
    )
    expect((await act(page, { kind: 'wait', untilText: 'Welcome' })).summary).toBe(
      'Found text "Welcome"',
    )
    expect(calls).toBe(3)
    peer.handle('Runtime.evaluate', (p) =>
      String(p.expression).includes('innerText.includes')
        ? { result: { type: 'boolean', value: false } }
        : FAKE_PASS,
    )
    const miss = await act(page, { kind: 'wait', untilText: 'Never' })
    expect(miss.error).toMatch(/did not appear within 400 ms/)
    expect((await act(page, { kind: 'wait', ms: 1 })).summary).toBe('Waited 1 ms')
    expect((await act(page, { kind: 'wait' })).error).toBe('ERROR: wait needs ms or untilText.')
  })

  test('settle waits for in-flight requests (bounded by settleMs)', async () => {
    const { peer, page } = await setup()
    page.limits = { ...FAST_LIMITS, quietMs: 0, settleMs: 200 }
    const started = Date.now()
    peer.emit('Network.requestWillBeSent', { requestId: 'r1', type: 'XHR' }, page.sessionId)
    setTimeout(() => peer.emit('Network.loadingFinished', { requestId: 'r1' }, page.sessionId), 60)
    await act(page, { kind: 'hover', ref: 'e3' })
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(50)
    expect(elapsed).toBeLessThan(190)
    // A request that never finishes does not hold the action beyond settleMs.
    peer.emit('Network.requestWillBeSent', { requestId: 'r2', type: 'XHR' }, page.sessionId)
    const t2 = Date.now()
    await act(page, { kind: 'hover', ref: 'e3' })
    expect(Date.now() - t2).toBeLessThan(400)
  })

  test('navigated and changed follow the page', async () => {
    const { peer, page } = await setup()
    peer.handle('Input.dispatchMouseEvent', (p) => {
      if (p.type === 'mouseReleased') {
        peer.state.url = 'https://example.test/home'
        peer.state.loaderId = 'L2'
      }
      return {}
    })
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.navigated).toBe(true)
    expect(res.changed).toBe(true)
    expect(res.page.url).toBe('https://example.test/home')
  })

  test('a dialog opened by the page is dismissed and reported as a note', async () => {
    const { peer, page } = await setup()
    peer.handle('Input.dispatchMouseEvent', (p) => {
      if (p.type === 'mousePressed') {
        peer.emit(
          'Page.javascriptDialogOpening',
          { type: 'confirm', message: 'Delete?' },
          page.sessionId,
        )
      }
      return {}
    })
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.note).toContain('confirm dialog ("Delete?") was dismissed')
    expect(peer.last('Page.handleJavaScriptDialog')?.params).toEqual({ accept: false })
  })

  test('a lost connection is an error string, not a throw', async () => {
    const { peer, page } = await setup()
    peer.closeFromPeer(1006, 'gone')
    const res = await act(page, { kind: 'click', ref: 'e3' })
    expect(res.error).toMatch(/^ERROR: .*connection closed/)
  })
})
