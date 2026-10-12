/** Ports the use cases depend on; `infra/` implements them. */
import type { AgentDef } from '../domain/agents.ts'
import type { ApprovalView } from '../domain/approvals.ts'
import type { Briefing, Notification, NotificationKind } from '../domain/briefings.ts'
import type {
  ChannelActivityPage,
  ChannelActivityQuery,
  ChannelBindInput,
  ChannelConnectionView,
  ChannelConversationLog,
  ChannelInboxPage,
  ChannelLimitsInput,
  ChannelLinkView,
  ChannelMemberView,
  ChannelNodeView,
  ChannelPeopleSettings,
  ChannelPersonView,
  ChannelPolicyInput,
  ChannelReminderView,
  ChannelRole,
  ChannelUnlinkedView,
} from '../domain/channels.ts'
import type {
  AgentConnectors,
  AgentConnectorView,
  ConnectionAccessInput,
  ConnectionChoices,
  ConnectionPatchInput,
  ConnectionTestResult,
  ConnectionView,
  ConnectorView,
  CustomConnectorInput,
  CustomConnectorResult,
  CustomProbe,
  FlowActInput,
  FlowActResult,
  FlowResult,
  FlowStartInput,
} from '../domain/connectors.ts'
import type { RememberedDecision } from '../domain/decision-memory.ts'
import type {
  Decision,
  DecisionAnswer,
  DecisionKind,
  DecisionOutcome,
  DecisionStatus,
} from '../domain/decisions.ts'
import type { DeliverableResult } from '../domain/deliverables.ts'
import type { NewEvent } from '../domain/events.ts'
import type {
  DigestConfig,
  DigestState,
  HeartbeatConfig,
  HeartbeatState,
} from '../domain/heartbeat.ts'
import type { LibraryFileMeta, LibraryVersion } from '../domain/library.ts'
import type {
  ModelCallDetail,
  ModelCallFilter,
  ModelCallListQuery,
  ModelCallPage,
  ModelCallStats,
} from '../domain/model-calls.ts'
import type { AgentModeChoice, ModeSource, TeamMode } from '../domain/modes.ts'
import type { PersonaProposal, PersonaVersion, ProposalStatus } from '../domain/persona.ts'
import type {
  AuthorityInspection,
  Program,
  ProgramAuthority,
  ProgramBudget,
  ProgramWarning,
} from '../domain/programs.ts'
import type {
  ModelView,
  ProfileCreate,
  ProfilePatch,
  ProfileView,
  ProviderDefinitionView,
  TestResultView,
} from '../domain/providers.ts'
import type { Rehearsal, RehearsalSample, TestCase, TestResult } from '../domain/rehearsal.ts'
import type { Routine, RoutineRun, RoutineSpec } from '../domain/routines.ts'
import type { SettingsPatch, WorkspaceSettings } from '../domain/settings.ts'
import type { Task, TaskPriority, TaskReport, TaskStatus } from '../domain/tasks.ts'
import type { Thread, ThreadSeed, ThreadSource } from '../domain/threads.ts'

export interface Clock {
  now(): number
}

export interface IdGenerator {
  next(): string
}

export interface AgentRepo {
  list(opts?: { includeArchived?: boolean }): AgentDef[]
  get(id: string): AgentDef | undefined
  getBySlug(slug: string): AgentDef | undefined
  insert(def: AgentDef): void
  /** Replace the row (not its connector enablement); `expectedVersion` guards concurrent edits (returns false on conflict). */
  /** Optimistic update; `connectors: true` replaces the agent's connectors in the same transaction. */
  update(def: AgentDef, expectedVersion: number, opts?: { connectors?: boolean }): boolean
  /** Replace the whole connector enablement of an agent (the other enablement writes go through the connectors port). */
  setConnectors(agentId: string, connectors: AgentDef['connectors'], now: number): void
  count(): number
}

/** A UI message as the app sees it: JSON data, shaped by the AI SDK (`UIMessage`). */
export interface ChatMessage {
  id?: string
  role: string
  parts: Array<Record<string, unknown>>
  metadata?: unknown
}

export type Actor = { id: string; name?: string }

export interface ChatStats {
  running: boolean
  /** The model of the agent and what the catalog knows of it (prices per 1M tokens). */
  model: {
    id: string
    /** The provider profile the model is reached through. */
    profileId?: string
    contextWindow?: number
    maxOutputTokens?: number
    pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  }
  context: {
    window: number
    tokens: number
    instructions: number
    tools: number
    messages: number
    summarizeAt: number
    hardLimit: number
    lastCompaction?: { markerId: string; before: number; after: number; at: number }
  }
  activeTurn: {
    turnId: string
    kind: string
    messageId: string
    owner: string
    startedAt: number
    heartbeatAt: number
  } | null
  pending: {
    messageId: string
    approvals: Array<{
      approvalId: string
      toolCallId: string
      toolName: string
      input?: unknown
      risk?: string
    }>
    clientTools: number
    externals: number
  } | null
  /** Cumulative usage of all finished turns (`session.stats().usage`). */
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    /** Turns that ran at least one model step. */
    turns: number
  }
}

