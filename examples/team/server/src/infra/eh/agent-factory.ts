/**
 * Agent definition (a database row) -> `HarnessAgent` (docs/plans/P32-team-example.md §6.1).
 *
 * One agent object per definition version, many sessions: the cache key is `agentId@version`.
 * An edit bumps the version, so the next `agent.session(id)` of a chat gets a fresh agent while
 * open turns finish on the old one (retired agents are closed with the factory).
 *
 * Plugin order is fixed and identical for every session of an agent (prompt-cache prefix,
 * `toolOrder`): filesystem (library) -> memory -> todos -> web -> permissions -> ask -> MCP (TODO)
 * -> subagents -> taskIndex. Static instructions come first; the volatile parts (date, roster)
 * live in the turn reminder, never in `instructions` (spec 02 §5).
 *
 * Delegation (M4, ADR-0035 / ADR-0041): the lead gets `subagents({ approvals: 'park' })` with the
 * role agents of the DB roster; every other agent gets the child side of the same plugin
 * (`parentAgent` = the lead, `selfAgent` = itself) so it can `send_message` to `main` and reports
 * of resumed turns find their way back. All instances build the same plugin set, which waits
 * and reconcile need.
 */
import type { Database } from 'bun:sqlite'
import {
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessSession,
  type HarnessWarning,
  type SessionLock,
} from 'eharness'
import { askUser } from 'eharness/ask'
import { type FileToolName, filesystem } from 'eharness/filesystem'
import { memory } from 'eharness/memory'
import { createPermissionEngine, permissionsPlugin } from 'eharness/permissions'
import { AGENT_MESSAGE_INSTRUCTIONS, subagents } from 'eharness/subagent'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import type { AgentDef, ToolName } from '../../domain/agents.ts'
import { MAX_UPLOAD_BYTES } from '../../domain/chat.ts'
import { memoryRootsFor, pinnedMemoryFiles } from '../../domain/memory.ts'
import { LEAD_PLAYBOOK, ROLE_AGENT_NOTE } from '../../domain/prompts.ts'
import type { TaskWriter } from '../db/tasks-repo.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'
import type { ModelConfig } from './provider.ts'
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

const READ_TOOLS: FileToolName[] = ['list_files', 'read_file', 'grep', 'glob']
const WRITE_TOOLS: FileToolName[] = ['write_file', 'edit_file', 'delete_file']

/** Memory tools are file writes by definition: the agent owns its memory, so they never ask. */
const MEMORY_TOOL_KINDS = {
  memory_view: { kind: 'read' as const, pathField: 'path' },
  memory_create: { kind: 'write' as const, pathField: 'path' },
  memory_str_replace: { kind: 'write' as const, pathField: 'path' },
  memory_insert: { kind: 'write' as const, pathField: 'path' },
  memory_delete: { kind: 'write' as const, pathField: 'path' },
  memory_rename: { kind: 'write' as const, pathField: 'old_path' },
}
const MEMORY_ALLOW = Object.keys(MEMORY_TOOL_KINDS).filter((n) => n !== 'memory_view')

/** Limits of delegation (plan decision D4: multi-agent runs cost many times a chat). */
export interface TeamLimits {
  /** Children the lead starts at once (the spawn cap). Default 4. */
  spawnCap?: number
  /** Steps a role agent may take per delegated run. Default 30. */
  childMaxTurns?: number
  /** How long the lead stays parked on a task before the wait times out (ms). Default 24 h. */
  parkTimeoutMs?: number
}

