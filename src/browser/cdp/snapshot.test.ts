import { describe, expect, test } from 'bun:test'
import { fakeCdpPeer } from '../../testing/browser-fake-peer.ts'
import { capOutline, resolveRef, takeSnapshot, wantsRef } from './snapshot.ts'
import { FAST_LIMITS, installWorld, openPage, SESSION } from './test-kit.ts'

async function world() {
  const peer = fakeCdpPeer({ url: 'https://example.test/login', title: 'Login' })
  installWorld(peer)
  const { page } = await openPage(peer)
  return { peer, page }
}

describe('takeSnapshot', () => {
  test('renders the outline with refs, flags, nested iframe and ids', async () => {
    const { page } = await world()
    const snap = await takeSnapshot(page, {})
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.id).toBe('s1')
    expect(snap.page).toEqual({ url: 'https://example.test/login', title: 'Login' })
    expect(snap.text).toBe(
      [
        '- heading "Sign in" [level=1]',
        '- textbox "Email" value="a@b.c" [ref=e1]',
        '- checkbox "Remember me" [checked] [ref=e2]',
        '- button "Submit" [ref=e3]',
        '- link "Forgot password?" [ref=e4]',
        '- iframe "Captcha"',
        '  - button "Inner OK" [ref=e5]',
        '- combobox "Country" [collapsed] [ref=e6]',
      ].join('\n'),
    )
    expect(snap.refCount).toBe(6)
    expect(page.refs.entries.get('e3')).toMatchObject({
      snapshotId: 's1',
      frameId: 'F1',
      loaderId: 'L1',
      backendNodeId: 14,
      role: 'button',
      name: 'Submit',
    })
    expect(page.refs.entries.get('e5')).toMatchObject({ frameId: 'F2', loaderId: 'LF2' })
  })

  test('a second snapshot gets a new id and keeps refs of the same elements', async () => {
    const { page } = await world()
    await takeSnapshot(page, {})
    const second = await takeSnapshot(page, {})
    if (typeof second === 'string') throw new Error(second)
    expect(second.id).toBe('s2')
    expect(second.text).toContain('[ref=e3]')
    expect(page.refs.entries.get('e3')?.snapshotId).toBe('s2')
  })

  test('interactive:false adds refs to headings', async () => {
    const { page } = await world()
    const snap = await takeSnapshot(page, { interactive: false })
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.text).toContain('- heading "Sign in" [level=1] [ref=')
    expect(wantsRef('heading', true)).toBe(false)
    expect(wantsRef('menuitemcheckbox', true)).toBe(true)
  })

  test('scope snapshots one subtree', async () => {
    const { page } = await world()
    await takeSnapshot(page, {})
    const scoped = await takeSnapshot(page, { scope: 'e3' })
    if (typeof scoped === 'string') throw new Error(scoped)
    expect(scoped.text).toBe('- button "Submit" [ref=e3]')
  })

  test('refs from an older document answer STALE with the snapshot id', async () => {
    const { page, peer } = await world()
    await takeSnapshot(page, {})
    peer.state.loaderId = 'L2'
    expect(await resolveRef(page, 'e3')).toBe(
      'STALE: the page changed since snapshot s1. Take a new snapshot.',
    )
    expect(await takeSnapshot(page, { scope: 'e3' })).toStartWith('STALE:')
    expect(await resolveRef(page, 'zz')).toStartWith('ERROR: "zz" is not a ref')
    const fresh = await takeSnapshot(page, {})
    if (typeof fresh === 'string') throw new Error(fresh)
    // New document, new refs (the loader id is part of the key).
    expect(fresh.text).not.toContain('[ref=e3]')
    expect(typeof (await resolveRef(page, 'e7'))).toBe('object')
  })

  test('an unknown ref before any snapshot asks for a snapshot', async () => {
    const { page } = await world()
    expect(await resolveRef(page, 'e1')).toBe(
      'ERROR: unknown ref "e1". Take a snapshot first with browser_snapshot.',
    )
  })

  test('a cross-site iframe is listed with a readable "not supported yet" answer', async () => {
    const { page, peer } = await world()
    page.oopifs.add('F2')
    peer.emit(
      'Target.attachedToTarget',
      { sessionId: 'child', targetInfo: { targetId: 'F2', type: 'iframe' } },
      SESSION,
    )
    const snap = await takeSnapshot(page, {})
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.text).toContain('- iframe "Captcha" [cross-site, not supported yet] [ref=')
    expect(snap.text).not.toContain('Inner OK')
    const ref = [...page.refs.entries.values()].find((e) => e.role === 'iframe')?.ref as string
    expect(await resolveRef(page, ref)).toMatch(/cross-site iframe.*not supported yet/)
  })

  test('the clickable pass adds elements without a role', async () => {
    const { page, peer } = await world()
    peer.handle('Runtime.evaluate', (p) =>
      typeof p.expression === 'string' && p.expression.includes('getComputedStyle')
        ? { result: { type: 'object', objectId: 'arr' } }
        : { result: { type: 'object', value: { url: 'x', title: 'y' } } },
    )
    peer.handle('Runtime.getProperties', {
      result: [
        { name: '0', value: { objectId: 'el0' } },
        { name: '1', value: { objectId: 'el1' } },
        { name: 'length', value: { type: 'number', value: 2 } },
      ],
    })
    peer.handle('Runtime.callFunctionOn', {
      result: { type: 'object', value: ['Buy now', 'Menu'] },
    })
    peer.handle('DOM.describeNode', (p) =>
      p.objectId === 'el0'
        ? { node: { backendNodeId: 200 } }
        : p.objectId === 'el1'
          ? { node: { backendNodeId: 14 } } // already listed as the Submit button
          : {
              node: {
                backendNodeId: Number(p.backendNodeId),
                frameId: p.backendNodeId === 16 ? 'F2' : undefined,
              },
            },
    )
    const snap = await takeSnapshot(page, {})
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.text.split('\n').at(-1)).toMatch(/^- clickable "Buy now" \[ref=e\d+\]$/)
    expect(snap.text).not.toContain('"Menu"')
  })
})

