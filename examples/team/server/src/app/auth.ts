/**
 * Bearer token check. `TEAM_TOKEN` unset means open access: the server then binds to loopback
 * only (see `listenConfig`), so only local processes can reach it.
 */
export function checkBearer(expected: string | undefined, header: string | undefined): boolean {
  if (expected === undefined || expected === '') return true
  if (header === undefined) return false
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const given = match?.[1] ?? ''
  // constant-time compare over the longer of both strings: no early return on length
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  const n = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Hostname part of a `Host` header value (port stripped, lower-cased, IPv6 brackets kept). */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.indexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

/** True for loopback names and addresses (`localhost`, `127.x`, `::1`). */
export function isLoopbackHost(host: string): boolean {
  const name = hostnameOf(host)
  return LOOPBACK_HOSTS.has(name) || name.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(name)
}

/**
 * Host header allow-list (blocks DNS rebinding: a page on `attacker.com` whose A record flips to
 * 127.0.0.1 still sends `Host: attacker.com`). Loopback names are always allowed, plus the
 * configured public host names (`TEAM_ALLOWED_HOSTS`, `TEAM_HOST`, the host of `TEAM_PUBLIC_URL`).
 */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  if (hostHeader === undefined || hostHeader === '') return false
  if (isLoopbackHost(hostHeader)) return true
  const name = hostnameOf(hostHeader)
  return allowed.some((a) => hostnameOf(a) === name)
}

export interface ListenConfig {
  hostname: string
  allowedHosts: string[]
}

/**
 * Where the server listens. Without a token only loopback is allowed: binding elsewhere without
 * `TEAM_TOKEN` throws (the caller prints it and exits). Default bind is `127.0.0.1`.
 */
export function listenConfig(
  env: Record<string, string | undefined> & {
    TEAM_HOST?: string | undefined
    TEAM_TOKEN?: string | undefined
    TEAM_ALLOWED_HOSTS?: string | undefined
    TEAM_PUBLIC_URL?: string | undefined
  },
): ListenConfig {
  const hostname = env.TEAM_HOST?.trim() || '127.0.0.1'
  const hasToken = env.TEAM_TOKEN !== undefined && env.TEAM_TOKEN !== ''
  if (!hasToken && !isLoopbackHost(hostname)) {
    throw new Error(
      `TEAM_HOST=${hostname} is not a loopback address and TEAM_TOKEN is not set: refusing to start an open server on the network. Set TEAM_TOKEN, or bind to 127.0.0.1.`,
    )
  }
  const allowedHosts = (env.TEAM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (!isLoopbackHost(hostname) && hostname !== '0.0.0.0' && hostname !== '::') {
    allowedHosts.push(hostname)
  }
  if (env.TEAM_PUBLIC_URL) {
    try {
      allowedHosts.push(new URL(env.TEAM_PUBLIC_URL).host)
    } catch {
      // ignored: an invalid public url fails elsewhere
    }
  }
  return { hostname, allowedHosts }
}
