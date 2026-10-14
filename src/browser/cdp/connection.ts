/**
 * The CDP implementation of the operation-level connection (spec 35 §4): one WebSocket, the
 * browser target, flattened sessions per tab, and the operations of this folder composed into
 * `navigate`, `snapshot`, `act`, `screenshot`, `read`, `tabs` and `live`.
 */
import { act } from './act.ts'
import {
  type CdpClient,
  type CdpConnectionOptions,
  type CdpEndpoint,
  cdpConnection,
} from './client.ts'
import { startLive } from './live.ts'
import { call, errorText, gotoUrl, pageInfo, settle } from './page.ts'
import { readPage } from './read.ts'
import { type ShotOptions, takeScreenshot } from './shot.ts'
import { takeSnapshot } from './snapshot.ts'
import { createTabSet } from './tabs.ts'
import {
  type ActInput,
  type ActResult,
  type CdpLimits,
  DEFAULT_CDP_LIMITS,
  type LiveFeed,
  type PageInfo,
  type Shot,
  type Snapshot,
  type TabInfo,
} from './types.ts'

/** What the engine behind the connection can do (a subset of `BrowserCapabilities`). */
export interface CdpCapabilities {
  snapshot: boolean
  screenshot: boolean
  liveView: 'screencast' | 'poll'
  takeover: boolean
  tabs: boolean
}

/** Options of {@link cdpBrowserConnection}. */
export interface CdpBrowserOptions {
  limits?: Partial<CdpLimits>
  /** Default: Chrome (`screencast`, tabs, JPEG). Lightpanda: `{ liveView: 'poll', tabs: false }`. */
  capabilities?: Partial<CdpCapabilities>
  /** Screenshot and poll frame format. Default `jpeg`; `png` for engines without JPEG. */
  imageFormat?: 'jpeg' | 'png'
  /** Options of the underlying {@link cdpConnection}. */
  cdp?: CdpConnectionOptions
}

/** The operation-level connection over CDP. Expected failures are strings or `error` fields. */
export interface CdpBrowserConnection {
  readonly capabilities: CdpCapabilities
  readonly client: CdpClient
  navigate(
    input: { url?: string; action?: 'back' | 'forward' | 'reload' },
    signal?: AbortSignal,
  ): Promise<PageInfo & { error?: string }>
  snapshot(
    input: { scope?: string; interactive?: boolean; offset?: number },
    signal?: AbortSignal,
  ): Promise<Snapshot | string>
  act(input: ActInput, signal?: AbortSignal): Promise<ActResult>
  screenshot(
    input: { fullPage?: boolean; ref?: string; maxWidth?: number },
    signal?: AbortSignal,
  ): Promise<Shot | string>
  read(
    input: { offset?: number; maxChars?: number },
    signal?: AbortSignal,
  ): Promise<{ text: string; page: PageInfo; nextOffset?: number } | string>
  tabs(
    input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string },
    signal?: AbortSignal,
  ): Promise<TabInfo[] | string>
  /** URL and title of the current page (cheap: no snapshot, no text extraction). */
  page(signal?: AbortSignal): Promise<PageInfo>
  /** Run a script in the current page (`browser_eval`); the result as text, or an `ERROR:` text. */
  evalScript(expression: string, signal?: AbortSignal): Promise<string>
  /** Start a live feed of the current tab (the manager adds controller rules). */
  live(): Promise<LiveFeed>
  /** Forget every ref (a person handed the browser back; the page may have changed). */
  clearRefs(): void
  close(): Promise<void>
}

const DEFAULT_CAPABILITIES: CdpCapabilities = {
  snapshot: true,
  screenshot: true,
  liveView: 'screencast',
  takeover: true,
  tabs: true,
}

/** Open the browser at `endpoint` and wrap it as a {@link CdpBrowserConnection}. */
export async function cdpBrowserConnection(
  endpoint: CdpEndpoint,
  options: CdpBrowserOptions = {},
): Promise<CdpBrowserConnection> {
  const limits = { ...DEFAULT_CDP_LIMITS, ...options.limits }
  const client = await cdpConnection(endpoint, { timeoutMs: limits.timeoutMs, ...options.cdp })
  return wrapCdpClient(client, options)
}

