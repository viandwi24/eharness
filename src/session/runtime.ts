/**
 * Internal runtime state of one live session, shared by the session object, the turn runner,
 * the context objects and the stream writers.
 */
import type { LanguageModel, Tool, UIMessageChunk } from 'ai'
import type { AgentInternals } from '../agent/internals.ts'
import type { MessageAdapter, SessionEvent, SessionOptions } from '../agent/session-types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import type { HarnessContext, HarnessLogger, TurnInfo } from '../plugin/types.ts'
import type { NormalizedInstruction } from '../registry/static.ts'
import type { ToolSource } from '../registry/types.ts'
import type { SessionSkills } from '../skills/registry.ts'
import type { HookRunner } from './hooks.ts'
import type { StateStore } from './state.ts'

/** A resolved static tool (setup or session phase), in stable order. */
export interface ResolvedTool {
  owner: string
  name: string
  tool: Tool
}

/** What exists after the session was opened (plugin session phases ran). */
export interface OpenSession {
  services: Map<string, unknown>
  hooks: HookRunner
  /** Static tools (setup + session contributions), plugin order then declaration order. */
  tools: ResolvedTool[]
  toolSources: Array<{ owner: string; source: ToolSource }>
  /** Instructions (setup + session contributions), plugin order. */
  instructions: NormalizedInstruction[]
  /** System block 2 (session-refresh instructions), computed at the first turn. */
  sessionBlock: string | undefined
  /** `list()` results of `refresh: 'session'` sources. */
  sourceCache: Map<ToolSource, Array<{ name: string; tool: Tool }>>
  /** Skill sources in registry order (static skills wrapped), `list()` cache, index limit. */
  skills: SessionSkills
  /** Plugin dispose functions and tool source `close()`, in registration order. */
  disposers: Array<{ owner: string; dispose: () => unknown }>
}

/** Live state of the running turn (read by context getters and writers). */
export interface TurnState {
  info: TurnInfo
  step: { index: number; model: LanguageModel } | undefined
  /** Session runtime merged with `SendOptions.runtime`. */
  runtime: Readonly<Record<string, unknown>>
  /** True while the turn stream is open. */
  active: boolean
  /** Write one chunk to the turn stream (cloned into the turn buffer). */
  write(chunk: UIMessageChunk): void
}

/** Minimal event hub interface used by writers. */
export interface EventSink {
  emit(event: SessionEvent): void
  /** Number of open `events()` readers. */
  readonly readers: number
}

/** Internal state of one live session. */
export interface SessionRuntime {
  readonly id: string
  readonly agent: AgentInternals
  /** Effective options (`runtime` may be replaced by `agent.session(id, { runtime })`). */
  options: SessionOptions
  readonly messages: MessageAdapter
  readonly state: StateStore
  /** Random id of the agent instance (crash recovery owner). */
  readonly owner: string
  readonly log: HarnessLogger
  /** Aborts on session close (`ctx.signal`). */
  readonly signal: AbortSignal
  readonly events: EventSink
  open: OpenSession | undefined
  /** Hot cache: the assembled view (id order), `undefined` before the first load. */
  view: HarnessUIMessage[] | undefined
  /** Newest id the session knows (stored or generated): the id floor. */
  newestId: string | undefined
  /** Newest id known to be stored (compared with `lastId()`). */
  storedLastId: string | undefined
  turn: TurnState | undefined
  running: boolean
  closed: boolean
  /** Emit a warning: agent handler + transient `data-eh.warning` in a turn, `data` event otherwise. */
  warn(warning: HarnessWarning, key?: string): void
  /** Next message id respecting the per-session floor. */
  nextId(): string
  /** Context object of one plugin (`'app'` for the root plugin). */
  contextOf(plugin: string): HarnessContext
  /** Insert or replace a message in the hot cache (id order) and track the newest id. */
  cacheMessage(message: HarnessUIMessage): void
}
