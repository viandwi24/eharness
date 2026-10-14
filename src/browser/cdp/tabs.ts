/**
 * Pages and tabs: attach a flattened session to a target, track network state and dialogs, and
 * the `browser_tabs` operations (spec 35 §4).
 */
import type { CdpClient } from './client.ts'
import { call, createRefStore, errorText, gotoUrl, sleep } from './page.ts'
import type { CdpLimits, PageSession, TabInfo } from './types.ts'

const IGNORED_REQUEST_TYPES = new Set(['WebSocket', 'EventSource', 'Ping', 'Other'])

/**
 * Attach to a target and enable the domains the operations need. Unsupported `enable` calls are
 * tolerated (minimal engines do not implement all of them).
 */
export async function attachPage(
  cdp: CdpClient,
  targetId: string,
  limits: CdpLimits,
): Promise<PageSession> {
  const sessionId = await cdp.attach(targetId)
  const page: PageSession = {
    cdp,
    targetId,
    sessionId,
    refs: createRefStore(),
    limits,
    oopifs: new Set(),
    net: { inflight: new Map(), lastActivity: Date.now() },
    notes: [],
    dispose: () => {
      for (const off of offs) off()
    },
  }
  const frameTargets = new Map<string, string>() // child session id → frame id
  const own = (sid: string | undefined): boolean => sid === sessionId
  const offs = [
    cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (!own(sid)) return
      page.net.lastActivity = Date.now()
      const type = typeof p.type === 'string' ? p.type : ''
      if (!IGNORED_REQUEST_TYPES.has(type) && typeof p.requestId === 'string') {
        page.net.inflight.set(p.requestId, Date.now())
      }
    }),
    cdp.on('Network.loadingFinished', (p, sid) => {
      if (!own(sid)) return
      page.net.lastActivity = Date.now()
      if (typeof p.requestId === 'string') page.net.inflight.delete(p.requestId)
    }),
    cdp.on('Network.loadingFailed', (p, sid) => {
      if (!own(sid)) return
      page.net.lastActivity = Date.now()
      if (typeof p.requestId === 'string') page.net.inflight.delete(p.requestId)
    }),
    cdp.on('Target.attachedToTarget', (p, sid) => {
      if (!own(sid)) return
      const info = p.targetInfo as { targetId?: string; type?: string } | undefined
      if (info?.type === 'iframe' && info.targetId && typeof p.sessionId === 'string') {
        page.oopifs.add(info.targetId)
        frameTargets.set(p.sessionId, info.targetId)
      }
    }),
    cdp.on('Target.detachedFromTarget', (p, sid) => {
      if (!own(sid) || typeof p.sessionId !== 'string') return
      const frameId = frameTargets.get(p.sessionId)
      if (frameId) page.oopifs.delete(frameId)
      frameTargets.delete(p.sessionId)
    }),
    cdp.on('Page.javascriptDialogOpening', (p, sid) => {
      if (!own(sid)) return
      // An open dialog blocks the page: accept alerts and leave-page prompts, dismiss the rest.
      const type = String(p.type ?? 'alert')
      const accept = type === 'alert' || type === 'beforeunload'
      page.notes.push(
        `A ${type} dialog ("${String(p.message ?? '').slice(0, 120)}") was ${accept ? 'accepted' : 'dismissed'}.`,
      )
      void call(page, 'Page.handleJavaScriptDialog', { accept }).catch(() => {})
    }),
  ]
  for (const method of ['Page.enable', 'Network.enable', 'DOM.enable', 'Accessibility.enable']) {
    try {
      await call(page, method)
    } catch {}
  }
  try {
    await call(page, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    })
  } catch {}
  return page
}

