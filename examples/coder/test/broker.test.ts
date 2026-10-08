/** The approval broker: FIFO queue, answers, abort and listeners. */
import { describe, expect, test } from 'bun:test'
import type { ApprovalAnswer, ApprovalRequest } from '../src/contracts.ts'
import { createBroker, createDenyingBroker } from '../src/permissions/broker.ts'

const request = (id: string): ApprovalRequest => ({
  id,
  toolName: 'bash',
  input: { command: id },
  title: `Bash: ${id}`,
})
const ids = (list: ApprovalRequest[]): string[] => list.map((r) => r.id)

describe('createBroker', () => {
  test('pending is FIFO and answer resolves the matching ask', async () => {
    const broker = createBroker()
    const a = broker.ask(request('a'))
    const b = broker.ask(request('b'))
    const c = broker.ask(request('c'))
    expect(ids(broker.pending())).toEqual(['a', 'b', 'c'])
    broker.answer('b', { approved: true, remember: 'session' })
    expect(ids(broker.pending())).toEqual(['a', 'c'])
    expect(await b).toEqual({ approved: true, remember: 'session' })
    broker.answer('a', { approved: false, feedback: 'no' })
    broker.answer('c', { approved: true })
    expect(await a).toEqual({ approved: false, feedback: 'no' })
    expect(await c).toEqual({ approved: true })
    expect(broker.pending()).toEqual([])
  })

  test('answering an unknown id (or twice) does nothing', async () => {
    const broker = createBroker()
    const seen: number[] = []
    const p = broker.ask(request('a'))
    broker.subscribe((list) => seen.push(list.length))
    broker.answer('nope', { approved: true })
    expect(seen).toEqual([])
    broker.answer('a', { approved: true })
    broker.answer('a', { approved: false })
    expect(await p).toEqual({ approved: true })
    expect(seen).toEqual([0])
  })

  test('an aborted signal resolves with a denial and removes the entry', async () => {
    const broker = createBroker()
    const ctl = new AbortController()
    const a = broker.ask(request('a'), ctl.signal)
    const b = broker.ask(request('b'))
    ctl.abort()
    expect(await a).toEqual({ approved: false, feedback: 'Interrupted.' })
    expect(ids(broker.pending())).toEqual(['b'])
    broker.answer('b', { approved: true })
    await b
  })

  test('an already aborted signal never queues', async () => {
    const broker = createBroker()
    const ctl = new AbortController()
    ctl.abort()
    const seen: number[] = []
    broker.subscribe((list) => seen.push(list.length))
    expect(await broker.ask(request('a'), ctl.signal)).toEqual({
      approved: false,
      feedback: 'Interrupted.',
    })
    expect(broker.pending()).toEqual([])
    expect(seen).toEqual([])
  })

  test('abort after the answer is a no-op; the answer stays', async () => {
    const broker = createBroker()
    const ctl = new AbortController()
    const p = broker.ask(request('a'), ctl.signal)
    broker.answer('a', { approved: true })
    ctl.abort()
    expect(await p).toEqual({ approved: true })
  })

  test('listeners get a snapshot on every change and can unsubscribe', async () => {
    const broker = createBroker()
    const snapshots: string[][] = []
    const off = broker.subscribe((list) => snapshots.push(ids(list)))
    const a = broker.ask(request('a'))
    const b = broker.ask(request('b'))
    broker.answer('a', { approved: true })
    off()
    broker.answer('b', { approved: true })
    await Promise.all([a, b])
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']])
  })

  test('abort notifies listeners', async () => {
    const broker = createBroker()
    const snapshots: string[][] = []
    broker.subscribe((list) => snapshots.push(ids(list)))
    const ctl = new AbortController()
    const p = broker.ask(request('a'), ctl.signal)
    ctl.abort()
    await p
    expect(snapshots).toEqual([['a'], []])
  })

  test('pending returns a copy', () => {
    const broker = createBroker()
    void broker.ask(request('a'))
    broker.pending().pop()
    expect(ids(broker.pending())).toEqual(['a'])
  })

  test('a listener may unsubscribe while being notified', () => {
    const broker = createBroker()
    let calls = 0
    const off = broker.subscribe(() => {
      calls++
      off()
    })
    void broker.ask(request('a'))
    void broker.ask(request('b'))
    expect(calls).toBe(1)
  })

  test('answers can be of both shapes', async () => {
    const broker = createBroker()
    const answers: ApprovalAnswer[] = [{ approved: true, remember: 'project' }, { approved: false }]
    for (const [i, answer] of answers.entries()) {
      const p = broker.ask(request(`r${i}`))
      broker.answer(`r${i}`, answer)
      expect(await p).toEqual(answer)
    }
  })
})

describe('createDenyingBroker', () => {
  test('denies everything with the default or a custom reason', async () => {
    const broker = createDenyingBroker()
    expect(await broker.ask(request('a'))).toEqual({
      approved: false,
      feedback: 'Approval is not available in non-interactive mode.',
    })
    expect(await createDenyingBroker('nope').ask(request('a'))).toEqual({
      approved: false,
      feedback: 'nope',
    })
  })

  test('nothing is ever pending, answer and subscribe are inert', async () => {
    const broker = createDenyingBroker()
    void broker.ask(request('a'))
    expect(broker.pending()).toEqual([])
    broker.answer('a', { approved: true })
    broker.subscribe(() => {})()
  })
})
