import type { TurnCtx } from './ctx.ts'

export async function heartbeat(t: TurnCtx): Promise<void> {
  // a slow state store must not stack ticks (each would queue another write and abort poll)
  if (t.heartbeatInFlight) return
  t.heartbeatInFlight = true
  try {
    await heartbeatOnce(t)
  } finally {
    t.heartbeatInFlight = false
  }
}

export async function heartbeatOnce(t: TurnCtx): Promise<void> {
  await t.abortPoll?.poll()
  if (!t.recovery || !t.committed || t.assistantId === undefined) return
  if (Date.now() - t.rt.state.lastWriteAt < t.staleMs / 4) return
  const active = t.rt.state.core().activeTurn
  if (active?.turnId !== t.turnId) return
  active.heartbeatAt = Date.now()
  t.rt.state.markDirty()
  try {
    await t.rt.state.write()
  } catch (error) {
    t.rt.log.warn('eharness: heartbeat state write failed', { error })
  }
}
