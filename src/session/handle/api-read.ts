import type {
  ActiveTurn,
  ApprovalActor,
  ChildSessionInfo,
  SendOptions,
  StateAdapter,
} from '../../agent/session-types.ts'
import { HarnessError, storageError } from '../../errors.ts'
import type {
  HarnessUIMessage,
  InstructionBlockStats,
  PendingExternal,
  PendingState,
  ToolSourceStats,
} from '../../messages/types.ts'
import {
  describeTools,
  instructionBlockStats,
  type SessionToolInfo,
  toolSourceStats,
} from '../../registry/inventory.ts'
import { liveForeignTurn } from '../inbox/driver.ts'
import { hiddenByRewind, rewindsIn } from '../load-context.ts'
import { DEFAULT_STALE_MS } from '../remote-abort.ts'
import type { SessionCtx } from './ctx.ts'
import { ensureContext, ensureOpen, inspect, staticTokens, storedRewinds } from './open.ts'
import { assertOpen, isIdle, touch } from './queue.ts'

export async function apiResolveWait(
  s: SessionCtx,
  waitId: string,
  result: { output: unknown } | { errorText: string },
  options: (SendOptions & { actor?: ApprovalActor | undefined }) | undefined,
): Promise<never> {
  assertOpen(s)
  touch(s)
  return (await s.waits.resolveWait(waitId, result, options)) as never
}

export async function apiExpireWaits(s: SessionCtx, now: number | undefined): Promise<never> {
  assertOpen(s)
  touch(s)
  return (await s.waits.expireWaits(now)) as never
}

export async function apiPendingWaits(s: SessionCtx): Promise<PendingExternal[]> {
  assertOpen(s)
  touch(s)
  return s.waits.pendingWaits()
}

export async function apiChildren(s: SessionCtx): Promise<ChildSessionInfo[]> {
  assertOpen(s)
  touch(s)
  const stored = await s.rt.state.peek()
  return structuredClone(stored?.core?.children ?? [])
}

export async function apiParentInfo(s: SessionCtx): Promise<
  | {
      sessionId: string
      turnId: string
      toolCallId?: string | undefined
      depth: number
      agent?: string | undefined
      name?: string | undefined
      description?: string | undefined
    }
  | undefined
> {
  assertOpen(s)
  touch(s)
  const stored = await s.rt.state.peek()
  const parent = stored?.core?.parent ?? s.rt.options.parent
  return parent === undefined ? undefined : { ...parent }
}

export async function apiMessages(
  s: SessionCtx,
  q:
    | {
        beforeId?: string | undefined
        limit?: number | undefined
        includeHidden?: boolean | undefined
      }
    | undefined = {},
): Promise<never> {
  assertOpen(s)
  touch(s)
  const limit = q.limit ?? 50
  const load = async (beforeId: string | undefined): Promise<HarnessUIMessage[]> => {
    try {
      return (await s.rt.messages.load({
        sessionId: s.id,
        limit,
        ...(beforeId === undefined ? {} : { beforeId }),
      })) as HarnessUIMessage[]
    } catch (error) {
      throw storageError('Message', 'load', error)
    }
  }
  if (q.includeHidden === true) return (await load(q.beforeId)) as never
  // rewinds of the state (a read never touches the live state store: no reload, no recovery)
  const rewinds = s.rt.state.loaded
    ? [...(s.rt.state.core().rewinds ?? [])]
    : await storedRewinds(s)
  // page until `limit` visible messages or the history is exhausted (spec 05 §2)
  let out: HarnessUIMessage[] = []
  let beforeId = q.beforeId
  for (;;) {
    const requested = beforeId
    const raw = await load(requested)
    // progress guard: never trust an adapter to honour beforeId (no duplicates, no endless loop)
    const page = requested === undefined ? raw : raw.filter((m) => m.id < requested)
    // a rewind hides only older messages: pages are read newest first
    rewinds.push(...rewindsIn(page))
    const visible =
      rewinds.length === 0
        ? page
        : page.filter((m) => !hiddenByRewind(m, rewinds, s.internals.messages))
    out = [...visible, ...out]
    const oldest = page[0]
    if (out.length >= limit || raw.length < limit || oldest === undefined) break
    if (page.length < raw.length) break // the adapter ignored beforeId: stop here
    beforeId = oldest.id
  }
  return out.slice(Math.max(0, out.length - limit)) as never
}

