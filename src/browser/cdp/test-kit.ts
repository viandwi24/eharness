/**
 * Recorded-style CDP payloads and a scripted page world for the unit tests of this folder (AX
 * trees, box models, hit tests, screenshots, screencast frames). Test support, not public API.
 */
import { FAKE_PASS, type FakeCdpPeer, fakeCdpError } from '../../testing/browser-fake-peer.ts'
import { type CdpClient, cdpConnection } from './client.ts'
import { type CdpBrowserConnection, wrapCdpClient } from './connection.ts'
import { attachPage } from './tabs.ts'
import { type CdpLimits, DEFAULT_CDP_LIMITS, type PageSession } from './types.ts'

/** Limits with no network quiet period and a short settle, so tests do not wait. */
export const FAST_LIMITS: CdpLimits = {
  ...DEFAULT_CDP_LIMITS,
  quietMs: 0,
  settleMs: 40,
  waitMs: 400,
  timeoutMs: 2_000,
  navigateMs: 200,
}

type Ax = Record<string, unknown>
const v = (value: unknown, type = 'string'): { type: string; value: unknown } => ({ type, value })

/** A login page as `Accessibility.getFullAXTree` answers it (trimmed from a real recording). */
export function loginAxTree(): Ax[] {
  return [
    {
      nodeId: '1',
      ignored: false,
      role: v('RootWebArea', 'internalRole'),
      name: v('Login'),
      childIds: ['2', '3', '4', '5', '6', '7', '12'],
      backendDOMNodeId: 1,
    },
    {
      nodeId: '2',
      ignored: false,
      role: v('heading', 'role'),
      name: v('Sign in'),
      properties: [{ name: 'level', value: v(1, 'integer') }],
      childIds: ['8'],
      parentId: '1',
      backendDOMNodeId: 10,
    },
    {
      nodeId: '8',
      ignored: false,
      role: v('StaticText', 'internalRole'),
      name: v('Sign in'),
      parentId: '2',
      backendDOMNodeId: 11,
    },
    {
      nodeId: '3',
      ignored: false,
      role: v('textbox', 'role'),
      name: v('Email'),
      value: v('a@b.c'),
      properties: [{ name: 'disabled', value: v(false, 'boolean') }],
      parentId: '1',
      backendDOMNodeId: 12,
    },
    {
      nodeId: '4',
      ignored: false,
      role: v('checkbox', 'role'),
      name: v('Remember me'),
      properties: [{ name: 'checked', value: v('true', 'tristate') }],
      parentId: '1',
      backendDOMNodeId: 13,
    },
    {
      nodeId: '5',
      ignored: false,
      role: v('button', 'role'),
      name: v('Submit'),
      childIds: ['9'],
      parentId: '1',
      backendDOMNodeId: 14,
    },
    {
      nodeId: '9',
      ignored: false,
      role: v('StaticText', 'internalRole'),
      name: v('Submit'),
      parentId: '5',
      backendDOMNodeId: 17,
    },
    {
      nodeId: '6',
      ignored: true,
      role: v('generic', 'internalRole'),
      childIds: ['10'],
      parentId: '1',
      backendDOMNodeId: 18,
    },
    {
      nodeId: '10',
      ignored: false,
      role: v('link', 'role'),
      name: v('Forgot password?'),
      parentId: '6',
      backendDOMNodeId: 15,
    },
    {
      nodeId: '7',
      ignored: false,
      role: v('Iframe', 'internalRole'),
      name: v('Captcha'),
      parentId: '1',
      backendDOMNodeId: 16,
    },
    {
      nodeId: '12',
      ignored: false,
      role: v('combobox', 'role'),
      name: v('Country'),
      properties: [{ name: 'expanded', value: v(false, 'boolean') }],
      parentId: '1',
      backendDOMNodeId: 19,
    },
  ]
}

