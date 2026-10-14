/**
 * Shared glue of the CDP adapters: the settings fields every CDP engine has, and the wrapper that
 * turns a {@link CdpBrowserConnection} into a {@link BrowserConnection}.
 */
import { z } from 'zod/v4'
import { ehMeta } from '../../providers/index.ts'
import { cdpConnection } from '../cdp/client.ts'
import {
  type CdpBrowserConnection,
  type CdpBrowserOptions,
  cdpBrowserConnection,
} from '../cdp/connection.ts'
import type { BrowserConnection, BrowserEndpoint, ConnectContext } from '../types.ts'

/** The CDP URL field. A hosted service's URL carries its key, so it is a secret (ADR-0064 D10). */
export const cdpUrlField: z.ZodString = z
  .string()
  .min(1)
  .meta({
    title: 'CDP URL',
    description:
      'The browser to connect to: ws://host:port/devtools/browser/<id>, or http://host:port (the browser is looked up).',
    ...ehMeta({ secret: true, endpoint: true, placeholder: 'wss://… or http://host:9222' }),
  })

/** Wrap a CDP connection as the operation-level connection of spec 35 §4. */
export function fromCdp(connection: CdpBrowserConnection): BrowserConnection {
  const out: BrowserConnection = {
    navigate: (input, signal) => connection.navigate(input, signal),
    snapshot: (input, signal) => connection.snapshot(input, signal),
    act: (input, signal) => connection.act(input, signal),
    screenshot: (input, signal) => connection.screenshot(input, signal),
    read: (input, signal) => connection.read(input, signal),
    page: (signal) => connection.page(signal),
    live: () => connection.live(),
    clearRefs: () => connection.clearRefs(),
    onClose: (handler) => connection.client.onClose(handler),
    close: () => connection.close(),
  }
  if (connection.capabilities.tabs) {
    out.tabs = (input, signal) => connection.tabs(input, signal)
  }
  out.eval = (expression, signal) => connection.evalScript(expression, signal)
  return out
}

/** Open the browser at a CDP endpoint and wrap it. */
export async function connectCdp(
  endpoint: BrowserEndpoint,
  ctx: ConnectContext,
  options: CdpBrowserOptions = {},
): Promise<BrowserConnection> {
  const connection = await cdpBrowserConnection(
    { url: endpoint.url, ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }) },
    {
      ...options,
      limits: { ...ctx.limits, ...options.limits },
      cdp: { ...(ctx.signal === undefined ? {} : { signal: ctx.signal }), ...options.cdp },
    },
  )
  return fromCdp(connection)
}

/** Ask the browser for its version (`Browser.getVersion`), then close the socket. */
export async function cdpVersion(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<string> {
  const client = await cdpConnection(
    { url: endpoint.url, ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }) },
    {
      timeoutMs: ctx.limits.timeoutMs,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    },
  )
  try {
    const info = await client.send<{ product?: string }>('Browser.getVersion')
    return info.product ?? 'unknown'
  } finally {
    await client.close()
  }
}
