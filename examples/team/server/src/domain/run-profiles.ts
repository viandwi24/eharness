/**
 * Run profiles (docs/plans/P40-team-autonomous-operations.md, decision D1). Pure.
 *
 * Every conversation or unit of work is one eharness session. What differs is policy: who starts
 * the turn, which permission source applies, whether the session feeds memory, where its result
 * goes and which budget scopes it spends from. That policy lives in this one table, keyed by the
 * origin of a session, instead of in `if (sessionId.startsWith(...))` checks spread over the app.
 *
 * The origin comes from the session id (`originOfSession`); the id shapes are:
 *
 *   dm:<agentId>                       a person chats with an agent (the first chat thread)
 *   chat:<agentId>:<threadId>          any other chat thread of an agent (`domain/threads.ts`)
 *   dm:<leadId>:agent:<call>           a child session: work the lead handed to a role agent
 *                                      (`chat:<leadId>:<threadId>:agent:<call>` from a thread)
 *   routine:<routineId>:<slot>         a scheduled prompt (task mode)
 *   program:<programId>:<runAt>        a run of a program (a standing order, `domain/programs.ts`)
 *   heartbeat:<agentId>                the ambient monitor of an agent (P40 phase E, `domain/heartbeat.ts`)
 *   rehearsal:<programId>:<ts>         a test run of a program on sample data (P40 phase K, `domain/rehearsal.ts`)
 */
import type { TaskOrigin } from './tasks.ts'

export const RUN_ORIGINS = ['dm', 'lead', 'routine', 'program', 'heartbeat', 'rehearsal'] as const
export type RunOrigin = (typeof RUN_ORIGINS)[number]

/** Where the tool permission decisions of a session come from. */
export type PermissionSource =
  /** The session mode picked in the chat or inherited from the agent / workspace (`domain/modes.ts`). */
  | 'session-mode'
  /** The mode of the delegating session (a child of the lead). */
  | 'parent-mode'
  /** Rules derived from the program of the run (`programAuthority`), closed world, nobody to ask. */
  | 'program-authority'

/** Where the outcome of a run is shown. */
export type ResultTarget = 'chat' | 'lead' | 'task' | 'program-report' | 'none'

export interface RunProfile {
  origin: RunOrigin
  /** Who starts a turn of this session. */
  startedBy: 'person' | 'lead' | 'scheduler' | 'program' | 'heartbeat'
  permissions: PermissionSource
  /** Nobody is there to answer an approval: a request that would ask is a denial. */
  unattended: boolean
  /** Whether what happens in the session is a source for memory notes (consolidation, later). */
  feedsMemory: boolean
  resultTo: ResultTarget
  /** The task index (the board) tracks the session; the origin the row gets. */
  task: { origin: TaskOrigin } | null
  /** Extra budget scopes besides the workspace one. */
  budget: 'workspace' | 'program'
}

export const RUN_PROFILES: Record<RunOrigin, RunProfile> = {
  dm: {
    origin: 'dm',
    startedBy: 'person',
    permissions: 'session-mode',
    unattended: false,
    feedsMemory: true,
    resultTo: 'chat',
    task: null,
    budget: 'workspace',
  },
  lead: {
    origin: 'lead',
    startedBy: 'lead',
    permissions: 'parent-mode',
    unattended: false,
    feedsMemory: true,
    resultTo: 'lead',
    task: { origin: 'lead' },
    budget: 'workspace',
  },
  routine: {
    origin: 'routine',
    startedBy: 'scheduler',
    permissions: 'session-mode',
    unattended: false,
    feedsMemory: false,
    resultTo: 'task',
    task: { origin: 'routine' },
    budget: 'workspace',
  },
  program: {
    origin: 'program',
    startedBy: 'program',
    permissions: 'program-authority',
    unattended: true,
    feedsMemory: false,
    resultTo: 'program-report',
    task: { origin: 'program' },
    budget: 'program',
  },
  heartbeat: {
    origin: 'heartbeat',
    startedBy: 'heartbeat',
    permissions: 'program-authority',
    unattended: true,
    feedsMemory: false,
    resultTo: 'none',
    task: null,
    budget: 'workspace',
  },
  // the authority of the program, in a scratch overlay with simulated external writes: not a task,
  // not in the run history, the digest or the program's own budget (it has a small cap of its own)
  rehearsal: {
    origin: 'rehearsal',
    startedBy: 'person',
    permissions: 'program-authority',
    unattended: true,
    feedsMemory: false,
    resultTo: 'none',
    task: null,
    budget: 'workspace',
  },
}

/** The origin of a session from its id; `hasParent` marks a child session of the lead. */
export function originOfSession(sessionId: string, hasParent = false): RunOrigin {
  if (sessionId.startsWith('routine:')) return 'routine'
  if (sessionId.startsWith('program:')) return 'program'
  if (sessionId.startsWith('heartbeat:')) return 'heartbeat'
  if (sessionId.startsWith('rehearsal:')) return 'rehearsal'
  if (hasParent || /^dm:[^:]+:/.test(sessionId) || /^chat:[^:]+:[^:]+:/.test(sessionId))
    return 'lead'
  return 'dm'
}

export const profileOfSession = (sessionId: string, hasParent = false): RunProfile =>
  RUN_PROFILES[originOfSession(sessionId, hasParent)]
