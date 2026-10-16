/**
 * Agent definition (a database row) -> `HarnessAgent` (docs/plans/P32-team-example.md §6.1).
 *
 * One agent object per definition version, many sessions: the cache key is `agentId@version`.
 * An edit bumps the version, so the next `agent.session(id)` of a chat gets a fresh agent while
 * open turns finish on the old one (retired agents are closed with the factory).
 *
 * Connectors decide the tools (`activateConnectors`, spec 24): the built-ins in their fixed order
 * (files, memory, planning, web, ask, team), then the other connectors by id; the plugin order is
 * identical for every session of an agent (prompt-cache prefix, `toolOrder`):
 * connectors -> chatTools -> decisions -> permissions -> child side of subagents -> routine outcomes -> taskIndex ->
 * activity (session events) -> activityLog (hook only).
 * Activation is asynchronous: `prepare` runs it, `agentFor` (synchronous) uses its result. Static instructions come first; the volatile parts (date, roster)
 * live in the turn reminder, never in `instructions` (spec 02 §5).
 *
 * Delegation (M4, ADR-0035 / ADR-0041): the lead gets `subagent({ approvals: 'park' })` with the
 * role agents of the DB roster; every other agent gets the child side of the same plugin
 * (`parentAgent` = the lead, `selfAgent` = itself) so it can `send_message` to `main` and reports
 * of resumed turns find their way back. All instances build the same plugin set, which waits
 * and reconcile need.
 *
 * Read with the walkthrough (docs/guides/walkthrough-server.md): sections 1 (definition, model,
 * prompt-cache order), 3 and 6 (`lock` with `takeOver`, `recovery.instanceId`), 7 (park +
 * background delegation), 8 (per-session permission engines), 11 (compaction, tool output) and
 * 12 (the shared budget ledger) explain what each block below is for and what breaks without it.
 */

import type { Database } from 'bun:sqlite'
import type { LanguageModel } from 'ai'
import {
  defineHarnessAgent,
  errorText,
  type HarnessAgent,
  type HarnessSession,
  type HarnessWarning,
  lookupModel,
  type ModelCatalog,
  type ModelInfo,
  type ObserveEvent,
  type SessionLock,
  type SessionPeek,
  type SessionStateSnapshot,
} from 'eharness'
import { type ActivityStore, activity } from 'eharness/activity'
import { clock, nowLine } from 'eharness/clock'
import type { ActivatedConnectors, BuiltinInput } from 'eharness/connectors'
import { type FileToolName, filesystem } from 'eharness/filesystem'
import {
  budgetNotice,
  type LongRunPlugin,
  type LongRunResumeResult,
  type LongRunState,
  longRun,
  stepBudget,
  trackRefusals,
} from 'eharness/limits'
import {
  type AutoClassifier,
  type AutoEvent,
  type AutoState,
  createPermissionEngine,
  matchRule,
  modelClassifier,
  type PermissionEngine,
} from 'eharness/permissions'
import { subagent } from 'eharness/subagent'
import type { EventAppender, PersonaStore, ProgramStore } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { READ_BRIEFINGS_TOOL } from '../../domain/briefings.ts'
import {
  isAllowedMediaType,
  isDmSession,
  LIBRARY_URL_PREFIX,
  libraryUrl,
  MAX_UPLOAD_BYTES,
  uploadPathOfUrl,
} from '../../domain/chat.ts'
import { SESSION_EVENT_TYPES } from '../../domain/events.ts'
import {
  HEARTBEAT_ALLOWED,
  HEARTBEAT_FILE_WRITES,
  HEARTBEAT_POST_TOOL,
  type HeartbeatDestination,
  heartbeatChannelRefusal,
  heartbeatRefusal,
  isFileWrite,
  ledgerWriteRefusal,
} from '../../domain/heartbeat.ts'
import { type DriftNote, pinnedServers, stripMcpPins } from '../../domain/mcp-pins.ts'
import {
  agentModeChoice,
  type ResolvedMode,
  resolveMode,
  type TeamMode,
  teamModeOf,
} from '../../domain/modes.ts'
import { nameOf, personaInstructions } from '../../domain/persona.ts'
import {
  type AuthoritySources,
  forbiddenReason,
  outsideAuthorityReason,
  PROGRAM_BASE_TOOLS,
  PROGRAM_FILE_TOOLS,
  type ProgramAuthority,
  parseProgramSession,
  programDayScope,
  programMaxOutputTokens,
  programRules,
  programRunScope,
  runFileTools,
  type ToolAvailability,
  toolWarnings,
  WORKER_TOOLS,
} from '../../domain/programs.ts'
import { HAND_OVER_REMINDER, LEAD_PLAYBOOK, ROLE_AGENT_NOTE } from '../../domain/prompts.ts'
import { isSimulatedCall, parseRehearsalSession, simulatedText } from '../../domain/rehearsal.ts'
import { originOfSession, profileOfSession } from '../../domain/run-profiles.ts'
import type { WorkspaceSettings } from '../../domain/settings.ts'
import { destKey, needTools } from '../../domain/standing-orders.ts'
import { parseChatSession } from '../../domain/threads.ts'
import { taskGrantRules } from '../../domain/work-queue.ts'
import {
  type ArtifactDecisions,
  type ArtifactService,
  createArtifactsHook,
} from '../artifacts/index.ts'
import { type BigDataConfig, createBigDataHook } from '../bigdata/index.ts'
import { resolveConnectionRef } from '../channels/connection-ref.ts'
import {
  CHANNEL_TOOLS,
  type ChannelGateway,
  channels,
  delegatedApprovals,
  webPersonNote,
  webReminders,
} from '../channels/index.ts'
import { nativeToolName } from '../channels/policy.ts'
import type { ChatToolsStore } from '../db/chat-tools-repo.ts'
import type { SessionModeStore } from '../db/modes-repo.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import type { ActivityLog } from './activity-log.ts'
import { capText } from './budget-cap-text.ts'
import { chatTools } from './chat-tools-plugin.ts'
import { DATETIME_TOOL, MEMORY_TOOL_KINDS } from './connector-catalog.ts'
import type { ConnectorsRuntime } from './connectors.ts'
import { DECISION_TOOLS, type DecisionIntake, decisions } from './decisions-plugin.ts'
import { fileGrant } from './file-grant-plugin.ts'
import { type HeartbeatIntake, heartbeat } from './heartbeat-plugin.ts'
import { type LibraryChange, libraryFs, TOOL_MEDIA_DIR } from './library-fs.ts'
import { memoryDiscipline } from './memory-discipline-plugin.ts'
import { toolFactsOf } from './order-tools.ts'
import { type SessionGate, sessionPermissions } from './permission-plugin.ts'
import { type PersonaIntake, persona } from './persona-plugin.ts'
import type { ModelConfig } from './provider.ts'
import { rehearsalSessions, sessionFileSystem } from './rehearsal-registry.ts'
import { routineOutcomes } from './routine-plugin.ts'
import type { RoutineOutcomes } from './routine-service.ts'
import { sessionContext } from './session-context-plugin.ts'
import { standingOrders } from './standing-order-plugin.ts'
import {
  setBudgetLimit,
  sqliteBudgetLedger,
  sqliteInbox,
  sqliteLock,
  sqliteMessages,
  sqliteState,
} from './storage.ts'
import { sqliteStreamLog } from './stream-log.ts'
import { taskIndex } from './task-index.ts'
import { turnRetry } from './turn-retry-plugin.ts'
import type { TurnRetryHooks } from './turn-retry-service.ts'
import { WORK_QUEUE_TOOLS, type WorkQueueIntake, workQueue } from './work-queue-plugin.ts'

/** Limits of delegation (plan decision D4: multi-agent runs cost many times a chat). */
export interface TeamLimits {
  /** Children the lead starts at once (the spawn cap). Default 4; the settings row overrides it. */
  spawnCap?: number
  /** Children one session may start over its lifetime (`subagent({ maxChildren })`). Default none. */
  maxChildren?: number
  /** Steps a role agent may take per delegated run. Default 25. */
  childMaxTurns?: number
  /**
   * Background workers run as long-run jobs (`longRun`, spec 33 §3): a chain of chunks that ends
   * when the job is done, stuck, over its cost or duration limit, or stopped by a person.
   */
  longRun?: {
    /** Steps per chunk. Default 80. */
    chunkSteps?: number
    /** Stop a job whose estimated cost reaches this (USD). Default 10; 0 = no limit. */
    maxCostUsd?: number
    /** Stop a job this long after it started (ms). Default 24 h; 0 = no limit. */
    maxDurationMs?: number
  }
  /**
   * The working context window (tokens): the model's own window, at most this. Compaction
   * summarizes at 80 % of it. Default 128 000.
   */
  contextCap?: number
  /** How long the lead stays parked on a task before the wait times out (ms). Default 24 h. */
  parkTimeoutMs?: number
  /** A background delegation running longer than this gets one "timed out" report. Default 2 h; 0 = never. */
  backgroundTimeoutMs?: number
  /** A delegation that did not start within this long is reported as failed to start. Default 90 s. */
  backgroundStartGraceMs?: number
  /** One reminder when a delegation waits for a person this long. Default 15 min; 0 = never. */
  backgroundWaitingReminderMs?: number
}

