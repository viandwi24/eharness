/**
 * The session cache of an agent (internal): `agent.session()`, `closeSession()`, `close()`,
 * option merging and default memory storage.
 *
 * @see docs/specs/05-session-and-storage.md#1-session-options
 */
import type { UIMessage } from 'ai'
import { uuidv7 } from '../messages/ids.ts'
import { defaultMemoryMessages, defaultMemoryState } from '../session/memory-storage.ts'
import { createSessionHandle, type SessionHandle } from '../session/session.ts'
import type { AgentInternals } from './internals.ts'
import type {
  HarnessSession,
  MessageAdapter,
  SessionOptions,
  StateAdapter,
} from './session-types.ts'

/** Default idle eviction: 30 minutes. */
export const DEFAULT_SESSION_IDLE_MS: number = 30 * 60 * 1000

/** Runtime part of an agent. */
export interface AgentSessions {
  session(id: string, options?: SessionOptions): HarnessSession<UIMessage, Record<string, unknown>>
  closeSession(id: string): Promise<void>
  close(): Promise<void>
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Create the session cache of one agent. */
export function createAgentSessions(internals: AgentInternals): AgentSessions {
  /** Random id of this agent instance (crash-recovery owner, spec 05 §9). */
  const owner = uuidv7()
  let defaults: { messages: MessageAdapter; state: StateAdapter } | undefined
  const sessions = new Map<string, SessionHandle>()
  /** Closes of handles that were replaced in `sessions` while closing (awaited by `close()`). */
  const closing = new Set<Promise<void>>()

  const storageFor = (options: SessionOptions) => {
    defaults ??= { messages: defaultMemoryMessages(), state: defaultMemoryState() }
    return {
      messages:
        options.storage?.messages ?? internals.config.storage?.messages ?? defaults.messages,
      state: options.storage?.state ?? internals.config.storage?.state ?? defaults.state,
      inbox: options.storage?.inbox ?? internals.config.storage?.inbox,
    }
  }

  const agent: AgentSessions = {
    session(id, options = {}) {
      if (typeof id !== 'string' || id.length === 0) {
        throw new TypeError('agent.session(id): id must be a non-empty string.')
      }
      const cached = sessions.get(id)
      if (cached !== undefined && !cached.rt.closed) {
        const current = cached.rt.options
        const differs =
          (options.storage?.messages !== undefined &&
            options.storage.messages !== current.storage?.messages) ||
          (options.storage?.state !== undefined &&
            options.storage.state !== current.storage?.state) ||
          (options.storage?.inbox !== undefined &&
            options.storage.inbox !== current.storage?.inbox) ||
          (options.lock !== undefined && options.lock !== current.lock) ||
          (options.onInvalidMessage !== undefined &&
            options.onInvalidMessage !== current.onInvalidMessage) ||
          (options.acceptClientMetadata !== undefined &&
            options.acceptClientMetadata !== current.acceptClientMetadata) ||
          (options.toolsContext !== undefined &&
            !sameJson(options.toolsContext, current.toolsContext)) ||
          (options.parent !== undefined && !sameJson(options.parent, current.parent))
        if (differs) {
          internals.emitWarning(
            {
              code: 'W_SESSION_OPTIONS_IGNORED',
              message: `Session '${id}' is already live; options other than \`runtime\` are ignored.`,
              details: { sessionId: id },
            },
            id,
          )
        }
        if (options.runtime !== undefined)
          cached.rt.options = { ...current, runtime: options.runtime }
        return cached.session
      }
      const storage = storageFor(options)
      // a handle that is still closing stays the only writer until its close finished (spec 05 §1)
      const previous = cached?.close()
      if (previous !== undefined) {
        closing.add(previous)
        const forget = () => void closing.delete(previous)
        previous.then(forget, forget)
      }
      const handle: SessionHandle = createSessionHandle({
        internals,
        owner,
        id,
        options: { ...options },
        messages: storage.messages,
        state: storage.state,
        ...(storage.inbox === undefined ? {} : { inbox: storage.inbox }),
        idleMs: internals.config.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
        onClosed: () => {
          if (sessions.get(id) === handle) sessions.delete(id)
        },
        ...(previous === undefined ? {} : { after: previous }),
      })
      sessions.set(id, handle)
      return handle.session
    },
    async closeSession(id) {
      await sessions.get(id)?.close()
    },
    async close() {
      await Promise.all([...[...sessions.values()].map((handle) => handle.close()), ...closing])
    },
  }
  return agent
}
