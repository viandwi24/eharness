/** Ports the use cases depend on; `infra/` implements them. */
import type { AgentDef } from '../domain/agents.ts'
import type { ApprovalAnswer, ApprovalView } from '../domain/approvals.ts'
import type { NewEvent, TeamEvent } from '../domain/events.ts'
import type { LibraryFileMeta, LibraryVersion } from '../domain/library.ts'
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
  /** Replace the row; `expectedVersion` guards concurrent edits (returns false on conflict). */
  update(def: AgentDef, expectedVersion: number): boolean
  count(): number
}

/** A UI message as the app sees it: JSON data, shaped by the AI SDK (`UIMessage`). */
export interface ChatMessage {
  id?: string
  role: string
  parts: Array<Record<string, unknown>>
  metadata?: unknown
}

/** A `useChat` request, already validated and cut down to what the server reads. */
export interface ChatInput {
  /** Exactly the last message of the client (the server never reads the client history). */
  messages: ChatMessage[]
  trigger?: 'submit-message' | 'regenerate-message'
  messageId?: string
}

export type Actor = { id: string; name?: string }

/** What a chat request produced: a UI message stream, or an input handed to another instance. */
export type ChatOutcome =
  | { kind: 'stream'; response: Response }
  | { kind: 'queued'; inboxId: string; target: 'local' | 'remote' }

export interface ChatStats {
  running: boolean
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
  /**
   * `ifBusy: 'steer'` hands the message to the running turn (this instance, or another one
   * through the durable inbox); `'reject'` answers 409 `EH_SESSION_BUSY`.
   */
  chat(
    agent: AgentDef,
    input: ChatInput,
    options: { actor: Actor; ifBusy: 'steer' | 'reject' },
  ): Promise<ChatOutcome>
  /** `204` when nothing streams; else the UI message stream of the active turn (any instance). */
  resume(agent: AgentDef, request: Request): Promise<Response>
  abort(
    agent: AgentDef,
    reason?: string,
  ): Promise<{ target: 'local' | 'remote' | 'idle' | 'unsupported' }>
  /** Newest `limit` messages before `before`, chronological. */
  messages(
    agent: AgentDef,
    query: { before?: string; limit: number },
  ): Promise<{ messages: ChatMessage[]; nextBefore: string | null }>
  /** `message` is the summary kind message, or null when there was nothing to compact. */
  compact(agent: AgentDef): Promise<{ compacted: boolean; message: ChatMessage | null }>
  stats(agent: AgentDef): Promise<ChatStats>
  /** Stats plus the tools the model sees in the next request (opens the session). */
  context(agent: AgentDef): Promise<{ stats: ChatStats; tools: ToolInfo[] }>
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
  /** Tasks the agent runs (`owned`) and tasks it handed to others from its DM (`delegated`). */
  ofAgent(agentId: string, dmSessionId: string): { owned: Task[]; delegated: Task[] }
  /** Events with `seq > after`, oldest first. */
  events(after: number, limit: number): TeamEvent[]
  lastSeq(): number
  /** Activity of every agent that has any, by agent id. */
  activity(): Map<string, AgentActivity>
  /** Everything up to the latest message event is read. Returns the marker. */
  markRead(agentId: string): number
}

/** Cross-session reads and answers on eharness sessions (implemented in `infra/eh/team-service.ts`). */
export interface TeamPort {
  /** Stored messages of a task session (newest `limit`, chronological). */
  taskMessages(task: Task, limit: number): Promise<ChatMessage[]>
  /**
   * Everything waiting for a person, across DM chats and task sessions, on any instance. With
   * `sessionId` only that session is read (cheap: used when answering).
   */
  approvals(only?: { sessionId?: string }): Promise<ApprovalView[]>
  /**
   * Answer one item with `respond()` on its session (this instance continues the turn). Resolves
   * once the answer is recorded; a rejected answer (stale, already answered) throws.
   */
  answer(view: ApprovalView, answer: ApprovalAnswer, actor: Actor): Promise<void>
  /** `requestAbort()` on the task session, from any instance. */
  abortTask(
    task: Task,
    reason?: string,
  ): Promise<{ target: 'local' | 'remote' | 'idle' | 'unsupported' }>
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

/** Appends to the event feed from use cases (routines, settings). */
export interface EventAppender {
  append(event: NewEvent): number
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
  list(query: { agentId?: string }): Routine[]
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

export interface Deps {
  agents: AgentRepo
  chat: ChatPort
  uploads: UploadStore
  tasks: TaskStore
  team: TeamPort
  library: LibraryStore
  settings: SettingsStore
  routines: RoutineStore
  schedule: ScheduleCalc
  routineEngine: RoutineEngine
  events: EventAppender
  clock: Clock
  ids: IdGenerator
  workspaceId: string
  /** How often the SSE feed polls the events table (ms). Default 500. */
  eventsPollMs?: number
}