export interface AgentFactoryDeps {
  sqlite: Database
  models: ModelConfig
  /** Connector activation (`infra/eh/connectors.ts`): the tools, MCP servers and rules of an agent. */
  connectors: ConnectorsRuntime
  /** Context windows and prices of models (`openRouterCatalog` / `modelsDevCatalog`); absent = unpriced. */
  catalog?: ModelCatalog
  workspaceId?: string
  /** Role agents the lead can delegate to (`subagents` catalog and the turn reminder). */
  roster?: () => AgentDef[]
  /** The lead's definition: role agents resolve their parent (`parentAgent`) through it. */
  lead?: () => AgentDef | undefined
  /** Writer of the task index and event feed (the `taskIndex` plugin); absent = no index. */
  taskStore?: TaskWriter
  /** Model call log (the `model.call` hook and the Auto classifier calls); absent = not logged. */
  activityLog?: ActivityLog
  /** The shared feed; absent = no session events. */
  activityStore?: ActivityStore
  /** App events (the `taskIndex` plugin's `message-added`, `task-changed`). */
  events?: EventAppender
  /** Definition of a hook context's agent (`agent.id` is the slug). */
  agentBySlug?: (slug: string) => AgentDef | undefined
  limits?: TeamLimits
  /** Monthly USD limit of the workspace ledger scope; absent = tracked, not limited. */
  budgetUsd?: number
  /**
   * Workspace settings (spawn cap, default model, default permission mode, budget): read on every
   * `agentFor`, so a change on any instance rebuilds the agents (the cache key holds `rev`).
   */
  settings?: () => Pick<
    WorkspaceSettings,
    | 'spawnCap'
    | 'defaultModel'
    | 'defaultProfile'
    | 'defaultPermissionMode'
    | 'budgetUsd'
    | 'timezone'
  > & { rev: number }
  /** Modes people picked per session (`domain/modes.ts`); absent = nobody can pick one. */
  sessionModes?: Pick<SessionModeStore, 'get'>
  /** Connections people switched off per chat (the composer tools menu); absent = none. */
  chatTools?: Pick<ChatToolsStore, 'off'>
  /**
   * Programs (`domain/programs.ts`): a session `program:<id>:<runAt>` runs under the authority of
   * its program (the permission gate of the session) and spends from its budget scopes. Absent =
   * no program sessions.
   */
  programs?: Pick<ProgramStore, 'get'>
  /**
   * Extra permissions given with an assigned task (`task:<id>:<round>`, `domain/work-queue.ts`):
   * allow rules on top of the agent's own, so the task needs no approval for them. undefined = none.
   */
  taskGrants?: (sessionId: string) => ProgramAuthority | undefined
  /**
   * The Decision Center intake (`decisions-plugin.ts`): `propose_plan`, `escalate`,
   * `request_authority` and the needs_decision report hook. Late-bound (built after the app
   * deps); absent = no decision tools.
   */
  decisions?: () => DecisionIntake | undefined
  /**
   * The heartbeat (`heartbeat-plugin.ts`): `team_status` and the hook that records a beat. Late-bound
   * like `decisions`; absent = no heartbeat tools.
   */
  heartbeat?: () => HeartbeatIntake | undefined
  /**
   * The channels gateway (`infra/channels`): channel tools, the observed-messages reminder and
   * reply delivery of channel sessions. Late-bound; absent = no channel tools.
   */
  channels?: () => ChannelGateway | undefined
  /** May this assigned task session post to a chat like a chat turn does (see `ChannelsPluginOptions.taskMayPost`)? */
  taskMayPost?: (sessionId: string) => boolean
  /**
   * The persona of every agent (docs/plans/P42-team-persona.md): the structured identity, the voice
   * and the operating rules are the persona and operating-rules layers of the prompt, read from the
   * newest version; its number is part of the cache key, so a change applies from the next turn and
   * the prefix is byte-identical within a version. Absent (or an agent without a version) = the
   * agent's own `instructions`, as before.
   */
  personas?: Pick<PersonaStore, 'latest' | 'latestNumber'>
  /** The `persona` tool (`persona-plugin.ts`). Late-bound; absent = no persona tool. */
  personaIntake?: () => PersonaIntake | undefined
  /**
   * Session ids the standing orders of an agent reference (the heartbeat may read those web chats
   * with `sessions_search` / `session_read`, `canReadForHeartbeat`). Absent = none.
   */
  sessionRefs?: (agentId: string) => readonly string[]
  /** The work queue intake (`work-queue-plugin.ts`): `create_task`, `list_tasks`, `update_task`, `complete_task`. */
  workQueue?: () => WorkQueueIntake | undefined
  /** The big-data toolkit (`infra/bigdata`): sources and `run_code` limits. Needs `programs`. */
  bigData?: BigDataConfig
  /** Artifacts (docs/plans/P45-team-artifacts.md): the service and the decision hook for public requests. Needs `programs`. */
  artifacts?: { service: ArtifactService; decisions: () => ArtifactDecisions | undefined }
  /** Definition by id: a child's parent session `dm:<agentId>` names its agent. */
  agentById?: (id: string) => AgentDef | undefined
  /**
   * The Auto mode classifier. Default: `modelClassifier` over `models.classifierModel`; with
   * neither, Auto mode is not offered.
   */
  classifier?: AutoClassifier
  /** Auto mode blocked / paused / resumed in a session (feeds the event feed). */
  onAutoEvent?: (info: {
    sessionId: string
    agentId: string
    event: AutoEvent
    state: AutoState
    mode: TeamMode
  }) => void
  /** Receives the end of every turn so routine runs get their outcome (see `routine-plugin.ts`). */
  routineOutcomes?: () => RoutineOutcomes | undefined
  /**
   * The automatic retry of turns that failed transiently (`turn-retry-service.ts`). Late-bound: the
   * service is built after the factory. Absent = a failed turn is simply failed.
   */
  turnRetry?: () => TurnRetryHooks | undefined
  /** Called after a library file changed (event feed, M4). */
  onFileChange?: (change: LibraryChange) => void
  onWarning?: (warning: HarnessWarning) => void
  /** `config.observe`: phase spans and failure counters (see `observe.ts`); absent = off. */
  observe?: (event: ObserveEvent) => void
  /** `debug.invariants` of every agent (explicit: the core never infers it from NODE_ENV). */
  debug?: { invariants?: boolean }
  /** Lease of the turn lock (ms). */
  lockLeaseMs?: number
  /**
   * Stable id of this server instance (survives restarts). A restarted instance owns the turns and
   * locks of its previous run, so they are recovered at once instead of after the stale timeout.
   * Must be unique among live instances of one database. Default: random per process.
   */
  instanceId?: string
  /** Timers of the stream log and the inbox (ms); tests shorten them. */
  tuning?: {
    streams?: StreamsTuning
    inbox?: { pollMs?: number }
    abortPollMs?: number
    /** AI SDK retries of one model call before the turn fails (default: the SDK's 2, with 2 s and 4 s backoff). Tests set 0. */
    modelMaxRetries?: number
  }
}

export interface StreamsTuning {
  flushMs?: number
  batchSize?: number
  retentionMs?: number
  pollMs?: number
}

export interface AgentFactory {
  /**
   * Activate the connectors of `def`, the lead and the roster (what delegation builds). Await it
   * before `agentFor` / `openSession` whenever the agent, its connections or its enablement may
   * have changed; cheap when nothing did.
   */
  prepare(def?: AgentDef): Promise<void>
  /**
   * The agent of a definition version (built once per version on this instance). Needs `prepare`.
   * With a session id, a worker session (`isWorkerSession`) gets the worker variant.
   */
  agentFor(def: AgentDef, sessionId?: string): HarnessAgent
  /** The model an agent runs on and what the catalog knows about it (window, prices). */
  modelInfo(def: AgentDef): ModelInfoOf
  /**
   * Turn settings of a program run: the output cap its budget can afford (`programMaxOutputTokens`).
   * Every model call reserves its worst case against the budgets, so a run with a small budget
   * must not use the agent-wide 32k cap. `{}` for any other session. Pass it to every turn of the
   * run (`send`, `resolveWait`).
   */
  programTurn(def: AgentDef, sessionId: string): { settings?: { maxOutputTokens: number } }
  /**
   * The tools a program run of `def` can have under `authority`: the connector tools that are on,
   * the plugin tools every run has, the file tools the authority grants, and the channel tools when
   * the agent is bound to a channel connection. Await `prepare(def)` first.
   */
  toolAvailability(def: AgentDef, authority: ProgramAuthority): ToolAvailability
  /** What an authority can name for `def`: connections, connector tools with kinds, availability. */
  authoritySources(def: AgentDef, authority: ProgramAuthority): AuthoritySources | undefined
  /** Shared storage ports (messages, state, inbox), for `agent.session(id, { lock })` callers. */
  storage: ReturnType<typeof createStorage>
  /** Cross-process turn lock; pass it as `session(id, { lock })`. */
  lock: SessionLock
  /**
   * The long-run job of a worker session (the worker variant of `def`): stored state, stop and
   * resume (boot and every reconcile pass; idempotent).
   */
  longRun: {
    state(def: AgentDef, sessionId: string): Promise<LongRunState | undefined>
    stop(def: AgentDef, sessionId: string, reason?: string): Promise<boolean>
    resume(def: AgentDef, sessionId: string): Promise<LongRunResumeResult>
  }
  /** Limits of background delegations, for the reconcile pass. */
  background: { timeoutMs: number; startGraceMs: number; waitingReminderMs: number }
  /** Open a session of a definition's agent with the shared lock and runtime (any instance). */
  openSession(def: AgentDef, sessionId: string): HarnessSession
  /**
   * A side-effect-free read handle of a stored session (messages, pending, usage, busy, children):
   * no `session.start` hooks, nothing resumes. Use it for every pure read (spec 05 `agent.peek`).
   */
  peek(sessionId: string): SessionPeek
  /**
   * Force a reload of one chat (urgent cases: the model lacks tools the owner allowed): the
   * connectors of the agent are activated again (remote MCP lists are fetched anew), the agent is
   * rebuilt, and the session object of `sessionId` is closed on every build as soon as it is idle
   * (a running turn is never cut: `pending` is then true and it closes right after the turn).
   * The next message opens a fresh session, and the model is told once that its tools were
   * reloaded. Nothing is stored here.
   */
  reloadSession(def: AgentDef, sessionId: string): Promise<ReloadResult>
  /**
   * The same for every session of the agent that is open in this process. `stored`: further
   * session ids of the agent (not open here) whose pinned remote MCP definitions are cleared too;
   * `servers`: clear the pins of these servers only (connection slugs), default every server.
   */
  reloadAgent(
    def: AgentDef,
    opts?: { stored?: readonly string[]; servers?: ReadonlySet<string> },
  ): Promise<ReloadResult>
  /**
   * Sessions whose remote MCP tools were excluded because the server changed their definitions
   * (the library's `W_MCP_DRIFT`, noted at the last turn of each session; in memory).
   */
  drifts(): Array<{ sessionId: string } & DriftNote>
  /** Stored sessions that hold pinned MCP definitions (every agent). */
  pinnedSessions(): Array<{ sessionId: string; servers: string[] }>
  /** Permission modes of sessions (per-session mode, inheritance, Auto state). */
  modes: SessionModes
  /** Close every agent built (shutdown). */
  close(): Promise<void>
}

/** What a forced reload did. */
export interface ReloadResult {
  /** Open sessions the reload looked at. */
  sessions: number
  /** Closed at once (idle). */
  closed: number
  /** Busy: they close right after their turn. */
  pending: number
  /** The tools the agent is configured with now. */
  tools: string[]
  /**
   * Pinned MCP definition sets cleared: the owner accepted the servers' current definitions
   * (tools the server changed are offered again at the next turn). Sets of a chat that is busy
   * are cleared right after its turn and not counted here.
   */
  pinsCleared: number
}

/** A model id and its catalog entry (no entry fields = unknown to the catalog). */
export type ModelInfoOf = { id: string; profileId?: string } & ModelInfo

export interface SessionModes {
  /** Auto mode needs a classifier model; without one it is not offered. */
  autoAvailable: boolean
  /**
   * The effective mode of a session of `def`: its own stored pick, else (child sessions) the mode
   * of the delegating session, else the agent's own mode, else the workspace default; clamped by
   * the agent's ceiling (see `domain/modes.ts`).
   */
  resolve(def: AgentDef, sessionId: string, parentSessionId?: string): ResolvedMode
  /** Auto mode counters of a live session in this process (zeros when none is open). */
  autoState(sessionId: string): AutoState
  /** A person re-enabled Auto: a paused classifier resumes. No-op when the session is not live. */
  resumeAuto(sessionId: string): void
}

/** Ledger scope of the workspace: every model call of every agent reserves against it. */
export const workspaceScope = (workspaceId: string): string => `workspace:${workspaceId}`

/** Ledger scope of one rehearsal (its own small cap, `domain/rehearsal.ts`). */
export const rehearsalScope = (sessionId: string): string => `rehearsal:${sessionId}`

function createStorage(sqlite: Database) {
  return {
    messages: sqliteMessages(sqlite),
    state: sqliteState(sqlite),
    inbox: sqliteInbox(sqlite),
    // cross-instance resume (spec 04 §6.2): every instance appends its turns here
    streams: sqliteStreamLog(sqlite),
  }
}

const EMPTY_ACTIVATION: ActivatedConnectors = {
  plugins: [],
  mcpSources: [],
  rules: { allow: [], ask: [], deny: [], pinnedAsk: [], toolKinds: {} },
  instructions: [],
  toolNameMap: {},
  connections: [],
  warnings: [],
}

/** Common preamble; the definition's own instructions follow. Static text only. */
/** Output cap of a model the catalog does not list, and the ceiling of any catalog value. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** The classifier reads at most this much of one action (library default, set explicitly). */
const CLASSIFIER_MAX_CALL_CHARS = 8_000

/**
 * Bounded waits, all explicit so nothing a turn awaits can hang it (spec 10): an awaited hook
 * (the app's task index, activity and routine hooks are all local writes), a stalled model stream
 * (idle between chunks, per step) and a tool source that does not list (the remote MCP servers).
 * The values are the library defaults; a production app tunes them to its providers.
 */
const HOOK_TIMEOUT_MS = 30_000
const MODEL_IDLE_TIMEOUT_MS = 120_000
const TOOL_SOURCE_TIMEOUT_MS = 30_000
/** A failed tool source (a down MCP server) is asked again after this long, doubling to 60 s. */
const TOOL_SOURCE_RETRY_MS = 5_000
/** The same warning is printed once per minute, with a count of the repeats. */
const WARNING_DEDUPE_MS = 60_000
const MAX_OUTPUT_TOKENS_CAP = 32_768

