/**
 * Executable options of the supervisor's questions (docs/plans/P53-supervisor-and-consistency.md):
 * when the beat knows the action, the question carries it as a structured `action` (never free
 * text), the server checks it is possible now, and the answer carries it out like an answer about
 * a standing order does. The outcome is recorded on the decision.
 *
 *   retry-run:<task>            continue a failed run of the agent
 *   pause-routine:<routine>     pause a routine of the agent
 *   remove:<order>              remove a standing order (the existing command)
 *   propose-tool:<program>:<tool>  create the change card that adds a tool to a program
 *   fix-finding:<fingerprint>   the one-click fix of a consistency finding
 */
import { EMPTY_SUPERVISOR_STATE } from '../domain/supervisor.ts'
import { consistencyFindings } from './consistency.ts'
import { fixFinding, planFix } from './consistency-fix.ts'
import { proposeFromAgent } from './decisions.ts'
import type { Deps } from './ports.ts'
import { pauseRoutine } from './routines.ts'
import { listOrders } from './standing-orders.ts'
import { retryTask } from './tasks.ts'

export const ACTION_KINDS = [
  'retry-run',
  'pause-routine',
  'remove-order',
  'propose-program-tool',
  'fix-finding',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface OwnerAction {
  kind: ActionKind
  /** A task, routine, order, program id, or a finding fingerprint (`fix-finding`). */
  target: string
  /** `propose-program-tool`: the tool to add to the program. */
  tool?: string | undefined
}

export const ACTION_LEAVE = 'Leave it'
const RETRYABLE = ['failed', 'interrupted', 'timed_out', 'stopped']
const clip = (t: string, n = 60): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const FINDING_PREFIX = 'supervisor:consistency:'

/** The buttons of a question: the action and a way out. `error`: a readable reason for the beat. */
export async function offerAction(
  deps: Deps,
  agentId: string,
  a: OwnerAction,
): Promise<{ label: string; command: string } | { error: string }> {
  const target = a.target.trim()
  switch (a.kind) {
    case 'retry-run': {
      const t = deps.tasks.get(target)
      if (t === undefined || t.agentId !== agentId)
        return { error: `there is no run ${target} of yours` }
      if (!RETRYABLE.includes(t.status))
        return {
          error: `the run is ${t.status}; only a run that stopped without finishing can be retried`,
        }
      return { label: `Retry "${clip(t.title, 40)}"`, command: `retry-run:${t.id}` }
    }
    case 'pause-routine': {
      const r = deps.routines.get(target)
      if (r === undefined || r.agentId !== agentId)
        return { error: `there is no routine ${target} of yours` }
      if (r.status !== 'active') return { error: `the routine is ${r.status}, not active` }
      return { label: `Pause "${clip(r.name, 40)}"`, command: `pause-routine:${r.id}` }
    }
    case 'remove-order': {
      const o = (await listOrders(deps, agentId)).find((x) => x.id === target)
      if (o === undefined) return { error: `there is no standing order ${target} of yours` }
      return { label: `Remove order ${o.id}`, command: `remove:${o.id}` }
    }
    case 'propose-program-tool': {
      const tool = (a.tool ?? '').trim()
      const p = deps.programs.get(target)
      if (p === undefined || p.agentId !== agentId)
        return { error: `there is no program ${target} of yours` }
      if (tool === '' || /\s/.test(tool) || tool.length > 100)
        return { error: 'name the tool to add (one word, as listed)' }
      if (p.authority.tools.includes(tool)) return { error: `the program already grants ${tool}` }
      return {
        label: `Propose adding ${tool} to "${clip(p.name, 40)}"`,
        command: `propose-tool:${p.id}:${tool}`,
      }
    }
    case 'fix-finding': {
      const fp = target.startsWith(FINDING_PREFIX) ? target.slice(FINDING_PREFIX.length) : target
      const found = (await consistencyFindings(deps, { agentId, now: deps.clock.now() })).find(
        (f) => f.fingerprint === fp,
      )
      if (found === undefined) return { error: 'that finding is not open now' }
      const plan = planFix(deps, found)
      if (plan === undefined)
        return { error: 'that finding has no one-click fix: ask with a text fix' }
      return { label: plan.label, command: `fix-finding:${fp}` }
    }
  }
}

/**
 * The answer picked an executable option. undefined: not a command of this module. Throws are the
 * caller's: `applyOrderAnswer` turns them into the effect text.
 */
export async function runAnswerAction(
  deps: Deps,
  d: { agentId: string },
  verb: string,
  arg: string,
): Promise<string | undefined> {
  switch (verb) {
    case 'retry-run': {
      const t = deps.tasks.get(arg)
      if (t === undefined) return `Nothing to retry: run ${arg} is gone.`
      if (!RETRYABLE.includes(t.status)) return `Nothing to retry: the run is ${t.status} now.`
      await retryTask(deps, arg)
      const now = deps.clock.now()
      // the beat must not retry the same run again
      deps.heartbeat.store.updateState(
        d.agentId,
        (s) => {
          const cur = s.supervisor ?? EMPTY_SUPERVISOR_STATE
          return {
            ...s,
            supervisor: { ...cur, retries: [...cur.retries, { taskId: arg, at: now }] },
          }
        },
        now,
      )
      return `Retried "${clip(t.title)}": it continues from where it stopped.`
    }
    case 'pause-routine': {
      const r = deps.routines.get(arg)
      if (r === undefined) return `Nothing to pause: routine ${arg} is gone.`
      if (r.status !== 'active') return `Nothing to pause: the routine is ${r.status}.`
      pauseRoutine(deps, arg)
      return `Paused routine "${clip(r.name)}": it fires no more until it is resumed.`
    }
    case 'propose-tool': {
      const i = arg.indexOf(':')
      const programId = arg.slice(0, i)
      const tool = arg.slice(i + 1)
      const p = deps.programs.get(programId)
      if (i < 0 || p === undefined) return `Nothing to propose: program ${programId} is gone.`
      const out = proposeFromAgent(deps, {
        agentId: d.agentId,
        sessionId: null,
        title: `Change to program ${p.name}`,
        program: {},
        runOnce: false,
        target: p.id,
        addAuthority: { tools: [tool] },
      })
      return out.duplicate
        ? `A change card that does this is already open (${out.decision.id}).`
        : `Created the change card "${out.decision.title}" (${out.decision.id}) in the Decision Center: approve it there to grant ${tool}.`
    }
    case 'fix-finding': {
      return (await fixFinding(deps, arg)).outcome
    }
    default:
      return undefined
  }
}