/** The tabs of a connection: one current page, the others attached on demand. */
export interface TabSet {
  /** The current page, attaching the first tab (or opening a blank one) when needed. */
  current(): Promise<PageSession>
  /** The current page when there is one. */
  peek(): PageSession | undefined
  /** `browser_tabs`: an `ERROR:` string for a bad request. */
  tabs(
    input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string },
    signal?: AbortSignal,
  ): Promise<TabInfo[] | string>
  /** Forget every ref of every page (a person handed the browser back). */
  clearRefs(): void
  dispose(): void
}

interface TargetInfo {
  targetId: string
  type: string
  url: string
  title: string
}

/** Create the tab set of a connection. */
export function createTabSet(cdp: CdpClient, limits: CdpLimits): TabSet {
  const pages = new Map<string, PageSession>()
  const labels = new Map<string, string>()
  let counter = 0
  let cur: PageSession | undefined

  const label = (targetId: string): string => {
    const known = labels.get(targetId)
    if (known) return known
    const created = `t${++counter}`
    labels.set(targetId, created)
    return created
  }
  const forget = (targetId: string): void => {
    pages.get(targetId)?.dispose()
    pages.delete(targetId)
    if (cur?.targetId === targetId) cur = undefined
  }
  const offDestroyed = cdp.on('Target.targetDestroyed', (p) => {
    if (typeof p.targetId === 'string') forget(p.targetId)
  })

  const targets = async (): Promise<TargetInfo[]> => {
    const res = await cdp.send<{ targetInfos?: TargetInfo[] }>('Target.getTargets')
    return (res.targetInfos ?? []).filter((t) => t.type === 'page')
  }
  const pageFor = async (targetId: string): Promise<PageSession> => {
    const known = pages.get(targetId)
    if (known) return known
    const page = await attachPage(cdp, targetId, limits)
    pages.set(targetId, page)
    return page
  }
  const list = async (): Promise<TabInfo[]> =>
    (await targets()).map((t) => ({
      id: label(t.targetId),
      url: t.url,
      title: t.title,
      active: t.targetId === cur?.targetId,
    }))

  const set: TabSet = {
    async current() {
      if (cur) return cur
      const first = (await targets())[0]
      let targetId = first?.targetId
      if (!targetId) {
        const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
          url: 'about:blank',
        })
        targetId = created.targetId
      }
      label(targetId)
      cur = await pageFor(targetId)
      return cur
    },
    peek: () => cur,
    async tabs(input, signal) {
      try {
        switch (input.action) {
          case 'list':
            await set.current()
            return await list()
          case 'open': {
            const created = await cdp.send<{ targetId: string }>('Target.createTarget', {
              url: 'about:blank',
            })
            label(created.targetId)
            cur = await pageFor(created.targetId)
            await cdp.send('Target.activateTarget', { targetId: created.targetId })
            if (input.url) {
              const failed = await gotoUrl(cur, input.url, signal)
              if (failed) return failed
            }
            return await list()
          }
          case 'switch':
          case 'close': {
            if (!input.tab) return `ERROR: ${input.action} needs a tab id such as t1.`
            const targetId = [...labels].find(([, l]) => l === input.tab)?.[0]
            const open = targetId ? (await targets()).some((t) => t.targetId === targetId) : false
            if (!targetId || !open) {
              const known = (await list()).map((t) => t.id).join(', ')
              return `ERROR: unknown tab "${input.tab}". Open tabs: ${known || 'none'}.`
            }
            if (input.action === 'switch') {
              cur = await pageFor(targetId)
              await cdp.send('Target.activateTarget', { targetId })
              await sleep(0)
            } else {
              await cdp.send('Target.closeTarget', { targetId })
              forget(targetId)
            }
            return await list()
          }
        }
      } catch (error) {
        return `ERROR: ${errorText(error)}`
      }
    },
    clearRefs() {
      for (const p of pages.values()) p.refs.clear()
    },
    dispose() {
      offDestroyed()
      for (const p of pages.values()) p.dispose()
      pages.clear()
      cur = undefined
    },
  }
  return set
}
