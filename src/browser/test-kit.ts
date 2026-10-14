/**
 * Test support of the module surface: an adapter over the scripted CDP peer, a runtime that
 * records its calls, and the fixture world. Not public API.
 */
import { z } from 'zod/v4'
import type { FakeCdpPeer } from '../testing/browser-fake-peer.ts'
import { type BrowserAdapter, defineBrowserAdapter } from './adapter.ts'
import { fromCdp } from './adapters/cdp.ts'
import { cdpConnection } from './cdp/client.ts'
import { wrapCdpClient } from './cdp/connection.ts'
import { FAST_LIMITS } from './cdp/test-kit.ts'
import type { BrowserRuntime, RuntimeStatus } from './runtime.ts'
import type { BrowserCapabilities, BrowserConnection } from './types.ts'

export { FAST_LIMITS, installWorld, quad, TINY_JPEG } from './cdp/test-kit.ts'

/** Capabilities of a full Chrome. */
export const CHROME_CAPS: BrowserCapabilities = {
  snapshot: true,
  screenshot: true,
  liveView: 'screencast',
  takeover: true,
  tabs: true,
  persistentProfile: false,
}

/** Options of {@link fakeAdapter}. */
export interface FakeAdapterOptions {
  id?: string
  capabilities?: Partial<BrowserCapabilities>
  runtime?: BrowserRuntime
  /** Called with each connection opened. */
  onConnect?: (connection: BrowserConnection) => void
}

/** An adapter whose connections talk to `peer` (every lease opens a new socket on it). */
export function fakeAdapter(peer: FakeCdpPeer, options: FakeAdapterOptions = {}): BrowserAdapter {
  const settings = z.object({ cdpUrl: z.string(), token: z.string().optional() })
  return defineBrowserAdapter({
    id: options.id ?? 'fake',
    label: 'Fake',
    manual: {
      settings,
      endpoint: (s) => ({ protocol: 'cdp', url: s.cdpUrl }),
    },
    ...(options.runtime === undefined
      ? {}
      : { managed: { settings: z.object({}), runtime: options.runtime } }),
    capabilities: { ...CHROME_CAPS, ...options.capabilities },
    connect: async () => {
      // the peer is one object: a closed socket is reopened for the next lease
      if (peer.readyState === 3) {
        ;(peer as unknown as { listeners: Map<string, Set<unknown>> }).listeners.clear()
        peer.readyState = 0
      }
      const client = await cdpConnection(
        { url: 'ws://fake.test/devtools' },
        { webSocket: peer.socketFactory, timeoutMs: 2_000 },
      )
      const connection = fromCdp(wrapCdpClient(client, { limits: FAST_LIMITS }))
      options.onConnect?.(connection)
      return connection
    },
  })
}

/** A runtime that records calls and runs nothing. */
export function fakeRuntime(
  over: Partial<BrowserRuntime> & { state?: RuntimeStatus['state'] } = {},
): BrowserRuntime & { calls: string[] } {
  const calls: string[] = []
  const running = new Set<string>()
  return {
    calls,
    status: async () => ({
      state: over.state ?? (running.size > 0 ? 'running' : 'ready'),
      version: '1.0.0',
      ...(running.size > 0 ? { running: [...running] } : {}),
    }),
    install: async () => {
      calls.push('install')
    },
    start: async (profile) => {
      calls.push(`start:${profile.id}`)
      running.add(profile.id)
      return { cdpUrl: 'ws://fake.test/devtools' }
    },
    stop: async (id) => {
      calls.push(`stop:${id}`)
      running.delete(id)
    },
    usage: async (id) => (running.has(id) ? { rssBytes: 1000, cpuPercent: 5 } : null),
    ...over,
  } as BrowserRuntime & { calls: string[] }
}
