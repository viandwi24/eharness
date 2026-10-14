/**
 * Domain rules for navigation (spec 35 §8): `allowDomains`, `denyDomains`, and the private-host
 * block shared with `web_fetch` (spec 22). Pure functions; no DNS (runtime-neutral), so a public
 * name that resolves to a private address is not caught, as for `web_fetch` without a resolver.
 */
import { isPrivateHost } from '../index.ts'

/** The rules one navigation is checked against. */
export interface DomainRules {
  /** Only these hosts (empty or absent: any public host). */
  allowDomains?: readonly string[]
  /** Never these hosts (wins over `allowDomains`). */
  denyDomains?: readonly string[]
  /** Open private, loopback and link-local hosts. */
  allowPrivateHosts?: boolean
}

function splitHostPort(value: string): [host: string, port: string] {
  const v = value.toLowerCase().trim().replace(/\.+$/, '')
  if (v.startsWith('[')) {
    const m = /^(\[[^\]]*\])(?::(\d+))?$/.exec(v)
    return [m?.[1] ?? v, m?.[2] ?? '']
  }
  const m = /^([^:]*)(?::(\d+))?$/.exec(v)
  return [m?.[1] ?? v, m?.[2] ?? '']
}

/**
 * Match a host against a pattern: `example.com` (that host only), `*.example.com` (subdomains,
 * not the apex), `*` (any), optionally with `:port`. Case-insensitive. `host` may carry a port.
 */
export function matchesHost(pattern: string, host: string): boolean {
  const [p, pPort] = splitHostPort(pattern)
  const [h, hPort] = splitHostPort(host)
  if (pPort !== '' && pPort !== hPort) return false
  if (p === '*') return true
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1
  return p === h
}

/**
 * `undefined` when `url` may be opened, else a `BLOCKED:` text for the model. Only `http(s)` pages
 * and `about:blank` can be opened; an unparsable URL is an `ERROR:`-free `BLOCKED:` too, so the
 * model sees one family of answers.
 */
export function checkUrl(url: string, rules: DomainRules): string | undefined {
  const raw = url.trim()
  if (raw === '' || raw === 'about:blank') return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return `BLOCKED: "${raw.slice(0, 80)}" is not a valid URL. Use a full http(s) address.`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `BLOCKED: only http(s) pages can be opened (got ${parsed.protocol}).`
  }
  const host = parsed.hostname.toLowerCase()
  const hostPort = parsed.port === '' ? host : `${host}:${parsed.port}`
  if (rules.denyDomains?.some((p) => matchesHost(p, hostPort) || matchesHost(p, host)) === true) {
    return `BLOCKED: ${host} is not allowed.`
  }
  const allow = rules.allowDomains ?? []
  const listed = allow.some((p) => matchesHost(p, hostPort) || matchesHost(p, host))
  if (allow.length > 0 && !listed) {
    return `BLOCKED: ${host} is not on this browser profile's list of allowed sites (${allow.join(', ')}).`
  }
  if (isPrivateHost(host)) {
    const explicit = allow.some((p) => p !== '*' && !p.startsWith('*.') && matchesHost(p, host))
    if (rules.allowPrivateHosts !== true && !explicit) {
      return `BLOCKED: ${host} is a private or local address. Ask an administrator to allow it for this profile.`
    }
  }
  return undefined
}