/** The DM chat of an agent, on eharness sessions (implemented in `infra/eh/chat-service.ts`). */
export interface ChatPort {
  /** `message` is the summary kind message, or null when there was nothing to compact. */
  compact(
    agent: AgentDef,
    sessionId: string,
  ): Promise<{ compacted: boolean; message: ChatMessage | null }>
  stats(agent: AgentDef, sessionId: string): Promise<ChatStats>
  /** Stats plus the tools the model sees in the next request (opens the session). */
  context(agent: AgentDef, sessionId: string): Promise<{ stats: ChatStats; tools: ToolInfo[] }>
  /** Put a context message (an `eh.event`, no model call) at the start of a thread's session. */
  seed(
    agent: AgentDef,
    sessionId: string,
    event: { name: string; text: string; key: string },
  ): Promise<void>
}

/** A connector of the agent as the composer tools menu shows it. */
export interface ChatToolConnector {
  connectionId: string
  connectorId: string
  name: string
  icon?: string
  label: string
  accountLabel?: string
  source: 'builtin' | 'curated' | 'custom'
  status: 'connected' | 'needs-auth' | 'error'
  /** Offered to the model in this chat. */
  on: boolean
  /** Tools it contributes (not counting the ones its mode turns off). */
  tools: number
}

export interface ChatToolsState {
  connectors: ChatToolConnector[]
  offCount: number
}

/** Per-chat connector switches (the composer tools menu). */
export interface ChatToolsPort {
  get(agent: AgentDef, sessionId: string): Promise<ChatToolsState>
  /** Replace the connections switched off in this chat. */
  set(agent: AgentDef, sessionId: string, off: string[], now: number): Promise<ChatToolsState>
}

export interface ToolInfo {
  name: string
  description: string | null
  /** `app`, `core`, `plugin:<name>` or `source:<id>`. */
  source: string
  deferred: boolean
  tokens: number
}

export interface StoredUpload {
  path: string
  version: string
  size: number
  mediaType: string
}

/** Library file storage the chat needs (uploads and their resolution to bytes). */
export interface UploadStore {
  put(path: string, bytes: Uint8Array, mediaType: string): Promise<StoredUpload>
  get(path: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined>
  /** Existence and metadata without reading the content. */
  stat(path: string): Promise<{ size: number; mediaType: string } | undefined>
}

/** Sidebar data of one agent, from the event feed and its last-read marker. */
export interface AgentActivity {
  lastMessageAt: number | null
  preview: string | null
  unread: number
}

/** Read side of the task index and the event feed (written by the `taskIndex` plugin). */
export interface TaskStore {
  list(query: { status?: TaskStatus; agentId?: string; limit: number }): Task[]
  get(id: string): Task | undefined
  getBySession(sessionId: string): Task | undefined
  /** The runs of a program (task sessions `program:<id>:<runAt>`), newest first. */
  ofProgram(programId: string, limit: number): Task[]
  /** Tasks the agent runs (`owned`) and tasks it handed to others from its DM (`delegated`). */
  ofAgent(agentId: string, dmSessionId: string): { owned: Task[]; delegated: Task[] }
  /** Activity of every agent that has any, by agent id. */
  activity(): Map<string, AgentActivity>
  /** Everything up to the latest message event is read. Returns the marker. */
  markRead(agentId: string): number