export interface AgentFactoryDeps {
  sqlite: Database
  models: ModelConfig
  workspaceId?: string
  /** Role agents the lead can delegate to (`subagents` catalog and the turn reminder). */
  roster?: () => AgentDef[]
  /** The lead's definition: role agents resolve their parent (`parentAgent`) through it. */
  lead?: () => AgentDef | undefined
  /** Writer of the task index and event feed (the `taskIndex` plugin); absent = no index. */
  taskStore?: TaskWriter
  /** Definition of a hook context's agent (`agent.id` is the slug). */
  agentBySlug?: (slug: string) => AgentDef | undefined
  limits?: TeamLimits
  /** Monthly USD limit of the workspace ledger scope; absent = tracked, not limited. */
  budgetUsd?: number
  /** Called after a library file changed (event feed, M4). */
  onFileChange?: (change: LibraryChange) => void
  onWarning?: (warning: HarnessWarning) => void
  /** Lease of the turn lock (ms). */
  lockLeaseMs?: number
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
  /** The agent of a definition version (built once per version on this instance). */
  agentFor(def: AgentDef): HarnessAgent
  /** Shared storage ports (messages, state, inbox), for `agent.session(id, { lock })` callers. */
  storage: ReturnType<typeof createStorage>
  /** Cross-process turn lock; pass it as `session(id, { lock })`. */
  lock: SessionLock
  /** Open a session of a definition's agent with the shared lock and runtime (any instance). */
  openSession(def: AgentDef, sessionId: string): HarnessSession
  /** Close every agent built (shutdown). */
  close(): Promise<void>
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

const has = (def: AgentDef, tool: ToolName): boolean => def.tools.includes(tool)

/** Common preamble; the definition's own instructions follow. Static text only. */
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
  })
  const workspaceId = deps.workspaceId ?? 'default'
  const ledger = sqliteBudgetLedger(sqlite)
  if (deps.budgetUsd !== undefined)
    setBudgetLimit(sqlite, workspaceScope(workspaceId), deps.budgetUsd)
  const limits = {
    spawnCap: deps.limits?.spawnCap ?? 4,
    childMaxTurns: deps.limits?.childMaxTurns ?? 30,
    parkTimeoutMs: deps.limits?.parkTimeoutMs ?? 24 * 60 * 60 * 1000,
  }
  const cache = new Map<string, HarnessAgent>()
  const latest = new Map<string, string>()
  const retired: HarnessAgent[] = []

  const leadAgent = (): HarnessAgent => {
    const lead = deps.lead?.()
    if (lead === undefined) throw new Error('the workspace has no lead agent')
    return factoryAgentFor(lead)
  }

  function build(def: AgentDef): HarnessAgent {
    const holder: { self?: HarnessAgent } = {}
    const self = (): HarnessAgent => holder.self as HarnessAgent
    const delegates = def.role === 'lead' && has(def, 'delegate')
    const messaging = def.role === 'lead' ? has(def, 'send_message') : true
    const fs = libraryFs(sqlite, {
      agentId: def.id,
      ...(deps.onFileChange ? { onChange: deps.onFileChange } : {}),
    })

    const fsTools: FileToolName[] = [
      ...(has(def, 'library_read') ? READ_TOOLS : []),
      ...(has(def, 'library_write') ? WRITE_TOOLS : []),
    ]
    const useMemory = has(def, 'memory')

    const engine = createPermissionEngine({
      roots: () => [{ virtual: '/', real: '/' }],
      mode: def.permissionMode,
      rules: {
        allow: [
          ...def.rules.allow,
          ...(useMemory ? MEMORY_ALLOW : []),
          // library writes are the point of the role agents (plan §6.5); deletes still ask
          ...(has(def, 'library_write') ? ['write_file', 'edit_file'] : []),
        ],
        ask: def.rules.ask,
        deny: def.rules.deny,
      },
      toolKinds: MEMORY_TOOL_KINDS,
    })

    const plugins = [
      // memory needs the `fs` service, so the filesystem plugin is installed even without file tools
      ...(fsTools.length > 0 || useMemory
        ? [
            filesystem({
              fs,
              tools: fsTools,
              hiddenPrefixes: ['/memories'],
              ...(def.skills.length > 0 ? { skills: { root: '/skills' } } : {}),
            }),
          ]
        : []),
      ...(useMemory
        ? [
            memory({
              roots: () => memoryRootsFor(def),
              pinned: () => pinnedMemoryFiles(def.id),
              flushOnCompaction: true,
            }),
          ]
        : []),
      ...(has(def, 'todos') ? [todos()] : []),
      ...(has(def, 'web_fetch') ? [webFetch({})] : []),
      ...(has(def, 'web_search')
        ? [
            webSearch({
              search: async () => {
                throw new Error('web search is not configured on this server')
              },
            }),
          ]
        : []),
      permissionsPlugin({ engine }),
      ...(has(def, 'ask_user') ? [askUser()] : []),
      // TODO: mcpServer() per def.mcp (M8)
      ...(delegates
        ? [
            subagents({
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
              parkTimeoutMs: limits.parkTimeoutMs,
              maxConcurrent: limits.spawnCap,
              // role agents are leaves: a delegation is one level deep
              maxDepth: 1,
              messageTool: messaging,
              outputTool: messaging,
              stopTool: messaging,
              selfAgent: self,
            }),
          ]
        : def.role === 'lead'
          ? []
          : [
              // child side: send_message to main, reports of resumed turns, reconcile on open
              subagents({
                agents: {},
                approvals: 'park',
                parentAgent: leadAgent,
                selfAgent: self,
                messageTool: true,
                outputTool: false,
                stopTool: false,
              }),
            ]),
      ...(deps.taskStore === undefined
        ? []
        : [
            taskIndex({
              store: deps.taskStore,
              agentOf: (slug) => {
                const found = deps.agentBySlug?.(slug)
                return found === undefined ? undefined : { id: found.id, name: found.name }
              },
            }),
          ]),
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
      model: deps.models.resolve(def.model),
      contextWindow: 200_000,
      instructions: [
        TEAM_PREAMBLE,
        ...(def.role === 'lead' ? [LEAD_PLAYBOOK] : [ROLE_AGENT_NOTE]),
        ...(delegates || messaging ? [AGENT_MESSAGE_INSTRUCTIONS] : []),
        def.instructions,
        reminder,
      ],
      plugins,
      storage,
      budget: {
        ledger: { adapter: ledger, scopes: () => [workspaceScope(workspaceId)] },
      },
      loop: { maxSteps: 40 },
      // uploads are checked by the chat route; the core caps data URLs at the same size
      inputFiles: { protocols: ['data:', 'https:'], maxBytes: MAX_UPLOAD_BYTES },
      ...(deps.tuning?.streams ? { streams: deps.tuning.streams } : {}),
      ...(deps.tuning?.inbox ? { inbox: deps.tuning.inbox } : {}),
      ...(deps.tuning?.abortPollMs !== undefined
        ? { recovery: { abortPollMs: deps.tuning.abortPollMs } }
        : {}),
      compaction: { summarizeAt: 0.8, prune: {} },
      toolOutput: { maxChars: 30_000, strategy: 'evict' },
      ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
    }) as unknown as HarnessAgent
    holder.self = agent
    return agent
  }

  function factoryAgentFor(def: AgentDef): HarnessAgent {
    const key = `${def.id}@${def.version}`
    let agent = cache.get(key)
    if (agent === undefined) {
      agent = build(def)
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
    agentFor: factoryAgentFor,
    openSession: (def, sessionId) =>
      factoryAgentFor(def).session(sessionId, {
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
