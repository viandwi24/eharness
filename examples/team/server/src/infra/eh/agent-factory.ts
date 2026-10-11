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
  type HarnessAgent,
  type HarnessSession,
  type HarnessWarning,
  lookupModel,
  type ModelCatalog,
  type ModelInfo,
  type ObserveEvent,
  type SessionLock,
  type SessionPeek,
} from 'eharness'
import { type ActivityStore, activity } from 'eharness/activity'
import type { ActivatedConnectors, BuiltinInput } from 'eharness/connectors'
import { type FileToolName, filesystem } from 'eharness/filesystem'
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
import type { EventAppender, ProgramStore } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { READ_BRIEFINGS_TOOL } from '../../domain/briefings.ts'
import {
  isAllowedMediaType,
  LIBRARY_URL_PREFIX,
  libraryUrl,
  MAX_UPLOAD_BYTES,
  uploadPathOfUrl,
} from '../../domain/chat.ts'
import { SESSION_EVENT_TYPES } from '../../domain/events.ts'
import { HEARTBEAT_ALLOWED, heartbeatRefusal } from '../../domain/heartbeat.ts'
import {
  agentModeChoice,
  type ResolvedMode,
  resolveMode,
  type TeamMode,
  teamModeOf,
} from '../../domain/modes.ts'
import {
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
import { LEAD_PLAYBOOK, ROLE_AGENT_NOTE } from '../../domain/prompts.ts'
import { isSimulatedCall, parseRehearsalSession, simulatedText } from '../../domain/rehearsal.ts'
import { originOfSession, profileOfSession } from '../../domain/run-profiles.ts'
import type { WorkspaceSettings } from '../../domain/settings.ts'
import { parseChatSession } from '../../domain/threads.ts'
import { type BigDataConfig, createBigDataHook } from '../bigdata/index.ts'
import { CHANNEL_TOOLS, type ChannelGateway, channels } from '../channels/index.ts'
import { nativeToolName } from '../channels/policy.ts'
import type { ChatToolsStore } from '../db/chat-tools-repo.ts'
import type { SessionModeStore } from '../db/modes-repo.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import type { ActivityLog } from './activity-log.ts'
import { chatTools } from './chat-tools-plugin.ts'
import { MEMORY_TOOL_KINDS } from './connector-catalog.ts'
import type { ConnectorsRuntime } from './connectors.ts'
import { DECISION_TOOLS, type DecisionIntake, decisions } from './decisions-plugin.ts'
import { fileGrant } from './file-grant-plugin.ts'
import { type HeartbeatIntake, heartbeat } from './heartbeat-plugin.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'
import { type SessionGate, sessionPermissions } from './permission-plugin.ts'
import type { ModelConfig } from './provider.ts'
import { rehearsalSessions, sessionFileSystem } from './rehearsal-registry.ts'
import { routineOutcomes } from './routine-plugin.ts'
import type { RoutineOutcomes } from './routine-service.ts'
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
import { WORK_QUEUE_TOOLS, type WorkQueueIntake, workQueue } from './work-queue-plugin.ts'

/** Limits of delegation (plan decision D4: multi-agent runs cost many times a chat). */
export interface TeamLimits {
  /** Children the lead starts at once (the spawn cap). Default 4; the settings row overrides it. */
  spawnCap?: number
  /** Children one session may start over its lifetime (`subagent({ maxChildren })`). Default none. */
  maxChildren?: number
  /** Steps a role agent may take per delegated run. Default 25. */
  childMaxTurns?: number
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
    'spawnCap' | 'defaultModel' | 'defaultProfile' | 'defaultPermissionMode' | 'budgetUsd'
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
  /** The work queue intake (`work-queue-plugin.ts`): `create_task`, `list_tasks`, `update_task`, `complete_task`. */
  workQueue?: () => WorkQueueIntake | undefined
  /** The big-data toolkit (`infra/bigdata`): sources and `run_code` limits. Needs `programs`. */
  bigData?: BigDataConfig
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
  tuning?: { streams?: StreamsTuning; inbox?: { pollMs?: number }; abortPollMs?: number }
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
  /** The agent of a definition version (built once per version on this instance). Needs `prepare`. */
  agentFor(def: AgentDef): HarnessAgent
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
  /** Shared storage ports (messages, state, inbox), for `agent.session(id, { lock })` callers. */
  storage: ReturnType<typeof createStorage>
  /** Cross-process turn lock; pass it as `session(id, { lock })`. */
  lock: SessionLock
  /** Limits of background delegations, for the reconcile pass. */
  background: { timeoutMs: number; startGraceMs: number; waitingReminderMs: number }
  /** Open a session of a definition's agent with the shared lock and runtime (any instance). */
  openSession(def: AgentDef, sessionId: string): HarnessSession
  /**
   * A side-effect-free read handle of a stored session (messages, pending, usage, busy, children):
   * no `session.start` hooks, nothing resumes. Use it for every pure read (spec 05 `agent.peek`).
   */
  peek(sessionId: string): SessionPeek
  /** Permission modes of sessions (per-session mode, inheritance, Auto state). */
  modes: SessionModes
  /** Close every agent built (shutdown). */
  close(): Promise<void>
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
 * The gate of a program run: the rules the engine gets (`rules`) and the closed-world check of
 * the session (`SessionGate`).
 */
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
  const ledger = sqliteBudgetLedger(sqlite)
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
  const currentSettings = () =>
    deps.settings?.() ?? {
      spawnCap: deps.limits?.spawnCap ?? 4,
      defaultModel: null,
      defaultProfile: null,
      defaultPermissionMode: 'default' as const,
      budgetUsd: deps.budgetUsd ?? null,
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

  const cache = new Map<string, HarnessAgent>()
  const latest = new Map<string, string>()
  const retired: HarnessAgent[] = []

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
      agents: () =>
        Object.fromEntries(
          (deps.roster?.() ?? [])
            .filter((a) => a.id !== def.id && a.archivedAt === null)
            .map((a) => [
              a.slug,
              {
                agent: factoryAgentFor(a),
                description: a.description === '' ? a.name : a.description,
                maxTurns: limits.childMaxTurns,
              },
            ]),
        ),
      approvals: 'park',
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
      childSession: childSessionOptions,
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
    return { available, channelTools: CHANNEL_TOOLS, channelsBound: bound.length > 0 }
  }

  function build(
    def: AgentDef,
    settings: ReturnType<typeof currentSettings>,
    out: ActivatedConnectors,
  ): HarnessAgent {
    const self = (): HarnessAgent => selves.get(def.id) as HarnessAgent
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
          toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
        })
      }
      const classifier = classifierFor(sessionId, def.id)
      return createPermissionEngine({
        roots: () => [{ virtual: '/', real: '/' }],
        mode: 'default',
        ...(classifier === undefined ? {} : { classifier }),
        // connector modes and the app's own rules, most restrictive wins (activateConnectors)
        // read-risk native actions of the agent's channel connections never ask (derived from the
        // adapters' action catalog, `infra/channels`)
        rules: {
          allow: [...out.rules.allow, ...(deps.channels?.()?.readActionTools(def.id) ?? [])],
          ask: out.rules.ask,
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
        return {
          rules: { allow: [...HEARTBEAT_ALLOWED], deny: [] },
          refuse: (call) =>
            HEARTBEAT_ALLOWED.some((rule) => matchRule(rule, call, { ...match, polarity: 'allow' }))
              ? undefined
              : heartbeatRefusal(call.toolName),
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
      const current = (): { name: string; rules: { allow: string[]; deny: string[] } } => {
        const program = deps.programs?.get(parsed.programId)
        return {
          name: program?.name ?? parsed.programId,
          rules: program === undefined ? { allow: [], deny: [] } : programRules(program, tools),
        }
      }
      return {
        rules: current().rules,
        refuse(call) {
          const { name, rules } = current()
          for (const rule of rules.deny) {
            if (matchRule(rule, call, { ...match, polarity: 'restrict' })) {
              return forbiddenReason(name, call.toolName, rule)
            }
          }
          const granted = rules.allow.some((rule) =>
            matchRule(rule, call, { ...match, polarity: 'allow' }),
          )
          return granted ? undefined : outsideAuthorityReason(name, call.toolName)
        },
        askedReason: (toolName) => outsideAuthorityReason(current().name, toolName),
        // a rehearsal does not call external systems that would change something: the call is
        // recorded and the model reads what it would have done (`domain/rehearsal.ts`)
        ...(originOfSession(sessionId) !== 'rehearsal'
          ? {}
          : {
              simulate(call: { toolName: string; input: unknown; risk?: string | undefined }) {
                const origin = out.toolNameMap[call.toolName]
                if (!isSimulatedCall({ connectorId: origin?.connectorId, risk: call.risk })) {
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
      const parsed = parseProgramSession(sessionId) ?? parseRehearsalSession(sessionId)
      const program = parsed === undefined ? undefined : deps.programs?.get(parsed.programId)
      return new Set(program === undefined ? [] : runFileTools(program.authority))
    }

    const plugins = [
      // memory needs the `fs` service: a bare filesystem plugin when only memory is on. With
      // programs it also defines the file tools (hidden from every session but a program run that
      // is granted them, `fileGrant`), so an agent without a Files connection can still be given
      // paths to write
      ...((pluginNames.has('memory') || deps.programs !== undefined) &&
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
              hiddenPrefixes: ['/memories'],
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
      ...(deps.heartbeat === undefined ? [] : [heartbeat({ intake: deps.heartbeat })]),
      ...(deps.channels === undefined
        ? []
        : [channels({ gateway: deps.channels, agentOf: (slug) => deps.agentBySlug?.(slug) })]),
      sessionPermissions({
        createEngine,
        gate: gateOf,
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
      ...(def.role === 'lead'
        ? []
        : [
            subagent({
              agents: {},
              approvals: 'park',
              parentAgent: leadAgent,
              childSession: childSessionOptions,
              parentSession: parentSessionOptions,
              selfAgent: self,
              messageTool: true,
              outputTool: false,
              stopTool: false,
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
            }),
          ]),
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
      // hook only: no tools, no instructions (prompt-cache prefix untouched)
      ...(deps.activityLog === undefined ? [] : [deps.activityLog.plugin()]),
    ]

    const roster = deps.roster
    const reminder = {
      text: (): string => {
        const lines = [
          `Today's date: ${new Date().toISOString().slice(0, 10)}`,
          `You are ${def.name}.`,
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
      ...(modelInfoOf(def, settings).contextWindow === undefined ? { contextWindow: 200_000 } : {}),
      ...(catalog === undefined ? {} : { models: catalog }),
      // never leave the output cap to the provider: OpenRouter-style gateways then reserve (and
      // check credits for) the model maximum on every call
      settings: {
        maxOutputTokens: outputCapOf(modelInfoOf(def, settings).maxOutputTokens),
        timeout: { firstChunkMs: MODEL_IDLE_TIMEOUT_MS, chunkMs: MODEL_IDLE_TIMEOUT_MS },
      },
      hooks: { timeoutMs: HOOK_TIMEOUT_MS },
      toolSources: { timeoutMs: TOOL_SOURCE_TIMEOUT_MS, retryAfterMs: TOOL_SOURCE_RETRY_MS },
      warnings: { dedupeWindowMs: WARNING_DEDUPE_MS },
      ...(deps.observe === undefined ? {} : { observe: deps.observe }),
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
      instructions: [
        TEAM_PREAMBLE,
        ...(def.role === 'lead' ? [LEAD_PLAYBOOK] : [ROLE_AGENT_NOTE]),
        def.instructions,
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
      loop: { maxSteps: def.role === 'lead' ? 40 : fixed.childMaxTurns },
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
      toolOutput: { maxChars: 30_000, strategy: 'evict' },
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    }) as unknown as HarnessAgent
    selves.set(def.id, agent)
    return agent
  }

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
    const key = `${def.id}@${def.version}@${settings.rev}@${deps.models.rev?.() ?? 0}@${activationId(out)}`
    let agent = cache.get(key)
    if (agent === undefined) {
      // the workspace limit is a row of the shared ledger: applied by whoever builds first
      setBudgetLimit(sqlite, workspaceScope(workspaceId), settings.budgetUsd)
      agent = build(def, settings, out)
      cache.set(key, agent)
      const previous = latest.get(def.id)
      if (previous !== undefined && previous !== key) {
        const old = cache.get(previous)
        if (old !== undefined) {
          retired.push(old)
          cache.delete(previous)
        }
      }
      latest.set(def.id, key)
    }
    return agent
  }

  return {
    storage,
    lock,
    background: backgroundTuning,
    modes: {
      autoAvailable,
      resolve: (def, sessionId, parentSessionId) =>
        resolveSessionMode(def, sessionId, parentSessionId, currentSettings()),
      autoState: (sessionId) =>
        engines.get(sessionId)?.autoState() ?? { paused: false, consecutive: 0, total: 0 },
      resumeAuto: (sessionId) => engines.get(sessionId)?.resumeAuto(),
    },
    prepare: async (def) => {
      const all = new Map<string, AgentDef>()
      for (const a of [def, deps.lead?.(), ...(deps.roster?.() ?? [])]) {
        if (a !== undefined) all.set(a.id, a)
      }
      await deps.connectors.prepare([...all.values()])
    },
    agentFor: (def) => factoryAgentFor(def, def.archivedAt !== null),
    modelInfo: (def) => modelInfoOf(def, currentSettings()),
    toolAvailability: (def, authority) =>
      availabilityOf(def, deps.connectors.activated(def.id) ?? EMPTY_ACTIVATION, authority),
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
    openSession: (def, sessionId) =>
      factoryAgentFor(def, def.archivedAt !== null).session(sessionId, {
        lock,
        runtime: { workspaceId, agentId: def.id },
      }) as HarnessSession,
    async close() {
      await Promise.allSettled([...cache.values(), ...retired].map((a) => a.close()))
      cache.clear()
      retired.length = 0
    },
  }
}
