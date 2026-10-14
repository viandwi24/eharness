/**
 * `chromeAdapter()`: Chrome, Chromium, Edge and any CDP service (Browserbase, Kernel, Steel,
 * Anchor, Browserless, a self-hosted container). Spec 35 §2.1.
 */
import { z } from 'zod/v4'
import { ehMeta } from '../../providers/index.ts'
import { type BrowserAdapter, defineBrowserAdapter } from '../adapter.ts'
import type { BrowserRuntime } from '../runtime.ts'
import { cdpUrlField, cdpVersion, connectCdp } from './cdp.ts'

/** Manual mode: connect to a browser someone else runs. */
const chromeManualSettings = z.object({
  cdpUrl: cdpUrlField,
  headers: z
    .record(z.string(), z.string())
    .optional()
    .meta({
      title: 'Headers',
      description: 'Extra headers for the connection, for example an Authorization token.',
      ...ehMeta({ secretValues: true, widget: 'keyvalue', group: 'auth' }),
    }),
  liveUrl: z
    .string()
    .url()
    .optional()
    .meta({
      title: 'Live view URL',
      description: "The provider's own live view page, shown next to the agent's work.",
      ...ehMeta({ endpoint: false, group: 'advanced' }),
    }),
})

/** Managed mode: the app downloads and starts Chrome. */
const chromeManagedSettings = z.object({
  headless: z
    .boolean()
    .optional()
    .meta({
      title: 'Headless',
      description: "Run without a window. Empty: the server's default.",
      ...ehMeta({ group: 'advanced' }),
    }),
  windowSize: z
    .string()
    .regex(/^\d{3,5}x\d{3,5}$/, 'use WIDTHxHEIGHT, for example 1280x800')
    .default('1280x800')
    .meta({ title: 'Window size', ...ehMeta({ group: 'advanced', placeholder: '1280x800' }) }),
  proxy: z
    .string()
    .optional()
    .meta({
      title: 'Proxy',
      description: 'Proxy server, for example http://host:3128.',
      ...ehMeta({ group: 'advanced', endpoint: false }),
    }),
  locale: z
    .string()
    .regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/, 'use a locale such as en-US')
    .optional()
    .meta({ title: 'Locale', ...ehMeta({ group: 'advanced', placeholder: 'en-US' }) }),
  extraArgs: z
    .array(z.string())
    .optional()
    .meta({
      title: 'Extra Chrome flags',
      description: 'Advanced. Flags that move or expose the debugging port are refused.',
      ...ehMeta({ group: 'advanced' }),
    }),
})

/** Options of {@link chromeAdapter}. */
export interface ChromeAdapterOptions {
  /** Offers managed mode: `chromeRuntime({ root })` from `eharness/browser/node`, or a remote runtime. */
  managed?: BrowserRuntime
}

/**
 * The Chrome adapter. Manual mode needs no runtime; pass `managed` to offer "run it on this
 * server". Capabilities: snapshot, screenshot, screencast live view, takeover and tabs; the engine
 * keeps its login across leases in managed mode only.
 *
 * @example
 * ```ts
 * const registry = createBrowserRegistry([chromeAdapter({ managed: chromeRuntime({ root }) })])
 * ```
 */
export function chromeAdapter(options: ChromeAdapterOptions = {}): BrowserAdapter {
  return defineBrowserAdapter({
    id: 'chrome',
    label: 'Chrome',
    description: 'Chrome, Chromium or any hosted browser that speaks the DevTools protocol.',
    manual: {
      settings: chromeManualSettings,
      endpoint: (s) => ({
        protocol: 'cdp',
        url: s.cdpUrl,
        ...(s.headers === undefined ? {} : { headers: s.headers }),
        ...(s.liveUrl === undefined ? {} : { liveUrl: s.liveUrl }),
      }),
    },
    ...(options.managed === undefined
      ? {}
      : {
          managed: {
            settings: chromeManagedSettings,
            runtime: options.managed,
            runtimeSettings: (s: z.infer<typeof chromeManagedSettings>) => {
              const args: string[] = []
              const size = /^(\d+)x(\d+)$/.exec(s.windowSize)
              if (size) args.push(`--window-size=${size[1]},${size[2]}`)
              if (s.proxy !== undefined && s.proxy !== '') args.push(`--proxy-server=${s.proxy}`)
              if (s.locale !== undefined && s.locale !== '') args.push(`--lang=${s.locale}`)
              args.push(...(s.extraArgs ?? []))
              return {
                ...(s.headless === undefined ? {} : { headless: s.headless }),
                extraArgs: args,
              }
            },
          },
        }),
    capabilities: (mode) => ({
      snapshot: true,
      screenshot: true,
      liveView: 'screencast',
      takeover: true,
      tabs: true,
      persistentProfile: mode === 'managed',
    }),
    connect: (endpoint, ctx) => connectCdp(endpoint, ctx),
    test: async (endpoint, ctx) => ({ version: await cdpVersion(endpoint, ctx) }),
  })
}
