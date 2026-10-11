/**
 * Side-effect-free session read handle (internal): `agent.peek(id)`.
 *
 * Reads the stored state and messages through the adapters only: no `session.start` hook, no crash
 * recovery, no reconcile, no inbox drain, no lock, no write (spec 05 §2.2).
 *
 * @see docs/specs/05-session-and-storage.md#22-read-only-handle-agentpeekid
 */
import type {
  MessageAdapter,
  SessionPeek,
  SessionStateSnapshot,
  StateAdapter,
} from '../agent/session-types.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { liveForeignTurn } from './inbox/driver.ts'
import { isKnownPending } from './interaction/waits.ts'
import { hiddenByRewind, rewindsIn } from './load-context.ts'

const TURN_OPERATIONS = ['send', 'respond', 'regenerate', 'edit', 'enqueue', 'inject', 'compact']

/** Create the read handle of session `id`. `localTurn` reports a turn running in this process. */
export function createSessionPeek(args: {
  id: string
  messages: MessageAdapter
  state: StateAdapter
  registry: MessageRegistry
  staleMs: number | false
  localTurn: () => Promise<string | undefined>
}): SessionPeek<HarnessUIMessage> {
  const { id, registry } = args
  const getState = async (what: string): Promise<SessionStateSnapshot | null> => {
    try {
      return await args.state.get(id)
    } catch (error) {
      if (isHarnessError(error)) throw error
      throw new HarnessError('EH_STORAGE', `State storage failed (${what}).`, { cause: error })
    }
  }
  const load = async (limit: number, beforeId: string | undefined): Promise<HarnessUIMessage[]> => {
    try {
      return (await args.messages.load({
        sessionId: id,
        limit,
        ...(beforeId === undefined ? {} : { beforeId }),
      })) as HarnessUIMessage[]
    } catch (error) {
      if (isHarnessError(error)) throw error
      throw new HarnessError('EH_STORAGE', 'Message storage failed (load).', { cause: error })
    }
  }
  const peek: SessionPeek<HarnessUIMessage> = {
    id,
    async messages(q = {}) {
      const limit = q.limit ?? 50
      if (q.includeHidden === true) return load(limit, q.beforeId)
      const stored = await getState('state get')
      const rewinds = [...(stored?.core?.rewinds ?? [])]
      let out: HarnessUIMessage[] = []
      let beforeId = q.beforeId
      for (;;) {
        const requested = beforeId
        const raw = await load(limit, requested)
        const page = requested === undefined ? raw : raw.filter((m) => m.id < requested)
        rewinds.push(...rewindsIn(page))
        const visible =
          rewinds.length === 0 ? page : page.filter((m) => !hiddenByRewind(m, rewinds, registry))
        out = [...visible, ...out]
        const oldest = page[0]
        if (out.length >= limit || raw.length < limit || oldest === undefined) break
        if (page.length < raw.length) break
        beforeId = oldest.id
      }
      return out.slice(Math.max(0, out.length - limit))
    },
    async stats() {
      const core = (await getState('state get'))?.core
      return {
        pending: core?.pending ?? null,
        activeTurn: core?.activeTurn ?? null,
        usage:
          core?.usage === undefined
            ? { inputTokens: 0, outputTokens: 0, turns: 0 }
            : { ...core.usage },
      }
    },
    async busy() {
      const local = await args.localTurn()
      if (local !== undefined) return { scope: 'local', turnId: local }
      const active = liveForeignTurn(await getState('busy'), '', args.staleMs)
      if (active === undefined) return null
      return {
        scope: 'remote',
        turnId: active.turnId,
        owner: active.owner,
        heartbeatAt: active.heartbeatAt,
      }
    },
    async pending() {
      const pending = (await getState('state get'))?.core?.pending
      return pending === undefined ? null : structuredClone(pending)
    },
    async pendingWaits() {
      const pending = (await getState('state get'))?.core?.pending
      if (pending === undefined || !isKnownPending(pending)) return []
      return structuredClone(pending.externals ?? [])
    },
    async children() {
      return structuredClone((await getState('state get'))?.core?.children ?? [])
    },
    async parentInfo() {
      const parent = (await getState('state get'))?.core?.parent
      return parent === undefined ? undefined : { ...parent }
    },
  }
  // turn operations are not part of the type; a JS caller gets a clear error instead of a TypeError
  for (const name of TURN_OPERATIONS) {
    Object.defineProperty(peek, name, {
      enumerable: false,
      value: (): never => {
        throw new HarnessError(
          'EH_INVALID_INPUT',
          `agent.peek() is read-only: '${name}()' needs agent.session('${id}').`,
          { details: { sessionId: id, reason: 'peek-read-only' } },
        )
      },
    })
  }
  return peek
}
