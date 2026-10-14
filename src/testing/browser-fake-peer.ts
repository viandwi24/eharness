/**
 * An in-memory, scriptable CDP peer for tests (spec 35 §11): a WebSocket-like object that answers
 * commands from handlers (recorded AX trees, box models, hit tests, screenshots, screencast
 * frames), pushes events, and records every command it receives.
 *
 * `fakeCdpPeer()` starts with a small page world (one tab, one frame, `Target.*` and `Page.*`
 * basics) so tests only script what they care about. Handlers added with {@link FakeCdpPeer.handle}
 * run newest first; returning {@link FAKE_PASS} falls through to the next one.
 *
 * Standalone on purpose: it implements the socket slice the client needs and imports nothing.
 */

/** Fall through to the next (older) handler of the method. */
export const FAKE_PASS: unique symbol = Symbol('fake-cdp-pass')

/** A CDP error answer. */
export class FakeCdpError {
  readonly message: string
  readonly code: number
  constructor(message: string, code = -32000) {
    this.message = message
    this.code = code
  }
}

/** Shorthand for `new FakeCdpError(message)`. */
export function fakeCdpError(message: string, code?: number): FakeCdpError {
  return new FakeCdpError(message, code)
}

/** A recorded command. */
export interface FakeCommand {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

/** What a handler returns: a result object, an error, or nothing to stay silent (timeouts). */
export type FakeReply = Record<string, unknown> | FakeCdpError | typeof FAKE_PASS | undefined

/** Context passed to handlers. */
export interface FakeHandlerContext {
  sessionId?: string
  peer: FakeCdpPeer
}

/** A scripted answer for one method. */
export type FakeHandler =
  | FakeReply
  | ((params: Record<string, unknown>, ctx: FakeHandlerContext) => FakeReply | Promise<FakeReply>)

/** The mutable page world behind the default handlers. */
export interface FakePageState {
  url: string
  title: string
  loaderId: string
  /** Extra frames. The main frame is `F1`. */
  childFrames: Array<{ id: string; parentId: string; loaderId: string; url: string }>
  viewport: { width: number; height: number }
  content: { width: number; height: number }
  /** Targets: the first page is `T1`; its session id is `S-T1`. */
  targets: Array<{ targetId: string; type: string; url: string; title: string }>
}

/** Options of {@link fakeCdpPeer}. */
export interface FakeCdpPeerOptions {
  url?: string
  title?: string
  /** Answer unknown methods with a `-32601` error instead of `{}`. Default false. */
  strict?: boolean
  /** Start without the default handlers. */
  bare?: boolean
}

type Listener = (event: never) => void

/** The fake peer; also the socket the client talks to. */
export class FakeCdpPeer {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  /** Every command received, in order. */
  readonly sent: FakeCommand[] = []
  readonly state: FakePageState
  /** The URL the client asked for and the headers it sent. */
  connectedUrl?: string
  connectedHeaders?: Record<string, string>
  private readonly handlers = new Map<string, FakeHandler[]>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly strict: boolean
  private tabCounter = 1

  constructor(options: FakeCdpPeerOptions = {}) {
    this.strict = options.strict ?? false
    this.state = {
      url: options.url ?? 'https://example.test/',
      title: options.title ?? 'Example',
      loaderId: 'L1',
      childFrames: [],
      viewport: { width: 1280, height: 800 },
      content: { width: 1280, height: 2400 },
      targets: [
        {
          targetId: 'T1',
          type: 'page',
          url: options.url ?? 'https://example.test/',
          title: options.title ?? 'Example',
        },
      ],
    }
    if (!options.bare) installDefaults(this)
  }

  /** A socket factory for `cdpConnection({ webSocket })`; the socket opens on the next tick. */
  readonly socketFactory = (
    url: string,
    init?: { headers?: Record<string, string> },
  ): FakeCdpPeer => {
    this.connectedUrl = url
    if (init?.headers) this.connectedHeaders = init.headers
    queueMicrotask(() => this.open())
    return this
  }

  /** Open the socket (the factory does it; tests of connect failures can skip it). */
  open(): void {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.dispatch('open', {})
  }

  /** Script a method. Newest handler first. */
  handle(method: string, handler: FakeHandler): this {
    const list = this.handlers.get(method) ?? []
    list.unshift(handler)
    this.handlers.set(method, list)
    return this
  }

  /** Script a method with a sequence of answers; the last one repeats. */
  handleSequence(method: string, replies: FakeReply[]): this {
    let i = 0
    return this.handle(method, () => replies[Math.min(i++, replies.length - 1)])
  }

  /** Push an event to the client. */
  emit(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    const msg: Record<string, unknown> = { method, params }
    if (sessionId) msg.sessionId = sessionId
    this.dispatch('message', { data: JSON.stringify(msg) })
  }

  /** The peer closes the socket (browser crash, proxy cut). */
  closeFromPeer(code = 1006, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }

  /** Commands received, optionally filtered by method. */
  commands(method?: string): FakeCommand[] {
    return method === undefined ? [...this.sent] : this.sent.filter((c) => c.method === method)
  }

  /** The newest command of a method. */
  last(method: string): FakeCommand | undefined {
    return this.commands(method).at(-1)
  }

  /** Forget recorded commands. */
  clearSent(): void {
    this.sent.length = 0
  }

  /** A new target (tab) as created by `Target.createTarget`. */
  newTarget(url: string): string {
    const targetId = `T${++this.tabCounter}`
    this.state.targets.push({ targetId, type: 'page', url, title: '' })
    return targetId
  }