const TEAM_PREAMBLE = [
  'You are an agent in a small team. A person (the user) works with you and with other agents',
  'through a chat app. The shared library of files is under /library; memory notes live under',
  '/memories (see the memory tools). Say what you did and where you saved files.',
].join(' ')

/**
 * Long work in the background (production feedback: an audit of a whole group ran out of steps
 * in the chat turn). Every agent can hand a long job to `worker`, a copy of itself with the same
 * tools and chats that runs as a background child; the chat stays free and the report wakes the
 * agent, which then answers. Worker sessions are `<parent>:worker:<call>`, so the server opens them
 * on the worker variant (`isWorkerSession`).
 */
export const WORKER_TYPE = 'worker'
const WORKER_MARK = ':worker:'
export const isWorkerSession = (sessionId: string): boolean => sessionId.includes(WORKER_MARK)

/** Runs whose budget is set by their runner: the step budget never extends them. */
const FIXED_STEP_ORIGINS: ReadonlySet<string> = new Set([
  'program',
  'rehearsal',
  'heartbeat',
  'routine',
])

/**
 * The hard step cap of a turn of this session (0 = never extended): a chat turn 120 steps; a
 * delegated child or an assigned task 200; a background worker has no cap here (0): it runs as
 * a long-run job in chunks (`longRun`).
 */
export function stepCapOf(sessionId: string, hasParent: boolean): number {
  if (isWorkerSession(sessionId)) return 0
  const origin = originOfSession(sessionId, hasParent)
  if (FIXED_STEP_ORIGINS.has(origin)) return 0
  if (hasParent || origin === 'task') return 200
  return 120
}

const TEAM_DATETIME_DESCRIPTION =
  'The current date and time, and date arithmetic, in the team timezone (the one zone the whole team uses: routines, reminders, chat times, "today"). ' +
  'now: the exact time now. convert: a moment in another zone. add: a moment plus or minus months/weeks/days/hours/minutes (calendar-aware). diff: the time between two moments. ' +
  'Use it instead of computing dates, weekdays or time differences yourself. Read-only.'
/** The child session id: workers are told apart from role agents by id. */
const childIdFor = (parentId: string, toolCallId: string, agent: string): string =>
  agent === WORKER_TYPE
    ? `${parentId}${WORKER_MARK}${toolCallId}`
    : `${parentId}:agent:${toolCallId}`
/** Base step budget of a worker turn (the step budget plugin extends it while it progresses). */
const WORKER_BASE_STEPS = 60
const WORKER_DESCRIPTION =
  'A copy of you with all your tools, connections and chats, running in the background. Use it for long work: reading or auditing many messages or a whole chat, research over many sources, anything that needs many tool calls or would fill this conversation. Give it the complete brief (goal, scope, time range, what the result looks like, who asked; for a chat its id or exact title, and the topic if one), because it starts with an empty context; it reports back and the report wakes you.'

/** What the agent itself should know about its worker (static: part of the instructions). */
const WORKER_PLAYBOOK = [
  '## Long work',
  '',
  'When a request needs many tool calls or a lot of reading (an audit of a chat over weeks, research,',
  'a big summary), hand it to your `worker` with the `agent` tool (subagent_type "worker") instead of',
  'doing it in this turn: it is a copy of you with the same tools and chats and runs in the background.',
  'Tell the person in one short sentence that you started it, then end your turn. When its report',
  'wakes you, check it and answer the person who asked (in a chat, your reply goes to that chat).',
  'One worker per job; do not start the same job twice; `agent_stop` stops one when the person cancels.',
].join('\n')

/** What a worker should know (static: part of the worker variant's instructions). */
const WORKER_NOTE = [
  '## You are a background worker',
  '',
  'You run a job handed to you by your main session; nobody watches this conversation. Work through the',
  'whole job, use the tools that cover the most ground per call (for chats: chat_history over all topics',
  'with time windows and large pages; ask for a backfill when the range is older than the log), and save',
  'long intermediate results to files under /library when they are worth keeping. Finish with one report:',
  'what you did, the result itself (complete enough to post), gaps, and the paths of files you wrote.',
  'Do not post to chats yourself unless the brief says so; your main session answers the person.',
  'A big job runs in chunks: at the end of a chunk you are asked for a checkpoint note (what is done with',
  'ids and counts, what remains, the exact next step); write it completely, it is all you keep. Never write',
  'the final report before the whole job is done.',
].join('\n')

/**
 * The gate of a program run: the rules the engine gets (`rules`) and the closed-world check of
 * the session (`SessionGate`).
 */
/** The tool kinds of the connector rules without the pinned "always ask" ones (D6). */
function withoutPinnedAsks(rules: {
  toolKinds: Record<string, unknown>
  pinnedAsk: readonly string[]
}): typeof rules.toolKinds {
  return Object.fromEntries(
    Object.entries(rules.toolKinds).filter(([name]) => !rules.pinnedAsk.includes(name)),
  )
}

export type ProgramGate = SessionGate & { rules: { allow: string[]; deny: string[] } }

