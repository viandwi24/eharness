/**
 * Agent definition (a database row) -> `HarnessAgent` (docs/plans/P32-team-example.md §6.1).
 *
 * One agent object per definition version, many sessions: the cache key is `agentId@version`.
 * An edit bumps the version, so the next `agent.session(id)` of a chat gets a fresh agent while
 * open turns finish on the old one (retired agents are closed with the factory).
 *
 * Plugin order is fixed and identical for every session of an agent (prompt-cache prefix,
 * `toolOrder`): filesystem (library) -> memory -> todos -> web -> permissions -> ask -> MCP ->
 * (lead: subagents + roster tools, M4) -> taskIndex (M4). Static instructions come first; the
 * volatile parts (date, roster) live in the turn reminder, never in `instructions` (spec 02 §5).
 */
import type { Database } from 'bun:sqlite'
import {
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessWarning,
  type SessionLock,
} from 'eharness'
import { askUser } from 'eharness/ask'
import { type FileToolName, filesystem } from 'eharness/filesystem'
import { memory } from 'eharness/memory'
import { createPermissionEngine, permissionsPlugin } from 'eharness/permissions'
import { todos } from 'eharness/todos'
import { webFetch, webSearch } from 'eharness/web'
import type { AgentDef, ToolName } from '../../domain/agents.ts'
import { MAX_UPLOAD_BYTES } from '../../domain/chat.ts'
import { memoryRootsFor, pinnedMemoryFiles } from '../../domain/memory.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'
import type { ModelConfig } from './provider.ts'
import { sqliteInbox, sqliteLock, sqliteMessages, sqliteState } from './storage.ts'
import { sqliteStreamLog } from './stream-log.ts'

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

export interface AgentFactoryDeps {
  sqlite: Database
  models: ModelConfig
  /** Lead's roster (role agents) for the turn reminder; M4 also feeds `subagents`. */
  roster?: () => AgentDef[]
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
  /** Close every agent built (shutdown). */
  close(): Promise<void>
}

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
  const cache = new Map<string, HarnessAgent>()
  const latest = new Map<string, string>()
  const retired: HarnessAgent[] = []

  function build(def: AgentDef): HarnessAgent {
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
      // TODO(M4): mcpServer() per def.mcp; subagents({ agents: roster, approvals: 'park' }) +
      // roster tools for the lead; taskIndex plugin
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

    return defineHarnessAgent({
      id: def.slug,
      model: deps.models.resolve(def.model),
      contextWindow: 200_000,
      instructions: [TEAM_PREAMBLE, def.instructions, reminder],
      plugins,
      storage,
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
  }

  return {
    storage,
    lock,
    agentFor(def) {
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
    },
    async close() {
      await Promise.allSettled([...cache.values(), ...retired].map((a) => a.close()))
      cache.clear()
      retired.length = 0
    },
  }
}
