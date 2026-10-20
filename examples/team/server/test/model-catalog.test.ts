/** The model catalog in chats: real costs / windows from `GET /stats` (loader tests: providers.test.ts). */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'team-catalog-'))
  dirs.push(d)
  return d
}

describe('catalog in chats', () => {
  test('stats carry the model entry and the ledger gets a real cost', async () => {
    const dir = tmp()
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(
        scriptedModel([{ text: 'hi', usage: { inputTokens: 1000, outputTokens: 1000 } }]) as never,
      ),
      catalog: { scripted: { contextWindow: 123_456, pricing: { input: 1000, output: 2000 } } },
    })
    servers.push(server)
    const res = await server.app.request('/sessions/dm:researcher/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'dm:researcher',
        messages: [{ id: 'c', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      }),
    })
    await res.text()
    const stats = (await (await server.app.request('/agents/researcher/stats')).json()) as {
      model: { id: string; contextWindow?: number; pricing?: { input: number } }
      context: { window: number }
      usage: { costUsd: number }
    }
    expect(stats.model.id).toBe('scripted')
    expect(stats.model.contextWindow).toBe(123_456)
    expect(stats.model.pricing?.input).toBe(1000)
    expect(stats.context.window).toBe(123_456)
    expect(stats.usage.costUsd).toBeCloseTo(3, 5)
  })
})

describe('working window', () => {
  test('a 1M model limited to 128k on the agent summarizes at 80 % of the limit, not after an output reserve', async () => {
    const dir = tmp()
    const server = compose({
      dbFile: join(dir, 'team.db'),
      models: scriptedModelConfig(
        scriptedModel([{ text: 'hi', usage: { inputTokens: 1000, outputTokens: 1000 } }]) as never,
      ),
      catalog: {
        scripted: {
          contextWindow: 1_048_576,
          maxOutputTokens: 384_000,
          pricing: { input: 1, output: 2 },
        },
      },
    })
    servers.push(server)
    // the owner limits this agent to 128k of the model's 1M
    const patched = await server.app.request('/agents/researcher', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contextWindow: 128_000 }),
    })
    expect(patched.status).toBe(200)
    await (
      await server.app.request('/sessions/dm:researcher/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'dm:researcher',
          messages: [{ id: 'c', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        }),
      })
    ).text()
    const stats = (await (await server.app.request('/agents/researcher/stats')).json()) as {
      context: { window: number; summarizeAt: number; hardLimit: number }
    }
    expect(stats.context.window).toBe(128_000)
    // before: 128k × 0.9 − 32k output reserve = 82k hard limit, summary at ~78k
    expect(stats.context.hardLimit).toBe(115_200)
    expect(stats.context.summarizeAt).toBe(102_400)
  })
})
