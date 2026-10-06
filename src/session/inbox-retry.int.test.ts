/**
 * Inbox retries and dead-letter (spec 05 §12 rules 11–15, ADR-0026): two agent instances share
 * one message store, one state store and one `memoryInbox()`; poison items go dead after
 * `retry.maxAttempts`, deferrals never consume attempts, non-retryable inputs go dead at once,
 * and without `inbox.retry` the 0.4 behaviour is kept.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type {
  DeadInboxItem,
  InboxAdapter,
  InboxItemInput,
  InboxReleaseOptions,
  MessageAdapter,
  SessionEvent,
} from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { memoryInbox } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(2)
  }
}

/** A memory inbox that records claims and release options; `legacy` drops the 0.5 members. */
function spyInbox(options: { legacy?: boolean } = {}) {
  const inner = memoryInbox()
  const log = {
    claims: [] as Array<{ owner: string; items: Array<[string, number]> }>,
    releases: [] as Array<{ ids: string[]; opts: InboxReleaseOptions | undefined }>,
    acks: [] as string[],
    dead: [] as string[],
  }
  const adapter: InboxAdapter = {
    enqueue: (sessionId, item) => inner.enqueue(sessionId, item),
    async claim(sessionId, owner, opts) {
      const items = await inner.claim(sessionId, owner, opts)
      if (items.length > 0) log.claims.push({ owner, items: items.map((i) => [i.id, i.attempts]) })
      return items
    },
    async ack(ids) {
      log.acks.push(...ids)
      return inner.ack(ids)
    },
    async release(ids, opts) {
      log.releases.push({ ids: [...ids], opts: opts === undefined ? undefined : { ...opts } })
      return inner.release(ids, opts)
    },
    notify: (sessionId) => inner.notify?.(sessionId) ?? Promise.resolve(),
    subscribe: (sessionId, onNotify) => inner.subscribe?.(sessionId, onNotify) ?? (() => {}),
  }
  if (options.legacy !== true) {
    adapter.deadLetter = async (ids, info) => {
      log.dead.push(...ids)
      return inner.deadLetter?.(ids, info)
    }
    adapter.redrive = (ids) => inner.redrive?.(ids) ?? Promise.resolve()
    adapter.listDead = (opts) => inner.listDead?.(opts) ?? Promise.resolve([])
    adapter.stats = (opts) =>
      inner.stats?.(opts) ?? Promise.resolve({ ready: 0, claimed: 0, delayed: 0, dead: 0 })
  }
  /** Highest attempt count seen for an item. */
  const attempts = (id: string) =>
    Math.max(0, ...log.claims.flatMap((c) => c.items.filter(([i]) => i === id).map(([, n]) => n)))
  return { adapter, inner, log, attempts }
}

/** Messages whose save fails for user messages containing `poison` (`EH_STORAGE`). */
function poisonMessages(): MessageAdapter & { failures: number; enabled: boolean } {
  const inner = defaultMemoryMessages()
  const out = {
    failures: 0,
    enabled: true,
    load: inner.load.bind(inner),
    lastId: inner.lastId?.bind(inner),
    async save(sessionId: string, messages: Parameters<MessageAdapter['save']>[1]) {
      const poisoned = messages.some(
        (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && p.text === 'poison'),
      )
      if (poisoned && out.enabled) {
        out.failures++
        // real I/O: without a backoff (0.4) the redelivery loop would starve the timers
        await sleep(1)
        throw new Error('disk full')
      }
      return inner.save(sessionId, messages)
    },
  }
  return out as MessageAdapter & { failures: number; enabled: boolean }
}

type Spy = ReturnType<typeof spyInbox>

function storageWith(inbox: Spy, messages: MessageAdapter = defaultMemoryMessages()) {
  return { messages, state: defaultMemoryState(), inbox }
}
type Storage = ReturnType<typeof storageWith>

function instance(
  storage: Storage,
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
) {
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: storage.messages, state: storage.state, inbox: storage.inbox.adapter },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
    inbox: { pollMs: 10, ...config.inbox },
  })
  return { agent, warnings }
}

function record(stream: ReadableStream<SessionEvent>): SessionEvent[] {
  const events: SessionEvent[] = []
  const reader = stream.getReader()
  void (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      events.push(next.value)
    }
  })()
  return events
}

