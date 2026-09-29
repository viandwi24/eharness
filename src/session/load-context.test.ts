import { describe, expect, test } from 'bun:test'
import type { SessionStateSnapshot } from '../agent/session-types.ts'
import { uuidv7 } from '../messages/ids.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { spyMessages } from './int-kit.ts'
import { loadContext } from './load-context.ts'

const registry = createCoreMessageRegistry()
const user = (id: string): HarnessUIMessage => ({
  id,
  role: 'user',
  metadata: { eharness: { v: 1, createdAt: 1 } },
  parts: [{ type: 'text', text: id }],
})
const marker = (id: string, resumeFromId: string | null) =>
  createKindMessage(
    'eh.compaction',
    { summary: 's', resumeFromId, tokens: { before: 0, after: 0 }, trigger: 'auto' },
    { id },
  )

async function load(
  messages: ReturnType<typeof spyMessages>,
  core: SessionStateSnapshot['core'],
): Promise<{ view: string[]; dirty: number }> {
  let dirty = 0
  const loaded = await loadContext({
    adapter: messages,
    sessionId: 's1',
    registry,
    policy: 'drop',
    core,
    markDirty: () => dirty++,
  })
  return { view: loaded.view.map((m) => m.id), dirty }
}

describe('loadContext: compaction pointer path (spec 05 §5)', () => {
  const ids = Array.from({ length: 8 }, () => uuidv7())
  const [u1, u2, u3, m1, u4, m2, u5] = ids as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]

  async function history() {
    const messages = spyMessages()
    await messages.save('s1', [
      user(u1),
      user(u2),
      user(u3),
      marker(m1, u2),
      user(u4),
      marker(m2, u3),
      user(u5),
    ])
    messages.saves.length = 0
    return messages
  }

  test('one range query from resumeFromId', async () => {
    const messages = await history()
    const core = { compaction: { markerId: m2, resumeFromId: u3 } }
    const { view, dirty } = await load(messages, core)
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: u3 }])
    expect(view).toEqual([m2, u3, u4, u5])
    expect(dirty).toBe(0)
  })

  test('stale pointer: the range still holds the newer marker; the pointer is healed', async () => {
    const messages = await history()
    const core: SessionStateSnapshot['core'] = { compaction: { markerId: m1, resumeFromId: u2 } }
    const { view, dirty } = await load(messages, core)
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: u2 }])
    expect(view).toEqual([m2, u3, u4, u5])
    expect(core.compaction).toEqual({ markerId: m2, resumeFromId: u3 })
    expect(dirty).toBe(1)
  })

  test('resumeFromId null: the range starts at the marker', async () => {
    const messages = spyMessages()
    await messages.save('s1', [user(u1), marker(m1, null), user(u4)])
    const { view } = await load(messages, { compaction: { markerId: m1, resumeFromId: null } })
    expect(messages.loads).toEqual([{ sessionId: 's1', fromId: m1 }])
    expect(view).toEqual([m1, u4])
  })

  test('a pointer whose range holds no marker falls back to paging and is removed', async () => {
    const messages = spyMessages()
    await messages.save('s1', [user(u1), user(u2)])
    const core: SessionStateSnapshot['core'] = { compaction: { markerId: m1, resumeFromId: u2 } }
    const { view, dirty } = await load(messages, core)
    expect(messages.loads).toEqual([
      { sessionId: 's1', fromId: u2 },
      { sessionId: 's1', limit: 100 },
    ])
    expect(view).toEqual([u1, u2])
    expect(core.compaction).toBeUndefined()
    expect(dirty).toBe(1)
  })

  test('without a pointer: paging finds the boundary and sets the pointer', async () => {
    const messages = await history()
    const core: SessionStateSnapshot['core'] = {}
    const { view } = await load(messages, core)
    expect(messages.loads[0]).toEqual({ sessionId: 's1', limit: 100 })
    expect(view).toEqual([m2, u3, u4, u5])
    expect(core.compaction).toEqual({ markerId: m2, resumeFromId: u3 })
  })
})

describe('loadContext: rewind view rule and mirror healing (spec 11 §5)', () => {
  const rewind = (id: string, afterId: string | null) =>
    createKindMessage('eh.rewind', { afterId, reason: 'regenerate' }, { id })

  test('hidden messages leave the view; the mirror is rebuilt from the markers', async () => {
    const [u1, a1, r1, a2] = Array.from({ length: 4 }, () => uuidv7()) as [
      string,
      string,
      string,
      string,
    ]
    const messages = spyMessages()
    await messages.save('s1', [user(u1), user(a1), rewind(r1, u1), user(a2)])
    const core: SessionStateSnapshot['core'] = {}
    const { view, dirty } = await load(messages, core)
    expect(view).toEqual([u1, r1, a2])
    expect(core.rewinds).toEqual([{ afterId: u1, rewindId: r1 }])
    expect(dirty).toBe(1)
    // consistent mirror: nothing to heal
    expect((await load(messages, core)).dirty).toBe(0)
  })

  test('a mirror entry without its marker (lost save) is dropped; older entries are kept', async () => {
    const [old, u1, lost] = Array.from({ length: 3 }, () => uuidv7()) as [string, string, string]
    const [m1] = [uuidv7()]
    const [u2] = [uuidv7()]
    const messages = spyMessages()
    // only the range from the compaction pointer is loaded: `old` lies before it
    await messages.save('s1', [user(u1), marker(m1 as string, u1), user(u2 as string)])
    const core: SessionStateSnapshot['core'] = {
      compaction: { markerId: m1 as string, resumeFromId: u1 },
      rewinds: [
        { afterId: null, rewindId: old },
        { afterId: u1, rewindId: lost },
      ],
    }
    const { dirty } = await load(messages, core)
    expect(core.rewinds).toEqual([{ afterId: null, rewindId: old }])
    expect(dirty).toBe(1)
  })
})
