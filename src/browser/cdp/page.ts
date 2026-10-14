/**
 * Helpers shared by the CDP operations: calls bound to one page session, page info, frame loader
 * ids, network settle, and the ref store.
 */
import { CdpError } from './client.ts'
import type { PageInfo, PageSession, RefEntry, RefStore } from './types.ts'

/** Readable text of any failure (a `CdpError` message is already readable). */
export function errorText(error: unknown): string {
  if (error instanceof CdpError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/** A fresh ref store: `s1`, `s2`, ... and `e1`, `e2`, ... never restart within a lease. */
export function createRefStore(): RefStore {
  let snapshotN = 0
  let refN = 0
  const byKey = new Map<string, string>()
  const store: RefStore = {
    entries: new Map<string, RefEntry>(),
    nextSnapshotId() {
      const id = `s${++snapshotN}`
      store.lastSnapshotId = id
      return id
    },
    refFor(frameId, loaderId, backendNodeId) {
      const key = `${frameId}|${loaderId}|${backendNodeId}`
      const known = byKey.get(key)
      if (known) return known
      const ref = `e${++refN}`
      byKey.set(key, ref)
      return ref
    },
    clear() {
      store.entries.clear()
      byKey.clear()
    },
  }
  return store
}

/** Send a command on the page's flattened session. */
export function call<R = Record<string, unknown>>(
  page: PageSession,
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<R> {
  return page.cdp.send<R>(method, params, {
    sessionId: page.sessionId,
    timeoutMs: page.limits.timeoutMs,
    ...(signal ? { signal } : {}),
  })
}

/** `Runtime.evaluate` with `returnByValue`; `undefined` when the page threw. */
export async function evaluate<T = unknown>(
  page: PageSession,
  expression: string,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const res = await call<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    page,
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    signal,
  )
  if (res.exceptionDetails) return undefined
  return res.result?.value
}

/** URL and title of the page. */
export async function pageInfo(page: PageSession, signal?: AbortSignal): Promise<PageInfo> {
  try {
    const v = await evaluate<{ url?: string; title?: string }>(
      page,
      '({ url: location.href, title: document.title })',
      signal,
    )
    if (v && typeof v.url === 'string') return { url: v.url, title: v.title ?? '' }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  const info = await page.cdp.send<{ targetInfo?: { url?: string; title?: string } }>(
    'Target.getTargetInfo',
    { targetId: page.targetId },
    { timeoutMs: page.limits.timeoutMs },
  )
  return { url: info.targetInfo?.url ?? '', title: info.targetInfo?.title ?? '' }
}

/** Frame id → current loader id and parent, from `Page.getFrameTree`. */
export async function frameLoaders(
  page: PageSession,
  signal?: AbortSignal,
): Promise<Map<string, { loaderId: string; parentId?: string; url: string }>> {
  type Node = {
    frame: { id: string; loaderId?: string; parentId?: string; url?: string }
    childFrames?: Node[]
  }
  const res = await call<{ frameTree?: Node }>(page, 'Page.getFrameTree', undefined, signal)
  const out = new Map<string, { loaderId: string; parentId?: string; url: string }>()
  const walk = (n: Node): void => {
    out.set(n.frame.id, {
      loaderId: n.frame.loaderId ?? '',
      ...(n.frame.parentId ? { parentId: n.frame.parentId } : {}),
      url: n.frame.url ?? '',
    })
    for (const c of n.childFrames ?? []) walk(c)
  }
  if (res.frameTree) walk(res.frameTree)
  return out
}

/** The main frame's id and loader id. */
export async function mainFrame(
  page: PageSession,
  signal?: AbortSignal,
): Promise<{ frameId: string; loaderId: string }> {
  const frames = await frameLoaders(page, signal)
  for (const [frameId, f] of frames) if (!f.parentId) return { frameId, loaderId: f.loaderId }
  return { frameId: '', loaderId: '' }
}

const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

/** Resolve after `ms` (or when `signal` aborts). */
export { sleepMs as sleep }

/** Wait for network idle (quiet for `quietMs`) or `settleMs`, whichever comes first. */
export async function settle(page: PageSession, signal?: AbortSignal): Promise<void> {
  const { quietMs, settleMs } = page.limits
  const started = Date.now()
  page.net.lastActivity = Math.max(page.net.lastActivity, started)
  for (;;) {
    if (signal?.aborted) return
    const now = Date.now()
    // A request that never finishes (long poll) must not block us: only fresh ones count.
    for (const [id, at] of page.net.inflight) if (now - at > settleMs) page.net.inflight.delete(id)
    const quiet = page.net.inflight.size === 0 && now - page.net.lastActivity >= quietMs
    if (quiet || now - started >= settleMs) return
    await sleepMs(Math.min(25, Math.max(1, quietMs)), signal)
  }
}

/** A cheap digest of the visible page, to tell whether an action changed something. */
export async function fingerprint(page: PageSession, signal?: AbortSignal): Promise<string> {
  try {
    const v = await evaluate<string>(
      page,
      "location.href + '|' + document.title + '|' + (document.body ? document.body.innerText.length : 0) + '|' + document.getElementsByTagName('*').length",
      signal,
    )
    return v ?? ''
  } catch {
    return ''
  }
}

/** Invoke `fn` with `this` = the element behind `objectId`. */
export async function callOn<T = unknown>(
  page: PageSession,
  objectId: string,
  fn: string,
  args: unknown[] = [],
  signal?: AbortSignal,
): Promise<T | undefined> {
  const res = await call<{ result?: { value?: T }; exceptionDetails?: unknown }>(
    page,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    },
    signal,
  )
  if (res.exceptionDetails) return undefined
  return res.result?.value
}

/** The remote object behind a backend node id. */
export async function objectIdOf(
  page: PageSession,
  backendNodeId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await call<{ object?: { objectId?: string } }>(
    page,
    'DOM.resolveNode',
    { backendNodeId },
    signal,
  )
  return res.object?.objectId
}

/**
 * Navigate the page and wait for its load event (or `limits.navigateMs`).
 * Returns an `ERROR:` string when the browser could not load the URL.
 */
export async function gotoUrl(
  page: PageSession,
  url: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const loaded = page.cdp
    .waitFor('Page.loadEventFired', {
      sessionId: page.sessionId,
      timeoutMs: page.limits.navigateMs,
      ...(signal ? { signal } : {}),
    })
    .then(
      () => true,
      () => false,
    )
  let res: { errorText?: string; loaderId?: string }
  try {
    res = await call(page, 'Page.navigate', { url }, signal)
  } catch (error) {
    void loaded
    return `ERROR: could not open ${url} (${errorText(error)}).`
  }
  if (res.errorText) return `ERROR: could not load ${url} (${res.errorText}).`
  // A same-document navigation (a hash change) has no loader id and fires no load event.
  if (res.loaderId) await loaded
  return undefined
}
