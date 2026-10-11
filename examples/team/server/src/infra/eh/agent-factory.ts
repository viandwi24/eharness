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
 * connectors -> chatTools -> permissions -> child side of subagents -> routine outcomes -> taskIndex ->
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
import { filesystem } from 'eharness/filesystem'
import {
  type AutoClassifier,
  type AutoEvent,
  type AutoState,
  createPermissionEngine,
  modelClassifier,
  type PermissionEngine,
} from 'eharness/permissions'
import { subagent } from 'eharness/subagent'
import type { EventAppender } from '../../app/ports.ts'
import type { AgentDef } from '../../domain/agents.ts'
import { MAX_UPLOAD_BYTES, uploadPathOfUrl } from '../../domain/chat.ts'
import { SESSION_EVENT_TYPES } from '../../domain/events.ts'
import {
  agentModeChoice,
  type ResolvedMode,
  resolveMode,
  type TeamMode,
  teamModeOf,
} from '../../domain/modes.ts'
import { LEAD_PLAYBOOK, ROLE_AGENT_NOTE } from '../../domain/prompts.ts'
import type { WorkspaceSettings } from '../../domain/settings.ts'
import type { ChatToolsStore } from '../db/chat-tools-repo.ts'
import type { SessionModeStore } from '../db/modes-repo.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import type { ActivityLog } from './activity-log.ts'
import { chatTools } from './chat-tools-plugin.ts'
import { MEMORY_TOOL_KINDS } from './connector-catalog.ts'
import type { ConnectorsRuntime } from './connectors.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'
import { sessionPermissions } from './permission-plugin.ts'
import type { ModelConfig } from './provider.ts'
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

  // children and re-opened parents get the app's lock and runtime (spec 20, ADR-0042)
  const childSessionOptions = (info: { agent: string }) => {
    const child = deps.agentBySlug?.(info.agent)
    return {
      lock,
      runtime: { workspaceId, ...(child === undefined ? {} : { agentId: child.id }) },
    }
  }
  const parentSessionOptions = (sessionId: string) => {
    const owner = /^dm:([^:]+)/.exec(sessionId)?.[1]
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
    const owner = /^dm:([^:]+)$/.exec(sessionId)?.[1]
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

  function build(
    def: AgentDef,
    settings: ReturnType<typeof currentSettings>,
    out: ActivatedConnectors,
  ): HarnessAgent {
    const self = (): HarnessAgent => selves.get(def.id) as HarnessAgent
    const pluginNames = new Set(out.plugins.map((p) => p.name))

    // one engine per live session (Auto mode counters are per conversation); the mode is read
    // per tool call, never baked into the engine (`permission-plugin.ts`)
    const createEngine = (sessionId: string): PermissionEngine => {
      const classifier = classifierFor(sessionId, def.id)
      return createPermissionEngine({
        roots: () => [{ virtual: '/', real: '/' }],
        mode: 'default',
        ...(classifier === undefined ? {} : { classifier }),
        // connector modes and the app's own rules, most restrictive wins (activateConnectors)
        rules: { allow: out.rules.allow, ask: out.rules.ask, deny: out.rules.deny },
        // pinned asks (write / destructive tools of non-built-in connectors) ask even in Bypass
        toolKinds: { ...MEMORY_TOOL_KINDS, ...out.rules.toolKinds },
      })
    }

    const plugins = [
      // memory needs the `fs` service: a bare filesystem plugin when only memory is on
      ...(pluginNames.has('memory') && !pluginNames.has('filesystem')
        ? [
            filesystem({
              fs: libraryFs(sqlite, {
                agentId: def.id,
                ...(deps.onFileChange ? { onChange: deps.onFileChange } : {}),
              }),
              tools: [],
              hiddenPrefixes: ['/memories'],
              ...(def.skills.length > 0 ? { skills: { root: '/skills' } } : {}),
            }),
          ]
        : []),
      ...out.plugins,
      ...(deps.chatTools === undefined
        ? []
        : [
            chatTools({
              off: (sessionId) => new Set(deps.chatTools?.off(sessionId) ?? []),
              origins: out.toolNameMap,
            }),
          ]),
      sessionPermissions({
        createEngine,
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
          scopes: (ctx) => [workspaceScope(String(ctx.runtime.workspaceId ?? workspaceId))],
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
    return { id, ...(lookupModel(catalog, id) ?? {}) }
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
