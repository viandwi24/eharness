/** Per-chat connector switches: the plugin and the routes (composer tools menu). */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from 'eharness/testing'
import { visibleTools } from '../src/infra/eh/chat-tools-plugin.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

describe('visibleTools', () => {
  const origins = {
    gh__issues: { connectionIds: ['c-gh'] },
    gh__prs: { connectionIds: ['c-gh'] },
    shared: { connectionIds: ['c-gh', 'c-other'] },
    web_search: { connectionIds: ['c-web'] },
  }
  const names = ['read_file', 'gh__issues', 'gh__prs', 'shared', 'web_search']
  test('nothing off: no narrowing', () => {
    expect(visibleTools(names, new Set(), origins)).toBeUndefined()
  })
  test('hides tools owned only by switched-off connections, keeps order and unknown tools', () => {
    expect(visibleTools(names, new Set(['c-gh']), origins)).toEqual([
      'read_file',
      'shared',
      'web_search',
    ])
    expect(visibleTools(names, new Set(['c-gh', 'c-other']), origins)).toEqual([
      'read_file',
      'web_search',
    ])
  })
  test('an id that owns no tool changes nothing', () => {
    expect(visibleTools(names, new Set(['c-nope']), origins)).toBeUndefined()
  })
})

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function app(model = scriptedModel([])) {
  const dir = mkdtempSync(join(tmpdir(), 'team-chat-tools-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    models: scriptedModelConfig(model as never),
  })
  servers.push(server)
  return server.app
}
const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
interface State {
  connectors: Array<{ connectionId: string; connectorId: string; on: boolean; source: string }>
  offCount: number
}

describe('GET/PUT /agents/{id}/chat/tools', () => {
  test('lists switchable connectors, all on; PUT switches one off for this chat only', async () => {
    const a = app()
    const first = (await (await a.request('/agents/researcher/chat/tools')).json()) as State
    expect(first.offCount).toBe(0)
    // built-ins other than web search are not switchable
    expect(first.connectors.every((c) => c.source !== 'builtin' || c.connectorId === 'web')).toBe(
      true,
    )
    expect(first.connectors.every((c) => c.on)).toBe(true)
    const target = first.connectors[0]
    if (target === undefined) throw new Error('the seeded researcher has no switchable connector')

    const res = await a.request(
      '/agents/researcher/chat/tools',
      put({ off: [target.connectionId] }),
    )
    expect(res.status).toBe(200)
    const next = (await res.json()) as State
    expect(next.offCount).toBe(1)
    expect(next.connectors.find((c) => c.connectionId === target.connectionId)?.on).toBe(false)

    // another agent's chat is untouched
    const other = (await (await a.request('/agents/lead/chat/tools')).json()) as State
    expect(other.offCount).toBe(0)

    const back = await a.request('/agents/researcher/chat/tools', put({ off: [] }))
    expect(((await back.json()) as State).offCount).toBe(0)
  })

  test('an unknown connection is a 400, an unknown agent a 404', async () => {
    const a = app()
    const bad = await a.request('/agents/researcher/chat/tools', put({ off: ['nope'] }))
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      'UNKNOWN_CONNECTION',
    )
    expect((await a.request('/agents/ghost/chat/tools')).status).toBe(404)
  })
})

describe('a switched-off connector is not offered to the model', () => {
  test('its tools leave the request of the next turn; the others stay', async () => {
    const model = scriptedModel([{ text: 'one' }, { text: 'two' }])
    const a = app(model)
    const send = async (text: string) => {
      const res = await a.request('/agents/researcher/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text }] }],
        }),
      })
      expect(res.status).toBe(200)
      await res.text()
    }
    const names = (i: number): string[] =>
      ((model.calls[i]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)

    await send('first')
    const state = (await (await a.request('/agents/researcher/chat/tools')).json()) as State
    const web = state.connectors.find((c) => c.connectorId === 'web')
    if (web === undefined) throw new Error('web search is not switchable')
    expect(names(0)).toContain('web_fetch')

    await a.request('/agents/researcher/chat/tools', put({ off: [web.connectionId] }))
    await send('second')
    expect(names(1)).not.toContain('web_fetch')
    expect(names(1).filter((n) => n !== 'web_fetch')).toEqual(
      names(0).filter((n) => n !== 'web_fetch'),
    )
  })
})
