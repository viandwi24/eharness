/** Ports the use cases depend on; `infra/` implements them. */

import type { AgentDef } from '../domain/agents.ts'
import type { Alarm, NewAlarm } from '../domain/alarms.ts'
import type { ApprovalView } from '../domain/approvals.ts'
import type {
  Artifact,
  ArtifactExport,
  ArtifactPatch,
  ArtifactShare,
  ArtifactSummary,
  ArtifactVersionView,
  NewArtifact,
  SignedUrl,
} from '../domain/artifacts.ts'
import type {
  BackupRecord,
  RestoreMode,
  RestorePlan,
  RestorePoint,
  RestoreResult,
} from '../domain/backups.ts'
import type { Notification, NotificationKind } from '../domain/briefings.ts'
import type { BrowserDriver, BrowserInfo, BrowserRuntimeView } from '../domain/browser.ts'
import type {
  ChannelActivityPage,
  ChannelActivityQuery,
  ChannelActivityTableQuery,
  ChannelAuditPage,
  ChannelAuditQuery,
  ChannelBindInput,
  ChannelBulkRoleInput,
  ChannelBulkRoleResult,
  ChannelChatsQuery,
  ChannelConnectionView,
  ChannelConversationLog,
  ChannelInboxPage,
  ChannelInboxTableQuery,
  ChannelLimitsInput,
  ChannelLinkView,
  ChannelMemberView,
  ChannelNodeView,
  ChannelOutboxAttentionPage,
  ChannelPeopleQuery,
  ChannelPeopleSettings,
  ChannelPersonView,
  ChannelPolicyInput,
  ChannelRemindersQuery,
  ChannelReminderView,
  ChannelRole,
  ChannelRoleSuggestions,
  ChannelUnlinkedView,
  TablePage,
} from '../domain/channels.ts'
import type { CodeSandboxInfo } from '../domain/code-sandbox.ts'
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
import type { StreamEvent, StreamPage, StreamQuery } from '../domain/event-stream.ts'
import type { NewEvent } from '../domain/events.ts'
import type { DriftFact, ToolEvent } from '../domain/health.ts'
import type {
  ChatActivity,
  DigestConfig,
  DigestState,
  HeartbeatConfig,
  HeartbeatDestinationView,
  HeartbeatState,
  WatchNode,
} from '../domain/heartbeat.ts'
import type { LibraryFileMeta, LibraryVersion } from '../domain/library.ts'
import type { LibraryMove } from '../domain/library-moves.ts'
import type {
  ModelCallDetail,
  ModelCallFilter,
  ModelCallListQuery,
  ModelCallPage,
  ModelCallStats,
} from '../domain/model-calls.ts'
import type { AgentModeChoice, ModeSource, TeamMode } from '../domain/modes.ts'
import type { WorkspacePause } from '../domain/pause.ts'
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
  ProviderFieldView,
  TestResultView,
} from '../domain/providers.ts'
import type { Routine, RoutineRun, RoutineSpec } from '../domain/routines.ts'
import type { BlockedTool, ConfiguredGroup, LastCallTools } from '../domain/session-tools.ts'
import type { SettingsPatch, WorkspaceSettings } from '../domain/settings.ts'
import type {
  StorageAction,
  StorageActionResult,
  StorageReport,
  VolumeInfo,
} from '../domain/storage.ts'
import type { Task, TaskPriority, TaskReport, TaskStatus } from '../domain/tasks.ts'
import type { Thread, ThreadSeed, ThreadSource } from '../domain/threads.ts'
import type {
  Trigger,
  TriggerAction,
  TriggerFilters,
  TriggerFire,
  TriggerScope,
} from '../domain/triggers.ts'
import type { PendingRetry } from '../domain/turn-retry.ts'
import type { DataRow } from '../domain/workspace-data.ts'
import type {
  EntityFile,
  ImportSource,
  ReminderRecord,
  WorkspaceManifest,
} from '../domain/workspace-export.ts'
import type { SecretRecord } from '../domain/workspace-secrets.ts'

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
  /** The model of an agent and what the catalog knows of it (window, output cap, prices). Optional: fakes omit it. */
  modelOf?(agent: AgentDef): ChatStats['model']
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

/** What tools a session has, and the forced reload of them (the chat's "Tools in this session"). */
export interface SessionToolsView {
  sessionId: string
  agentId: string
  /** Offered by the agent's current activation, grouped by connection. */
  configured: ConfiguredGroup[]
  /** What the newest model call of the session carried; null with a reason when unknown. */
  lastCall: LastCallTools | null
  lastCallNote: string | null
  /** Configured and allowed, yet neither loaded nor deferred in the last call. */
  missing: string[]
  /** Carried by the last call but not configured (plugin tools such as `tool_search`). */
  extra: string[]
  /** Kept off because the remote server changed their definitions since this chat pinned them. */
  blocked: BlockedTool[]
}

export interface ReloadView {
  /** Open sessions the reload looked at. */
  sessions: number
  closed: number
  /** True when a session was busy: it closes right after its turn. */
  pending: boolean
  /** Tools the agent is configured with now. */
  tools: string[]
  /** Pinned remote tool definitions the owner accepted (sets cleared). */
  pinsCleared: number
}

