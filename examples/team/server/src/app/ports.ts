/** Ports the use cases depend on; `infra/` implements them. */
import type { AgentDef } from '../domain/agents.ts'
import type { ApprovalView } from '../domain/approvals.ts'
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
import type {
  Decision,
  DecisionAnswer,
  DecisionKind,
  DecisionOutcome,
  DecisionStatus,
} from '../domain/decisions.ts'
import type { NewEvent } from '../domain/events.ts'
import type { LibraryFileMeta, LibraryVersion } from '../domain/library.ts'
import type {
  ModelCallDetail,
  ModelCallFilter,
  ModelCallListQuery,
  ModelCallPage,
  ModelCallStats,
} from '../domain/model-calls.ts'
import type { AgentModeChoice, ModeSource, TeamMode } from '../domain/modes.ts'
import type { Program } from '../domain/programs.ts'
import type {
  ModelView,
  ProfileCreate,
  ProfilePatch,
  ProfileView,
  ProviderDefinitionView,
  TestResultView,
} from '../domain/providers.ts'
import type { Routine, RoutineRun, RoutineSpec } from '../domain/routines.ts'
import type { SettingsPatch, WorkspaceSettings } from '../domain/settings.ts'
import type { Task, TaskStatus } from '../domain/tasks.ts'

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
  compact(agent: AgentDef): Promise<{ compacted: boolean; message: ChatMessage | null }>
  stats(agent: AgentDef): Promise<ChatStats>
  /** Stats plus the tools the model sees in the next request (opens the session). */
  context(agent: AgentDef): Promise<{ stats: ChatStats; tools: ToolInfo[] }>
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
  get(agent: AgentDef): Promise<ChatToolsState>
  /** Replace the connections switched off in this chat. */
  set(agent: AgentDef, off: string[], now: number): Promise<ChatToolsState>
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

/** Starts program runs (`infra/eh/program-service.ts`). */
export interface ProgramRunner {
  /**
   * Start the run of `runAt`: the task session `program:<id>:<runAt>` gets the run prompt and a
   * structured-output spec. Returns once the turn is started (not finished). `started: false`
   * when that run exists already (a recovered fire, a double click).
   */
  start(
    program: Program,
    options: { runAt: number },
  ): Promise<{ sessionId: string; started: boolean }>
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
  get(agent: AgentDef): ModeState
  /** Store a pick for the agent's DM chat; the caller validated it against `available`. */
  set(agent: AgentDef, mode: TeamMode, now: number): ModeState
}

/** Read side of the model call log (written by the `activityLog` plugin). */
export interface ModelCallStore {
  list(query: ModelCallListQuery): ModelCallPage
  /** Buckets and totals of a range; `bucketMs` default fits the range in about 60 buckets. */
  stats(query: ModelCallFilter & { from: number; to: number; bucketMs?: number }): ModelCallStats
  /** One call with its JSON columns and the ids of its neighbours under `filter`. */
  get(id: string, filter: ModelCallFilter): ModelCallDetail | undefined
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
export interface RoutineEngine {
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

export interface Deps {
  agents: AgentRepo
  chat: ChatPort
  chatTools: ChatToolsPort
  uploads: UploadStore
  tasks: TaskStore
  team: TeamPort
  library: LibraryStore
  settings: SettingsStore
  providers: ProvidersPort
  connectors: ConnectorsPort
  /** Where the browser app lives (the OAuth callback redirects back to it). */
  webUrl: string
  modes: ModePort
  routines: RoutineStore
  schedule: ScheduleCalc
  routineEngine: RoutineEngine
  programs: ProgramStore
  programRunner: ProgramRunner
  decisions: DecisionStore
  decisionResolver: DecisionResolver
  events: EventAppender
  modelCalls: ModelCallStore
  clock: Clock
  ids: IdGenerator
  workspaceId: string
}
