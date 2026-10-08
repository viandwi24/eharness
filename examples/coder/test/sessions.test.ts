import { describe, expect, test } from 'bun:test'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { UIMessage } from 'ai'
import { createStorage, latestSessionId, listSessions, newSessionId } from '../src/app/sessions.ts'
import { setup } from './helpers.ts'

const msg = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

async function touch(file: string, secondsAgo: number): Promise<void> {
  const t = new Date(Date.now() - secondsAgo * 1000)
  await utimes(file, t, t)
}

describe('sessions', () => {
  test('storage round trip (messages and state) under the project data dir', async () => {
    const { config } = await setup()
    const { messages, state } = createStorage(config)
    const id = newSessionId()
    await messages.save(id, [msg('m1', 'user', 'hello'), msg('m2', 'assistant', 'hi')])
    await messages.save(id, [msg('m2', 'assistant', 'hi there')]) // upsert by id
    const loaded = await messages.load({ sessionId: id })
    expect(loaded.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(JSON.stringify(loaded[1])).toContain('hi there')
    expect(await messages.lastId?.(id)).toBe('m2')
    expect(await state.get(id)).toBeNull()
    expect(
      await Bun.file(join(config.projectDataDir, 'sessions', `${id}.messages.json`)).exists(),
    ).toBe(true)
  })

  test('newSessionId ids sort by creation time', async () => {
    const a = newSessionId()
    await new Promise((r) => setTimeout(r, 3))
    expect(newSessionId() > a).toBe(true)
  })

  test('listSessions is empty without sessions', async () => {
    const { config } = await setup()
    expect(await listSessions(config)).toEqual([])
    expect(await latestSessionId(config)).toBeUndefined()
  })

  test('listSessions: newest first, first prompt, skips :agent: children and broken files', async () => {
    const { config } = await setup()
    const { messages } = createStorage(config)
    const dir = join(config.projectDataDir, 'sessions')
    await messages.save('old', [
      msg('a1', 'user', '  first   prompt\n here '),
      msg('a2', 'assistant', 'x'),
    ])
    await messages.save('new', [
      msg('b0', 'assistant', 'greeting'),
      msg('b1', 'user', 'x'.repeat(200)),
    ])
    await messages.save('mid', [msg('c1', 'user', 'middle')])
    await messages.save('old:agent:call-1', [msg('d1', 'user', 'child prompt')])
    await Bun.write(join(dir, 'broken.messages.json'), '{ not json')
    await touch(join(dir, 'old.messages.json'), 300)
    await touch(join(dir, 'mid.messages.json'), 200)
    await touch(join(dir, 'new.messages.json'), 100)
    await touch(join(dir, 'old%3Aagent%3Acall-1.messages.json'), 1)

    const list = await listSessions(config)
    expect(list.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
    expect(list[2]?.firstPrompt).toBe('first prompt here')
    expect(list[1]?.firstPrompt).toBe('middle')
    expect(list[0]?.firstPrompt).toHaveLength(80)
    expect(list[0]?.firstPrompt.endsWith('…')).toBe(true)
    expect(list[0]?.updatedAt).toBeGreaterThan(list[1]?.updatedAt ?? 0)
    expect(await latestSessionId(config)).toBe('new')
  })
})
