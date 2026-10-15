/**
 * A connection the model named: the connection id, or the platform / connector id ("telegram-user")
 * when the agent has exactly one connection of it. Models pass what they saw in a tool name.
 */
import type { ConnectionInfo } from './gateway.ts'

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** The agent's connections as `id (platform)` for an error text. */
export function connectionList(bound: readonly ConnectionInfo[]): string {
  return bound
    .map((c) => `${c.connectionId} (${c.platform}${c.connected ? '' : ', not connected'})`)
    .join(', ')
}

export type ConnectionRef = { ok: true; id: string } | { ok: false; text: string }

/** Resolve `ref` against the agent's own connections. */
export function resolveConnectionRef(bound: readonly ConnectionInfo[], ref: string): ConnectionRef {
  const exact = bound.find((c) => c.connectionId === ref)
  if (exact !== undefined) return { ok: true, id: exact.connectionId }
  const key = norm(ref)
  const byId = bound.filter((c) => norm(c.connectionId) === key)
  const hits = byId.length > 0 ? byId : bound.filter((c) => norm(c.platform) === key)
  if (hits.length === 1) return { ok: true, id: (hits[0] as ConnectionInfo).connectionId }
  if (hits.length > 1) {
    return {
      ok: false,
      text: `Several of your connections are "${ref}": name one by its connection id: ${connectionList(hits)}.`,
    }
  }
  return {
    ok: false,
    text:
      bound.length === 0
        ? `The connection "${ref}" is not one of yours: you have no channel connection.`
        : `The connection "${ref}" is not one of yours. Your connections (use the id): ${connectionList(bound)}.`,
  }
}
