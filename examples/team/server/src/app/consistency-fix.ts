/**
 * One-click fixes of consistency findings (docs/plans/P53-supervisor-and-consistency.md): only where
 * the fix is unambiguous. The plan is derived from the live state on every call (a finding of the
 * cache is never trusted), and `fixFinding` re-scans, re-plans and runs the plan, so a stale card
 * can only do what is still true. Everything else keeps its text fix.
 *
 *  - program-needs-tool, granted and forbidden: take the tools out of Forbidden;
 *  - program-duplicate: delete the copy that has no runs (both none: the identical newer one);
 *  - order-duplicates-note: remove the standing order that says what a program note says;
 *  - routine-duplicate: delete the copy that never fired (both never: the identical newer one).
 */

import type { ConsistencyFinding } from '../domain/consistency.ts'
import { conflict, notFound } from '../domain/errors.ts'
import { grantedAndForbidden } from '../domain/programs.ts'
import { consistencyFindings } from './consistency.ts'
import { forgetConsistency } from './consistency-cache.ts'
import type { Deps } from './ports.ts'
import { deleteProgram, updateProgram } from './programs.ts'
import { deleteRoutine } from './routines.ts'
import { removeOrder } from './standing-orders.ts'

export type FixKind = 'unforbid' | 'delete-program' | 'remove-order' | 'delete-routine'

/** What a card shows: the button and the sentence the confirmation says. */
export interface FixOffer {
  kind: FixKind
  label: string
  confirm: string
}

export interface FixPlan extends FixOffer {
  run(): Promise<string>
}

const clip = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()

/** Which of two copies goes: the only one with no history, else the newer of two identical ones. */
function duplicateToDelete<T extends { id: string; createdAt: number }>(
  pair: readonly [T, T],
  used: (x: T) => boolean,
  identical: boolean,
): T | undefined {
  const [a, b] = pair
  if (used(a) && used(b)) return undefined
  if (!used(a) && used(b)) return a
  if (used(a) && !used(b)) return b
  return identical ? (a.createdAt >= b.createdAt ? a : b) : undefined
}

export function planFix(deps: Deps, c: ConsistencyFinding): FixPlan | undefined {
  switch (c.kind) {
    case 'program-needs-tool': {
      if (!c.fingerprint.includes(':forbidden:')) return undefined
      const p = deps.programs.get(c.refs[0] ?? '')
      if (p === undefined) return undefined
      const both = grantedAndForbidden(p.authority, p.forbidden)
      if (both.length === 0) return undefined
      return {
        kind: 'unforbid',
        label: 'Allow the tools',
        confirm: `Take ${both.join(', ')} out of Forbidden on the program "${clip(p.name)}", so its runs get what its authority grants?`,
        run: async () => {
          updateProgram(deps, p.id, {
            forbidden: p.forbidden.filter((f) => !both.includes(f.trim())),
          })
          return `Took ${both.join(', ')} out of Forbidden on "${clip(p.name)}".`
        },
      }
    }
    case 'program-duplicate': {
      const a = deps.programs.get(c.refs[0] ?? '')
      const b = deps.programs.get(c.refs[1] ?? '')
      if (a === undefined || b === undefined) return undefined
      const hasRuns = (p: { id: string }): boolean =>
        deps.tasks.ofProgram(p.id, 1).length > 0 ||
        deps.decisions.list({ status: 'open', limit: 200 }).some((d) => d.programId === p.id)
      const victim = duplicateToDelete(
        [a, b],
        hasRuns,
        norm(a.name) === norm(b.name) && norm(a.brief) === norm(b.brief),
      )
      if (victim === undefined) return undefined
      return {
        kind: 'delete-program',
        label: 'Delete the copy',
        confirm: `Delete the program "${clip(victim.name)}" (${victim.id})? It has no runs; the other copy stays. This cannot be undone.`,
        run: async () => {
          deleteProgram(deps, victim.id)
          return `Deleted the duplicate program "${clip(victim.name)}" (${victim.id}).`
        },
      }
    }
    case 'order-duplicates-note': {
      const orderId = c.refs[0]
      if (c.agentId === null || orderId === undefined) return undefined
      const agentId = c.agentId
      return {
        kind: 'remove-order',
        label: 'Remove the order',
        confirm: `Remove the standing order ${orderId} from HEARTBEAT.md? The program note that says the same stays.`,
        run: async () => {
          const gone = await removeOrder(deps, agentId, orderId)
          return gone === undefined
            ? `Nothing to remove: order ${orderId} was already gone.`
            : `Removed order ${orderId} ("${clip(gone.text)}") from HEARTBEAT.md.`
        },
      }
    }
    case 'routine-duplicate': {
      const a = deps.routines.get(c.refs[0] ?? '')
      const b = deps.routines.get(c.refs[1] ?? '')
      if (a === undefined || b === undefined) return undefined
      const victim = duplicateToDelete(
        [a, b],
        (r) => r.fireCount > 0 || deps.routines.runs(r.id, 1).length > 0,
        norm(a.prompt) === norm(b.prompt),
      )
      if (victim === undefined) return undefined
      return {
        kind: 'delete-routine',
        label: 'Delete the copy',
        confirm: `Delete the routine "${clip(victim.name)}" (${victim.id})? It never fired; the other copy stays.`,
        run: async () => {
          deleteRoutine(deps, victim.id)
          return `Deleted the duplicate routine "${clip(victim.name)}" (${victim.id}).`
        },
      }
    }
    default:
      return undefined
  }
}

export const offerOf = (plan: FixPlan | undefined): FixOffer | undefined =>
  plan === undefined ? undefined : { kind: plan.kind, label: plan.label, confirm: plan.confirm }

/** Re-scan, find the finding, and run its fix. Throws a readable error when there is none now. */
export async function fixFinding(
  deps: Deps,
  fingerprint: string,
): Promise<{ outcome: string; offer: FixOffer }> {
  const found = (await consistencyFindings(deps, { now: deps.clock.now() })).find(
    (f) => f.fingerprint === fingerprint,
  )
  if (found === undefined) throw notFound('finding', fingerprint)
  const plan = planFix(deps, found)
  if (plan === undefined) {
    throw conflict('this finding has no one-click fix: follow its text fix', 'NO_FIX')
  }
  const outcome = await plan.run()
  forgetConsistency(deps)
  return { outcome, offer: offerOf(plan) as FixOffer }
}