  // --- socket ----------------------------------------------------------------------------------

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('fake peer: socket is not open') // plain-error: test helper
    const msg = JSON.parse(data) as {
      id: number
      method: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    const command: FakeCommand = { id: msg.id, method: msg.method, params: msg.params ?? {} }
    if (msg.sessionId) command.sessionId = msg.sessionId
    this.sent.push(command)
    queueMicrotask(() => void this.answer(command))
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatch('close', { code, reason })
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    this.listeners.set(type, set)
    set.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  // --- internals -------------------------------------------------------------------------------

  private dispatch(type: string, event: Record<string, unknown>): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) (l as (e: unknown) => void)(event)
  }

  private async answer(command: FakeCommand): Promise<void> {
    const ctx: FakeHandlerContext = { peer: this }
    if (command.sessionId) ctx.sessionId = command.sessionId
    let reply: FakeReply = FAKE_PASS
    for (const handler of this.handlers.get(command.method) ?? []) {
      reply =
        typeof handler === 'function' ? await handler(command.params, ctx) : (handler as FakeReply)
      if (reply !== FAKE_PASS) break
    }
    if (reply === FAKE_PASS) {
      reply = this.strict ? fakeCdpError(`'${command.method}' wasn't found`, -32601) : {}
    }
    if (reply === undefined || this.readyState !== 1) return
    const base: Record<string, unknown> = { id: command.id }
    if (command.sessionId) base.sessionId = command.sessionId
    if (reply instanceof FakeCdpError) base.error = { code: reply.code, message: reply.message }
    else base.result = reply
    this.dispatch('message', { data: JSON.stringify(base) })
  }
}

/** A peer with the default page world. */
export function fakeCdpPeer(options: FakeCdpPeerOptions = {}): FakeCdpPeer {
  return new FakeCdpPeer(options)
}

function frameTree(peer: FakeCdpPeer): Record<string, unknown> {
  const { state } = peer
  const frame = (f: { id: string; loaderId: string; url: string; parentId?: string }): unknown => ({
    id: f.id,
    loaderId: f.loaderId,
    url: f.url,
    ...(f.parentId ? { parentId: f.parentId } : {}),
    mimeType: 'text/html',
    securityOrigin: 'https://example.test',
  })
  const children = (parentId: string): unknown[] =>
    state.childFrames
      .filter((c) => c.parentId === parentId)
      .map((c) => ({ frame: frame(c), childFrames: children(c.id) }))
  return {
    frameTree: {
      frame: frame({ id: 'F1', loaderId: state.loaderId, url: state.url }),
      childFrames: children('F1'),
    },
  }
}

function installDefaults(peer: FakeCdpPeer): void {
  const { state } = peer
  const empty = (): Record<string, unknown> => ({})
  for (const m of [
    'Target.setAutoAttach',
    'Target.setDiscoverTargets',
    'Target.activateTarget',
    'Page.enable',
    'Network.enable',
    'DOM.enable',
    'Accessibility.enable',
    'Runtime.enable',
    'Page.setLifecycleEventsEnabled',
    'Page.bringToFront',
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Input.insertText',
    'Page.startScreencast',
    'Page.stopScreencast',
    'Page.screencastFrameAck',
    'Page.handleJavaScriptDialog',
  ]) {
    peer.handle(m, empty)
  }
  peer.handle('Target.getTargets', () => ({
    targetInfos: state.targets.map((t) => ({ ...t, attached: false })),
  }))
  peer.handle('Target.getTargetInfo', (p) => {
    const t = state.targets.find((x) => x.targetId === p.targetId) ?? state.targets[0]
    return { targetInfo: { ...t } }
  })
  peer.handle('Target.attachToTarget', (p) => ({ sessionId: `S-${String(p.targetId)}` }))
  peer.handle('Target.createTarget', (p) => ({
    targetId: peer.newTarget(String(p.url ?? 'about:blank')),
  }))
  peer.handle('Target.closeTarget', (p) => {
    const i = state.targets.findIndex((t) => t.targetId === p.targetId)
    if (i >= 0) state.targets.splice(i, 1)
    return { success: i >= 0 }
  })
  peer.handle('Page.getFrameTree', () => frameTree(peer))
  peer.handle('Page.getLayoutMetrics', () => ({
    cssVisualViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: state.viewport.width,
      clientHeight: state.viewport.height,
      scale: 1,
    },
    cssContentSize: { x: 0, y: 0, ...state.content },
    cssLayoutViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: state.viewport.width,
      clientHeight: state.viewport.height,
    },
  }))
  peer.handle('Page.navigate', (p, ctx) => {
    state.url = String(p.url)
    state.loaderId = `L${Number(state.loaderId.slice(1)) + 1}`
    const t = state.targets[0]
    if (t) t.url = state.url
    const loaderId = state.loaderId
    queueMicrotask(() => peer.emit('Page.loadEventFired', { timestamp: 1 }, ctx.sessionId))
    return { frameId: 'F1', loaderId }
  })
  peer.handle('Page.reload', (_p, ctx) => {
    state.loaderId = `L${Number(state.loaderId.slice(1)) + 1}`
    queueMicrotask(() => peer.emit('Page.loadEventFired', { timestamp: 1 }, ctx.sessionId))
    return {}
  })
  // The page-info expression of the connection: `({ url: location.href, title: document.title })`.
  peer.handle('Runtime.evaluate', (p) =>
    typeof p.expression === 'string' && p.expression.includes('location.href')
      ? { result: { type: 'object', value: { url: state.url, title: state.title } } }
      : FAKE_PASS,
  )
}
