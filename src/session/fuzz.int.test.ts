/**
 * Property / fuzz test of the session state machine (spec 05 §15): seeded random interleavings of
 * operations on two agent instances sharing messages, state, inbox and lock; after every step the
 * stored session must satisfy the invariants, no operation may throw anything but the documented
 * `EH_SESSION_BUSY` / `EH_SESSION_CLOSED`, and `run.result` never rejects.
 *
 * `FUZZ_SEEDS` (default 250) sets the number of seeds, `FUZZ_START` the first seed (`FUZZ_ONLY`
 * runs one seed and prints its op log).
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type {
  HarnessRun,
  HarnessSession,
  InboxAdapter,
  MessageAdapter,
  SessionLock,
  StateAdapter,
} from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { isHarnessError } from '../errors.ts'
import type { HarnessUIMessage, PendingState } from '../messages/types.ts'
import { memoryInbox } from '../storage/memory.ts'
import { type ScriptedStepInput, scriptedModel } from '../testing/scripted-model.ts'
import { prng, sleep } from '../testing/test-utils.ts'
import { spyMessages } from './int-kit.ts'
import { checkSessionInvariants } from './invariants.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const SID = 's1'

/** Wraps an adapter so that, once `gate.dead`, every call hangs forever (a crashed process). */
const calls = new Map<string, number>()
let totalCalls = 0
let runaway: string | undefined
/** Storage calls per seed: a runaway (a hot loop starving timers) is reported instead of hanging. */
const MAX_CALLS = 400_000

