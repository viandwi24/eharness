/**
 * `eharness/web/node`: a ready DNS resolver for `webFetch({ resolveHost })`. Node-only (ADR-0036):
 * it imports `node:dns`.
 *
 * It closes the "public name that points at a private address" hole, not DNS rebinding between
 * the check and the connection (see docs/guides/web.md for the pinned-IP fetch recipe).
 *
 * **Draft:** every symbol of this subpath is experimental and may change in a minor release
 * (docs/engineering/api-stability.md).
 *
 * @experimental
 * @see docs/specs/22-web-plugin.md
 */
import { lookup } from 'node:dns/promises'

/**
 * Resolve a host name to all of its IPv4/IPv6 addresses with `dns.lookup(host, { all: true })`
 * (the resolver the OS uses, so `/etc/hosts` and search domains apply). IP literals resolve to
 * themselves. Rejects when the name does not resolve (`webFetch` then lets the fetch report it).
 *
 * @example
 * ```ts
 * webFetch({ resolveHost: nodeResolveHost })
 * ```
 */
export async function nodeResolveHost(host: string): Promise<string[]> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  const records = await lookup(bare, { all: true, verbatim: true })
  return records.map((r) => r.address)
}
