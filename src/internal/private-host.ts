/**
 * Private-network host check shared by the shipped plugins (web_fetch, OAuth discovery): true for
 * loopback, private, link-local, unspecified, multicast, reserved and local names. Pure string
 * checks, no DNS.
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  const [a, b, c] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Expand an IPv6 literal (no brackets, no zone) to 8 groups; `undefined` when malformed. */
function expandIPv6(name: string): number[] | undefined {
  let text = name
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail?.[1] !== undefined && tail[2] !== undefined) {
    const o = tail[2].split('.').map(Number)
    if (o.some((n) => n > 255)) return undefined
    text = `${tail[1]}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] | undefined => {
    if (part === '') return []
    const groups = part
      .split(':')
      .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : -1))
    return groups.includes(-1) ? undefined : groups
  }
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (head === undefined || rest === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const fill = 8 - head.length - rest.length
  if (fill < 1) return undefined
  return [...head, ...new Array<number>(fill).fill(0), ...rest]
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

function isPrivateIPv6(name: string): boolean {
  const g = expandIPv6(name.split('%')[0] ?? name)
  if (g === undefined) return true // malformed: refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g7 === 1) return true // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0))
    return isPrivateIPv4(v4Of(g6, g7))
  // NAT64 64:ff9b::/96 (embedded IPv4) and the local-use 64:ff9b:1::/48
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPrivateIPv4(v4Of(g6, g7))
  }
  // 6to4 2002::/16 embeds the IPv4 in bits 16..47
  if (g0 === 0x2002) return isPrivateIPv4(v4Of(g1, g2))
  // Teredo 2001::/32 hides the server and the (xor-ed) client IPv4: refuse
  if (g0 === 0x2001 && g1 === 0) return true
  // documentation 2001:db8::/32
  if (g0 === 0x2001 && g1 === 0xdb8) return true
  // unique local fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
  return (
    (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || g0 >= 0xff00
  )
}

/** True for loopback, private, link-local, unspecified and multicast addresses and local names. */
export function isPrivateHost(host: string): boolean {
  // a fully-qualified trailing dot (`localhost.`) names the same host
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '')
  if (name === '') return true
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local')) return true
  if (IPV4.test(name)) return isPrivateIPv4(name)
  if (name.includes(':')) return isPrivateIPv6(name)
  // single-label names and internal suffixes only resolve inside a private network
  return !name.includes('.') || name.endsWith('.internal') || name.endsWith('.lan')
}
