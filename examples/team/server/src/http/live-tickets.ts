/**
 * One-time tickets for the browser live view WebSocket. A browser cannot send an `Authorization`
 * header on a WebSocket, so with token auth the page first asks for a ticket over the normal
 * (authenticated) API and opens the socket with `?ticket=`. A ticket is random, bound to one
 * profile, valid for a minute and used once; the token itself never appears in a URL or a log.
 */
const TTL_MS = 60_000
const tickets = new Map<string, { profileId: string; expiresAt: number }>()

function prune(now: number): void {
  for (const [t, v] of tickets) if (v.expiresAt <= now) tickets.delete(t)
}

/** A new ticket for `profileId`. */
export function issueLiveTicket(
  profileId: string,
  now: number = Date.now(),
): { ticket: string; expiresAt: number } {
  prune(now)
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const ticket = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const expiresAt = now + TTL_MS
  tickets.set(ticket, { profileId, expiresAt })
  return { ticket, expiresAt }
}

/** Use a ticket for `profileId` (once). True when it was valid. */
export function takeLiveTicket(
  ticket: string | undefined,
  profileId: string,
  now: number = Date.now(),
): boolean {
  if (ticket === undefined || ticket === '') return false
  const found = tickets.get(ticket)
  tickets.delete(ticket)
  return found !== undefined && found.profileId === profileId && found.expiresAt > now
}

/** The profile id of a live view path (`/browser/profiles/<id>/live`), else undefined. */
export function liveProfileOf(path: string): string | undefined {
  return /^\/browser\/profiles\/([^/]+)\/live$/.exec(path)?.[1]
}