/** The AX tree of a same-process iframe `F2`. */
export function innerAxTree(): Ax[] {
  return [
    {
      nodeId: '1',
      ignored: false,
      role: v('RootWebArea', 'internalRole'),
      name: v('Inner'),
      childIds: ['2'],
      backendDOMNodeId: 30,
    },
    {
      nodeId: '2',
      ignored: false,
      role: v('button', 'role'),
      name: v('Inner OK'),
      parentId: '1',
      backendDOMNodeId: 31,
    },
  ]
}

/** A 1x1 JPEG as `Page.captureScreenshot` returns it (base64). */
export const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

/** Page world options. */
export interface WorldOptions {
  ax?: Ax[]
  innerAx?: Ax[]
  /** backendNodeId → content quad `[x1,y1,x2,y1,x2,y2,x1,y2]` (frame-relative). Missing = no box. */
  boxes?: Record<number, number[]>
  /** The element at a point: backendNodeId (and frame). Default: the element being clicked. */
  hit?: (x: number, y: number) => { backendNodeId: number; frameId?: string } | undefined
}

/** A box `w` x `h` with its top-left at `x`,`y`, as a content quad. */
export function quad(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h]
}

/**
 * Script the page-specific methods on a peer: AX trees, frame owners, object ids, box models,
 * hit tests, and `Runtime.callFunctionOn` answers keyed by a fragment of the function text
 * (`peer.handle('Runtime.callFunctionOn', ...)` overrides them).
 */
export function installWorld(peer: FakeCdpPeer, options: WorldOptions = {}): void {
  const ax = options.ax ?? loginAxTree()
  peer.state.childFrames.push({
    id: 'F2',
    parentId: 'F1',
    loaderId: 'LF2',
    url: 'https://example.test/inner',
  })
  peer.handle('Accessibility.getFullAXTree', (p) => ({
    nodes: p.frameId === 'F2' ? (options.innerAx ?? innerAxTree()) : ax,
  }))
  peer.handle('DOM.describeNode', (p) => {
    if (p.backendNodeId === 16)
      return { node: { nodeName: 'IFRAME', frameId: 'F2', backendNodeId: 16 } }
    if (typeof p.backendNodeId === 'number') {
      return { node: { nodeName: 'DIV', backendNodeId: p.backendNodeId } }
    }
    return FAKE_PASS
  })
  peer.handle('DOM.getFrameOwner', (p) => (p.frameId === 'F2' ? { backendNodeId: 16 } : FAKE_PASS))
  peer.handle('DOM.resolveNode', (p) => ({
    object: { type: 'object', objectId: `obj-${String(p.backendNodeId)}` },
  }))
  peer.handle('DOM.getBoxModel', (p) => {
    const q = options.boxes?.[Number(p.backendNodeId)]
    if (!q) return fakeCdpError('Could not compute box model.')
    return { model: { content: q, padding: q, border: q, margin: q, width: 10, height: 10 } }
  })
  peer.handle('DOM.getNodeForLocation', (p) => {
    const hit = options.hit?.(Number(p.x), Number(p.y))
    return hit ? { ...hit, frameId: hit.frameId ?? 'F1' } : FAKE_PASS
  })
  peer.handle('Page.captureScreenshot', () => ({ data: TINY_JPEG }))
}

/** Open a client on a peer. */
export async function connect(peer: FakeCdpPeer): Promise<CdpClient> {
  return cdpConnection(
    { url: 'ws://fake.test/devtools' },
    { webSocket: peer.socketFactory, timeoutMs: 2_000 },
  )
}

/** Open a client and attach the first page. */
export async function openPage(
  peer: FakeCdpPeer,
  limits: CdpLimits = FAST_LIMITS,
): Promise<{ client: CdpClient; page: PageSession }> {
  const client = await connect(peer)
  const page = await attachPage(client, 'T1', limits)
  return { client, page }
}

/** Open a client and wrap it as a connection. */
export async function openConnection(
  peer: FakeCdpPeer,
  limits: CdpLimits = FAST_LIMITS,
): Promise<CdpBrowserConnection> {
  return wrapCdpClient(await connect(peer), { limits })
}

/** The session id the fake peer gives target `T1`. */
export const SESSION = 'S-T1'
