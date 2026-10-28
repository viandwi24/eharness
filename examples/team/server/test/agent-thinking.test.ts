/**
 * The thinking setting of an agent: stored, exported, and sent to the model as the AI SDK
 * `reasoning` option, mapped onto the levels the model's catalog entry lists.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { thinkingFor } from '../src/domain/agents.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('thinkingFor', () => {
  const flash = { levels: ['max', 'high', 'low', 'none'] as const, defaultLevel: 'high' as const }
  test('default sends nothing; a listed level goes as is', () => {
    expect(thinkingFor('default', { levels: [...flash.levels] })).toBeUndefined()
    expect(thinkingFor('low', { levels: [...flash.levels] })).toBe('low')
    expect(thinkingFor('none', { levels: [...flash.levels] })).toBe('none')
  })
  test('a level the model lacks becomes the nearest one (stronger on a tie)', () => {
    expect(thinkingFor('medium', { levels: [...flash.levels] })).toBe('high')
    expect(thinkingFor('xhigh', { levels: [...flash.levels] })).toBe('max')
    expect(thinkingFor('minimal', { levels: [...flash.levels] })).toBe('low')
  })
  test('off for a model that always thinks sends nothing; unknown levels pass through', () => {
    expect(thinkingFor('none', { levels: ['high', 'low'], mandatory: true })).toBeUndefined()
    expect(thinkingFor('none', { mandatory: true })).toBeUndefined()
    expect(thinkingFor('high', {})).toBe('high')
    expect(thinkingFor('high', undefined)).toBe('high')
  })
})

describe('agent thinking end to end', () => {
  test('stored and patched by the API, sent to the model mapped onto its levels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-thinking-'))
    dirs.push(dir)
    const model = scriptedModel([{ text: 'one' }, { text: 'two' }])
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(model as never),
      catalog: { scripted: { thinking: { levels: ['max', 'high', 'low', 'none'] } } },
    })
    servers.push(server)
    const chat = async (text: string, id: string) => {
      const res = await server.app.request('/sessions/dm:researcher/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'dm:researcher',
          messages: [{ id, role: 'user', parts: [{ type: 'text', text }] }],
        }),
      })
      await res.text()
    }
    const agent = (await (await server.app.request('/agents/researcher')).json()) as {
      thinking: string
    }
    expect(agent.thinking).toBe('default')
    await chat('hi', 'c1')
    expect(model.calls[0]?.reasoning).toBeUndefined()

    const patched = await server.app.request('/agents/researcher', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: 'medium' }),
    })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { thinking: string }).thinking).toBe('medium')
    await chat('again', 'c2')
    // medium is not offered: the nearest level, the stronger on a tie
    expect(model.calls.at(-1)?.reasoning).toBe('high')

    const bad = await server.app.request('/agents/researcher', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thinking: 'turbo' }),
    })
    expect(bad.status).toBe(400)
  })
})
