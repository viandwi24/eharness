import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type HarnessContext } from '../index.ts'
import { handoffStoreConformance } from '../testing/handoff.conformance.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  cancelHandoff,
  expireHandoffs,
  type HandoffRequest,
  handoff,
  memoryHandoffStore,
  redeliverHandoff,
  resolveHandoff,
} from './index.ts'

describe('memoryHandoffStore conformance', () => {
  for (const c of handoffStoreConformance(() => memoryHandoffStore())) test(c.name, c.run)
})

const CALL = {
  toolName: 'ask_person',
  input: {
    title: 'Refund',
    body: 'Refund 50?',
    options: [
      { id: 'yes', label: 'Approve' },
      { id: 'no', label: 'Deny' },
    ],
  },
}

function setup(over: { defaultExpiryMs?: number; now?: () => number } = {}) {
  const store = memoryHandoffStore()
  const notified: HandoffRequest[] = []
  const model = scriptedModel([{ toolCalls: [CALL] }, { text: 'done' }])
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    plugins: [
      handoff({
        store,
        notify: (r: HandoffRequest, _ctx: HarnessContext) => {
          notified.push(r)
        },
        ...over,
      }),
    ],
  })
  return { store, notified, model, agent }
}

describe('handoff plugin', () => {
  test('parks, notifies, resumes with the answer and rejects a second answer', async () => {
    const { store, notified, model, agent } = setup()
    const first = await agent.session('s1').send('refund?').result
    expect(first.stop).toBe('tool-pending')
    expect(notified).toHaveLength(1)
    const id = notified[0]?.id as string
    expect((await store.get(id))?.status).toBe('open')

    const sessions = agent
    const res = await resolveHandoff({
      store,
      sessions,
      id,
      answer: { optionId: 'yes', text: 'ok', by: 'ana' },
    })
    expect(res.status).toBe('resolved')
    if (res.status !== 'resolved' || res.wait.status !== 'continued') throw new Error('no run')
    const result = await res.wait.run.result
    expect(result.stop).toBe('complete')
    expect(result.messageId).toBe(first.messageId)
    expect(JSON.stringify(model.prompts[1])).toContain('ana chose Approve: ok')

    const again = await resolveHandoff({
      store,
      sessions,
      id,
      answer: { optionId: 'no', by: 'bob' },
    })
    expect(again.status).toBe('already-answered')
    expect((await store.get(id))?.answer?.by).toBe('ana')
  })

  test('unknown option and empty answers are invalid and leave the request open', async () => {
    const { store, notified, agent } = setup()
    await agent.session('s1').send('refund?').result
    const id = notified[0]?.id as string
    const bad = await resolveHandoff({
      store,
      sessions: agent,
      id,
      answer: { optionId: 'x', by: 'a' },
    })
    expect(bad.status).toBe('invalid')
    const empty = await resolveHandoff({ store, sessions: agent, id, answer: { by: 'a' } })
    expect(empty.status).toBe('invalid')
    expect((await store.get(id))?.status).toBe('open')
    expect(
      (await resolveHandoff({ store, sessions: agent, id: 'zzz', answer: { text: 'x', by: 'a' } }))
        .status,
    ).toBe('not-found')
  })

  test('expiry resolves the wait with a no-answer result', async () => {
    let t = 1000
    const { store, model, agent } = setup({ defaultExpiryMs: 500, now: () => t })
    await agent.session('s1').send('refund?').result
    t = 2000
    const out = await expireHandoffs({ store, sessions: agent, now: 2000 })
    expect(out).toHaveLength(1)
    const wait = out[0]?.wait
    if (wait?.status !== 'continued') throw new Error(`expected continued, got ${wait?.status}`)
    await wait.run.result
    expect(JSON.stringify(model.prompts[1])).toContain('expired')
    const late = await resolveHandoff({
      store,
      sessions: agent,
      id: out[0]?.request.id as string,
      answer: { text: 'late', by: 'a' },
    })
    expect(late).toMatchObject({ status: 'closed', reason: 'expired' })
  })

  test('cancel resolves the wait and closes the request', async () => {
    const { store, notified, model, agent } = setup()
    await agent.session('s1').send('refund?').result
    const id = notified[0]?.id as string
    const res = await cancelHandoff({ store, sessions: agent, id })
    expect(res.status).toBe('resolved')
    if (res.status !== 'resolved' || res.wait.status !== 'continued') throw new Error('no run')
    await res.wait.run.result
    expect(JSON.stringify(model.prompts[1])).toContain('cancelled')
    expect((await store.get(id))?.status).toBe('cancelled')
  })

  test('output and metadata shape the delivery; a losing answer delivers nothing', async () => {
    const { store, notified, model, agent } = setup()
    await agent.session('s1').send('refund?').result
    const id = notified[0]?.id as string
    const res = await resolveHandoff({
      store,
      sessions: agent,
      id,
      answer: { optionId: 'yes', by: 'ana' },
      output: (_r, a) => `CUSTOM ${a.optionId}`,
      metadata: { outcome: 'granted' },
    })
    if (res.status !== 'resolved' || res.wait.status !== 'continued') throw new Error('no run')
    await res.wait.run.result
    expect(JSON.stringify(model.prompts[1])).toContain('CUSTOM yes')
    expect((await store.get(id))?.metadata).toEqual({ outcome: 'granted' })

    let delivered = 0
    const spy = {
      session: () => ({
        resolveWait: async () => {
          delivered++
          return { status: 'already-resolved' as const }
        },
      }),
    }
    const lost = await resolveHandoff({
      store,
      sessions: spy,
      id,
      answer: { optionId: 'no', by: 'bob' },
      metadata: { outcome: 'denied' },
    })
    expect(lost.status).toBe('already-answered')
    expect(delivered).toBe(0)
    expect((await store.get(id))?.metadata).toEqual({ outcome: 'granted' })
  })

  test('redeliverHandoff delivers a stored answer only while the wait is pending', async () => {
    const { store, notified, model, agent } = setup()
    await agent.session('s1').send('refund?').result
    const id = notified[0]?.id as string
    // the process died after the store answered and before the session was told
    await store.answer(id, { optionId: 'yes', by: 'ana', at: 1 })
    const sessions = { session: (sid: string) => agent.session(sid) }
    const res = await redeliverHandoff({ store, sessions, id })
    if (res.status !== 'resolved' || res.wait.status !== 'continued') throw new Error('no run')
    await res.wait.run.result
    expect(JSON.stringify(model.prompts[1])).toContain('ana chose Approve')
    const again = await redeliverHandoff({ store, sessions, id })
    expect(again.status).toBe('already-answered')
    expect(again.status === 'already-answered' && again.wait).toBeFalsy()
  })
})