async function userTexts(storage: Storage): Promise<string[]> {
  const messages = (await storage.messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''))
}

const sendItem = (text: string): InboxItemInput => ({
  kind: 'send',
  mode: 'queue',
  input: { parts: [{ type: 'text', text }] },
  at: Date.now(),
})

/** A stored input that no longer normalizes (no parts): `EH_INVALID_INPUT`. */
const invalidItem = (): InboxItemInput => ({
  kind: 'send',
  mode: 'queue',
  input: { parts: [] },
  at: Date.now(),
})

const fast = { backoff: { delayMs: 5, jitter: false } } as const

describe('inbox retries and dead-letter (spec 05 §12 rules 11–15)', () => {
  test('a send whose unit always fails with EH_STORAGE goes dead after maxAttempts; the next item runs', async () => {
    const inbox = spyInbox()
    const messages = poisonMessages()
    const storage = storageWith(inbox, messages)
    const model = scriptedModel([{ text: 'healthy done' }])
    const reported: DeadInboxItem[] = []
    const a = instance(storage, {
      model,
      inbox: {
        retry: { maxAttempts: 3, ...fast },
        onDeadLetter: (item) => {
          reported.push(item)
        },
      },
    })
    const poison = { inboxId: await inbox.adapter.enqueue('s1', sendItem('poison')) }
    const healthy = { inboxId: await inbox.adapter.enqueue('s1', sendItem('healthy')) }
    const sessionA = a.agent.session('s1')
    const events = record(sessionA.events())

    await until('the healthy item ran', async () => (await userTexts(storage)).includes('healthy'))
    await sessionA.idle()
    expect(messages.failures).toBe(3)
    expect(await userTexts(storage)).toEqual(['healthy'])
    expect(model.prompts.length).toBe(1)

    // failed attempts: backoff + lastError; the parked item behind it: deferrals (uncount)
    const failed = inbox.log.releases.filter((r) => r.ids.includes(poison.inboxId))
    expect(failed.length).toBe(3)
    for (const r of failed) {
      expect(r.opts?.uncount).toBeUndefined()
      expect(r.opts?.delayMs).toBeGreaterThanOrEqual(5)
      expect(r.opts?.lastError).toContain('EH_STORAGE')
    }
    expect(failed.map((r) => r.opts?.delayMs)).toEqual([5, 10, 20])
    for (const r of inbox.log.releases.filter((x) => x.ids.includes(healthy.inboxId))) {
      expect(r.opts?.uncount).toBe(true)
    }
    expect(inbox.attempts(healthy.inboxId)).toBe(1)

    // dead: kept by the adapter and reported once
    expect(inbox.log.dead).toEqual([poison.inboxId])
    const dead = await inbox.adapter.listDead?.({ sessionId: 's1' })
    expect(dead?.map((d) => [d.id, d.reason, d.attempts])).toEqual([
      [poison.inboxId, 'max-attempts', 4],
    ])
    expect(dead?.[0]?.lastError).toContain('EH_STORAGE')
    expect(reported.map((d) => [d.id, d.sessionId, d.reason])).toEqual([
      [poison.inboxId, 's1', 'max-attempts'],
    ])
    expect(events).toContainEqual({
      type: 'inbox-dead',
      inboxId: poison.inboxId,
      kind: 'send',
      reason: 'max-attempts',
      attempts: 4,
    })
    const warning = a.warnings.find((w) => w.code === 'W_INBOX_DEAD_LETTER')
    expect(warning?.details).toEqual({
      sessionId: 's1',
      inboxId: poison.inboxId,
      kind: 'send',
      attempts: 4,
      reason: 'max-attempts',
    })
    expect(await inbox.adapter.stats?.({ sessionId: 's1' })).toEqual({
      ready: 0,
      claimed: 0,
      delayed: 0,
      dead: 1,
    })
    await a.agent.close()
  })

  test('a redriven item runs again once its cause is fixed', async () => {
    const inbox = spyInbox()
    const messages = poisonMessages()
    const storage = storageWith(inbox, messages)
    const id = await inbox.adapter.enqueue('s1', sendItem('poison'))
    const model = scriptedModel([{ text: 'ok' }])
    const a = instance(storage, { model, inbox: { retry: { maxAttempts: 1, ...fast } } })
    const sessionA = a.agent.session('s1')
    await until('dead', () => inbox.log.dead.includes(id))
    await sessionA.idle()
    expect(messages.failures).toBe(1)
    messages.enabled = false // the operator fixed the cause
    await inbox.adapter.redrive?.([id])
    await until('applied', async () => (await userTexts(storage)).includes('poison'))
    await sessionA.idle()
    expect(await inbox.adapter.listDead?.({ sessionId: 's1' })).toEqual([])
    expect(inbox.log.acks).toContain(id)
    await a.agent.close()
  })

  test('a holder that dies after its claim, again and again, is counted via claim expiry → dead', async () => {
    const inbox = spyInbox()
    const storage = storageWith(inbox)
    const id = await inbox.adapter.enqueue('s1', sendItem('crashes the holder'))
    for (let i = 0; i < 3; i++) {
      await inbox.adapter.claim('s1', `dead-instance-${i}`, { claimTtlMs: 15 })
      await sleep(25)
    }
    const model = scriptedModel([{ text: 'must not run' }])
    const a = instance(storage, { model, inbox: { retry: { maxAttempts: 3, ...fast } } })
    const sessionA = a.agent.session('s1')
    const events = record(sessionA.events())
    await until('dead', () => inbox.log.dead.includes(id))
    await sessionA.idle()
    expect(model.prompts.length).toBe(0)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'inbox-dead', inboxId: id, attempts: 4 }),
    )
    expect(await userTexts(storage)).toEqual([])
    await a.agent.close()
  })

  test('a long foreign turn with 20+ polls does not consume attempts (uncount)', async () => {
    const inbox = spyInbox()
    const storage = storageWith(inbox)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const gated = tool({
      inputSchema: z.object({}),
      execute: async () => {
        started()
        await gate
        return 'ok'
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'gated', input: {} }] },
      { text: 'first done' },
      { text: 'second done' },
    ])
    const retry = { maxAttempts: 2, ...fast }
    const a = instance(storage, { model, tools: { gated }, inbox: { retry } })
    const b = instance(storage, { model, inbox: { retry } })
    const run = a.agent.session('s1').send('first')
    await running
    const queued = await b.agent.session('s1').enqueue('second')
    expect(queued.target).toBe('remote')
    await until('20 claims while the turn runs', () => {
      return (
        inbox.log.claims.filter((c) => c.items.some(([i]) => i === queued.inboxId)).length >= 20
      )
    })
    expect(inbox.attempts(queued.inboxId)).toBe(1)
    release()
    expect((await run.result).stop).toBe('complete')
    await until('the queued item ran', async () => (await userTexts(storage)).includes('second'))
    await a.agent.session('s1').idle()
    expect(await userTexts(storage)).toEqual(['first', 'second'])
    expect(inbox.log.dead).toEqual([])
    expect(a.warnings.some((w) => w.code === 'W_INBOX_DEAD_LETTER')).toBe(false)
    await a.agent.close()
    await b.agent.close()
  })

  test('a non-retryable invalid stored input goes dead at once; the next item runs', async () => {
    const inbox = spyInbox()
    const storage = storageWith(inbox)
    const bad = await inbox.adapter.enqueue('s1', invalidItem())
    await inbox.adapter.enqueue('s1', sendItem('next'))
    const model = scriptedModel([{ text: 'ok' }])
    const a = instance(storage, { model, inbox: { retry: { maxAttempts: 5, ...fast } } })
    const sessionA = a.agent.session('s1')
    await until('next applied', async () => (await userTexts(storage)).includes('next'))
    await sessionA.idle()
    expect(inbox.log.dead).toEqual([bad])
    const dead = await inbox.adapter.listDead?.({ sessionId: 's1' })
    expect(dead?.map((d) => [d.reason, d.attempts])).toEqual([['non-retryable', 1]])
    expect(dead?.[0]?.lastError).toStartWith('EH_INVALID_INPUT')
    expect(await userTexts(storage)).toEqual(['next'])
    await a.agent.close()
  })

  test('without inbox.retry: 0.4 behaviour (no release options, unlimited redelivery, invalid input acked)', async () => {
    const inbox = spyInbox()
    const messages = poisonMessages()
    const storage = storageWith(inbox, messages)
    const bad = await inbox.adapter.enqueue('s1', invalidItem())
    const poison = await inbox.adapter.enqueue('s1', sendItem('poison'))
    const model = scriptedModel([])
    const a = instance(storage, { model })
    a.agent.session('s1') // opening the session starts its drain
    await until('six failed attempts', () => messages.failures >= 6)
    expect(inbox.log.acks).toContain(bad)
    expect(inbox.log.dead).toEqual([])
    expect(inbox.attempts(poison)).toBeGreaterThanOrEqual(6)
    expect(inbox.log.releases.every((r) => r.opts === undefined)).toBe(true)
    expect(a.warnings.some((w) => w.code === 'W_INBOX_DEAD_LETTER')).toBe(false)
    // never idle: the poison item is redelivered without limit (0.4)
    await a.agent.close()
  })

  test('onDeadLetter failure with a dead store: reported as W_HOOK_FAILED, the item is kept', async () => {
    const inbox = spyInbox()
    const storage = storageWith(inbox)
    const id = await inbox.adapter.enqueue('s1', invalidItem())
    const model = scriptedModel([])
    const a = instance(storage, {
      model,
      inbox: {
        retry: fast,
        onDeadLetter: () => {
          throw new Error('pager down')
        },
      },
    })
    const sessionA = a.agent.session('s1')
    await until('dead', () => inbox.log.dead.includes(id))
    await sessionA.idle()
    expect((await inbox.adapter.listDead?.())?.map((d) => d.id)).toContain(id)
    const hook = a.warnings.find((w) => w.code === 'W_HOOK_FAILED')
    expect(hook?.details).toMatchObject({ hook: 'inbox.onDeadLetter', inboxId: id })
    expect(a.warnings.some((w) => w.code === 'W_INBOX_DEAD_LETTER')).toBe(true)
    await a.agent.close()
  })

  test('without deadLetter: onDeadLetter runs before the ack; a failing callback keeps the item', async () => {
    const inbox = spyInbox({ legacy: true })
    const storage = storageWith(inbox)
    const id = await inbox.adapter.enqueue('s1', invalidItem())
    const seen: Array<{ id: string; acked: boolean }> = []
    let fail = 2
    const model = scriptedModel([])
    const a = instance(storage, {
      model,
      inbox: {
        retry: fast,
        onDeadLetter: (item) => {
          seen.push({ id: item.id, acked: inbox.log.acks.includes(item.id) })
          if (fail-- > 0) throw new Error('not yet')
        },
      },
    })
    const sessionA = a.agent.session('s1')
    await until('acked after a successful report', () => inbox.log.acks.includes(id))
    await sessionA.idle()
    expect(seen).toEqual([
      { id, acked: false },
      { id, acked: false },
      { id, acked: false },
    ])
    expect(a.warnings.filter((w) => w.code === 'W_HOOK_FAILED').length).toBe(2)
    expect(a.warnings.filter((w) => w.code === 'W_INBOX_DEAD_LETTER').length).toBe(1)
    await a.agent.close()
  })

  test('a failing deadLetter is W_INBOX_FAILED and the item is released, never lost', async () => {
    const inbox = spyInbox()
    let fail = 1
    const deadLetter = inbox.adapter.deadLetter
    inbox.adapter.deadLetter = async (ids, info) => {
      if (fail-- > 0) throw new Error('dead table missing')
      return deadLetter?.(ids, info)
    }
    const storage = storageWith(inbox)
    const id = await inbox.adapter.enqueue('s1', invalidItem())
    const a = instance(storage, { model: scriptedModel([]), inbox: { retry: fast } })
    const sessionA = a.agent.session('s1')
    await until('dead on the second try', () => inbox.log.dead.includes(id))
    await sessionA.idle()
    expect(
      a.warnings.some((w) => w.code === 'W_INBOX_FAILED' && w.details?.operation === 'deadLetter'),
    ).toBe(true)
    expect(inbox.log.acks).not.toContain(id)
    expect((await inbox.adapter.listDead?.({ sessionId: 's1' }))?.map((d) => d.id)).toEqual([id])
    await a.agent.close()
  })
})