/** A connection whose remote tools changed on the server after some chats pinned them. */
export interface ConnectionDrift {
  /** Distinct tools that are kept off in at least one chat. */
  tools: number
  /** Chats that keep them off. */
  sessions: number
  agentIds: string[]
}

export interface SessionToolsPort {
  /** Read-only: stored data and the last activation, no model call, no session opened. */
  tools(sessionId: string): Promise<SessionToolsView>
  reload(sessionId: string): Promise<ReloadView>
  reloadAgent(agent: AgentDef): Promise<ReloadView>
  /** Chats that keep remote tools off because the server changed them (the Health page). */
  drifts(): DriftFact[]
  /** The drift of one connection, or null when no chat is known to keep its tools off. */
  connectionDrift(connectionId: string): ConnectionDrift | null
  /**
   * The owner accepts the current definitions of a connection's server in every chat of every agent
   * that uses it: pins are cleared, chats reload. Returns the totals.
   */
  acceptConnection(connectionId: string): Promise<ReloadView & { agents: number }>
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
/** Automatic retry of turns that failed transiently (`infra/eh/turn-retry-service.ts`). */
export interface TurnRetryPort {
  /** The retry that waits (or runs) for a session. */
  pending(sessionId: string): PendingRetry | undefined
  /** Every waiting retry by session id (Health reads this for "will retry at ..."). */
  waiting(): Map<string, PendingRetry>
  /** Continue the session now. Throws a conflict when something is working on it. */
  retryNow(sessionId: string): Promise<{ started: true }>
}

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

/**
 * One model call (no tools, no session) with the model the agent runs on. Throws a readable error
 * when the agent's model or provider is unavailable.
 */
export type AgentCompletion = (
  agentId: string,
  input: { system: string; prompt: string; maxOutputTokens: number },
) => Promise<string>

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
      /** What started this run (a trigger's event): appended to the run prompt as context. */
      eventNote?: string
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

/** Alarms (`domain/alarms.ts`): stored incidents of failed background work. */
export interface AlarmStore {
  get(id: string): Alarm | undefined
  byKey(key: string): Alarm | undefined
  /** Newest first. `open`: not acknowledged. */
  list(query: { open: boolean; limit: number }): Alarm[]
  countOpen(): number
  /** Unacknowledged alarms of a subject (and kind when given). */
  openOf(subject: string, kind?: Alarm['kind']): Alarm[]
  /** How many alarms (open or not) a subject has had: the suffix of a recurring incident's key. */
  countOf(subject: string, kind: Alarm['kind']): number
  /** undefined when an alarm with this `key` exists already (one alarm per incident). */
  insert(a: NewAlarm & { id: string; createdAt: number }): Alarm | undefined
  ack(id: string, by: 'owner' | 'auto', now: number): Alarm | undefined
  /** Open and not delivered yet, oldest first. */
  pending(): Alarm[]
  /** Subjects delivered since `since` (the rate limit). */
  deliveredSince(since: number): Array<{ subject: string; deliveredAt: number }>
  markDelivered(ids: readonly string[], now: number): void
}

/**
 * Where an alarm goes besides the Health page: a chat message to the owner (the channels'
 * proactive path). `unavailable` = no chat destination now; the bell is the fallback.
 */
export interface AlarmPush {
  push(text: string): Promise<'sent' | 'unavailable'>
}

/** Stop a running task's turn like the Stop button does (`idle`: nothing was running). */
export type RunInterrupter = (task: Task, reason: string) => Promise<'aborted' | 'idle'>

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

/** What the heartbeat and the digest need besides the stores (`app/heartbeat.ts`). */
export interface HeartbeatPorts {
  store: HeartbeatStore
  /** Spend and limit of the workspace budget this month (the shared ledger). */
  budget(): Promise<{ spentUsd: number; limitUsd: number | null } | null>
  /** The messages of a session of the client (DM requests), newest `limit`, chronological. */
  requests(sessionId: string, limit: number): Promise<Array<{ text: string; at: number }>>
  /** Fire one beat now (the web's "Run now"); a skip says why and costs no model call. */
  run(agentId: string, at: number): Promise<{ started: boolean; reason?: string }>
  /**
   * The tools the agent has for the needs of an order (`web`, `browser`, `phone/<slug>`), and the
   * needs it has no tool for. Absent = none are known.
   */
  needsTools?(agentId: string, needs: readonly string[]): { tools: string[]; missing: string[] }
  /** A session still has stored messages (a note's reference to it resolves). Absent = unknown. */
  sessionExists?(sessionId: string): Promise<boolean>
  /** The chat side of the heartbeat; absent when channels are not set up. */
  channels?: HeartbeatChannels
  /** Reports to a web chat thread (the destination of an order that was asked there). */
  web?: {
    deliver(input: {
      agentId: string
      sessionId: string
      text: string
      key: string
    }): Promise<{ posted: boolean; reason?: string }>
  }
}

/** What the heartbeat reads of the chat gateway (`infra/eh/heartbeat-channels.ts`). */
export interface HeartbeatChannels {
  /** The places a beat may report to: postable conversations of the agent's connections. */
  destinations(agentId: string): HeartbeatDestinationView[]
  /** Every conversation of the agent's connections (the watch rule picks among them). */
  nodes(agentId: string): WatchNode[]
  /** New messages of others in each node in `[since, until)`. */
  activity(nodes: readonly WatchNode[], since: number, until: number): Promise<ChatActivity[]>
  /** The agent bound to a connection. */
  agentOf(connectionId: string): string | undefined
  /** What a person (identity id) is today: undefined when the identity is gone. */
  roleOf?(identityId: string): string | undefined
  /**
   * Can this person (identity id) read the conversation themselves today: an owner or an admin any
   * chat, a member the chats they belong to and their divisions, a guest none. The privacy rule of
   * the heartbeat's chat reads asks it per standing order giver. Absent = unknown.
   */
  canRead?(identityId: string, nodeId: string): boolean
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

/** What answering a decision parked on an external wait does (claim, effect, delivery in one step). */
export interface ParkedAnswer {
  status: 'approved' | 'rejected'
  note: string
  decidedAt: number
  /** Stored with the decision (`decision` is `approved`, `rejected` or the option picked). */
  outcome: DecisionOutcome
  /** The payload as approved (an amendment the client narrowed). */
  payload?: Decision['payload'] | undefined
  /** What the agent reads. */
  answer: DecisionAnswer
  /** Runs after the claim, before the session is told; a throw reopens the decision. */
  beforeDeliver?: (() => void) | undefined
}

export type ParkedResult =
  | { kind: 'delivered'; decision: Decision; delivery: 'resumed' | 'recorded' }
  /** The session no longer waits (stopped, timed out, deleted). */
  | { kind: 'gone'; decision: Decision }
  /** Somebody decided first (or it expired): `status` is what it is now. */
  | { kind: 'closed'; status: DecisionStatus }

/**
 * Answers a decision parked on an external wait: the first answer wins, then the session resumes
 * (`infra/eh/decision-handoff.ts`, over `eharness/handoff`). Throws, with the decision open again,
 * when the effect or the delivery fails.
 */
export interface DecisionHandoff {
  answerParked(decision: Decision, answer: ParkedAnswer): Promise<ParkedResult>
}

/** Cross-session reads on eharness sessions (answers are the library's `attention` routes) (implemented in `infra/eh/team-service.ts`). */
/** The long-run job of a background worker session (`eharness/limits` `longRun`, spec 33 §3). */
export interface WorkerJob {
  status: 'running' | 'finished' | 'stopped'
  chunk: number
  steps: number
  costUsd: number
  startedAt: number
  updatedAt: number
  checkpoint: string | null
  stopReason: string | null
}

export interface TeamPort {
  /** The long-run job of a worker task session; undefined for any other task or before its first turn. */
  workerJob(task: Task): Promise<WorkerJob | undefined>
  /** Stop a running worker job (the running turn is aborted, no further chunk starts). False when it does not run. */
  stopWorkerJob(task: Task, reason?: string): Promise<boolean>
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

/** A tool call of a stored session, before the session is resolved to an agent or a program. */
export type StoredTool = Omit<ToolEvent, 'agentId' | 'programId' | 'link'>

/** A row of the model call log, the columns agent health reads. */
export interface StoredCall {
  id: string
  sessionId: string | null
  agentId: string | null
  at: number
  kind: string
  status: string
  inputTokens: number | null
  errorName: string | null
  errorMessage: string | null
}

/** What agent health reads and keeps (`infra/db/health-repo.ts`). */
export interface HealthStore {
  /** Tool calls and error notices of the assistant messages created since `since` (ms), newest first. */
  scanMessages(since: number): {
    tools: StoredTool[]
    notices: Array<{ sessionId: string; at: number; code: string; message: string }>
  }
  /** Model calls started since `since`, oldest first. */
  calls(since: number): StoredCall[]
  /** Creation time of the newest message of a session (when a pending approval started waiting). */
  lastMessageAt(sessionId: string): number | null
  /** Dismissed fingerprints and when. */
  dismissed(): Map<string, number>
  dismiss(fingerprint: string, now: number): void
  /** False when it was not dismissed. */
  restore(fingerprint: string): boolean
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

/** Artifacts (`infra/artifacts/service.ts`, docs/plans/P45-team-artifacts.md). */
export interface ArtifactsPort {
  list(query: {
    query?: string | undefined
    kind?: string | undefined
    agentId?: string | undefined
    limit: number
    cursor?: string | undefined
  }): { items: ArtifactSummary[]; nextCursor: string | null }
  get(id: string): Artifact | undefined
  versions(id: string): ArtifactVersionView[] | undefined
  viewUrl(
    id: string,
    opts: { version?: number | undefined; path?: string | undefined },
  ): Promise<SignedUrl>
  create(input: NewArtifact): Promise<Artifact>
  patch(id: string, patch: ArtifactPatch): Promise<Artifact>
  /** Editor save: a compare-and-set write of the entry file, then a version by the web. */
  saveEntry(id: string, content: string, ifVersion: string | null | undefined): Promise<Artifact>
  exportOf(id: string, format: string, version?: number): Promise<ArtifactExport>
  remove(id: string): void
  share(token: string): ArtifactShare | undefined
  /** A signed raw view URL of a library file (the caller checked the path). */
  libraryViewUrl(path: string): Promise<SignedUrl>
}

/** The workspace settings row (`infra/db/settings-repo.ts`). */
export interface SettingsStore {
  get(): WorkspaceSettings & { updatedAt: number }
  patch(patch: SettingsPatch, now: number): WorkspaceSettings & { updatedAt: number }
}

/** The workspace pause gate (`infra/db/pause-repo.ts`, `domain/pause.ts`). */
/** The unified event stream over channel events and app events (`infra/events/stream.ts`). */
export interface EventStreamPort {
  list(query: StreamQuery): Promise<StreamPage>
  get(id: string): Promise<StreamEvent | undefined>
  /** The connections that have events, with their label (the Events page filter). */
  sources(): Promise<
    Array<{ id: string; label: string; platform: string; transport?: 'bot' | 'user' }>
  >
}

/** A trigger row to store; the webhook secret arrives sealed. */
export interface NewTriggerRow {
  id: string
  name: string
  enabled: boolean
  eventTypes: string[]
  scope: TriggerScope
  filters: TriggerFilters
  action: TriggerAction
  sealedSecret: string | null
  cooldownSec: number
  allowSelf: boolean
  createdBy: string
  notes: string | null
  now: number
}

export type TriggerPatchRow = Partial<
  Omit<NewTriggerRow, 'id' | 'createdBy' | 'now' | 'sealedSecret'>
> & { sealedSecret?: string | null }

export interface TriggerStore {
  list(): Trigger[]
  get(id: string): Trigger | undefined
  insert(row: NewTriggerRow): Trigger
  update(id: string, patch: TriggerPatchRow, now: number): Trigger | undefined
  delete(id: string): boolean
  /** Newest first, cursor paged (`before` = a fire id). */
  fires(query: {
    triggerId?: string | undefined
    result?: string | undefined
    before?: string | undefined
    limit: number
  }): { items: TriggerFire[]; next?: string }
  /** Firings whose action ran (result ok or error) since `since`: what the hourly cap counts. */
  executedSince(since: number): number
}

/** Seals a webhook secret with the server's secret vault; the plain value is never stored or returned. */
export interface TriggerSecrets {
  seal(triggerId: string, secret: string): Promise<string>
}

/** What the engine knows that a dry run needs. */
export interface TriggerEnginePort {
  /** Problems the action would run into now (agent gone, no program, chat has no session, webhook host private); empty = fine. */
  preflight(trigger: Trigger, event: StreamEvent): Promise<string[]>
  /** Are webhooks to plain http and local hosts allowed (development)? */
  allowPrivateWebhooks: boolean
  /** Why a webhook URL may not be called (a private, local or internal host), or undefined. */
  webhookBlocked(url: string): Promise<string | undefined>
  /** Firings the engine skipped without a stored row, per trigger (since the server started). */
  filteredCount(triggerId: string): number
}

export interface PauseStore {
  get(): WorkspacePause
  set(state: WorkspacePause, now: number): void
  /** Resume; remembers the window `[pausedAt, now]` for `lastWindow`. */
  clear(now: number): void
  /** The most recent finished pause: one-shot slots due inside it fire once after Resume. */
  lastWindow(): { pausedAt: number; resumedAt: number } | null
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
  /** Keys (`sys:...`) of the active system routines: heartbeats, the digest, reminders, order wakes. */
  activeSystemKeys(): string[]
  /** Runs recorded as skipped with this reason since `since` (ms). */
  countSkipped(reason: string, since: number): number
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
  /** Run the scheduler once now (resume after Pause all). Absent on engines without a ticker. */
  tick?(): Promise<unknown>
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
  /**
   * Where the model a profile uses when nothing picks one comes from: `env` (`TEAM_MODEL` on the
   * env default profile) or `built-in` (the provider's fallback, never chosen by a person).
   */
  defaultModelSource(profileId: string): 'env' | 'built-in'
  /** The built-in model of `web_search` on this profile; undefined when the profile cannot search. */
  searchModelOf(profileId: string): string | undefined
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
  /** One page of the chats (or topics) of the connection: SQL filter, sort and count. */
  chatsTable(id: string, query: ChannelChatsQuery): Promise<TablePage<ChannelNodeView>>
  /** One chat or topic with its own and inherited settings. */
  chat(id: string, nodeId: string): Promise<ChannelNodeView>
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

/** One person of the directory (P43) as the People page lists it. */
export interface PersonListItem {
  id: string
  displayName: string
  nickname: string | null
  status: 'active' | 'suspended' | 'left'
  /** null = the connection or chat default. */
  role: 'owner' | 'admin' | 'member' | 'guest' | null
  divisions: Array<{ nodeId: string; title: string }>
  fields: Record<string, string>
  accountCount: number
  accounts: Array<{ platform: string; label: string | null; username: string | null }>
  updatedAt: number
}

export interface PersonAccountView {
  id: string
  platform: string
  nativeId: string
  label: string | null
  /** The connection where the account was seen (absent: never seen). */
  connectionId: string | null
  name: string | null
  username: string | null
}

export interface PersonDetail extends PersonListItem {
  notes: string
  memberId: string | null
  createdAt: number
  accountViews: PersonAccountView[]
  events: Array<{
    id: string
    kind: string
    actor: string | null
    detail: Record<string, unknown>
    at: number
  }>
}

export interface UnassignedAccountView {
  connectionId: string
  platform: string
  peerId: string
  name: string | null
  username: string | null
}

export interface PersonPatchInput {
  displayName?: string
  nickname?: string | null
  status?: 'active' | 'suspended' | 'left'
  role?: 'owner' | 'admin' | 'member' | 'guest' | null
  divisions?: string[]
  fields?: Record<string, string | null>
  notes?: string
}

/** The people directory for the web app (P43): persons, accounts, pairing codes. The actor is always `web`. */
export interface PeoplePort {
  list(query: { q?: string; page: number; limit: number }): Promise<TablePage<PersonListItem>>
  get(id: string): Promise<PersonDetail>
  create(input: PersonPatchInput & { displayName: string; id?: string }): Promise<PersonDetail>
  update(id: string, patch: PersonPatchInput): Promise<PersonDetail>
  link(
    id: string,
    input: { connectionId: string; peerId: string; label?: string },
  ): Promise<PersonDetail>
  setLabel(id: string, accountId: string, label: string | null): Promise<PersonDetail>
  unlink(id: string, accountId: string): Promise<PersonDetail>
  /** Delete a person: their accounts belong to nobody (guests until linked), the history stays. */
  remove(id: string): Promise<void>
  pairingCode(id: string): Promise<{ code: string; expiresAt: number }>
  unassigned(limit: number): Promise<UnassignedAccountView[]>
  fromAccount(input: { connectionId: string; peerId: string }): Promise<PersonDetail>
  /** Chats and topics a person can be given as divisions, across connections. */
  nodes(): Promise<Array<{ id: string; connectionId: string; label: string }>>
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
  /** One page of the conversations: SQL filter, sort and count. */
  inboxTable(
    id: string,
    query: ChannelInboxTableQuery,
  ): Promise<TablePage<ChannelInboxPage['items'][number]>>
  conversation(
    id: string,
    conversationId: string,
    options: { limit: number; before?: string },
  ): Promise<ChannelConversationLog>
  activity(id: string, query: ChannelActivityQuery): Promise<ChannelActivityPage>
  /** Messages whose delivery is uncertain or failed and not dismissed, newest first. */
  outboxAttention(
    id: string,
    query: { limit: number; before?: string },
  ): Promise<ChannelOutboxAttentionPage>
  /** "Send again": re-queue a failed message (not a tool call). It may appear twice. */
  retryOutbox(id: string, rowId: string): Promise<void>
  /** Mark a failed message reviewed so it leaves the list. Nothing is deleted. */
  dismissOutbox(id: string, rowId: string): Promise<void>
  /** The action and read names recorded in the activity (the Activity filter). */
  activityActions(id: string): Promise<string[]>
  /** Platform actions of every connection, newest first, cursor paged (the Audit page and export). */
  audit(query: ChannelAuditQuery): Promise<ChannelAuditPage>
  /** One page of activity: SQL filter and count, newest first by default. */
  activityTable(
    id: string,
    query: ChannelActivityTableQuery,
  ): Promise<TablePage<ChannelActivityPage['items'][number]>>
  /** The people directory (roles, divisions, suggestions from the platform's admins). */
  people(id: string): Promise<ChannelPersonView[]>
  /** One page of the directory: SQL filter, sort and count. */
  peopleTable(id: string, query: ChannelPeopleQuery): Promise<TablePage<ChannelPersonView>>
  /** One person of the directory. */
  person(id: string, peerId: string): Promise<ChannelPersonView>
  setRole(
    id: string,
    peerId: string,
    input: { role: ChannelRole; divisions?: string[] },
  ): Promise<ChannelPersonView>
  clearRole(id: string, peerId: string): Promise<void>
  /** Set the role of many people at once (through the same path as one role). */
  bulkRole(id: string, input: ChannelBulkRoleInput): Promise<ChannelBulkRoleResult>
  /** Who the platform and the chats suggest as admins and members (read-only, never applied). */
  roleSuggestions(id: string, options: { nodeId?: string }): Promise<ChannelRoleSuggestions>
  importAdmins(id: string): Promise<{ chats: number; people: number; problems: string[] }>
  peopleSettings(id: string): Promise<ChannelPeopleSettings>
  setPeopleSettings(
    id: string,
    input: Partial<ChannelPeopleSettings>,
  ): Promise<ChannelPeopleSettings>
  reminders(id: string, options: { all: boolean }): Promise<ChannelReminderView[]>
  /** One page of the reminders of a connection: SQL filter, sort and count. */
  remindersTable(id: string, query: ChannelRemindersQuery): Promise<TablePage<ChannelReminderView>>
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

/** What a snapshot download answers: the bytes as a stream, with a file name. */
export interface BackupDownload {
  stream: ReadableStream<Uint8Array>
  size: number
  filename: string
  mediaType: string
}

/** A workspace zip read and verified: its manifest and every file by entry path (manifest excluded). */
export interface ParsedWorkspaceZip {
  manifest: WorkspaceManifest
  entries: Map<string, Uint8Array>
  /**
   * Library and memory files whose bytes differ from the manifest, files the manifest does not list,
   * and listed files that are gone: the zip was reorganized offline. Tolerated for files only; every
   * other document must match its hash.
   */
  edited: { changed: number; added: number; removed: number }
}

/** Snapshots of the database, the workspace export and restore from them (`infra/backup`). */
export interface BackupPort {
  /** The directory the snapshots are written to. */
  readonly dir: string
  /** The directory is temporary storage: a container restart clears it. */
  readonly temporary?: boolean
  /**
   * Take a verified snapshot. Throws only when no copy could be written at all. `entities` are the
   * documents of the workspace export (settings, agents, programs...) the app collected; the
   * library and memory files are read from the verified copy.
   */
  create(reason: string, entities?: readonly EntityFile[]): Promise<BackupRecord>
  /** The workspace export of the live database, as a zip to download now. */
  exportNow(entities: readonly EntityFile[]): Promise<BackupDownload>
  /** Read and verify a workspace zip (limits, paths, manifest hashes); throws `IMPORT_REFUSED`. */
  readWorkspace(source: ImportSource): Promise<ParsedWorkspaceZip>
  /** Verify an uploaded zip and keep it for the import that follows; returns its id. */
  stageUpload(bytes: Uint8Array, name: string): Promise<{ uploadId: string; name: string }>
  /** Write a library or memory file (`ifVersion` null = create only). */
  writeFile(
    path: string,
    bytes: Uint8Array,
    options: { ifVersion: string | null; mediaType: string | null; binary: boolean },
  ): Promise<boolean>
  /** Delete a library or memory file; false when it changed meanwhile or is gone. */
  deleteFile(path: string, ifVersion: string): Promise<boolean>
  /**
   * Move a library or memory file as a move (its history follows; the old path gets a deletion).
   * `missing`: no file at `from`; `exists`: `to` is taken; `conflict`: it changed meanwhile.
   */
  moveFile(
    from: string,
    to: string,
    ifVersion: string | null,
  ): Promise<'ok' | 'missing' | 'exists' | 'conflict'>
  /** The moves imports applied, for the redirects of the agents' file system (`library_moves`). */
  moves: {
    list(): LibraryMove[]
    add(moves: readonly LibraryMove[]): void
    /** Forget the moves of one import (its undo). */
    removeOf(restorePointId: string): number
  }
  /** Active reminders (a reference in the export: they are tied to chats). */
  activeReminders(): ReminderRecord[]
  restorePoints: {
    list(): RestorePoint[]
    get(id: string): RestorePoint | undefined
    add(point: RestorePoint): void
    /** Mark a restore point as undone by another. */
    markUndone(id: string, by: string): void
  }
  /** The rows of the data tables of the export (`domain/workspace-data.ts`). */
  data: {
    /** Every row of the dataset of a table (its filter, columns and order). */
    rows(table: string): DataRow[]
    /** Write rows: `ignore` adds the missing ones, `replace` also updates the ones that are here. */
    put(
      table: string,
      rows: readonly DataRow[],
      mode: 'ignore' | 'replace',
    ): { added: number; updated: number }
    /** Delete the rows that match by key; returns how many. */
    remove(table: string, rows: readonly DataRow[]): number
    /** Row count of every table of the live database. */
    counts(): Record<string, number>
  }
  /** Restore of the whole database: staged, swapped in at the next start (`infra/backup/database-restore.ts`). */
  database: {
    /** The live database file; undefined for an in-memory database. */
    readonly file: string | undefined
    /** Row counts of every table of a backup's database copy. */
    counts(backupId: string): Record<string, number> | undefined
    /** Verify the copy of a backup and stage it for the next start; throws a readable `DomainError`. */
    stage(backupId: string, info: PendingDatabaseRestore): void
    /** The restore that waits for the restart, if any. */
    pending(): PendingDatabaseRestore | undefined
    /** Drop the staged restore. */
    cancel(): void
    /** What the last start did with a staged restore. */
    lastResult():
      | { ok: boolean; at: number; backupId: string; restorePointId: string; error: string | null }
      | undefined
  }
  /** Newest first. */
  list(): BackupRecord[]
  get(id: string): BackupRecord | undefined
  remove(id: string): boolean
  download(id: string, what: 'db' | 'files'): BackupDownload | undefined
  /** Files of a snapshot under a prefix (`/` = all). */
  entries(
    id: string,
    prefix: string,
    limit: number,
  ): Array<{ path: string; size: number; updatedAt: number }> | undefined
  restorePlan(id: string, scope: string, mode: RestoreMode): RestorePlan | undefined
  restore(id: string, scope: string, mode: RestoreMode): Promise<RestoreResult | undefined>
}

/** A restore of the whole database that waits for the restart of the server. */
export interface PendingDatabaseRestore {
  backupId: string
  safetyBackupId: string
  restorePointId: string
  stagedAt: number
}

/** Restarts the process so a staged database restore is applied (the process manager starts it again). */
export interface Lifecycle {
  restart(): void
}

/**
 * The stored secrets (provider keys, connection credentials, OAuth client credentials) as the
 * workspace export carries them, encrypted by the export itself. Plain values live in memory only
 * while an export or a restore runs; nothing here logs them.
 */
export interface SecretsPort {
  /**
   * The stored rows of the connections that are not built in, WITHOUT their `settings` (which hold
   * the secret fields): what the zip needs to create a connection before its secrets come back.
   */
  connectionRows(): Promise<Array<{ id: string; profile: Record<string, unknown> }>>
  /** Every stored secret, plain, grouped as `SecretRecord` (a connection with its credentials). */
  list(): Promise<SecretRecord[]>
  /** Write a record back under its own ids (overwrites what is stored there). */
  put(record: SecretRecord): Promise<void>
  /** Tell the running server that secrets were written (reload the provider profiles). */
  changed(): Promise<void>
}

/** What Settings > Storage reads and does: the scan of the data directory and the maintenance actions. */
export interface StoragePort {
  /** The scan, reused for 60 s (`refresh` forces a new one). */
  report(options?: { refresh?: boolean }): Promise<StorageReport>
  /** The data volume alone (cheap, never cached): the low-disk alarm reads it. */
  volume(): (VolumeInfo & { path: string }) | null
  /** One maintenance action; throws a `DomainError` when it must not run. */
  run(action: StorageAction, options?: { days?: number }): Promise<StorageActionResult>
}

export interface Deps {
  agents: AgentRepo
  /** The storage scan and maintenance; absent for an in-memory database. */
  storage?: StoragePort
  /** Snapshots and restore; absent for an in-memory database without `TEAM_BACKUP_DIR`. */
  backups?: BackupPort
  /** Secrets for the encrypted part of the workspace export; absent: exports never hold secrets. */
  secrets?: SecretsPort
  /** Restarts the server after a whole-database restore was staged; absent: the owner restarts it. */
  lifecycle?: Lifecycle
  persona: PersonaStore
  chat: ChatPort
  chatTools: ChatToolsPort
  sessionTools: SessionToolsPort
  threads: ThreadStore
  notifications: NotificationStore
  alarms: AlarmStore
  /** Owner delivery of alarms; absent: only the bell. */
  alarmPush?: AlarmPush
  /** Interrupts a stuck run (the same abort as the Stop button). */
  interruptRun?: RunInterrupter
  /**
   * Resume after Pause all, for the chat messages the hold kept: answer them (once per
   * conversation) or drop them. Absent without channels.
   */
  channelsResume?: (options: {
    answer: boolean
    maxAgeMs: number
  }) => Promise<{ conversations: number; messages: number }>
  uploads: UploadStore
  tasks: TaskStore
  turnRetry: TurnRetryPort
  team: TeamPort
  library: LibraryStore
  artifacts: ArtifactsPort
  settings: SettingsStore
  /** Pause all: while paused nothing automatic starts (read per decision). */
  pause: PauseStore
  /** The unified event stream (channel events and app events). */
  eventStream: EventStreamPort
  /** Triggers: event listeners with an action (`infra/triggers`). */
  triggers: TriggerStore
  triggerSecrets: TriggerSecrets
  triggerEngine: TriggerEnginePort
  providers: ProvidersPort
  connectors: ConnectorsPort
  channels: ChannelsPort
  channelAccounts: ChannelAccountsPort
  channelInbox: ChannelInboxPort
  people: PeoplePort
  /** Where the browser app lives (the OAuth callback redirects back to it). */
  webUrl: string
  /** The code sandbox of the Files & Sandbox connector (Settings shows its status). */
  codeSandbox?: { info(): Promise<CodeSandboxInfo> }
  /** The browser (`infra/browser`, plan P48): the manager, the profiles and the driver status. */
  browser?: BrowserPort
  modes: ModePort
  routines: RoutineStore
  schedule: ScheduleCalc
  routineEngine: RoutineEngine
  programs: ProgramStore
  programRunner: ProgramRunner
  /** One plain model call with an agent's own model (P57: the memory reorganization proposal). */
  completion?: AgentCompletion
  programMemory: ProgramMemoryStore
  decisions: DecisionStore
  decisionResolver: DecisionResolver
  decisionHandoff: DecisionHandoff
  heartbeat: HeartbeatPorts
  events: EventAppender
  modelCalls: ModelCallStore
  health: HealthStore
  clock: Clock
  ids: IdGenerator
  workspaceId: string
}

// --- browser (app-owned structural copies of `eharness/browser`; `infra/browser/port.ts` implements) ---

export type BrowserMode = 'manual' | 'managed'

export interface BrowserCapabilitiesView {
  snapshot: boolean
  screenshot: boolean
  liveView: 'screencast' | 'poll' | 'external' | 'none'
  takeover: boolean
  tabs: boolean
  persistentProfile: boolean
}

/** A stored browser profile (settings in plain form; only `infra/browser` sees ciphertext). */
export interface BrowserProfileRecord {
  id: string
  name: string
  adapter: string
  mode: BrowserMode
  settings: Record<string, unknown>
  allowDomains?: string[]
  trusted?: boolean
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown>
}

/** A profile with its secrets replaced by `{ set, hint }`. */
export type BrowserPublicProfileRecord = BrowserProfileRecord

export interface BrowserProfileCreateInput {
  name: string
  adapter: string
  mode: BrowserMode
  settings: Record<string, unknown>
  allowDomains?: string[]
  trusted?: boolean
  metadata?: Record<string, unknown>
}

export interface BrowserProfilePatchInput {
  name?: string
  settings?: Record<string, unknown>
  allowDomains?: string[]
  trusted?: boolean
}

export interface BrowserProfilesPort {
  create(input: BrowserProfileCreateInput): Promise<BrowserProfileRecord>
  get(id: string): Promise<BrowserProfileRecord | null>
  list(query?: {
    limit?: number
    cursor?: string
  }): Promise<{ items: BrowserProfileRecord[]; nextCursor?: string }>
  update(
    id: string,
    patch: BrowserProfilePatchInput,
  ): Promise<{ ok: true; profile: BrowserProfileRecord } | { ok: false; reason: string }>
  delete(id: string): Promise<boolean>
}

export interface BrowserFormSpecView {
  fields: ProviderFieldView[]
  jsonSchema: Record<string, unknown>
}

export interface BrowserAdapterInfoView {
  id: string
  label: string
  description?: string
  modes: BrowserMode[]
  capabilities: Partial<Record<BrowserMode, BrowserCapabilitiesView>>
}

/** The managed runtime of an adapter (download, remove). */
export interface BrowserRuntimeControl {
  status(): Promise<{ state: string; running?: string[] }>
  install(): Promise<void>
  uninstall?(): Promise<void>
  removeProfileData?(profileId: string): Promise<void>
}

export interface BrowserAdapterHandle {
  id: string
  label: string
  modes: readonly BrowserMode[]
  runtime(): BrowserRuntimeControl | undefined
}

export interface BrowserLeaseView {
  profileId: string
  holder: { kind: 'session' | 'person'; id: string }
  controller: { by: 'agent' | 'human'; holder?: string; since: number; reason?: string }
  since: number
  page?: { url: string; title: string }
  viewers: number
}

export interface BrowserHandBackInfo {
  by: string
  at: number
  page?: { url: string; title: string }
  reason: 'handed-back' | 'viewer-left'
}

export type BrowserTestOutcome = { ok: true; version: string } | { ok: false; error: string }

export interface BrowserUsageData {
  profiles: Array<{ profileId: string; adapter: string; rssBytes?: number; cpuPercent?: number }>
  totals: { rssBytes: number; cpuPercent: number }
  system?: { totalBytes: number; freeBytes: number }
}

/** What a person may send on the live socket (coordinates in the frame's pixels). */
export type BrowserLiveInput =
  | {
      type: 'mouse'
      event: 'move' | 'down' | 'up' | 'wheel'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
      clickCount?: number
      deltaX?: number
      deltaY?: number
      modifiers?: number
    }
  | {
      type: 'key'
      event: 'down' | 'up' | 'char'
      key: string
      code?: string
      text?: string
      modifiers?: number
    }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }

export interface BrowserLiveFrame {
  seq: number
  data: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
  at: number
}

/** One viewer of a profile's live view. */
export interface BrowserLiveChannel {
  info: {
    width: number
    height: number
    liveView: BrowserCapabilitiesView['liveView']
    liveUrl?: string
  }
  frames: ReadableStream<BrowserLiveFrame>
  controller(): BrowserLeaseView['controller']
  takeOver(): Promise<string | undefined>
  handBack(): Promise<string | undefined>
  input(event: BrowserLiveInput): Promise<string | undefined>
  close(): void
}

export interface BrowserLiveRefusal {
  refused: true
  kind: 'busy' | 'limit' | 'error'
  text: string
}

/** The browser as the routes and use cases see it (`infra/browser/port.ts`). */
export interface BrowserPort {
  readonly driver: BrowserDriver
  readonly max: number
  /** Can a managed Chrome on this server run with a window (a display or `TEAM_BROWSER_XVFB`)? */
  readonly windows: boolean
  /** Profiles with plain settings (the table holds ciphertext of secret fields). */
  readonly profiles: BrowserProfilesPort
  adapters(): BrowserAdapterInfoView[]
  adapter(id: string): BrowserAdapterHandle | undefined
  forms(adapterId: string): { manual?: BrowserFormSpecView; managed?: BrowserFormSpecView }
  /** Throws `EH_CONFIG_INVALID` for bad settings. */
  validate(
    adapterId: string,
    mode: BrowserMode,
    settings: Record<string, unknown>,
  ): Record<string, unknown>
  merge(
    adapterId: string,
    mode: BrowserMode,
    stored: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Record<string, unknown>
  publicProfile(profile: BrowserProfileRecord): BrowserPublicProfileRecord
  capabilities(profile: BrowserProfileRecord): BrowserCapabilitiesView | undefined
  leases(): Promise<BrowserLeaseView[]>
  start(profileId: string): Promise<{ ok: true } | { ok: false; error: string }>
  stop(profileId: string): Promise<void>
  test(
    target:
      | BrowserProfileRecord
      | { adapter: string; mode: BrowserMode; settings: Record<string, unknown> },
  ): Promise<BrowserTestOutcome>
  usage(): Promise<BrowserUsageData>
  /** Attach a viewer to the live view of a profile. */
  live(profileId: string, viewer: { id: string }): Promise<BrowserLiveChannel | BrowserLiveRefusal>
  /** Controller changes and takeovers of a profile; returns the unsubscribe function. */
  onChange(listener: (event: { profileId: string; type: string }) => void): () => void
  /** What the agent is told when a person hands the browser back. */
  formatHandBack(info: { by: string; page?: { url: string; title: string } }): string
  runtimes(): Promise<BrowserRuntimeView[]>
  /** The runtime of the connected Remote sandbox (`chrome@remote`), undefined when none. */
  remoteRuntime(): Promise<BrowserRuntimeControl | undefined>
  info(): Promise<BrowserInfo>
}
