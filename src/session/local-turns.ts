/**
 * Turns running in this process, by turn id (internal). A stable `recovery.instanceId` makes every
 * agent object of the process share one owner id, so "owned by this instance" alone cannot tell a
 * turn left by a previous process from a turn another agent object (a rebuilt agent, a second
 * handle) is running right now: this registry can.
 */
export const localTurns: Map<string, object> = new Map()

/** A turn another handle of this process runs (same owner id, different runtime). */
export function runsElsewhereHere(active: { turnId: string }, self: object): boolean {
  const owner = localTurns.get(active.turnId)
  return owner !== undefined && owner !== self
}
