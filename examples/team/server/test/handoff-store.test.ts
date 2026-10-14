/** The decisions table as an `eharness/handoff` store passes the library's conformance suite. */
import { describe, expect, test } from 'bun:test'
import { handoffStoreConformance } from 'eharness/testing'
import { openDatabase } from '../src/infra/db/client.ts'
import { drizzleDecisionStore } from '../src/infra/db/decisions-repo.ts'
import { decisionHandoffStore } from '../src/infra/eh/decisions-handoff-store.ts'

describe('decisions handoff store', () => {
  for (const c of handoffStoreConformance(() => {
    const conn = openDatabase(':memory:')
    return decisionHandoffStore(drizzleDecisionStore(conn.db))
  })) {
    test(c.name, c.run)
  }

  test('a team escalation is a handoff request and a rejection is an answer', async () => {
    const conn = openDatabase(':memory:')
    const decisions = drizzleDecisionStore(conn.db)
    const store = decisionHandoffStore(decisions)
    decisions.insert({
      id: 'd1',
      kind: 'escalation',
      title: 'Pay?',
      body: '**Pay?**',
      agentId: 'a1',
      sessionId: 's1',
      programId: null,
      payload: { question: 'Pay?', options: ['now', 'later'], source: 'agent' },
      waitId: 'w_9',
      createdAt: 5,
    })
    const r = await store.get('d1')
    expect(r?.waitId).toBe('w_9')
    expect(r?.options?.map((o) => o.id)).toEqual(['now', 'later', 'rejected'])
    const done = await store.answer('d1', { optionId: 'rejected', text: 'no', by: 'client', at: 9 })
    expect(done.ok).toBe(true)
    expect(decisions.get('d1')?.status).toBe('rejected')
  })
})