export async function apiStats(s: SessionCtx): Promise<{
  pending: PendingState | null
  activeTurn: ActiveTurn | null
  usage: { inputTokens: number; outputTokens: number; turns: number; costUsd?: number | undefined }
  window: number
  tokens: number
  instructions: number
  tools: number
  messages: number
  summarizeAt: number
  hardLimit: number
  lastCompaction?: { markerId: string; before: number; after: number; at: number } | undefined
  pruned?: { outputs: number; chars: number } | undefined
  instructionBlocks?: InstructionBlockStats[] | undefined
  toolSources?: ToolSourceStats[] | undefined
}> {
  assertOpen(s)
  touch(s)
  const open = await ensureOpen(s)
  if (s.rt.view === undefined) await ensureContext(s)
  const { inspection, ...fixed } = await staticTokens(s, open)
  // an idle, clean handle may be stale: another instance can have answered, started or
  // finished a turn since it loaded (spec 05 §2.1); a running turn is authoritative here
  let core = s.rt.state.core()
  if (!s.rt.running && !s.rt.state.dirty) {
    const stored = (await s.rt.state.peek())?.core
    if (stored !== undefined && !s.rt.running && !s.rt.state.dirty) {
      core = {
        ...core,
        pending: stored.pending,
        activeTurn: stored.activeTurn,
        usage: stored.usage,
      }
    }
  }
  const measured = await s.compaction.measureView(s.rt.view ?? [])
  return {
    ...s.compaction.stats(
      s.config.model,
      { ...fixed, messages: measured.tokens },
      {
        pruned: measured.pruned,
        split: {
          instructionBlocks: instructionBlockStats(
            inspection.instructionBlocks,
            s.compaction.count,
            s.compaction.calibration.apply,
          ),
          toolSources: await toolSourceStats(
            inspection.entries,
            s.compaction.count,
            s.compaction.calibration.apply,
          ),
        },
      },
    ),
    pending: core.pending ?? null,
    activeTurn: core.activeTurn ?? null,
    usage:
      core.usage === undefined ? { inputTokens: 0, outputTokens: 0, turns: 0 } : { ...core.usage },
  }
}

export async function apiBusy(
  s: SessionCtx,
): Promise<
  | { scope: 'local'; turnId: string; owner?: undefined; heartbeatAt?: undefined }
  | { scope: 'remote'; turnId: string; owner: string; heartbeatAt: number }
  | null
> {
  assertOpen(s)
  touch(s)
  if (s.current !== undefined) return { scope: 'local', turnId: s.current.run.turnId }
  const staleMs =
    s.config.recovery === false ? false : (s.config.recovery?.staleMs ?? DEFAULT_STALE_MS)
  let stored: Awaited<ReturnType<StateAdapter['get']>>
  try {
    stored = await s.args.state.get(s.id)
  } catch (error) {
    throw new HarnessError('EH_STORAGE', 'State storage failed (busy).', { cause: error })
  }
  const active = liveForeignTurn(stored, s.rt.owner, staleMs, s.rt)
  if (active === undefined) return null
  return {
    scope: 'remote',
    turnId: active.turnId,
    owner: active.owner,
    heartbeatAt: active.heartbeatAt,
  }
}

export async function apiTools(s: SessionCtx): Promise<SessionToolInfo[]> {
  assertOpen(s)
  touch(s)
  const open = await ensureOpen(s)
  const inspection = await inspect(s, open)
  return describeTools(inspection.entries, s.compaction.count, s.compaction.calibration.apply)
}

export function apiEvents(s: SessionCtx): never {
  assertOpen(s)
  touch(s)
  return s.events.stream() as never
}

export function apiIdle(s: SessionCtx): Promise<void> {
  if (isIdle(s)) return Promise.resolve()
  return new Promise<void>((resolve) => {
    s.idleWaiters.push(resolve)
  })
}