  // --- the work queue (P40 D6) -------------------------------------------------------------
  /** A queued task: a row with an owner, a brief and no session yet. */
  enqueue(task: {
    agentId: string
    title: string
    brief: string | null
    inputs: string[]
    priority: TaskPriority
    dueAt: number | null
    createdBy: string
    hold?: boolean
    /** Default true. */
    review?: boolean
    grants?: ProgramAuthority | null
    now: number
  }): Task
  /** Change a task that is still queued; undefined when it is not (any more). */
  patchQueued(
    id: string,
    patch: {
      agentId?: string
      title?: string
      brief?: string | null
      inputs?: string[]
      priority?: TaskPriority
      dueAt?: number | null
      hold?: boolean
      review?: boolean
      grants?: ProgramAuthority | null
    },
    now: number,
  ): Task | undefined
  /** Queued -> stopped; undefined when it is not queued. */
  cancelQueued(id: string, now: number): Task | undefined
  /**
   * Take the next queued task of the agent (priority, nearest due date, oldest) and give it the
   * session. One atomic step: two callers never get the same task. undefined: nothing queued.
   */
  claimNext(agentId: string, sessionId: string, now: number): Task | undefined
  /**
   * Start the next queued, not held task of the agent as an assigned task (session
   * `task:<id>:<round>`) when it works on fewer than `limit` tasks. One atomic step.
   */
  claimAssigned(agentId: string, limit: number, now: number): Task | undefined
  /** Start one queued task now (hold or not, a free slot or not: the client asked). */
  claimTask(id: string, now: number): Task | undefined
  /**
   * Put an assigned task that was claimed but never started a turn (the process died in between)
   * back in the queue: running -> queued, the queued session id again. undefined when it is not
   * running any more.
   */
  requeueUnstarted(id: string, now: number): Task | undefined
  /** Tasks of the agent that run or wait for the client now (they hold a slot). */
  running(agentId: string): number
  /** The client accepts finished work in Review; undefined when it is not in Review. */
  accept(id: string, now: number): Task | undefined
  /** The client sends it back: queued again, the note appended to the brief. */
  sendBack(id: string, note: string, now: number): Task | undefined
  /** Queued tasks of an agent in queue order. */
  queued(agentId: string): Task[]
  /** `complete_task`: the outputs and summary of the work item running in `sessionId`. */
  complete(sessionId: string, report: TaskReport, now: number): Task | undefined
  /**
   * Store the deliverable checks of a run; `override` also replaces the report (a failed check
   * makes the run partial). undefined when the session has no row.
   */
  recordDeliverables(
    sessionId: string,
    result: DeliverableResult,
    override: { report: TaskReport; summary: string } | null,
    now: number,
  ): Task | undefined
}

/** A program to store; the store sets the timestamps and the version. */
export type NewProgram = Omit<Program, 'createdAt' | 'updatedAt' | 'version'> & { now: number }

/** Fields `update` may change (anything absent stays). */
export type ProgramPatch = Partial<
  Omit<Program, 'id' | 'agentId' | 'createdBy' | 'createdAt' | 'updatedAt' | 'version'>
>

export interface ProgramStore {
  list(query: { agentId?: string }): Program[]
  get(id: string): Program | undefined
  insert(program: NewProgram): Program
  update(id: string, patch: ProgramPatch, now: number): Program | undefined
  delete(id: string): boolean
}

/** Decisions a program's client already settled (stand-down answers), per program. */
export interface ProgramMemoryStore {
  list(programId: string): RememberedDecision[]
  /** Stores an answer; one per subject (a newer one replaces the older). */
  remember(item: RememberedDecision): void
  forget(programId: string, id: string, now: number): boolean
  deleteByProgram(programId: string): void
}

/** Starts program runs (`infra/eh/program-service.ts`). */
export interface ProgramRunner {
  /**
   * Start the run of `runAt`: the task session `program:<id>:<runAt>` gets the run prompt and a
   * structured-output spec. Returns once the turn is started (not finished). `started: false`
   * when that run exists already (a recovered fire, a double click).
   */
  start(
    program: Program,
    options: {
      runAt: number /** A fire of the program's schedule (nobody waits for the answer). */
      scheduled?: boolean
    },
  ): Promise<{ sessionId: string; started: boolean; idle?: boolean }>
  /**
   * Work an assigned task (`task:<id>:<round>`, already claimed: status `running`): the agent gets
   * the task prompt in its session, with its own tools and permissions, and a structured-output
   * spec. Returns at once; `ended` resolves (never rejects) when the turn ended, parked or not.
   */
  startTask(task: Task): { ended: Promise<void> }
  /**
   * What a program of this agent, authority and budget cannot do (`ProgramWarning`): tools the run
   * can never have and a budget below the cost of one model call. Nothing is stored.
   */
  /**
   * Checks an authority against what the agent really has (`inspectAuthority`): repaired connector
   * names, readable errors and the effective grant. Sync, from the last activation; undefined when
   * the agent was never prepared. `prepare` activates it first.
   */
  inspect(agentId: string, authority: ProgramAuthority): AuthorityInspection | undefined
  prepare(agentId: string): Promise<void>
  check(input: {
    agentId: string
    authority: ProgramAuthority
    budget: Pick<ProgramBudget, 'perRunUsd' | 'perDayUsd' | 'maxOutputTokens'>
  }): Promise<ProgramWarning[]>
}

/** Rehearsals (test runs) of programs (`infra/db/rehearsal-repo.ts`, `domain/rehearsal.ts`). */
export interface RehearsalStore {
  /** Insert or replace by id. */
  save(rehearsal: Rehearsal): void
  get(id: string): Rehearsal | undefined
  getBySession(sessionId: string): Rehearsal | undefined
  /** Newest first; the produced files keep names and sizes, not their content. */
  list(programId: string, limit: number): Rehearsal[]
  delete(id: string): boolean
  deleteByProgram(programId: string): void
  /** Delete all but the newest `keep` finished rehearsals of a program. */
  prune(programId: string, keep: number): void
  running(): Rehearsal[]
  /** USD the rehearsals started in a time window spent (the digest leaves it out of its cost line). */
  spentBetween(from: number, to: number): number
  /** Mark the rehearsals that were running as failed (the process that ran them is gone). */
  failRunning(reason: string, now: number): number
}

/** Saved test cases of programs. */
export interface ProgramTestStore {
  list(programId: string): TestCase[]
  get(id: string): TestCase | undefined
  /** Insert or replace by id. */
  save(testCase: TestCase): void
  /** Store the last result without changing `updatedAt`. */
  setResult(id: string, result: TestResult | null): void
  delete(id: string): boolean
  deleteByProgram(programId: string): void
}

/** Starts rehearsals (`infra/eh/rehearsal-service.ts`). */
export interface RehearsalRunner {
  /** Create the rehearsal row and start its session; returns while it runs. */
  start(
    program: Program,
    options: { sample: RehearsalSample; budgetUsd: number; testId?: string | null },
  ): Promise<Rehearsal>
  /** Run the cases one after the other in the background; each stores its result. */
  runCases(program: Program, cases: TestCase[]): void
  /** Rehearsals that are running in this process. */
  runningCount(): number
  /** The chat of a rehearsal session (UI messages, oldest first). */
  messages(sessionId: string): Promise<unknown[]>
}

/** Heartbeat configuration, beat history and the digest buffer (`infra/db/heartbeat-repo.ts`). */
export interface HeartbeatStore {
  /** The stored configuration of an agent; undefined = never set (the default of its role). */
  config(agentId: string): HeartbeatConfig | undefined
  setConfig(agentId: string, config: HeartbeatConfig, now: number): void
  state(agentId: string): HeartbeatState
  /** Read-modify-write under one transaction. */
  updateState(
    agentId: string,
    fn: (state: HeartbeatState) => HeartbeatState,
    now: number,
  ): HeartbeatState
  digestConfig(): DigestConfig
  setDigestConfig(config: DigestConfig, now: number): void
  digest(): DigestState
  updateDigest(fn: (state: DigestState) => DigestState, now: number): DigestState
}

/** Chat threads (`infra/db/threads-repo.ts`, `domain/threads.ts`). */
export interface ThreadStore {
  get(id: string): Thread | undefined
  getBySession(sessionId: string): Thread | undefined
  /** All threads of an agent, archived ones included, newest activity first. */
  list(agentId: string): Thread[]
  /** Session ids of every thread of an agent (archived included). */
  sessionsOf(agentId: string): string[]
  /** The sessions of every thread that is not archived. */
  allSessions(): Array<{ agentId: string; sessionId: string }>
  /** Idempotent on `sessionId`: an existing row is returned unchanged. */
  insert(thread: {
    id: string
    agentId: string
    sessionId: string
    title: string | null
    source: ThreadSource
    sourceLabel: string | null
    seed: ThreadSeed | null
    now: number
  }): Thread
  patch(
    id: string,
    patch: { title?: string | null; archivedAt?: number | null },
    now: number,
  ): Thread | undefined
  /** A message of a thread: its activity, preview and (for an unnamed thread) a title from it. */
  touch(sessionId: string, info: { at: number; preview: string | null; title: string | null }): void
}

export interface NotificationStore {
  get(id: string): Notification | undefined
  byKey(key: string): Notification | undefined
  /** Newest first. */
  list(query: { open: boolean; limit: number }): Notification[]
  countOpen(): number
  /** undefined when a notification with this `key` exists already. */
  insert(n: {
    id: string
    kind: NotificationKind
    key: string
    title: string
    body: string
    link: string | null
    agentId: string | null
    createdAt: number
  }): Notification | undefined
  dismiss(id: string, now: number): Notification | undefined
  dismissAll(now: number): number
  dismissByKeyPrefix(prefix: string, now: number): number
}

export interface BriefingStore {
  get(id: string): Briefing | undefined
  getByDay(day: string): Briefing | undefined
  /** Newest day first. */
  list(limit: number): Briefing[]
  /** undefined when that day has one already. */
  insert(b: Briefing): Briefing | undefined
}

/** What the heartbeat and the digest need besides the stores (`app/heartbeat.ts`). */
export interface HeartbeatPorts {
  store: HeartbeatStore
  /** Spend and limit of the workspace budget this month (the shared ledger). */
  budget(): Promise<{ spentUsd: number; limitUsd: number | null } | null>
  /** The messages of a session of the client (DM requests), newest `limit`, chronological. */
  requests(sessionId: string, limit: number): Promise<Array<{ text: string; at: number }>>
  /** Fire one beat now (the web's "Run now"); a skip says why and costs no model call. */
  run(agentId: string, at: number): Promise<{ started: boolean; reason?: string }>
}

/** A decision to store (always `open`). */
export type NewDecision = Pick<
  Decision,
  'id' | 'kind' | 'title' | 'body' | 'agentId' | 'sessionId' | 'programId' | 'waitId' | 'createdAt'
> & { payload: Decision['payload'] }

/** What deciding writes. */
export interface DecisionPatch {
  status: Exclude<DecisionStatus, 'open'>
  decidedBy: string
  decidedAt: number
  note: string
  outcome?: DecisionOutcome | undefined
  /** The payload as approved (a proposal the client edited). */
  payload?: Decision['payload'] | undefined
  programId?: string | null | undefined
}

export interface DecisionStore {
  get(id: string): Decision | undefined
  getByWait(waitId: string): Decision | undefined
  /** Newest first. */
  list(query: {
    status?: DecisionStatus
    kind?: DecisionKind
    agentId?: string
    sessionId?: string
    limit: number
  }): Decision[]
  countOpen(): number
  insert(decision: NewDecision): Decision
  /** Compare-and-set on `open`: undefined when the decision was decided meanwhile (the first answer wins). */
  decide(id: string, patch: DecisionPatch): Decision | undefined
  /** Back to `open` (a decision whose effect failed). */
  reopen(id: string): Decision | undefined
  setOutcome(id: string, outcome: DecisionOutcome, programId?: string): Decision | undefined
}

/**
 * Hands the answer to the session a decision came from (`infra/eh/decision-service.ts`): resolves
 * the external wait it is parked on (it resumes in whichever instance), or, for a decision made
 * from a final report, sends the answer as a new message.
 */
export interface DecisionResolver {
  /**
   * `resumed`: the session continues; `recorded`: the answer is stored and the session continues
   * when its other waits are answered; `gone`: the session no longer waits (stopped, timed out,
   * deleted).
   */
  resume(decision: Decision, answer: DecisionAnswer): Promise<'resumed' | 'recorded' | 'gone'>
}

/** Cross-session reads on eharness sessions (answers are the library's `attention` routes) (implemented in `infra/eh/team-service.ts`). */
export interface TeamPort {
  /** Stored messages of a task session (newest `limit`, chronological). */
  taskMessages(task: Task, limit: number): Promise<ChatMessage[]>
  /** Everything waiting for a person, across DM chats and task sessions, on any instance. */
  approvals(): Promise<ApprovalView[]>
  /**
   * A message from the user into the task session through the durable inbox: `steer` joins the
   * running turn at its next step boundary, `queue` runs after it (both start a turn when idle).
   */
  messageTask(
    task: Task,
    text: string,
    mode: 'steer' | 'queue',
  ): Promise<{ inboxId: string; target: 'local' | 'remote' }>
}

/** The permission mode of an agent's DM chat and what limits it (`domain/modes.ts`). */
export interface ModeState {
  /** Effective mode: what the next tool call runs under. */
  mode: TeamMode
  /** Where it comes from: the chat's own pick, the agent's mode, or the workspace default. */
  source: ModeSource
  /** The agent's own mode, or `inherit`. It is also the loosest mode its sessions may run in. */
  agentMode: AgentModeChoice
  workspaceDefault: TeamMode
  /** Modes a person may pick now (ceiling and classifier availability applied). */
  available: TeamMode[]
  /** False when the server has no classifier model (scripted runs): Auto is not offered. */
  autoAvailable: boolean
  /** Auto mode block counters; `paused`: calls ask a person until one is approved. */
  auto: { paused: boolean; consecutive: number; total: number }
}

/** Per-session permission modes (`infra/eh/mode-service.ts`). */
export interface ModePort {
  get(agent: AgentDef, sessionId: string): ModeState
  /** Store a pick for a chat thread; the caller validated it against `available`. */
  set(agent: AgentDef, sessionId: string, mode: TeamMode, now: number): ModeState
}

/** Read side of the model call log (written by the `activityLog` plugin). */
export interface ModelCallStore {
  list(query: ModelCallListQuery): ModelCallPage
  /** Buckets and totals of a range; `bucketMs` default fits the range in about 60 buckets. */
  stats(query: ModelCallFilter & { from: number; to: number; bucketMs?: number }): ModelCallStats
  /** One call with its JSON columns and the ids of its neighbours under `filter`. */
  get(id: string, filter: ModelCallFilter): ModelCallDetail | undefined
  /**
   * Spend of the kept calls by agent and where the session came from (`chat`, `task`, `delegated`,
   * `routine`, `program`, `heartbeat`, `rehearsal`, `other`): the one source of truth of what was
   * spent (the Usage page and the digest read the same rows as the Logs page).
   */
  usage(filter?: { from?: number; to?: number }): {
    since: number | null
    rows: Array<{
      agentId: string | null
      source: string
      calls: number
      turns: number
      sessions: number
      tokens: number
      costUsd: number
    }>
  }
}

/** Appends app events to the feed from use cases (routines, settings). Never throws. */
export interface EventAppender {
  append(event: NewEvent): void
}

/** Outcome of a conditional file change (`ifVersion`). */
export type FileChange =
  | { ok: true; version: string }
  | { ok: false; reason: 'exists' | 'conflict' | 'missing'; currentVersion?: string }

export interface LibraryListQuery {
  prefix: string
  excludePrefixes?: string[]
  createdBy?: string
  newestFirst?: boolean
  limit: number
}

/** The shared file store as the library and memory routes use it (`infra/eh/library-store.ts`). */
export interface LibraryStore {
  list(query: LibraryListQuery): LibraryFileMeta[]
  read(
    path: string,
  ): Promise<{ meta: LibraryFileMeta; text: string | null; bytes: Uint8Array | null } | undefined>
  /** `ifVersion`: undefined = overwrite, null = create only, string = must match. */
  writeText(path: string, content: string, ifVersion?: string | null): Promise<FileChange>
  delete(path: string, ifVersion?: string): Promise<FileChange>
  move(from: string, to: string, ifVersion?: string): Promise<FileChange>
  /** Metadata-only history of a path, newest first. */
  versions(path: string, limit: number): LibraryVersion[]
}

/** The workspace settings row (`infra/db/settings-repo.ts`). */
export interface SettingsStore {
  get(): WorkspaceSettings & { updatedAt: number }
  patch(patch: SettingsPatch, now: number): WorkspaceSettings & { updatedAt: number }
}

export interface NewRoutine {
  id: string
  agentId: string
  name: string
  prompt: string
  schedule: RoutineSpec
  sessionMode: Routine['sessionMode']
  overlap: Routine['overlap']
  catchUpWindowMs: number | null
  maxFailures: number
  maxFires: number | null
  endAt: number | null
  nextFireAt: number | null
  /** The program this routine is the schedule of (not listed as a routine). */
  programId?: string | null
  now: number
}

/** Fields `update` may change (anything absent stays). */
export type RoutinePatch = Partial<
  Pick<
    Routine,
    | 'name'
    | 'prompt'
    | 'schedule'
    | 'sessionMode'
    | 'overlap'
    | 'catchUpWindowMs'
    | 'maxFailures'
    | 'maxFires'
    | 'endAt'
    | 'status'
    | 'pausedReason'
    | 'lastStatus'
    | 'nextFireAt'
    | 'failures'
  >
>

export interface RoutineStore {
  /** Without `programId` the routines of programs are left out; with it only that program's. */
  list(query: { agentId?: string; programId?: string }): Routine[]
  getByProgram(programId: string): Routine | undefined
  get(id: string): Routine | undefined
  insert(routine: NewRoutine): Routine
  update(id: string, patch: RoutinePatch, now: number): Routine | undefined
  delete(id: string): boolean
  runs(routineId: string, limit: number): RoutineRun[]
  getRun(id: string): RoutineRun | undefined
}

/** Cron / interval maths (`infra/schedule.ts`, croner); pure functions of the clock they are given. */
export interface ScheduleCalc {
  /** Throws a `DomainError` for a bad expression, timezone or interval. */
  validate(spec: RoutineSpec): void
  /** The first slot strictly after `afterMs`, or null (`at` slots, exhausted crons). */
  next(spec: RoutineSpec, afterMs: number): number | null
}

/** Fires routines (`infra/eh/routine-service.ts`); every instance runs a ticker. */
/** One input waiting in the inbox of a session. */
export interface QueuedInput {
  id: string
  kind: string
  /** First text of the input, shortened ('' when it has none). */
  preview: string
  /** A holder is working on it right now. */
  claimed: boolean
  availableAt: number | null
}

/** The inbox of a session, as far as the owner needs to see and clear it. */
export interface SessionQueue {
  queued(sessionId: string): Promise<QueuedInput[]>
  /** Removes every waiting input of the session; returns how many. */
  clear(sessionId: string): Promise<number>
}

export interface RoutineEngine {
  /** The session whose inbox decides the overlap of this routine's next fire, and what waits in it. */
  queue(routine: Routine): Promise<{ sessionId: string | null; items: QueuedInput[] }>
  /** Clears the waiting inputs of that session (a stuck input that skips every fire). */
  clearQueue(routine: Routine): Promise<number>
  /** Fire `routine` now (a manual run); it respects `overlap: 'skip'`. */
  runNow(routine: Routine): Promise<RoutineRun>
}

/**
 * Model providers and their saved profiles (`infra/eh/providers.ts` over `eharness/providers`).
 * Secrets never leave it: every view is redacted.
 */
export interface ProvidersPort {
  /** Provider definitions (form fields, JSON Schema) and the profiles, redacted. */
  describe(): Promise<{ providers: ProviderDefinitionView[]; profiles: ProfileView[] }>
  /** Ids of the profiles known now (synchronous snapshot, for validating picks). */
  profileIds(): string[]
  create(input: ProfileCreate): Promise<ProfileView>
  update(id: string, patch: ProfilePatch): Promise<ProfileView>
  remove(id: string): Promise<void>
  test(id: string): Promise<TestResultView>
  models(id: string, options: { refresh: boolean; all?: boolean }): Promise<ModelView[]>
}

/**
 * Connectors (`infra/eh/connectors.ts` over `eharness/connectors`): the catalog, connections
 * (workspace or agent scope), server-driven connect flows and per-agent enablement. Secrets and
 * tokens never leave it: every view is redacted.
 */
export interface ConnectorsPort {
  catalog(): Promise<ConnectorView[]>
  connections(query?: {
    scope?: 'workspace' | 'agent'
    scopeId?: string
  }): Promise<ConnectionView[]>
  startFlow(input: FlowStartInput): Promise<FlowResult>
  getFlow(id: string): Promise<FlowResult | undefined>
  act(id: string, input: FlowActInput): Promise<FlowActResult>
  /** The OAuth redirect: the flow it belongs to, or why it failed. */
  oauthCallback(query: {
    state?: string
    code?: string
    error?: string
    errorDescription?: string
  }): Promise<{ flowId?: string; error?: string }>
  updateConnection(id: string, patch: ConnectionPatchInput): Promise<ConnectionView>
  removeConnection(id: string): Promise<void>
  /** Who uses a connection (see `ConnectionAccess`); converts an agent-scoped one to workspace scope. */
  setAccess(id: string, input: ConnectionAccessInput): Promise<ConnectionView>
  testConnection(id: string): Promise<ConnectionTestResult>
  /** Every connection this agent can use, with its effective state and modes. */
  agentConnectors(agent: AgentDef): Promise<AgentConnectorView[]>
  /** Replace the choices of the given connections (`null` removes the entry: back to inherit). */
  setAgentConnectors(
    agent: AgentDef,
    changes: Record<string, ConnectionChoices | null>,
  ): Promise<AgentConnectorView[]>
  /** Ask a server which sign-in it needs (an unauthenticated MCP request + OAuth discovery). */
  probeCustom(input: { url: string }): Promise<CustomProbe>
  /** Add a custom connector: its own connection, named by the user. */
  createCustom(input: CustomConnectorInput): Promise<CustomConnectorResult>
  setOAuthClient(
    definitionId: string,
    input: { clientId: string; clientSecret?: string },
  ): Promise<void>
  removeOAuthClient(definitionId: string): Promise<void>
}

export type { AgentConnectors }

/** Channel connections (chat platforms), their bindings, chats, pairing and delivery state. */
export interface ChannelsPort {
  connections(): Promise<ChannelConnectionView[]>
  connection(id: string): Promise<ChannelConnectionView>
  /** Bind a connection to an agent (starts the transport). */
  bind(id: string, input: ChannelBindInput): Promise<ChannelConnectionView>
  /** Remove the binding (stops the transport; the connector connection stays). */
  unbind(id: string): Promise<ChannelConnectionView>
  /** The chats and topics of the connection (nodes of the tree) with their own and inherited settings. */
  chats(id: string): Promise<ChannelNodeView[]>
  /** Write the settings of one node (a chat or a topic). `null` clears them (inherit again). */
  setChatPolicy(
    id: string,
    nodeId: string,
    input: ChannelPolicyInput | null,
  ): Promise<ChannelNodeView>
  links(id: string): Promise<ChannelLinkView[]>
  revokeLink(id: string, peerId: string): Promise<void>
  /** Remove the webhook of the bot so polling can start. */
  deleteWebhook(id: string): Promise<ChannelConnectionView>
  /** Stop and start the transport again (after a transient failure). */
  restart(id: string): Promise<ChannelConnectionView>
  /** Close the outbound breaker by hand. */
  resetBreaker(id: string): Promise<ChannelConnectionView>
}

/**
 * People, inbox and activity of a channel connection (any transport): who is linked and who is not
 * yet, the conversations with their channel logs (decrypted on read for the web token holder), and
 * the activity events. Texts of messages appear only in the conversation log.
 */
export interface ChannelInboxPort {
  /** Team members an account can be linked to. */
  members(id: string): Promise<ChannelMemberView[]>
  unlinked(id: string, options?: { includeIgnored?: boolean }): Promise<ChannelUnlinkedView[]>
  /** Link an account by its platform user id (also for somebody we never saw). */
  link(
    id: string,
    input: { peerId: string; memberId: string; name?: string },
  ): Promise<ChannelLinkView>
  ignore(id: string, peerId: string, ignored: boolean): Promise<void>
  inbox(id: string, options: { limit: number; cursor?: string }): Promise<ChannelInboxPage>
  conversation(
    id: string,
    conversationId: string,
    options: { limit: number; before?: string },
  ): Promise<ChannelConversationLog>
  activity(id: string, query: ChannelActivityQuery): Promise<ChannelActivityPage>
  /** The people directory (roles, divisions, suggestions from the platform's admins). */
  people(id: string): Promise<ChannelPersonView[]>
  setRole(
    id: string,
    peerId: string,
    input: { role: ChannelRole; divisions?: string[] },
  ): Promise<ChannelPersonView>
  clearRole(id: string, peerId: string): Promise<void>
  importAdmins(id: string): Promise<{ chats: number; people: number; problems: string[] }>
  peopleSettings(id: string): Promise<ChannelPeopleSettings>
  setPeopleSettings(
    id: string,
    input: Partial<ChannelPeopleSettings>,
  ): Promise<ChannelPeopleSettings>
  reminders(id: string, options: { all: boolean }): Promise<ChannelReminderView[]>
  /** Reminders of every connection (the Routines page): active ones, and with `all` the finished ones too. */
  allReminders(options: { all: boolean; agentId?: string }): Promise<ChannelReminderView[]>
  cancelReminder(id: string, reminderId: string): Promise<void>
}

/** Telegram user accounts (P41 L4): chat picker, per-chat backfill window, admin log, limits. */
export interface ChannelAccountsPort {
  /** Read the dialogs of the account from Telegram into the picker (needs a running connection). */
  refreshChats(id: string): Promise<ChannelNodeView[]>
  /** Choose (or stop) ingesting a chat. A chosen chat starts as observe-only. */
  selectChat(id: string, chatId: string, selected: boolean): Promise<ChannelNodeView>
  /** History window in days (`null` = no backfill). */
  setBackfill(id: string, chatId: string, days: number | null): Promise<ChannelNodeView>
  setAdminLog(id: string, chatId: string, enabled: boolean): Promise<ChannelNodeView>
  /** Read the admin logs that are due now (all chats with `force`). */
  runAdminLog(id: string, force: boolean): Promise<ChannelConnectionView>
  setLimits(id: string, input: ChannelLimitsInput): Promise<ChannelConnectionView>
}

/** Persona versions and proposals (`infra/db/persona-repo.ts`, docs/plans/P42-team-persona.md). */
export interface PersonaStore {
  /** The current persona of an agent; undefined before its first version. */
  latest(agentId: string): PersonaVersion | undefined
  /** The number of the current version (0 = none); cheap: it is part of the agent cache key. */
  latestNumber(agentId: string): number
  get(agentId: string, version: number): PersonaVersion | undefined
  /** Newest first. */
  history(agentId: string, limit?: number): PersonaVersion[]
  /** Write version `after + 1`; undefined when another writer took that number (re-read, retry). */
  append(v: Omit<PersonaVersion, 'version'>, after: number): PersonaVersion | undefined
  insertProposal(p: PersonaProposal): void
  getProposal(id: string): PersonaProposal | undefined
  listProposals(agentId: string, status?: ProposalStatus): PersonaProposal[]
  /** Decide a pending proposal once; false when it was decided already. */
  decideProposal(
    id: string,
    change: {
      status: Exclude<ProposalStatus, 'pending'>
      decidedBy: string
      decidedAt: number
      appliedVersion?: number | undefined
    },
  ): boolean
  /** Record the version an applied proposal produced. */
  setAppliedVersion(id: string, version: number): void
  pendingCount(agentId: string): number
}

export interface Deps {
  agents: AgentRepo
  persona: PersonaStore
  chat: ChatPort
  chatTools: ChatToolsPort
  threads: ThreadStore
  notifications: NotificationStore
  briefings: BriefingStore
  uploads: UploadStore
  tasks: TaskStore
  team: TeamPort
  library: LibraryStore
  settings: SettingsStore
  providers: ProvidersPort
  connectors: ConnectorsPort
  channels: ChannelsPort
  channelAccounts: ChannelAccountsPort
  channelInbox: ChannelInboxPort
  /** Where the browser app lives (the OAuth callback redirects back to it). */
  webUrl: string
  modes: ModePort
  routines: RoutineStore
  schedule: ScheduleCalc
  routineEngine: RoutineEngine
  programs: ProgramStore
  programRunner: ProgramRunner
  rehearsals: RehearsalStore
  programTests: ProgramTestStore
  programMemory: ProgramMemoryStore
  rehearsalRunner: RehearsalRunner
  decisions: DecisionStore
  decisionResolver: DecisionResolver
  heartbeat: HeartbeatPorts
  events: EventAppender
  modelCalls: ModelCallStore
  clock: Clock
  ids: IdGenerator
  workspaceId: string
}
