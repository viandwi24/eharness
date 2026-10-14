/**
 * `lightpandaAdapter()`: Lightpanda over CDP (spec 35 §2.1). Its rendering fidelity is lower than
 * Chrome's, screenshots are PNG only and it has no screencast, so the live view is polled.
 */
import { z } from 'zod/v4'
import { type BrowserAdapter, defineBrowserAdapter } from '../adapter.ts'
import type { BrowserRuntime } from '../runtime.ts'
import { cdpUrlField, cdpVersion, connectCdp } from './cdp.ts'

/** Manual mode: connect to a Lightpanda someone else runs. */
const lightpandaManualSettings = z.object({ cdpUrl: cdpUrlField })

/** Managed mode: no options yet (the runtime starts `lightpanda serve` on loopback). */
const lightpandaManagedSettings = z.object({})

/** Options of {@link lightpandaAdapter}. */
export interface LightpandaAdapterOptions {
  /** Offers managed mode: `lightpandaRuntime({ root })` from `eharness/browser/node`, or a remote runtime. */
  managed?: BrowserRuntime
}

/** The Lightpanda adapter. */
export function lightpandaAdapter(options: LightpandaAdapterOptions = {}): BrowserAdapter {
  return defineBrowserAdapter({
    id: 'lightpanda',
    label: 'Lightpanda',
    description:
      'A small, fast headless browser for pages that need little rendering. Lower fidelity than Chrome.',
    manual: {
      settings: lightpandaManualSettings,
      endpoint: (s) => ({ protocol: 'cdp', url: s.cdpUrl }),
    },
    ...(options.managed === undefined
      ? {}
      : { managed: { settings: lightpandaManagedSettings, runtime: options.managed } }),
    capabilities: {
      snapshot: true,
      screenshot: true,
      liveView: 'poll',
      takeover: true,
      tabs: false,
      persistentProfile: false,
    },
    connect: (endpoint, ctx) =>
      connectCdp(endpoint, ctx, {
        capabilities: { liveView: 'poll', tabs: false },
        imageFormat: 'png',
      }),
    test: async (endpoint, ctx) => ({ version: await cdpVersion(endpoint, ctx) }),
  })
}