export function createAgentFactory(deps: AgentFactoryDeps): AgentFactory {
  const { sqlite } = deps
  const storage = createStorage(sqlite)
  const lock = sqliteLock(sqlite, {
    ...(deps.lockLeaseMs !== undefined ? { leaseMs: deps.lockLeaseMs } : {}),
    ...(deps.instanceId !== undefined ? { owner: deps.instanceId, takeOver: true } : {}),
  })
  const workspaceId = deps.workspaceId ?? 'default'
  // an explicit catalog wins (tests); else the one of the provider manager (live profiles)
  const catalog = deps.catalog ?? deps.models.catalog
  // the ledger remembers which scope refused a reservation: a capped turn says which limit (D15)
  const refusals = trackRefusals(sqliteBudgetLedger(sqlite))
  const ledger = refusals.ledger
  /** The readable reason a turn of this session stopped on a budget. */
  const capTextOf = (sessionId: string): string =>
    capText(refusals.peek(sessionId), { program: (id) => deps.programs?.get(id)?.name })
  const fixed = {
    childMaxTurns: deps.limits?.childMaxTurns ?? 25,
    parkTimeoutMs: deps.limits?.parkTimeoutMs ?? 24 * 60 * 60 * 1000,
    maxChildren: deps.limits?.maxChildren,
  }
  const backgroundTuning = {
    timeoutMs: deps.limits?.backgroundTimeoutMs ?? 2 * 60 * 60 * 1000,
    startGraceMs: deps.limits?.backgroundStartGraceMs ?? 90_000,
    waitingReminderMs: deps.limits?.backgroundWaitingReminderMs ?? 15 * 60_000,
  }
  const longRunTuning = {
    chunkSteps: deps.limits?.longRun?.chunkSteps ?? 80,
    maxCostUsd: deps.limits?.longRun?.maxCostUsd ?? 10,
    maxDurationMs: deps.limits?.longRun?.maxDurationMs ?? 24 * 60 * 60 * 1000,
  }
  /** The long-run plugin of the current worker variant of each agent (by definition id). */
  const longRuns = new Map<string, LongRunPlugin>()
  const longRunOf = (def: AgentDef): LongRunPlugin => {
    workerAgentFor(def)
    const lr = longRuns.get(def.id)
    if (lr === undefined) throw new Error(`no long-run plugin for agent ${def.id}`)
    return lr
  }
  const currentSettings = () =>
    deps.settings?.() ?? {
      spawnCap: deps.limits?.spawnCap ?? 4,
      defaultModel: null,
      defaultProfile: null,
      defaultPermissionMode: 'default' as const,
      budgetUsd: deps.budgetUsd ?? null,
      timezone: 'UTC',
      rev: 0,
    }
  setBudgetLimit(sqlite, workspaceScope(workspaceId), currentSettings().budgetUsd)
  /**
   * Extra ledger scopes of a program run (the run profile says `budget: 'program'`): the run itself
   * (`perRunUsd`: a refused reservation ends the run with `cost-cap`) and the program's UTC day
   * (`perDayUsd`, scope `program:<id>:<YYYY-MM-DD>`). The limits are set from the program on
   * every turn, so an edit applies to the next turn.
   */
  const programScopes = (sessionId: string): string[] => {
    // a rehearsal spends from a small cap of its own, never from the program's scopes
    const rehearsal = rehearsalSessions.get(sessionId)
    if (rehearsal !== undefined) {
      const scope = rehearsalScope(sessionId)
      setBudgetLimit(sqlite, scope, rehearsal.budgetUsd)
      return [scope]
    }
    if (profileOfSession(sessionId).budget !== 'program') return []
    const parsed = parseProgramSession(sessionId)
    const program = parsed === undefined ? undefined : deps.programs?.get(parsed.programId)
    if (program === undefined) return []
    const out: string[] = []
    if (program.budget.perRunUsd !== null) {
      const scope = programRunScope(sessionId)
      setBudgetLimit(sqlite, scope, program.budget.perRunUsd)
      out.push(scope)
    }
    const day = programDayScope(program.id, Date.now())
    setBudgetLimit(sqlite, day, program.budget.perDayUsd)
    out.push(day)
    return out
  }
  // `library://` references of uploads stay references in stored messages; they become bytes only
  // when the request to the model is built (`inputFiles.resolve`, spec 03 §6)
  const uploads = libraryFs(sqlite)
  const resolveUpload = async (url: string, ctx: { mediaType: string }) => {
    let path: string | undefined
    try {
      path = uploadPathOfUrl(url)
    } catch {
      return null
    }
    if (path === undefined) return undefined // https: and friends: the provider fetches them
    const file = await uploads.readBytes?.(path)
    if (file === null || file === undefined) return null
    return { data: file.bytes, mediaType: file.mediaType ?? ctx.mediaType }
  }

  // The model reads an attachment as `[Attachment …: path <path>]` next to the file (`inputFiles.describe`)
  // and passes that path to `agent({ files })`; this turns it back into a checked file reference.
  const describeUpload = (file: { url: string; mediaType: string; filename?: string }) => {
    if (!file.url.startsWith(LIBRARY_URL_PREFIX)) return undefined
    let path: string | undefined
    try {
      path = uploadPathOfUrl(file.url)
    } catch {
      return undefined
    }
    return path === undefined
      ? undefined
      : `[Attachment ${file.filename ?? ''} (${file.mediaType}) at path "${path}". To hand it to another agent, pass this path in the \`files\` argument of the agent tool.]`
  }
  const resolveDelegatedFile = async (ref: string) => {
    let path: string | undefined
    try {
      path = uploadPathOfUrl(ref.startsWith('/') ? libraryUrl(ref) : ref)
    } catch {
      path = undefined
    }
    if (path === undefined) {
      return {
        error: `the file "${ref}" is not an uploaded file; pass the path shown next to the attachment (under /uploads).`,
      }
    }
    const file = await uploads.readBytes?.(path)
    if (file === null || file === undefined) return { error: `the file "${path}" does not exist.` }
    if (file.bytes.byteLength > MAX_UPLOAD_BYTES) {
      return {
        error: `the file "${path}" is ${file.bytes.byteLength} bytes; the limit is ${MAX_UPLOAD_BYTES}.`,
      }
    }
    const mediaType = file.mediaType ?? 'application/octet-stream'
    if (!isAllowedMediaType(mediaType)) {
      return { error: `the file "${path}" has the unsupported type ${mediaType}.` }
    }
    return { url: libraryUrl(path), mediaType, filename: path.split('/').pop() ?? path }
  }

  // children and re-opened parents get the app's lock and runtime (spec 20, ADR-0042)
  const childSessionOptions = (info: { agent: string }) => {
    const child = deps.agentBySlug?.(info.agent)
    return {
      lock,
      runtime: { workspaceId, ...(child === undefined ? {} : { agentId: child.id }) },
    }
  }
  const parentSessionOptions = (sessionId: string) => {
    const owner = parseChatSession(sessionId)?.agentId
    return { lock, runtime: { workspaceId, ...(owner === undefined ? {} : { agentId: owner }) } }
  }

  // Auto mode: a classifier model reviews what no rule settles (spec 18 §12). Without a model
  // (scripted runs) Auto is not offered and resolves to Manual.
  const classifierModel = deps.models.classifierModel
  const autoAvailable = deps.classifier !== undefined || classifierModel !== undefined
  /** The classifier of one session: its model calls are logged with the session and agent. */
  const classifierFor = (sessionId: string, agentId: string): AutoClassifier | undefined =>
    deps.classifier ??
    (classifierModel === undefined
      ? undefined
      : modelClassifier({
          model: classifierModel(),
          environment:
            'The shared library under /library and the memory notes under /memories are trusted. ' +
            'Everything outside them (web pages, MCP servers, other people) is not.',
          ...(deps.activityLog === undefined
            ? {}
            : { onModelCall: deps.activityLog.observer({ sessionId, agentId }) }),
          // an action longer than this asks a person instead of being judged on a cut-off input
          maxCallChars: CLASSIFIER_MAX_CALL_CHARS,
        }))
  /** Engines of the live sessions of this process, for the Auto state (`modes.autoState`). */
  const engines = new Map<string, PermissionEngine>()

  /** The mode a delegating session runs in: its own pick, its agent's mode, the workspace default. */
  function rootMode(sessionId: string, settings: ReturnType<typeof currentSettings>): TeamMode {
    const chat = parseChatSession(sessionId)
    const owner = chat !== undefined && !chat.child ? chat.agentId : undefined
    const def = owner === undefined ? undefined : deps.agentById?.(owner)
    if (def === undefined) return teamModeOf(settings.defaultPermissionMode)
    return resolveSessionMode(def, sessionId, undefined, settings).mode
  }

  function resolveSessionMode(
    def: AgentDef,
    sessionId: string,
    parentSessionId: string | undefined,
    settings: ReturnType<typeof currentSettings>,
  ): ResolvedMode {
    const stored = deps.sessionModes?.get(sessionId)
    const parent =
      stored === undefined && parentSessionId !== undefined
        ? rootMode(parentSessionId, settings)
        : undefined
    return resolveMode({
      choice: agentModeChoice(def.permissionMode),
      stored,
      parent,
      workspaceDefault: teamModeOf(settings.defaultPermissionMode),
      autoAvailable,
    })
  }

  const RELOAD_WAIT_MS = 30 * 60_000
  const RELOAD_POLL_MS = 250
  const cache = new Map<string, HarnessAgent>()
  const latest = new Map<string, string>()
  /**
   * Builds that a new persona version replaced, per agent id, with the sessions opened on them.
   * A session object stays a holder of its inbox for a long time (idle eviction), so a message
   * would still be run by the old build, with the old persona: `prepare` closes those sessions
   * once they are idle (`closeSuperseded`).
   */
  const superseded = new Map<string, HarnessAgent[]>()
  /**
   * Sessions opened per build, weakly: the library evicts idle sessions on its own, and this map
   * must not keep every session a long-lived server ever opened alive (dead refs are swept).
   */
  const liveSessions = new Map<HarnessAgent, Map<string, WeakRef<HarnessSession>>>()
  const retired: HarnessAgent[] = []
  /** The tools the model of a build is offered (connector tools that are not denied). */
  const toolsOfBuild = new WeakMap<HarnessAgent, readonly string[]>()
  /**
   * Sessions an older build held when the tools changed: their next open on the new build tells the
   * model once what changed, so an earlier "I cannot do that" in the chat is not repeated.
   */
  const toolNotices = new Map<string, { added: Set<string>; removed: Set<string> }>()
  /** Sessions a forced reload closed: their next open tells the model so, once. */
  const reloadNotices = new Set<string>()
  let reloadSeq = 0
  let shutdown = false

  const leadAgent = (): HarnessAgent => {
    const lead = deps.lead?.()
    if (lead === undefined) throw new Error('the workspace has no lead agent')
    return factoryAgentFor(lead)
  }

  /** The agent object of each agent id (latest build): `subagent({ selfAgent })` of the team connector. */
  const selves = new Map<string, HarnessAgent>()

  /** Stable ids of activations (they are part of the cache key of built agents). */
  const activationIds = new WeakMap<object, number>()
  let nextActivationId = 0
  const activationId = (out: ActivatedConnectors): number => {
    let id = activationIds.get(out)
    if (id === undefined) {
      id = ++nextActivationId
      activationIds.set(out, id)
    }
    return id
  }

  /**
   * The Team connector: the lead gets `subagent({ approvals: 'park' })` with the role agents of
   * the DB roster (delegate, output and stop tools follow the connector's tool modes); other agents
   * never get it (they have the child side below).
   */
  function teamPlugin(def: AgentDef, input: BuiltinInput) {
    if (def.role !== 'lead') return undefined
    const settings = currentSettings()
    const limits = { ...fixed, spawnCap: settings.spawnCap }
    if (input.modes.delegate === undefined || input.modes.delegate === 'off') return undefined
    const has = (tool: string): boolean => input.tools.includes(tool)
    return subagent({
      agents: () => ({
        ...Object.fromEntries(
          (deps.roster?.() ?? [])
            .filter((a) => a.id !== def.id && a.archivedAt === null && a.slug !== WORKER_TYPE)
            .map((a) => [
              a.slug,
              {
                agent: factoryAgentFor(a),
                description: a.description === '' ? a.name : a.description,
                maxTurns: limits.childMaxTurns,
              },
            ]),
        ),
        // a copy of the lead for long jobs (the same tools and chats)
        [WORKER_TYPE]: workerEntry(def),
      }),
      approvals: 'park',
      childSessionId: childIdFor,
      // the user's uploads can be handed to the role agent that works on them
      files: { resolve: resolveDelegatedFile },
      // durable background delegation (ADR-0046): the lead stays free to chat while the
      // role agents work; their reports arrive as events and wake it
      background: {
        default: true,
        ...(backgroundTuning.timeoutMs > 0 ? { timeoutMs: backgroundTuning.timeoutMs } : {}),
        startGraceMs: backgroundTuning.startGraceMs,
        waitingReminderMs: backgroundTuning.waitingReminderMs,
      },
      parkTimeoutMs: limits.parkTimeoutMs,
      maxConcurrent: limits.spawnCap,
      ...(limits.maxChildren === undefined ? {} : { maxChildren: limits.maxChildren }),
      childSession: (info) =>
        info.agent === WORKER_TYPE
          ? { lock, runtime: { workspaceId, agentId: def.id } }
          : childSessionOptions(info),
      parentSession: parentSessionOptions,
      // role agents are leaves: a delegation is one level deep
      maxDepth: 1,
      messageTool: has('send_message'),
      outputTool: has('agent_output'),
      stopTool: has('agent_stop'),
      selfAgent: () => selves.get(def.id) as HarnessAgent,
    })
  }
  if (deps.connectors.hooks.team === undefined) deps.connectors.hooks.team = teamPlugin
  // the big-data toolkit (run_code, ingest_source, manifests) works under a program's authority
  if (deps.connectors.hooks.bigdata === undefined && deps.programs !== undefined) {
    deps.connectors.hooks.bigdata = createBigDataHook({
      sqlite,
      programs: deps.programs,
      onFileChange: deps.onFileChange,
      config: deps.bigData,
    })
  }

  if (
    deps.connectors.hooks.artifacts === undefined &&
    deps.artifacts !== undefined &&
    deps.programs !== undefined
  ) {
    deps.connectors.hooks.artifacts = createArtifactsHook({
      service: deps.artifacts.service,
      programs: deps.programs,
      agentOf: (slug) => deps.agentBySlug?.(slug),
      channels: () => deps.channels?.(),
      decisions: deps.artifacts.decisions,
    })
  }

  /** The tools a program run of `def` can have (`AgentFactory.toolAvailability`). */
  function availabilityOf(
    def: AgentDef,
    out: ActivatedConnectors,
    authority: ProgramAuthority,
  ): ToolAvailability {
    const gateway = deps.channels?.()
    const bound = gateway?.connectionsOf(def.id) ?? []
    const available = new Set<string>([
      ...Object.keys(out.toolNameMap).filter((t) => !out.rules.deny.includes(t)),
      ...PROGRAM_BASE_TOOLS,
      ...WORKER_TOOLS,
      ...DECISION_TOOLS,
      ...WORK_QUEUE_TOOLS,
      READ_BRIEFINGS_TOOL,
      'final_answer',
      ...runFileTools(authority),
    ])
    if (bound.length > 0) {
      for (const tool of CHANNEL_TOOLS) available.add(tool)
      for (const c of bound) {
        const adapter = gateway?.adapter(c.connectionId)
        for (const action of adapter?.actions ?? []) {
          available.add(nativeToolName(adapter?.platform ?? 'channel', action.name))
        }
      }
    }
    const off = new Set(Object.keys(out.toolNameMap).filter((t) => out.rules.deny.includes(t)))
    return { available, channelTools: CHANNEL_TOOLS, channelsBound: bound.length > 0, off }
  }

  function build(
    def: AgentDef,
    settings: ReturnType<typeof currentSettings>,
    out: ActivatedConnectors,
    variant: 'main' | 'worker' = 'main',
  ): HarnessAgent {
    const worker = variant === 'worker'
    // the main variant is `self`; a worker variant reports to it
    const main = (): HarnessAgent => selves.get(def.id) as HarnessAgent
    let workerSelf: HarnessAgent | undefined
    const self = (): HarnessAgent => (worker ? (workerSelf as HarnessAgent) : main())
    // a worker never delegates (the lead's Team plugin is left out of its connector plugins)
    if (worker) out = { ...out, plugins: out.plugins.filter((p) => p.name !== 'subagent') }
    const pluginNames = new Set(out.plugins.map((p) => p.name))

    // one engine per live session (Auto mode counters are per conversation); the mode is read
    // per tool call, never baked into the engine (`permission-plugin.ts`)
    const createEngine = (sessionId: string, gate?: ProgramGate): PermissionEngine => {
      if (gate !== undefined) {
        // a program run (D3): the authority approves, `forbidden` and the connectors' own deny
        // rules deny, nothing asks (`dontAsk`). The connectors' ask rules are left out on purpose:
        // the client granted these tools to the program; tools pinned to always ask (writes of
        // third-party connectors) stay so and are refused, they are gates.
        return createPermissionEngine({
          roots: () => [{ virtual: '/', real: '/' }],
          mode: 'dontAsk',
          rules: {
            allow: gate.rules.allow,
            ask: [],
            // a file tool the agent's Files connector has switched off is not denied here: the
            // authority of the program decides (`fileGrant`), and it is closed-world
            deny: [
              ...out.rules.deny.filter((rule) => !PROGRAM_FILE_TOOLS.includes(rule)),
              ...gate.rules.deny,
            ],
          },
          // the authority is the client's explicit grant for this run, so it satisfies a connector's
          // "Ask first" for the tools it names (`refuse` below is closed world); "Off" is a deny
          // rule above and still wins (D6 of the e2e pass)
          toolKinds: { ...MEMORY_TOOL_KINDS, ...withoutPinnedAsks(out.rules) },
        })
      }
      const classifier = classifierFor(sessionId, def.id)
      // an assigned task may bring grants: allow rules, and the plain "Ask first" of exactly those
      // tools is lifted (the client pre-approved them); pinned asks and deny rules stay
      const grants = deps.taskGrants?.(sessionId)
      const granted =
        grants === undefined
          ? []
          : taskGrantRules(
              grants,
              Object.entries(out.toolNameMap).map(([name, origin]) => ({
                name,
                connectorId: origin.connectorId,
                connectionIds: origin.connectionIds,
              })),
            )
      // the plain "Ask first" of exactly the tools the grants name (and the file tools the paths need)
      const lifted = new Set<string>(
        grants === undefined ? [] : [...granted, ...runFileTools(grants)],
      )
      return createPermissionEngine({
        roots: () => [{ virtual: '/', real: '/' }],
        mode: 'default',
        ...(classifier === undefined ? {} : { classifier }),
        // connector modes and the app's own rules, most restrictive wins (activateConnectors)
        // read-risk native actions of the agent's channel connections never ask (derived from the
        // adapters' action catalog, `infra/channels`)
        rules: {
          allow: [
            ...out.rules.allow,
            ...(deps.channels?.()?.readActionTools(def.id) ?? []),
            ...granted,
          ],
          ask: lifted.size === 0 ? out.rules.ask : out.rules.ask.filter((r) => !lifted.has(r)),
          deny: out.rules.deny,
        },
        // pinned asks (write / destructive tools of non-built-in connectors) ask even in Bypass
        toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
      })
    }

    /**
     * The authority of a program run, closed world (see `ProgramGate`); undefined for other
     * sessions. The rules are read from the program on every tool call (`sync`), not frozen when
     * the session opens: an approved amendment (`request_authority`) widens the program and the
     * run that was parked at the time can use it as soon as it resumes, in this process or after a
     * restart.
     */
    const gateOf = (sessionId: string): ProgramGate | undefined => {
      if (profileOfSession(sessionId).permissions !== 'program-authority') return undefined
      if (originOfSession(sessionId) === 'heartbeat') {
        // the heartbeat is read-only and has one fixed authority (`HEARTBEAT_ALLOWED`)
        const match = {
          roots: [{ virtual: '/', real: '/' }],
          toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
        }
        // the read-only tools of connected third-party services (a tracker, a CRM) are what the
        // person's checklist usually asks a beat to look at; writes stay out (D18 of the e2e pass)
        const kinds = deps.connectors.toolKinds(def.id) ?? {}
        const lookups = Object.entries(out.toolNameMap)
          .filter(
            ([name, origin]) =>
              kinds[name] === 'read' &&
              !out.rules.deny.includes(name) &&
              deps.connectors.definitions.find((d) => d.id === origin.connectorId)?.source !==
                'builtin',
          )
          .map(([name]) => name)
        /**
         * Chat tools of a beat: reads go through (a download writes a file: refused); the one
         * post is allowed only as a new message to the chat of an active standing order, inside the
         * daily cap of that chat and not as a repeat. Read on every call, like a program's authority.
         */
        const channelCall = (call: { toolName: string; input: unknown }): string | undefined => {
          const allowed = deps.heartbeat?.()?.allowed(def.id) ?? []
          let target: HeartbeatDestination | { error: string } | undefined
          const input = (call.input ?? {}) as Record<string, unknown>
          const gw = deps.channels?.()
          if (call.toolName === HEARTBEAT_POST_TOOL && allowed.length > 0 && gw !== undefined) {
            try {
              const str = (v: unknown): string | undefined =>
                typeof v === 'string' ? v : undefined
              const ref =
                str(input.connection) === undefined
                  ? undefined
                  : resolveConnectionRef(gw.connectionsOf(def.id), input.connection as string)
              if (ref !== undefined && !ref.ok) target = { error: ref.text }
              else {
                const conversation = str(input.conversation)
                const topic = str(input.topic)
                const t = gw.resolveTarget(def.id, sessionId, {
                  ...(ref === undefined ? {} : { connection: ref.id }),
                  ...(conversation === undefined ? {} : { conversation }),
                  ...(topic === undefined ? {} : { topic }),
                })
                target = { connectionId: t.config.connectionId, nodeId: t.node.id }
              }
            } catch (error) {
              target = { error: errorText(error) }
            }
          }
          const refusal = heartbeatChannelRefusal(call, { allowed, target })
          if (refusal !== undefined || call.toolName !== HEARTBEAT_POST_TOOL) return refusal
          const text = typeof input.text === 'string' ? input.text : ''
          if (text.trim() === '') return 'Not posted: send needs text.'
          const to = destKey({
            kind: 'chat',
            connectionId: (target as HeartbeatDestination).connectionId,
            nodeId: (target as HeartbeatDestination).nodeId,
          })
          return deps.heartbeat?.()?.reservePost(def.id, to, text)
        }
        // what the live orders of owners and admins open for the running beat (P52): the tools of
        // their `needs` that the agent actually has, and writing their ledger paths. The snapshot is
        // read on every call; the engine rules below only make the candidates callable, `refuse`
        // is what decides.
        const facts = toolFactsOf(out, deps.connectors.toolKinds(def.id) ?? {})
        const candidates = facts
          .filter(
            (f) =>
              f.connectorId === 'web' ||
              f.connectorId === 'browser' ||
              deps.connectors.definitions.find((d) => d.id === f.connectorId)?.source !== 'builtin',
          )
          .map((f) => f.name)
        const grants = (): { needs: string[]; writes: string[] } =>
          deps.heartbeat?.()?.grants(def.id) ?? { needs: [], writes: [] }
        const fileWrites = HEARTBEAT_FILE_WRITES.filter(
          (t) => t in out.toolNameMap && !out.rules.deny.includes(t),
        )
        return {
          rules: {
            allow: [
              ...HEARTBEAT_ALLOWED,
              HEARTBEAT_POST_TOOL,
              ...lookups,
              ...candidates,
              ...fileWrites,
            ],
            deny: [],
          },
          refuse: (call) => {
            if (call.toolName === HEARTBEAT_POST_TOOL || call.toolName === 'channel_read') {
              return channelCall(call)
            }
            if (isFileWrite(call.toolName)) {
              return fileWrites.includes(call.toolName) || call.toolName === 'delete_file'
                ? ledgerWriteRefusal(call, grants().writes)
                : heartbeatRefusal(call.toolName)
            }
            if (lookups.includes(call.toolName)) return undefined
            if (candidates.includes(call.toolName)) {
              return needTools(grants().needs, facts, out.rules).includes(call.toolName)
                ? undefined
                : `Not available in a heartbeat: ${call.toolName}. No live standing order of an owner or an admin needs it (an order lists its needs: web, browser, phone/<slug>).`
            }
            return HEARTBEAT_ALLOWED.some((rule) =>
              matchRule(rule, call, { ...match, polarity: 'allow' }),
            )
              ? undefined
              : heartbeatRefusal(call.toolName)
          },
          askedReason: heartbeatRefusal,
        }
      }
      const parsed = parseProgramSession(sessionId) ?? parseRehearsalSession(sessionId)
      if (parsed === undefined) return undefined
      const tools = Object.entries(out.toolNameMap).map(([name, origin]) => ({
        name,
        connectorId: origin.connectorId,
        connectionIds: origin.connectionIds,
      }))
      const match = {
        roots: [{ virtual: '/', real: '/' }],
        toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
      }
      // a deleted program leaves nothing granted: its session can still be read, never act
      const current = (): {
        name: string
        rules: { allow: string[]; deny: string[] }
        readable: string[]
      } => {
        const program = deps.programs?.get(parsed.programId)
        return {
          name: program?.name ?? parsed.programId,
          readable:
            program === undefined ? [] : [...program.authority.read, ...program.authority.write],
          rules: program === undefined ? { allow: [], deny: [] } : programRules(program, tools),
        }
      }
      return {
        rules: current().rules,
        refuse(call) {
          const { name, rules, readable } = current()
          for (const rule of rules.deny) {
            if (matchRule(rule, call, { ...match, polarity: 'restrict' })) {
              return forbiddenReason(name, call.toolName, rule)
            }
          }
          const granted = rules.allow.some((rule) =>
            matchRule(rule, call, { ...match, polarity: 'allow' }),
          )
          if (granted) return undefined
          // a search or listing without a path scans the whole tree: say where it may look
          const listing =
            (match.toolKinds as Record<string, { listing?: unknown } | undefined>)[call.toolName]
              ?.listing !== undefined
          return outsideAuthorityReason(name, call.toolName, listing ? readable : [])
        },
        askedReason: (toolName) => outsideAuthorityReason(current().name, toolName),
        // a rehearsal does not call external systems that would change something: the call is
        // recorded and the model reads what it would have done (`domain/rehearsal.ts`)
        ...(originOfSession(sessionId) !== 'rehearsal'
          ? {}
          : {
              simulate(call: { toolName: string; input: unknown; risk?: string | undefined }) {
                const origin = out.toolNameMap[call.toolName]
                if (
                  !isSimulatedCall({
                    connectorId: origin?.connectorId,
                    risk: call.risk,
                    kind: deps.connectors.toolKinds(def.id)?.[call.toolName],
                  })
                ) {
                  return undefined
                }
                rehearsalSessions
                  .get(sessionId)
                  ?.recorder.simulated({ tool: call.toolName, input: call.input })
                return simulatedText(call.toolName, call.input)
              },
            }),
        // the engine learns rules the program gained since the session opened (session scope)
        async sync(engine) {
          const { rules } = current()
          for (const rule of rules.allow) await engine.addRule('allow', rule, 'session')
          for (const rule of rules.deny) await engine.addRule('deny', rule, 'session')
        },
      }
    }

    // file tools the Files connector of this agent does not offer (switched off, or no connection)
    const withheldFileTools = PROGRAM_FILE_TOOLS.filter(
      (t) => !(t in out.toolNameMap) || out.rules.deny.includes(t),
    )
    /** What the authority of the program of a session grants of them (empty for other sessions). */
    const grantedFileTools = (sessionId: string): ReadonlySet<string> => {
      const task = deps.taskGrants?.(sessionId)
      if (task !== undefined) return new Set(runFileTools(task))
      const parsed = parseProgramSession(sessionId) ?? parseRehearsalSession(sessionId)
      const program = parsed === undefined ? undefined : deps.programs?.get(parsed.programId)
      return new Set(program === undefined ? [] : runFileTools(program.authority))
    }

    /** The long-run plugin of this worker variant; its controls are kept for stop/resume/state. */
    const workerLongRun = (): LongRunPlugin => {
      const lr = longRun({
        // continuations go through the same lock and runtime as every session of this agent
        sessions: () => ({
          session: (id: string) =>
            (self() as HarnessAgent).session(id, {
              lock,
              runtime: { workspaceId, agentId: def.id },
            }) as HarnessSession,
        }),
        state: storage.state,
        match: (ctx) => isWorkerSession(ctx.session.id),
        chunkSteps: longRunTuning.chunkSteps,
        ...(longRunTuning.maxCostUsd > 0 ? { maxCostUsd: longRunTuning.maxCostUsd } : {}),
        ...(longRunTuning.maxDurationMs > 0 ? { maxDurationMs: longRunTuning.maxDurationMs } : {}),
      })
      longRuns.set(def.id, lr)
      return lr
    }

    const plugins = [
      // memory needs the `fs` service: a bare filesystem plugin when only memory is on. With
      // programs it also defines the file tools (hidden from every session but a program run that
      // is granted them, `fileGrant`), so an agent without a Files connection can still be given
      // paths to write
      // MCP tools too: the filesystem plugin holds their screenshots as files (`toolMedia`)
      ...((pluginNames.has('memory') || deps.programs !== undefined || out.mcpSources.length > 0) &&
      !pluginNames.has('filesystem')
        ? [
            filesystem({
              fs: sessionFileSystem(
                libraryFs(sqlite, {
                  agentId: def.id,
                  ...(deps.onFileChange ? { onChange: deps.onFileChange } : {}),
                }),
              ),
              tools: deps.programs === undefined ? [] : (PROGRAM_FILE_TOOLS as FileToolName[]),
              hiddenPrefixes: ['/memories', TOOL_MEDIA_DIR],
              ...(def.skills.length > 0 ? { skills: { root: '/skills' } } : {}),
            }),
          ]
        : []),
      ...out.plugins,
      // file tools of the agent's connector stay as they are; a program run may add those its
      // authority grants (the engine of a run does not deny them, see `createEngine`)
      fileGrant({ withheld: withheldFileTools, granted: grantedFileTools }),
      ...(deps.chatTools === undefined
        ? []
        : [
            chatTools({
              off: (sessionId) => new Set(deps.chatTools?.off(sessionId) ?? []),
              origins: out.toolNameMap,
            }),
          ]),
      ...(deps.decisions === undefined
        ? []
        : [
            decisions({
              intake: deps.decisions,
              agentOf: (slug) => deps.agentBySlug?.(slug),
              timezone: () => currentSettings().timezone,
              // `request_authority` for a tool the run can never have explains why instead of
              // parking: no decision of the client can make the tool exist
              unavailable: (sessionId, asked) => {
                const parsed = parseProgramSession(sessionId)
                const program =
                  parsed === undefined ? undefined : deps.programs?.get(parsed.programId)
                if (program === undefined) return undefined
                const merged = {
                  ...program.authority,
                  tools: [...program.authority.tools, ...(asked.tools ?? [])],
                  read: [...program.authority.read, ...(asked.read ?? [])],
                  write: [...program.authority.write, ...(asked.write ?? [])],
                }
                const problems = toolWarnings(
                  { tools: asked.tools ?? [] },
                  availabilityOf(def, out, merged),
                )
                return problems.length === 0
                  ? undefined
                  : `${problems.map((w) => w.message).join(' ')} Asking for it cannot help: finish what is inside your authority and report what you could not do (status 'needs_decision').`
              },
            }),
          ]),
      ...(deps.workQueue === undefined
        ? []
        : [
            workQueue({
              intake: deps.workQueue,
              agentOf: (slug) => deps.agentBySlug?.(slug),
            }),
          ]),
      // one clock for the team: the `datetime` tool reads the team timezone at every call
      clock({
        timezone: () => currentSettings().timezone,
        label: 'Team',
        description: TEAM_DATETIME_DESCRIPTION,
      }),
      // memory holds durable facts only: no system state, no style notes (hook only)
      memoryDiscipline(),
      // long turns: the base step budget grows while the turn makes progress (hook only)
      // a turn that reaches its cap hands the rest of the job to the background worker
      stepBudget({
        cap: (ctx) => stepCapOf(ctx.session.id, ctx.session.parent !== undefined),
        onCap: { reminder: HAND_OVER_REMINDER },
      }),
      // a worker is one long job: chunks with checkpoints, bounded by cost and time, resumable
      ...(worker ? [workerLongRun()] : []),
      // read-only tools over the agent's other sessions and runs (P52); every session kind gets them
      sessionContext({
        sqlite: deps.sqlite,
        agentOf: (slug) => deps.agentBySlug?.(slug),
        agentByRef: (ref) => deps.agentById?.(ref) ?? deps.agentBySlug?.(ref),
        gateway: () => deps.channels?.(),
        timezone: () => currentSettings().timezone,
        ...(deps.sessionRefs === undefined ? {} : { heartbeatRefs: deps.sessionRefs }),
      }),
      ...(deps.heartbeat === undefined ? [] : [heartbeat({ intake: deps.heartbeat })]),
      ...(deps.channels === undefined
        ? []
        : [
            channels({
              gateway: deps.channels,
              agentOf: (slug) => deps.agentBySlug?.(slug),
              ...(deps.taskMayPost === undefined ? {} : { taskMayPost: deps.taskMayPost }),
              ...(deps.turnRetry === undefined ? {} : { retry: deps.turnRetry }),
            }),
          ]),
      // the `reminder` tool of a person's own chat thread (a channel session has its own)
      ...(deps.channels === undefined
        ? []
        : [webReminders({ gateway: deps.channels, agentOf: (slug) => deps.agentBySlug?.(slug) })]),
      // the `standing_order` tool of a person's own chat (web or a channel): ongoing instructions
      // the heartbeat carries out (P51)
      ...(deps.channels === undefined
        ? []
        : [
            standingOrders({
              gateway: deps.channels,
              agentOf: (slug) => deps.agentBySlug?.(slug),
              orders: () => deps.heartbeat?.()?.orders,
              enabled: (slug) => deps.heartbeat?.()?.heartbeatOn(slug) === true,
              zone: () => currentSettings().timezone,
              now: () => Date.now(),
            }),
          ]),
      // `person_note` of a person's own chat thread, and no communication style in memory
      ...(deps.channels === undefined ? [] : [webPersonNote({ gateway: deps.channels })]),
      // a delegated agent of a chat waits for approval there too
      ...(deps.channels === undefined
        ? []
        : [
            delegatedApprovals({
              gateway: deps.channels,
              agentOf: (slug) => {
                const found = deps.agentBySlug?.(slug)
                return found === undefined ? undefined : { id: found.id, name: found.name }
              },
            }),
          ]),
      sessionPermissions({
        createEngine,
        gate: gateOf,
        manualAllowed: (_agentId, toolName) =>
          deps.connectors.readAllowed(def.id)?.has(toolName) === true,
        // a post an owner or admin just asked for in a chat needs no second "ya" (checked in code)
        directGrant: async (ctx, call) =>
          (await deps.channels?.()?.directInstruction(ctx.session.id, call)) === true,
        registry: engines,
        mode: (ctx) =>
          resolveSessionMode(def, ctx.session.id, ctx.session.parent?.sessionId, currentSettings())
            .mode,
        onAuto: (sessionId, event, engine) =>
          deps.onAutoEvent?.({
            sessionId,
            agentId: def.id,
            event,
            state: engine.autoState(),
            mode: resolveSessionMode(def, sessionId, undefined, currentSettings()).mode,
          }),
      }),
      // child side of subagents for every agent but the lead: send_message to main, reports of
      // resumed turns, reconcile on open
      ...(worker
        ? [
            // a worker is the child of its main session: reports and waits go back to `main`
            subagent({
              agents: {},
              approvals: 'park',
              parentAgent: main,
              childSession: childSessionOptions,
              parentSession: parentSessionOptions,
              selfAgent: self,
              messageTool: true,
              outputTool: false,
              stopTool: false,
              onPark: 'notice',
            }),
          ]
        : // a lead with the Team connector has its worker next to its role agents (`teamPlugin`)
          def.role === 'lead' && pluginNames.has('subagent')
          ? []
          : [
              subagent({
                // its own background worker (long jobs); for a role agent also the child side
                // towards the lead (a lead without the Team connector has no parent)
                agents: () => ({ [WORKER_TYPE]: workerEntry(def) }),
                approvals: 'park',
                ...(def.role === 'lead' ? {} : { parentAgent: leadAgent }),
                childSessionId: childIdFor,
                childSession: (info) =>
                  info.agent === WORKER_TYPE
                    ? { lock, runtime: { workspaceId, agentId: def.id } }
                    : childSessionOptions(info),
                parentSession: parentSessionOptions,
                selfAgent: self,
                background: {
                  default: true,
                  ...(backgroundTuning.timeoutMs > 0
                    ? { timeoutMs: backgroundTuning.timeoutMs }
                    : {}),
                  startGraceMs: backgroundTuning.startGraceMs,
                  waitingReminderMs: backgroundTuning.waitingReminderMs,
                },
                parkTimeoutMs: fixed.parkTimeoutMs,
                maxConcurrent: 2,
                messageTool: def.role !== 'lead',
                outputTool: true,
                stopTool: true,
                // "waiting for the client" is a stored notice, not an extra lead model call; the
                // role agent's final report still wakes the lead
                onPark: 'notice',
              }),
            ]),
      ...(deps.routineOutcomes === undefined
        ? []
        : [
            routineOutcomes({
              outcomes: {
                turnEnded: (e) => deps.routineOutcomes?.()?.turnEnded(e) ?? Promise.resolve(),
              },
              ...(deps.turnRetry === undefined ? {} : { retry: deps.turnRetry }),
            }),
          ]),
      ...(deps.taskStore === undefined || deps.events === undefined
        ? []
        : [
            taskIndex({
              store: deps.taskStore,
              events: deps.events,
              agentOf: (slug) => {
                const found = deps.agentBySlug?.(slug)
                return found === undefined ? undefined : { id: found.id, name: found.name }
              },
              describeStop: (sessionId, stop) =>
                stop === 'cost-cap' ? capTextOf(sessionId) : undefined,
              ...(deps.turnRetry === undefined ? {} : { retry: deps.turnRetry }),
            }),
          ]),
      // a waiting automatic retry is cancelled by any other turn; a failure schedules one
      ...(deps.turnRetry === undefined ? [] : [turnRetry({ retries: deps.turnRetry })]),
      // a chat turn that stops on a budget leaves a readable notice (which limit, where to raise it)
      // (`text` peeks the refusal itself: the task index reads the same one for its stop text)
      budgetNotice({
        text: (_refusal, sessionId) => (isDmSession(sessionId) ? capTextOf(sessionId) : ''),
      }),
      // session events of the feed (turn-started, pending-changed, approval-decided, ...): the
      // library plugin writes them on whichever instance runs the turn
      ...(deps.activityStore === undefined
        ? []
        : [
            activity({
              store: deps.activityStore,
              agentOf: (slug) => deps.agentBySlug?.(slug)?.id,
              types: SESSION_EVENT_TYPES,
              messages: false,
            }),
          ]),
      // the agent's own persona: view, propose, and (for admins, confirmed) apply and revert
      ...(deps.personaIntake === undefined
        ? []
        : [
            persona({
              intake: deps.personaIntake,
              agentOf: (slug) => deps.agentBySlug?.(slug),
              channels: () => deps.channels?.(),
            }),
          ]),
      // hook only: no tools, no instructions (prompt-cache prefix untouched)
      ...(deps.activityLog === undefined ? [] : [deps.activityLog.plugin()]),
    ]

    const roster = deps.roster
    // the persona of this version (layers 2 and 3); the same text for every turn of the version
    const personaNow = deps.personas?.latest(def.id)
    const callName = nameOf(personaNow?.identity, def.name)
    const reminder = {
      text: (): string => {
        const lines = [
          // the team timezone, like routines, reminders and chat times (never the host's or UTC)
          `Now: ${nowLine(Date.now(), currentSettings().timezone)}. For the exact time or date arithmetic use the ${DATETIME_TOOL} tool.`,
          `You are ${callName}.`,
        ]
        if (def.role === 'lead' && roster !== undefined) {
          const others = roster().filter((a) => a.id !== def.id)
          lines.push(
            `Your team: ${others.map((a) => `${a.slug} (${a.name}${a.description ? `: ${a.description}` : ''})`).join('; ') || 'none yet'}`,
          )
        }
        return lines.join('\n')
      },
      refresh: 'turn' as const,
    }

    const agent = defineHarnessAgent({
      id: def.slug,
      model: deps.models.resolve(...selectionOf(def, settings)),
      // the catalog knows the window of real models; 200k only for models it does not list
      // the working window: compaction summarizes at 80 % of it. A model that reads 1 M tokens would
      // otherwise carry ~800 k tokens of history into every call before anything is summarized
      // (production: 40 k tokens per call on average, 150 k at worst)
      contextWindow: Math.min(
        modelInfoOf(def, settings).contextWindow ?? 200_000,
        deps.limits?.contextCap ?? 128_000,
      ),
      ...(catalog === undefined ? {} : { models: catalog }),
      // never leave the output cap to the provider: OpenRouter-style gateways then reserve (and
      // check credits for) the model maximum on every call
      settings: {
        maxOutputTokens: outputCapOf(modelInfoOf(def, settings).maxOutputTokens),
        timeout: { firstChunkMs: MODEL_IDLE_TIMEOUT_MS, chunkMs: MODEL_IDLE_TIMEOUT_MS },
        ...(deps.tuning?.modelMaxRetries === undefined
          ? {}
          : { maxRetries: deps.tuning.modelMaxRetries }),
      },
      hooks: { timeoutMs: HOOK_TIMEOUT_MS },
      toolSources: { timeoutMs: TOOL_SOURCE_TIMEOUT_MS, retryAfterMs: TOOL_SOURCE_RETRY_MS },
      warnings: { dedupeWindowMs: WARNING_DEDUPE_MS },
      ...(deps.observe === undefined ? {} : { observe: deps.observe }),
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
      instructions: [
        TEAM_PREAMBLE,
        // a worker does one job for its main session: no team playbook, no delegation
        ...(worker
          ? [WORKER_NOTE]
          : [def.role === 'lead' ? LEAD_PLAYBOOK : ROLE_AGENT_NOTE, WORKER_PLAYBOOK]),
        ...(personaNow === undefined
          ? [def.instructions]
          : personaInstructions(personaNow, def.name)),
        ...out.instructions,
        reminder,
      ],
      plugins,
      storage,
      budget: {
        ledger: {
          adapter: ledger,
          scopes: (ctx) => [
            workspaceScope(String(ctx.runtime.workspaceId ?? workspaceId)),
            ...programScopes(ctx.session.id),
          ],
        },
      },
      ...(out.mcpSources.length > 0 ? { mcp: out.mcpSources } : {}),
      // role agents are bounded by the same cap as a delegated run (also when a chat opens them directly)
      // a base budget per turn; `stepBudget` extends it while the turn makes progress
      loop: {
        maxSteps: worker ? WORKER_BASE_STEPS : def.role === 'lead' ? 40 : fixed.childMaxTurns,
      },
      // uploads are checked by the chat route; the core caps data URLs at the same size
      inputFiles: {
        protocols: ['data:', 'https:', 'library:'],
        maxBytes: MAX_UPLOAD_BYTES,
        resolve: resolveUpload,
        describe: describeUpload,
      },
      ...(deps.tuning?.streams ? { streams: deps.tuning.streams } : {}),
      ...(deps.tuning?.inbox ? { inbox: deps.tuning.inbox } : {}),
      ...(deps.tuning?.abortPollMs !== undefined || deps.instanceId !== undefined
        ? {
            recovery: {
              ...(deps.tuning?.abortPollMs !== undefined
                ? { abortPollMs: deps.tuning.abortPollMs }
                : {}),
              ...(deps.instanceId !== undefined ? { instanceId: deps.instanceId } : {}),
            },
          }
        : {}),
      compaction: { summarizeAt: 0.8, prune: {} },
      // screenshots (browser, phone and other MCP tools) pile up: the model sees the newest three
      toolOutput: { maxChars: 30_000, strategy: 'evict', keepImages: 3 },
      onWarning: (w: HarnessWarning) => {
        noteDrift(w)
        deps.onWarning?.(w)
      },
    })
    if (worker) workerSelf = agent
    else selves.set(def.id, agent)
    return agent
  }

  /** The worker variant of an agent (same version key as the main one, built once). */
  const workers = new Map<string, HarnessAgent>()
  function workerAgentFor(def: AgentDef): HarnessAgent {
    factoryAgentFor(def, def.archivedAt !== null)
    const key = `${latest.get(def.id) ?? def.id}#worker`
    let agent = workers.get(key)
    if (agent === undefined) {
      const out = deps.connectors.activated(def.id) ?? EMPTY_ACTIVATION
      agent = build(def, currentSettings(), out, 'worker')
      for (const k of [...workers.keys()]) if (k.startsWith(`${def.id}@`)) workers.delete(k)
      workers.set(key, agent)
    }
    return agent
  }
  /** The catalog entry of an agent's worker. */
  const workerEntry = (def: AgentDef) => ({
    agent: workerAgentFor(def),
    description: WORKER_DESCRIPTION,
    maxTurns: WORKER_BASE_STEPS,
  })

  /**
   * The pick of an agent as `ModelConfig.resolve` takes it: the model id and the profile. An agent
   * without a profile follows the workspace default profile, and without a model the workspace
   * default model (only while the profile is the workspace's: a profile of its own has its own
   * default model).
   */
  function selectionOf(
    def: AgentDef,
    settings: Pick<ReturnType<typeof currentSettings>, 'defaultModel' | 'defaultProfile'>,
  ): [string | null, string | null] {
    return [
      def.model ?? (def.modelProfile === null ? settings.defaultModel : null),
      def.modelProfile ?? settings.defaultProfile,
    ]
  }

  /** The catalog's output limit of the model, capped; a sane default for models it does not list. */
  function outputCapOf(catalogMax: number | undefined): number {
    return Math.min(catalogMax ?? DEFAULT_MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS_CAP)
  }

  function modelInfoOf(
    def: AgentDef,
    settings: Pick<ReturnType<typeof currentSettings>, 'defaultModel' | 'defaultProfile'>,
  ): ModelInfoOf {
    const sel = deps.models.effective?.(...selectionOf(def, settings))
    if (sel !== undefined) {
      let model: LanguageModel | undefined
      try {
        model = deps.models.resolve(...selectionOf(def, settings))
      } catch {
        model = undefined
      }
      const info = model === undefined ? undefined : lookupModel(catalog, model)
      return { id: sel.modelId, profileId: sel.profileId, ...(info ?? {}) }
    }
    const id = def.model ?? settings.defaultModel ?? deps.models.defaultModel
    let info = lookupModel(catalog, id)
    if (info === undefined) {
      // the id alone is not what the catalog keys on (a scripted or aliased model): ask the model
      try {
        info = lookupModel(catalog, deps.models.resolve(...selectionOf(def, settings)))
      } catch {
        info = undefined
      }
    }
    return { id, ...(info ?? {}) }
  }

  /**
   * After a rebuild (persona, connectors, settings, models): close the sessions of the replaced builds as soon as they are idle (no
   * turn, nothing queued, no pending approval), so that the next message of a chat is run by the
   * new build and its persona. A session that is busy keeps its build until it is idle.
   */
  async function closeSuperseded(agentId: string): Promise<void> {
    const olds = superseded.get(agentId)
    if (olds === undefined || olds.length === 0) return
    for (const old of olds) {
      const sessions = liveSessions.get(old)
      if (sessions === undefined) continue
      for (const [id, ref] of [...sessions]) {
        const session = ref.deref()
        if (session === undefined) {
          sessions.delete(id)
          continue
        }
        const done = (async (): Promise<void> => {
          try {
            await session.idle()
            if ((await old.peek(id).pending()) !== null) return
            // a message may have been queued while the checks ran: wait for the session to be
            // idle once more right before the close, so a queued message is not cut off
            await session.idle()
            if ((await old.peek(id).pending()) !== null) return
            await old.closeSession(id)
          } catch {
            // already closed or evicted: nothing left to do
          } finally {
            sessions.delete(id)
            pruneSuperseded(agentId)
          }
        })()
        // an idle session is closed before the caller opens the new one; a busy one finishes first
        await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 100))])
      }
    }
    pruneSuperseded(agentId)
  }

  /** Remember, for every live session of `old`, which tools the new build adds and removes. */
  function noteToolChange(old: HarnessAgent, now: readonly string[]): void {
    const before = toolsOfBuild.get(old)
    if (before === undefined) return
    const was = new Set(before)
    const is = new Set(now)
    const added = now.filter((t) => !was.has(t))
    const removed = before.filter((t) => !is.has(t))
    if (added.length === 0 && removed.length === 0) return
    for (const [id, ref] of liveSessions.get(old) ?? []) {
      if (ref.deref() === undefined) continue
      const n = toolNotices.get(id) ?? { added: new Set<string>(), removed: new Set<string>() }
      for (const t of added) {
        n.removed.delete(t)
        n.added.add(t)
      }
      for (const t of removed) {
        n.added.delete(t)
        n.removed.add(t)
      }
      toolNotices.set(id, n)
    }
  }

  /** The text of a tool change notice (lists capped: a big connector would flood the chat). */
  const toolNoticeText = (n: { added: Set<string>; removed: Set<string> }): string => {
    const list = (s: Set<string>): string => {
      const all = [...s]
      return `${all.slice(0, 20).join(', ')}${all.length > 20 ? ` and ${all.length - 20} more` : ''}`
    }
    return [
      'Your tools changed since your last message here (connectors or settings were updated).',
      n.added.size > 0 ? `Now available: ${list(n.added)}.` : '',
      n.removed.size > 0 ? `No longer available: ${list(n.removed)}.` : '',
      'What you said earlier in this chat about what you can or cannot do may be outdated: check your tools again before answering.',
    ]
      .filter((l) => l !== '')
      .join(' ')
  }

  /** Forget replaced builds that hold no live session any more (the maps must not only grow). */
  function pruneSuperseded(agentId: string): void {
    const olds = superseded.get(agentId)
    if (olds === undefined) return
    const keep = olds.filter((old) => {
      const sessions = liveSessions.get(old)
      if (sessions === undefined) return false
      for (const [id, ref] of [...sessions]) if (ref.deref() === undefined) sessions.delete(id)
      if (sessions.size > 0) return true
      liveSessions.delete(old)
      return false
    })
    if (keep.length === 0) superseded.delete(agentId)
    else superseded.set(agentId, keep)
  }

  /** Every build of an agent that may hold a session: current, superseded and worker. */
  function buildsOf(agentId: string): HarnessAgent[] {
    const out = new Set<HarnessAgent>()
    for (const [k, a] of cache) if (k.startsWith(`${agentId}@`)) out.add(a)
    for (const a of superseded.get(agentId) ?? []) out.add(a)
    for (const [k, a] of workers) if (k.startsWith(`${agentId}@`)) out.add(a)
    return [...out]
  }

  /** No turn, nothing queued, no pending approval (a session no one else opened is read from storage). */
  async function idleNow(build: HarnessAgent, id: string): Promise<boolean> {
    const session = liveSessions.get(build)?.get(id)?.deref()
    if (session !== undefined) {
      const quiet = await Promise.race([
        session.idle().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ])
      if (!quiet) return false
    }
    const peek = build.peek(id)
    return (await peek.busy()) === null && (await peek.pending()) === null
  }

  async function closeOn(build: HarnessAgent, id: string, agentId: string): Promise<void> {
    try {
      await build.closeSession(id)
    } catch {
      // already closed or evicted
    }
    liveSessions.get(build)?.delete(id)
    pruneSuperseded(agentId)
  }

  /** Close a busy session right after its turn (polled; gives up after `RELOAD_WAIT_MS`). */
  async function closeWhenIdle(
    build: HarnessAgent,
    id: string,
    agentId: string,
    servers?: ReadonlySet<string>,
  ): Promise<void> {
    const end = Date.now() + RELOAD_WAIT_MS
    while (!shutdown && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, RELOAD_POLL_MS))
      try {
        if (await idleNow(build, id)) {
          // a message may have been queued while the check ran
          await new Promise((resolve) => setTimeout(resolve, 20))
          if (await idleNow(build, id)) {
            await closeOn(build, id, agentId)
            await clearPins(id, servers)
            return
          }
        }
      } catch {
        return
      }
    }
  }

  /** Sessions whose pinned remote MCP tools drifted (`W_MCP_DRIFT`): session id to server to note. */
  const drifted = new Map<string, Map<string, DriftNote>>()
  const noteDrift = (w: HarnessWarning): void => {
    if (w.code !== 'W_MCP_DRIFT') return
    const d = w.details ?? {}
    const sessionId = d.sessionId
    const source = d.source
    if (typeof sessionId !== 'string' || typeof source !== 'string') return
    const tools = Array.isArray(d.tools)
      ? d.tools.filter((t): t is string => typeof t === 'string')
      : []
    const server = source.replace(/^mcp:/, '')
    const bySession = drifted.get(sessionId) ?? new Map<string, DriftNote>()
    bySession.set(server, { server, tools, at: Date.now() })
    drifted.set(sessionId, bySession)
  }

  /**
   * Remove the pinned MCP definitions of one stored session (`servers`: only these) so the next
   * listing pins what the servers offer now. Called after the session was closed: a live session
   * would write its old pins back at the end of its turn. Returns the number of pin sets removed.
   */
  async function clearPins(sessionId: string, servers?: ReadonlySet<string>): Promise<number> {
    const bySession = drifted.get(sessionId)
    if (bySession !== undefined) {
      if (servers === undefined) drifted.delete(sessionId)
      else {
        for (const s of servers) bySession.delete(s)
        if (bySession.size === 0) drifted.delete(sessionId)
      }
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const stored = await storage.state.get(sessionId)
      if (stored === null) return 0
      const next = stripMcpPins(stored, servers)
      if (next === undefined) return 0
      const write = { ...next.state, rev: (typeof stored.rev === 'number' ? stored.rev : 0) + 1 }
      if (storage.state.setIf === undefined) {
        await storage.state.set(sessionId, write)
        return next.cleared
      }
      if (await storage.state.setIf(sessionId, write, stored.rev)) return next.cleared
    }
    return 0
  }

  function pinnedSessions(): Array<{ sessionId: string; servers: string[] }> {
    const rows = sqlite
      .query<{ session_id: string; state: string }, []>(
        `SELECT session_id, state FROM eh_state WHERE state LIKE '%:pins"%'`,
      )
      .all()
    const out: Array<{ sessionId: string; servers: string[] }> = []
    for (const row of rows) {
      try {
        const servers = pinnedServers(JSON.parse(row.state) as SessionStateSnapshot)
        if (servers.length > 0) out.push({ sessionId: row.session_id, servers })
      } catch {
        // an unreadable state has no pins we can clear
      }
    }
    return out
  }

  /**
   * `only`: one session id; without it every session of the agent that is open here, plus
   * `extra.stored` (stored sessions of the agent that are not open here: only their pins are cleared).
   */
  async function reloadFor(
    def: AgentDef,
    only?: string,
    extra: { stored?: readonly string[]; servers?: ReadonlySet<string> } = {},
  ): Promise<ReloadResult> {
    const targets: Array<{ build: HarnessAgent; id: string }> = []
    for (const build of buildsOf(def.id)) {
      for (const [id, ref] of liveSessions.get(build) ?? []) {
        if (ref.deref() === undefined) continue
        if (only === undefined || id === only) targets.push({ build, id })
      }
    }
    const ids = new Set(targets.map((t) => t.id))
    if (only !== undefined) ids.add(only)
    deps.connectors.invalidate(def.id)
    await prepareAgent(def)
    for (const id of ids) reloadNotices.add(id)
    let closed = 0
    let pending = 0
    let pinsCleared = 0
    const cleared = new Set<string>()
    for (const { build, id } of targets) {
      if (await idleNow(build, id)) {
        await closeOn(build, id, def.id)
        closed++
        cleared.add(id)
        pinsCleared += await clearPins(id, extra.servers)
      } else {
        pending++
        void closeWhenIdle(build, id, def.id, extra.servers).catch(() => undefined)
      }
    }
    // chats nobody has open here (and a session of `only` that is not open): only their pins
    for (const id of [...ids, ...(extra.stored ?? [])]) {
      if (cleared.has(id) || targets.some((t) => t.id === id)) continue
      cleared.add(id)
      pinsCleared += await clearPins(id, extra.servers)
    }
    let tools: string[] = []
    try {
      tools = [...(toolsOfBuild.get(factoryAgentFor(def, def.archivedAt !== null)) ?? [])]
    } catch {
      // an agent that cannot be built yet (no provider)
    }
    return { sessions: ids.size, closed, pending, tools, pinsCleared }
  }

  /** The text of the one-time notice after a forced reload. */
  const reloadNoticeText = (tools: readonly string[], n: { added: Set<string> } | undefined) => {
    const shown = tools.slice(0, 40).join(', ')
    return [
      'Your tools were reloaded by the owner (connectors were refreshed).',
      tools.length > 0
        ? `You now have ${tools.length} tools configured: ${shown}${tools.length > 40 ? ` and ${tools.length - 40} more` : ''}.`
        : '',
      n !== undefined && n.added.size > 0
        ? `Newly available: ${[...n.added].slice(0, 20).join(', ')}.`
        : '',
      'What you said earlier in this chat about what you can or cannot do may be outdated: check your tools again (load deferred ones with tool_search) before answering.',
    ]
      .filter((l) => l !== '')
      .join(' ')
  }

  /**
   * `bare`: a read-only handle (`peek`) may be built without connectors when none were prepared;
   * it never runs a turn.
   */
  function factoryAgentFor(def: AgentDef, bare = false): HarnessAgent {
    const settings = currentSettings()
    let out = deps.connectors.activated(def.id)
    if (out === undefined) {
      if (!bare) {
        throw new Error(
          `the connectors of agent ${def.slug} are not loaded: await factory.prepare(def) first`,
        )
      }
      out = EMPTY_ACTIVATION
    }
    const key = `${def.id}@${def.version}@${settings.rev}@${deps.models.rev?.() ?? 0}@${activationId(out)}@p${deps.personas?.latestNumber(def.id) ?? 0}`
    let agent = cache.get(key)
    if (agent === undefined) {
      // the workspace limit is a row of the shared ledger: applied by whoever builds first
      setBudgetLimit(sqlite, workspaceScope(workspaceId), settings.budgetUsd)
      agent = build(def, settings, out)
      cache.set(key, agent)
      const offered = Object.keys(out.toolNameMap).filter((t) => !out.rules.deny.includes(t))
      toolsOfBuild.set(agent, offered)
      const previous = latest.get(def.id)
      if (previous !== undefined && previous !== key) {
        const old = cache.get(previous)
        if (old !== undefined) {
          noteToolChange(old, offered)
          retired.push(old)
          cache.delete(previous)
          // whatever replaced it (persona, connectors and their tools, settings, models), a chat
          // that the old build holds must move to the new one: a busy group session is never
          // idle-evicted, so it would keep the old tools for good
          superseded.set(def.id, [...(superseded.get(def.id) ?? []), old])
          // close them as soon as they are idle, not only at the next prepare of this agent: a
          // queued message must not be taken by the old build in the meantime
          void closeSuperseded(def.id).catch(() => undefined)
        }
      }
      latest.set(def.id, key)
    }
    return agent
  }

  async function prepareAgent(def?: AgentDef): Promise<void> {
    const all = new Map<string, AgentDef>()
    for (const a of [def, deps.lead?.(), ...(deps.roster?.() ?? [])]) {
      if (a !== undefined) all.set(a.id, a)
    }
    await deps.connectors.prepare([...all.values()])
    // a new persona, new connector tools, settings or models reach the next message of a chat
    // that an older build still holds: build the current one, then close the old sessions
    if (def !== undefined && latest.get(def.id) !== undefined) {
      try {
        factoryAgentFor(def, def.archivedAt !== null)
      } catch {
        // an agent that cannot be built yet (no provider): the caller meets that error as before
        return
      }
      await closeSuperseded(def.id)
    }
  }

  return {
    storage,
    lock,
    background: backgroundTuning,
    longRun: {
      state: (def, sessionId) => longRunOf(def).state(sessionId),
      stop: (def, sessionId, reason) => longRunOf(def).stop(sessionId, reason),
      resume: (def, sessionId) => longRunOf(def).resume(sessionId),
    },
    modes: {
      autoAvailable,
      resolve: (def, sessionId, parentSessionId) =>
        resolveSessionMode(def, sessionId, parentSessionId, currentSettings()),
      autoState: (sessionId) =>
        engines.get(sessionId)?.autoState() ?? { paused: false, consecutive: 0, total: 0 },
      resumeAuto: (sessionId) => engines.get(sessionId)?.resumeAuto(),
    },
    prepare: prepareAgent,
    reloadSession: (def, sessionId) => reloadFor(def, sessionId),
    reloadAgent: (def, opts) => reloadFor(def, undefined, opts),
    drifts: () =>
      [...drifted].flatMap(([sessionId, byServer]) =>
        [...byServer.values()].map((note) => ({ sessionId, ...note })),
      ),
    pinnedSessions,
    agentFor: (def, sessionId) =>
      sessionId !== undefined && isWorkerSession(sessionId)
        ? workerAgentFor(def)
        : factoryAgentFor(def, def.archivedAt !== null),
    modelInfo: (def) => modelInfoOf(def, currentSettings()),
    toolAvailability: (def, authority) =>
      availabilityOf(def, deps.connectors.activated(def.id) ?? EMPTY_ACTIVATION, authority),
    authoritySources(def, authority) {
      const out = deps.connectors.activated(def.id)
      // never prepared: nothing to check against (the HTTP layer prepares first)
      if (out === undefined) return undefined
      const kinds = deps.connectors.toolKinds(def.id) ?? {}
      return {
        connections: out.connections.map((c) => ({
          connectionId: c.connectionId,
          connectorId: c.connectorId,
          slug: c.slug,
          toolPrefix: c.toolPrefix,
          label: c.slug,
        })),
        tools: Object.entries(out.toolNameMap).map(([name, origin]) => ({
          name,
          connectorId: origin.connectorId,
          connectionIds: origin.connectionIds,
          kind: kinds[name] ?? 'unknown',
          off: out.rules.deny.includes(name),
          pinned: out.rules.pinnedAsk.includes(name),
        })),
        definitionIds: deps.connectors.definitions.map((d) => d.id),
        availability: availabilityOf(def, out, authority),
      }
    },
    programTurn(def, sessionId) {
      const parsed = parseProgramSession(sessionId)
      const program = parsed === undefined ? undefined : deps.programs?.get(parsed.programId)
      if (program === undefined) return {}
      return {
        settings: {
          maxOutputTokens: programMaxOutputTokens(
            program.budget,
            modelInfoOf(def, currentSettings()),
          ),
        },
      }
    },
    peek: (sessionId) => {
      const lead = deps.lead?.()
      const any = lead ?? deps.roster?.()[0]
      if (any === undefined) throw new Error('the workspace has no agent to read sessions with')
      return factoryAgentFor(any, true).peek(sessionId)
    },
    openSession: (def, sessionId) => {
      const agent = isWorkerSession(sessionId)
        ? workerAgentFor(def)
        : factoryAgentFor(def, def.archivedAt !== null)
      const session = agent.session(sessionId, {
        lock,
        runtime: { workspaceId, agentId: def.id },
      }) as HarnessSession
      // every build knows its open sessions: a rebuild moves them over (`closeSuperseded`)
      const known = liveSessions.get(agent) ?? new Map<string, WeakRef<HarnessSession>>()
      known.set(sessionId, new WeakRef(session))
      // sweep the sessions the library already dropped
      if (known.size > 64)
        for (const [id, ref] of [...known]) if (ref.deref() === undefined) known.delete(id)
      liveSessions.set(agent, known)
      const notice = toolNotices.get(sessionId)
      if (reloadNotices.has(sessionId) && toolsOfBuild.get(agent) !== undefined) {
        reloadNotices.delete(sessionId)
        toolNotices.delete(sessionId)
        reloadSeq += 1
        void session
          .inject(
            'eh.event',
            {
              name: 'agent.tools.reloaded',
              text: reloadNoticeText(toolsOfBuild.get(agent) ?? [], notice),
            },
            { key: `tools-reloaded:${Date.now()}:${reloadSeq}` },
          )
          .catch(() => undefined)
      } else if (notice !== undefined && toolsOfBuild.get(agent) !== undefined) {
        toolNotices.delete(sessionId)
        const at = `${[...notice.added].join(',')}|${[...notice.removed].join(',')}`
        void session
          .inject(
            'eh.event',
            { name: 'agent.tools.changed', text: toolNoticeText(notice) },
            { key: `tools-changed:${at}`.slice(0, 200) },
          )
          .catch(() => undefined)
      }
      return session
    },
    async close() {
      shutdown = true
      await Promise.allSettled([...cache.values(), ...retired].map((a) => a.close()))
      cache.clear()
      retired.length = 0
    },
  }
}
