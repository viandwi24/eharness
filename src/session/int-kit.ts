/**
 * Helpers for the integration tests of the runtime (not part of the public API, not bundled).
 */
import type { UIMessageChunk } from 'ai'
import type { MessageAdapter, SessionStateSnapshot, StateAdapter } from '../agent/session-types.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

/** Read a whole stream (typed loosely: tests assert on plain chunk objects). */
export async function collect<T = UIMessageChunk>(stream: ReadableStream<unknown>): Promise<T[]> {
  const out: T[] = []
  for await (const chunk of stream) out.push(chunk as T)
  return out
}

/** A message adapter that records every call and can be told to fail. */
export interface SpyMessages extends MessageAdapter {
  saves: HarnessUIMessage[][]
  loads: Array<Parameters<MessageAdapter['load']>[0]>
  failSave?: (messages: HarnessUIMessage[]) => boolean
  failLoad?: boolean
}

/** Wrap (or create) a memory message adapter with call recording. */
export function spyMessages(inner: MessageAdapter = defaultMemoryMessages()): SpyMessages {
  const spy: SpyMessages = {
    saves: [],
    loads: [],
    async load(q) {
      spy.loads.push(q)
      if (spy.failLoad === true) throw new Error('load failed')
      return inner.load(q)
    },
    async save(sessionId, messages) {
      if (spy.failSave?.(messages as HarnessUIMessage[]) === true) throw new Error('save failed')
      spy.saves.push(structuredClone(messages) as HarnessUIMessage[])
      return inner.save(sessionId, messages)
    },
    async lastId(sessionId) {
      return (await inner.lastId?.(sessionId)) ?? null
    },
  }
  return spy
}

/** A state adapter that records writes. */
export interface SpyState extends StateAdapter {
  writes: SessionStateSnapshot[]
  failWrite?: boolean
}

/** Wrap (or create) a memory state adapter with call recording. */
export function spyState(inner: StateAdapter = defaultMemoryState()): SpyState {
  const spy: SpyState = {
    writes: [],
    get: (sessionId) => inner.get(sessionId),
    async set(sessionId, state) {
      if (spy.failWrite === true) throw new Error('state write failed')
      spy.writes.push(structuredClone(state))
      return inner.set(sessionId, state)
    },
    async setIf(sessionId, state, expectedRev) {
      if (spy.failWrite === true) throw new Error('state write failed')
      const ok = (await inner.setIf?.(sessionId, state, expectedRev)) ?? false
      if (ok) spy.writes.push(structuredClone(state))
      return ok
    },
  }
  return spy
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g
/** AI SDK approval ids (`aitxt-…`), random per run. */
const APPROVAL_ID = /aitxt-[A-Za-z0-9]+/g

/**
 * Normalize volatile values for golden comparisons: UUIDv7 ids become `<id:n>` and AI SDK approval
 * ids `<approval:n>` (numbered by first appearance), numeric `createdAt` / `durationMs` / `heartbeatAt` / `startedAt` become 0.
 */
export function normalizeVolatile(value: unknown): unknown {
  const ids = new Map<string, string>()
  const approvals = new Map<string, string>()
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      return v
        .replace(UUID, (id) => {
          let name = ids.get(id)
          if (name === undefined) {
            name = `<id:${ids.size}>`
            ids.set(id, name)
          }
          return name
        })
        .replace(APPROVAL_ID, (id) => {
          let name = approvals.get(id)
          if (name === undefined) {
            name = `<approval:${approvals.size}>`
            approvals.set(id, name)
          }
          return name
        })
    }
    if (typeof v === 'number' && key !== undefined) {
      if (['createdAt', 'durationMs', 'heartbeatAt', 'startedAt'].includes(key)) return 0
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (typeof v === 'object' && v !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k)
      return out
    }
    return v
  }
  return walk(JSON.parse(JSON.stringify(value)))
}

/** Types of the chunks (short form for assertions). */
export function chunkTypes(chunks: readonly UIMessageChunk[]): string[] {
  return chunks.map((c) =>
    c.type === 'data-eh.status' ? `data-eh.status:${(c.data as { state: string }).state}` : c.type,
  )
}
