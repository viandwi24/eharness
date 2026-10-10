/** The factory over a real SQLite file: scripted model, library and memory writes, version cache. */
import { afterEach, describe, expect, test } from 'bun:test'
import { scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('agent factory', () => {
  test('caches per agent version; an edit builds a new agent', async () => {
    server = compose({
      dbFile: ':memory:',
      models: scriptedModelConfig(scriptedModel([]) as never),
    })
    const researcher = server.deps.agents.getBySlug('researcher')
    if (researcher === undefined) throw new Error('seed missing')
    await server.factory.prepare(researcher)
    const a = server.factory.agentFor(researcher)
    expect(server.factory.agentFor(researcher)).toBe(a)
    const edited = updateAgent(server.deps, researcher.id, { instructions: 'Be brief.' })
    expect(edited.version).toBe(2)
    expect(server.factory.agentFor(edited)).not.toBe(a)
  })

  test('a turn writes a library file and agent memory through the DB-backed filesystem', async () => {
    let agentId = ''
    const model = scriptedModel([
      () => ({
        toolCalls: [
          {
            toolName: 'write_file',
            input: { path: '/library/research/notes.md', content: '# Notes\n' },
          },
          {
            toolName: 'memory_create',
            input: {
              path: `/memories/agents/${agentId}/profile.md`,
              file_text: 'Likes short notes.',
            },
          },
        ],
      }),
      { text: 'Saved the notes.' },
    ])
    server = compose({ dbFile: ':memory:', models: scriptedModelConfig(model as never) })
    const def = server.deps.agents.getBySlug('researcher')
    if (def === undefined) throw new Error('seed missing')
    agentId = def.id

    await server.factory.prepare(def)
    const agent = server.factory.agentFor(def)
    const session = agent.session(`dm:${def.id}`, { lock: server.factory.lock })
    const result = await session.send('Research and save notes').result
    expect(result.stop).toBe('complete')

    const file = server.conn.sqlite
      .query<{ path: string; created_by_agent_id: string }, []>(
        'SELECT path, created_by_agent_id FROM library_files ORDER BY path',
      )
      .all()
    expect(file.map((f) => f.path)).toEqual([
      `/library/research/notes.md`,
      `/memories/agents/${def.id}/profile.md`,
    ])
    expect(file.every((f) => f.created_by_agent_id === def.id)).toBe(true)

    // the chat is in SQLite: a second agent object over the same database reads it back
    const messages = await session.messages()
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const lock = server.conn.sqlite.query('SELECT count(*) AS n FROM eh_locks').get() as {
      n: number
    }
    expect(lock.n).toBe(0)
  })

  test('the lead gets no library write; role tools follow the definition', async () => {
    server = compose({
      dbFile: ':memory:',
      models: scriptedModelConfig(scriptedModel([]) as never),
    })
    const lead = server.deps.agents.getBySlug('lead')
    const analyst = server.deps.agents.getBySlug('analyst')
    if (lead === undefined || analyst === undefined) throw new Error('seed missing')
    await server.factory.prepare()
    const toolsOf = (id: string): string[] =>
      Object.keys(server?.connectors.activated(id)?.toolNameMap ?? {})
    // the lead can read the library but not write it: the tool is switched off
    expect(server.connectors.activated(lead.id)?.rules.deny).toContain('write_file')
    expect(toolsOf(analyst.id)).not.toContain('web_fetch')
    // both build (plugin order, permissions, memory roots) without throwing
    server.factory.agentFor(lead)
    server.factory.agentFor(analyst)
  })
})