describe('capOutline', () => {
  const text = Array.from({ length: 400 }, (_, i) => `- link "Item ${i}" [ref=e${i}]`).join('\n')

  test('short text is returned whole', () => {
    expect(capOutline('abc', 0, 100)).toEqual({ text: 'abc' })
  })

  test('long text is cut at a line, announces the offset and keeps the tail', () => {
    const out = capOutline(text, 0, 4000)
    expect(out.nextOffset).toBeGreaterThan(0)
    expect(out.text.length).toBeLessThanOrEqual(4000)
    expect(out.text).toContain(
      `… truncated; call browser_snapshot with offset ${out.nextOffset} for more`,
    )
    expect(out.text.startsWith('- link "Item 0"')).toBe(true)
    expect(out.text.endsWith('[ref=e399]')).toBe(true)
    expect(
      text.slice(0, out.nextOffset).endsWith('\n') || text[out.nextOffset as number] === '\n',
    ).toBe(true)
  })

  test('the offset continues where the previous page ended', () => {
    const first = capOutline(text, 0, 4000)
    const second = capOutline(text, first.nextOffset as number, 4000)
    expect(second.text.trimStart().startsWith('- link')).toBe(true)
    expect(capOutline(text, text.length + 5, 4000).text).toContain('nothing at offset')
  })

  test('the snapshot honours limits.snapshotChars', async () => {
    const { page } = await world()
    page.limits = { ...FAST_LIMITS, snapshotChars: 120 }
    const snap = await takeSnapshot(page, {})
    if (typeof snap === 'string') throw new Error(snap)
    expect(snap.nextOffset).toBeDefined()
    expect(snap.text).toContain('truncated; call browser_snapshot with offset')
  })
})
