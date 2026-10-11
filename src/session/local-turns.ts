/**
 * Turns running in this process, by turn id (internal). A stable `recovery.instanceId` makes every
 * agent object of the process share one owner id, so "owned by this instance" alone cannot tell a
 * turn left by a previous process from a turn another agent object (a rebuilt agent, a second
 * handle) is running right now: this registry can (spec 05 §9.2). It is process-wide on purpose:
 * sibling agent objects must see each other's turns. The map is private to this module and holds
 * the runtimes weakly, so a turn that hangs forever cannot pin its session in memory.
 */
/** Owner id (the stable instance id) -> turn id -> runtime. Different instance ids never see each other. */
const running = new Map<string, Map<string, WeakRef<object>>>()

/** Record `rt` as the runtime that runs `turnId`. */
export function registerLocalTurn(rt: { owner: string }, turnId: string): void {
  const turns = running.get(rt.owner) ?? new Map<string, WeakRef<object>>()
  running.set(rt.owner, turns)
  turns.set(turnId, new WeakRef(rt))
}

/** The turn ended (or never started to run here). */
export function unregisterLocalTurn(rt: { owner: string }, turnId: string): void {
  const turns = running.get(rt.owner)
  turns?.delete(turnId)
  if (turns?.size === 0) running.delete(rt.owner)
}

/** A turn another handle of this process runs (same owner id, different runtime). */
export function runsElsewhereHere(rt: object, active: { owner: string; turnId: string }): boolean {
  const owner = running.get(active.owner)?.get(active.turnId)?.deref()
  return owner !== undefined && owner !== rt
}

/**
 * An `activeTurn` this instance id owns but nothing in this process runs: left by a previous
 * process (stable `recovery.instanceId`), so nothing will ever write to it. The one check behind
 * recovery, takeover and "is this turn stale".
 */
export function isOwnLeftover(
  rt: { owner: string },
  active: { owner: string; turnId: string },
): boolean {
  return active.owner === rt.owner && !runsElsewhereHere(rt, active)
}