/** Wrap an open client (used by tests and by adapters that open the socket themselves). */
export function wrapCdpClient(
  client: CdpClient,
  options: CdpBrowserOptions = {},
): CdpBrowserConnection {
  const limits: CdpLimits = { ...DEFAULT_CDP_LIMITS, ...options.limits }
  const capabilities: CdpCapabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities }
  const format = options.imageFormat ?? 'jpeg'
  const tabs = createTabSet(client, limits)

  /** Turn a lost connection or a failed command into `ERROR:` text. */
  const guard = async <T>(
    run: () => Promise<T>,
    onError: (text: string) => T,
    signal?: AbortSignal,
  ): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof Error && error.name === 'HarnessError') throw error
      return onError(signal?.aborted ? 'ERROR: aborted.' : `ERROR: ${errorText(error)}`)
    }
  }

  return {
    capabilities,
    client,
    navigate: (input, signal) =>
      guard(
        async () => {
          const page = await tabs.current()
          let error: string | undefined
          if (input.url) error = await gotoUrl(page, input.url, signal)
          else if (input.action === 'reload') {
            const loaded = client
              .waitFor('Page.loadEventFired', {
                sessionId: page.sessionId,
                timeoutMs: limits.navigateMs,
              })
              .catch(() => undefined)
            await call(page, 'Page.reload', undefined, signal)
            await loaded
          } else if (input.action === 'back' || input.action === 'forward') {
            const hist = await call<{
              currentIndex?: number
              entries?: Array<{ id: number }>
            }>(page, 'Page.getNavigationHistory', undefined, signal)
            const entry =
              hist.entries?.[(hist.currentIndex ?? 0) + (input.action === 'back' ? -1 : 1)]
            if (!entry) error = `ERROR: there is no page to go ${input.action} to.`
            else {
              const loaded = client
                .waitFor('Page.loadEventFired', {
                  sessionId: page.sessionId,
                  timeoutMs: limits.navigateMs,
                })
                .catch(() => undefined)
              await call(page, 'Page.navigateToHistoryEntry', { entryId: entry.id }, signal)
              await loaded
            }
          } else error = 'ERROR: browser_open needs a url or an action (back, forward, reload).'
          if (!error) await settle(page, signal)
          const info = await pageInfo(page, signal).catch(() => ({ url: '', title: '' }))
          return error ? { ...info, error } : info
        },
        (text) => ({ url: '', title: '', error: text }),
        signal,
      ),
    snapshot: (input, signal) =>
      guard(
        async () => takeSnapshot(await tabs.current(), input, signal),
        (t) => t,
        signal,
      ),
    act: (input, signal) =>
      guard(
        async () => act(await tabs.current(), input, signal),
        (text) => ({
          page: { url: '', title: '' },
          navigated: false,
          changed: false,
          summary: text,
          error: text,
        }),
        signal,
      ),
    screenshot: (input, signal) =>
      guard(
        async () => {
          const opts: ShotOptions = { format }
          if (input.fullPage !== undefined) opts.fullPage = input.fullPage
          if (input.ref !== undefined) opts.ref = input.ref
          if (input.maxWidth !== undefined) opts.maxWidth = input.maxWidth
          return takeScreenshot(await tabs.current(), opts, signal)
        },
        (t) => t,
        signal,
      ),
    read: (input, signal) =>
      guard(
        async () => readPage(await tabs.current(), input, signal),
        (t) => t,
        signal,
      ),
    tabs: (input, signal) =>
      guard(
        () => tabs.tabs(input, signal),
        (t) => t,
        signal,
      ),
    page: async (signal) => {
      try {
        return await pageInfo(await tabs.current(), signal)
      } catch {
        return { url: '', title: '' }
      }
    },
    evalScript: (expression, signal) =>
      guard(
        async () => {
          const page = await tabs.current()
          const res = await call<{
            result?: { value?: unknown; description?: string }
            exceptionDetails?: { text?: string; exception?: { description?: string } }
          }>(
            page,
            'Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true },
            signal,
          )
          if (res.exceptionDetails) {
            const d = res.exceptionDetails
            return `ERROR: the script threw: ${d.exception?.description ?? d.text ?? 'unknown error'}`
          }
          const value = res.result?.value
          const text =
            value === undefined
              ? (res.result?.description ?? 'undefined')
              : typeof value === 'string'
                ? value
                : JSON.stringify(value)
          return text.length > 10_000 ? `${text.slice(0, 10_000)}\n… truncated` : text
        },
        (t) => t,
        signal,
      ),
    live: async () => {
      const page = await tabs.current()
      return startLive(page, {
        mode: capabilities.liveView,
        format,
        currentPage: () => tabs.peek(),
      })
    },
    clearRefs: () => tabs.clearRefs(),
    async close() {
      tabs.dispose()
      await client.close()
    },
  }
}