function deadable<T extends object>(inner: T, gate: { dead: boolean }): T {
  return new Proxy(inner, {
    get(target, key) {
      const value = (target as Record<string | symbol, unknown>)[key]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.set(String(key), (calls.get(String(key)) ?? 0) + 1)
        if (++totalCalls > MAX_CALLS) {
          runaway = `more than ${MAX_CALLS} storage calls ${JSON.stringify(Object.fromEntries(calls))}`
        }
        // a runaway loop is cut: every storage call hangs from now on
        if (runaway !== undefined) return new Promise(() => {})
        if (gate.dead) return key === 'subscribe' ? () => {} : new Promise(() => {})
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

/** Logs claims, acks and releases of the inbox (to read a failing seed). */
function spyInbox(inner: InboxAdapter, log: (message: string) => void): InboxAdapter {
  return {
    ...inner,
    async enqueue(sessionId, item) {
      const id = await inner.enqueue(sessionId, item)
      log(`enqueue ${id} ${item.kind}${'mode' in item ? `/${item.mode}` : ''}`)
      return id
    },
    ...(inner.enqueueOnce === undefined
      ? {}
      : {
          async enqueueOnce(
            sessionId: string,
            item: Parameters<NonNullable<InboxAdapter['enqueueOnce']>>[1],
          ) {
            const res = await (inner.enqueueOnce as NonNullable<InboxAdapter['enqueueOnce']>)(
              sessionId,
              item,
            )
            log(`enqueueOnce ${res.id} dup=${res.duplicate}`)
            return res
          },
        }),
    async claim(sessionId, owner, opts) {
      const items = await inner.claim(sessionId, owner, opts)
      if (items.length > 0)
        log(`claim ${owner} ${items.map((i) => `${i.id.slice(-6)}:${i.kind}`).join(',')}`)
      return items
    },
    async ack(ids) {
      log(`ack ${ids.map((i) => i.slice(-6)).join(',')}`)
      return inner.ack(ids)
    },
    async release(ids, opts) {
      log(`release ${ids.map((i) => i.slice(-6)).join(',')} ${JSON.stringify(opts ?? {})}`)
      return inner.release(ids, opts)
    },
    notify: (sessionId) => inner.notify?.(sessionId) ?? Promise.resolve(),
    subscribe: (sessionId, onNotify) => inner.subscribe?.(sessionId, onNotify) ?? (() => {}),
  }
}

/** A lock that rejects while held; `dropOwner` releases the locks of a crashed instance. */
function memoryLock() {
  const held = new Map<string, string>()
  return {
    forOwner(owner: string, gate: { dead: boolean }): SessionLock {
      return {
        async acquire(sessionId) {
          if (gate.dead) return new Promise(() => {})
          if (held.has(sessionId)) throw new Error('locked')
          held.set(sessionId, owner)
          return async () => {
            if (held.get(sessionId) === owner) held.delete(sessionId)
          }
        },
      }
    },
    dropOwner(owner: string) {
      for (const [id, o] of held) if (o === owner) held.delete(id)
    },
  }
}

const ALLOWED = new Set(['EH_SESSION_BUSY', 'EH_SESSION_CLOSED'])

class FuzzFailure extends Error {}

interface Slot {
  index: number
  gen: number
  instanceId: string
  gate: { dead: boolean }
  agent: ReturnType<typeof makeAgent>['agent']
  session: HarnessSession
  stopEvents: () => void
}

function makeAgent(env: Env, instanceId: string, gate: { dead: boolean }) {
  const agent = defineHarnessAgent({
    model: env.model,
    contextWindow: 100_000,
    tools: env.tools,
    approval: { policy: { pay: 'user-approval' } },
    loop: { maxSteps: 4 },
    storage: {
      messages: deadable(env.messages, gate) as MessageAdapter,
      state: deadable(env.state, gate) as StateAdapter,
      inbox: deadable(env.inbox, gate) as InboxAdapter,
    },
    inbox: { pollMs: 5, collect: { quietMs: 4, maxWaitMs: 20 } },
    recovery: { staleMs: 40, abortPollMs: 10, instanceId },
    debug: { invariants: true },
    logger: silent,
    onWarning: (w) => env.warnings.push(`${w.code}: ${w.message}`),
  })
  return { agent }
}

interface Env {
  model: ReturnType<typeof scriptedModel>
  tools: NonNullable<HarnessAgentConfig['tools']>
  messages: MessageAdapter
  state: StateAdapter
  inbox: InboxAdapter
  lock: ReturnType<typeof memoryLock>
  warnings: string[]
}

async function runSeed(seed: number, verbose: boolean): Promise<void> {
  calls.clear()
  totalCalls = 0
  runaway = undefined
  const rnd = prng(seed)
  const modelRnd = prng(seed ^ 0x9e3779b9)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  const log: string[] = []
  const note = (s: string) => {
    log.push(s)
    if (verbose) console.log(`[seed ${seed}] ${s}`)
  }
  const fail = async (what: string): Promise<never> => {
    const stored = (await env.messages.load({ sessionId: SID })) as HarnessUIMessage[]
    const timeline = stored.map((m) => {
      const e = m.metadata?.eharness
      const parts = m.parts.map((p) => p.type.replace('data-', '')).join(',')
      return `  ${m.id.slice(-6)} ${m.role} ${e?.kind ?? ''} turn=${e?.turnId?.slice(-6) ?? '-'} stop=${e?.stop ?? '-'} ${parts}`
    })
    throw new FuzzFailure(
      `seed ${seed}: ${what}\n--- stored ---\n${timeline.join('\n')}\n--- op log ---\n${(log.length > 250 ? [...log.slice(0, 150), `... ${log.length - 250} lines ...`, ...log.slice(-100)] : log).join('\n')}`,
    )
  }

  let callCounter = 0
  const id = () => `c${seed}-${callCounter++}`
  const stepFn = (): ScriptedStepInput => () => {
    const r = modelRnd()
    const delayMs = Math.floor(modelRnd() * 3)
    if (r < 0.04) return { throws: new Error('provider boom') }
    if (r < 0.5) return { text: 'ok', delayMs }
    if (r < 0.65)
      return { toolCalls: [{ toolName: 'pay', input: { amount: 1 }, toolCallId: id() }], delayMs }
    if (r < 0.75) return { toolCalls: [{ toolName: 'slow', input: {}, toolCallId: id() }], delayMs }
    if (r < 0.85)
      return { toolCalls: [{ toolName: 'ask', input: { q: 'x' }, toolCallId: id() }], delayMs }
    if (r < 0.92) {
      return {
        toolCalls: [
          { toolName: 'pay', input: { amount: 2 }, toolCallId: id() },
          { toolName: 'ask', input: { q: 'y' }, toolCallId: id() },
          { toolName: 'slow', input: {}, toolCallId: id() },
        ],
        delayMs,
      }
    }
    return { text: 'done', delayMs }
  }
  const env: Env = {
    model: scriptedModel(Array.from({ length: 4000 }, stepFn)),
    tools: {
      pay: tool({ inputSchema: z.object({ amount: z.number() }), execute: async () => 'paid' }),
      slow: tool({
        inputSchema: z.object({}),
        execute: async () => {
          await sleep(2)
          return 'slow ok'
        },
      }),
      ask: tool({ inputSchema: z.object({ q: z.string() }) }),
    },
    messages: spyMessages(defaultMemoryMessages()),
    state: defaultMemoryState(),
    inbox: spyInbox(memoryInbox(), (m) => note(`  inbox ${m}`)),
    lock: memoryLock(),
    warnings: [],
  }

  // ─── instances and observers ───────────────────────────────────────────────────────────────
  const activeTurns = new Map<string, number>() // turnId -> slot index
  const violations: string[] = []
  const slots: Slot[] = []
  const deadAgents: Slot[] = []

  function openSlot(index: number, gen: number): Slot {
    const instanceId = `inst-${index}`
    const gate = { dead: false }
    const { agent } = makeAgent(env, instanceId, gate)
    const session = agent.session(SID, {
      lock: env.lock.forOwner(`${instanceId}#${gen}`, gate),
    }) as HarnessSession
    const reader = session.events().getReader()
    let stopped = false
    void (async () => {
      while (!stopped) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done || next.value === undefined) return
        const e = next.value
        if (e.type === 'turn-start') {
          if (activeTurns.size > 0 && !activeTurns.has(e.turnId)) {
            violations.push(
              `concurrent turns: ${e.turnId} (slot ${index}) started while ${[...activeTurns.keys()].join(',')} active`,
            )
          }
          activeTurns.set(e.turnId, index)
        } else if (e.type === 'turn-end') activeTurns.delete(e.turnId)
      }
    })()
    return {
      index,
      gen,
      instanceId,
      gate,
      agent,
      session,
      stopEvents: () => {
        stopped = true
        void reader.cancel().catch(() => {})
      },
    }
  }
  slots.push(openSlot(0, 0), openSlot(1, 0))

  // ─── bookkeeping of operations ─────────────────────────────────────────────────────────────
  const results: Array<{ slot: Slot; name: string; done: boolean }> = []
  const ops: Array<{ slot: Slot; name: string; done: boolean; promise: Promise<unknown> }> = []

  function track(slot: Slot, name: string, run: HarnessRun): void {
    const entry = { slot, name, done: false }
    results.push(entry)
    run.result.then(
      (r) => {
        entry.done = true
        note(
          `  result ${name}: stop=${r.stop}${r.error ? ` error=${r.error.code}:${r.error.message}` : ''}`,
        )
      },
      (error) => {
        violations.push(`run.result of ${name} rejected: ${String(error)}`)
      },
    )
    run.accepted.catch((error) =>
      violations.push(`run.accepted of ${name} rejected: ${String(error)}`),
    )
  }

  function turnOp(slot: Slot, name: string, start: () => HarnessRun): void {
    try {
      track(slot, name, start())
    } catch (error) {
      if (!(isHarnessError(error) && ALLOWED.has(error.code))) {
        violations.push(`${name} threw ${String(error)}`)
      }
    }
  }

  function asyncOp(slot: Slot, name: string, start: () => Promise<unknown>): void {
    const entry = { slot, name, done: false, promise: Promise.resolve() as Promise<unknown> }
    entry.promise = (async () => {
      try {
        await start()
      } catch (error) {
        const allowed =
          ALLOWED.has(isHarnessError(error) ? error.code : '') ||
          (name.startsWith('compact') &&
            isHarnessError(error) &&
            error.code === 'EH_COMPACTION_FAILED')
        if (!allowed) {
          violations.push(`${name} rejected ${String(error)}`)
        }
      } finally {
        entry.done = true
      }
    })()
    ops.push(entry)
  }

  async function storedState() {
    return env.state.get(SID)
  }
  async function storedMessages(): Promise<HarnessUIMessage[]> {
    return (await env.messages.load({ sessionId: SID })) as HarnessUIMessage[]
  }

  const respondOf = (
    pending: PendingState | undefined | null,
    mode: 'all' | 'partial' | 'junk',
  ) => {
    const approvals: Array<{ id: string; approved: boolean; reason?: string }> = []
    const toolOutputs: Array<{ toolCallId: string; output: string }> = []
    if (pending !== undefined && pending !== null) {
      for (const a of pending.approvals) {
        if (mode === 'partial' && rnd() < 0.5) continue
        approvals.push({ id: a.approvalId, approved: rnd() < 0.5, reason: 'fuzz' })
      }
      for (const c of pending.clientTools) {
        if (mode === 'partial' && rnd() < 0.5) continue
        toolOutputs.push({ toolCallId: c.toolCallId, output: 'client says hi' })
      }
    }
    if (mode === 'junk') approvals.push({ id: 'nope', approved: true })
    return { approvals, toolOutputs }
  }

  async function checkNow(when: string): Promise<void> {
    const state = await storedState()
    const messages = await storedMessages()
    const problems = await checkSessionInvariants(state, messages)
    const inboxIds = messages.map(
      (m) => (m.metadata?.eharness as { inboxId?: string } | undefined)?.inboxId,
    )
    const seen = new Set<string>()
    for (const inboxId of inboxIds) {
      if (inboxId === undefined) continue
      if (seen.has(inboxId)) problems.push(`I7: inboxId ${inboxId} stored twice (duplicated turn)`)
      seen.add(inboxId)
    }
    problems.push(...violations)
    if (runaway !== undefined) problems.push(`runaway loop: ${runaway}`)
    if (problems.length > 0) await fail(`${when}: ${problems.join('; ')}`)
  }

  // ─── the random script ─────────────────────────────────────────────────────────────────────
  const nOps = 10 + Math.floor(rnd() * 22)
  let crashed = false
  for (let i = 0; i < nOps; i++) {
    const slot = pick(slots)
    const r = rnd()
    const text = `m${i}`
    if (r < 0.2) {
      const ifBusy = pick(['reject', 'queue', 'steer', 'wait', 'collect'] as const)
      note(`${i}: slot${slot.index}.send(${text}, ${ifBusy})`)
      turnOp(slot, `send#${i}`, () => slot.session.send(text, { ifBusy }))
      if (verbose) console.log('  send returned')
    } else if (r < 0.3) {
      const mode = pick(['queue', 'steer', 'collect'] as const)
      note(`${i}: slot${slot.index}.enqueue(${text}, ${mode})`)
      asyncOp(slot, `enqueue#${i}`, () => slot.session.enqueue(text, { mode }))
    } else if (r < 0.5) {
      const mode = pick(['all', 'partial', 'partial', 'junk'] as const)
      const state = await storedState()
      const response = respondOf(state?.core.pending, mode)
      note(`${i}: slot${slot.index}.respond(${mode}, ${JSON.stringify(response)})`)
      const ifBusy = pick(['reject', 'wait'] as const)
      turnOp(slot, `respond#${i}`, () => slot.session.respond(response, { ifBusy }))
    } else if (r < 0.6) {
      const deliver = pick(['next-turn', 'next-step'] as const)
      const wake = rnd() < 0.5
      const key = rnd() < 0.3 ? `k${Math.floor(rnd() * 3)}` : undefined
      note(`${i}: slot${slot.index}.inject(${deliver}, wake=${wake}, key=${key})`)
      asyncOp(slot, `inject#${i}`, async () => {
        const res = await slot.session.inject(
          'eh.event',
          { name: 'bg', text: `bg ${i}` },
          { deliver, wake, ...(key === undefined ? {} : { key }) },
        )
        if (res.run !== undefined) track(slot, `inject-wake#${i}`, res.run)
      })
    } else if (r < 0.66) {
      note(`${i}: slot${slot.index}.abort()`)
      slot.session.abort('fuzz')
    } else if (r < 0.7) {
      note(`${i}: slot${slot.index}.requestAbort()`)
      asyncOp(slot, `requestAbort#${i}`, () => slot.session.requestAbort('fuzz'))
    } else if (r < 0.75) {
      note(`${i}: slot${slot.index}.compact()`)
      asyncOp(slot, `compact#${i}`, () => slot.session.compact({ keepLast: 1 }))
    } else if (r < 0.8) {
      note(`${i}: slot${slot.index}.regenerate()`)
      turnOp(slot, `regenerate#${i}`, () => slot.session.regenerate())
    } else if (r < 0.85) {
      const users = (await storedMessages()).filter(
        (m) => m.role === 'user' && m.metadata?.eharness?.kind === undefined,
      )
      const target = users.length === 0 ? undefined : pick(users)
      if (target !== undefined) {
        note(`${i}: slot${slot.index}.edit(${target.id})`)
        turnOp(slot, `edit#${i}`, () => slot.session.edit(target.id, `edited ${i}`))
      }
    } else if (r < 0.9) {
      note(`${i}: slot${slot.index}.recover()`)
      asyncOp(slot, `recover#${i}`, () => slot.session.recover())
    } else if (r < 0.94 && !crashed) {
      crashed = true
      note(`${i}: CRASH slot${slot.index} (mid-turn if one runs) and restart`)
      slot.gate.dead = true
      slot.stopEvents()
      env.lock.dropOwner(`${slot.instanceId}#${slot.gen}`)
      for (const [turnId, idx] of [...activeTurns])
        if (idx === slot.index) activeTurns.delete(turnId)
      deadAgents.push(slot)
      for (const entry of [...results, ...ops]) if (entry.slot === slot) entry.done = true
      slots[slot.index] = openSlot(slot.index, slot.gen + 1)
    } else {
      note(`${i}: sleep`)
    }
    await sleep(rnd() < 0.4 ? 0 : Math.floor(rnd() * 6))
    if (verbose) console.log(`  sleep done ${i}`)
    await checkNow(`after op ${i}`)
    if (verbose) console.log(`  check done ${i}`)
  }

  // ─── settle: drive every leftover to its end ───────────────────────────────────────────────
  let stable = 0
  for (let n = 0; n < 600 && stable < 3; n++) {
    await sleep(5)
    const state = await storedState()
    const running = slots.some((s) => s.session.running)
    const inbox = (await env.inbox.stats?.({ sessionId: SID })) ?? {
      ready: 0,
      claimed: 0,
      delayed: 0,
      dead: 0,
    }
    const busy = running || inbox.ready + inbox.claimed + inbox.delayed > 0
    if (!running && state?.core.pending !== undefined && state.core.pending !== null) {
      const response = respondOf(state.core.pending, 'all')
      note(`settle: respond(all)`)
      turnOp(slots[0] as Slot, `settle-respond#${n}`, () =>
        (slots[0] as Slot).session.respond(response),
      )
      stable = 0
    } else if (!busy && state?.core.activeTurn !== undefined) {
      note(`settle: recover()`)
      asyncOp(slots[0] as Slot, `settle-recover#${n}`, () => (slots[0] as Slot).session.recover())
      stable = 0
    } else if (!busy) stable++
    else stable = 0
    if (violations.length > 0) await checkNow('during settle')
  }
  if (stable < 3) {
    const inboxNow = await env.inbox.stats?.({ sessionId: SID })
    await fail(
      `did not settle: running=${slots.map((x) => x.session.running)} inbox=${JSON.stringify(inboxNow)} state=${JSON.stringify((await storedState())?.core)} warnings=${env.warnings.join(' | ')}`,
    )
  }
  const unfinished = [...results, ...ops].filter((e) => !e.done).map((e) => e.name)
  if (unfinished.length > 0) {
    await sleep(50)
    const still = [...results, ...ops].filter((e) => !e.done).map((e) => e.name)
    if (still.length > 0) await fail(`operations never finished: ${still.join(', ')}`)
  }
  const state = await storedState()
  const messages = await storedMessages()
  const problems = await checkSessionInvariants(state, messages, { quiescent: true })
  if (runaway !== undefined) problems.push(`runaway loop: ${runaway}`)
  problems.push(...violations)
  if (problems.length > 0) await fail(`final: ${problems.join('; ')}`)
  const hard = env.warnings.filter((w) => /W_INVALID_MESSAGE|W_INVARIANT_VIOLATION/.test(w))
  if (hard.length > 0) await fail(`warnings: ${hard.join(' | ')}`)

  for (const s of slots) {
    s.stopEvents()
    await s.agent.close()
  }
}

describe('session state machine fuzz (spec 05 §15)', () => {
  test(
    'random interleavings keep the invariants',
    async () => {
      const only = process.env.FUZZ_ONLY
      const count = Number(process.env.FUZZ_SEEDS ?? 250)
      const start = Number(process.env.FUZZ_START ?? 1)
      const seeds =
        only === undefined ? Array.from({ length: count }, (_, i) => start + i) : [Number(only)]
      const failures: string[] = []
      for (const seed of seeds) {
        try {
          if (process.env.FUZZ_TRACE !== undefined) console.log(`seed ${seed}`)
          await runSeed(seed, only !== undefined)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
          if (failures.length >= 3) break
        }
      }
      expect(failures.join('\n\n')).toBe('')
    },
    60_000 + Number(process.env.FUZZ_SEEDS ?? 250) * 400,
  )
})
