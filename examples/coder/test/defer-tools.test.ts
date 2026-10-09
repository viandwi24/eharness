import { describe, expect, test } from 'bun:test'
import type { HarnessSession } from 'eharness'
import { DEFERRED_BUILTIN_TOOLS } from '../src/app/agent.ts'
import type { CoderMessage } from '../src/contracts.ts'
import { makeAgentsEnv, routerModel } from './helpers.ts'

const open = async (
  files: Record<string, string> = {},
  model = routerModel(() => ({ text: 'ok' })),
) => {
  const env = await makeAgentsEnv({ files, model })
  const session = env.agents.main.session('main-1') as never as HarnessSession<CoderMessage>
  return { env, session, model }
}

describe('deferred tools in the coder', () => {
  test('rarely used built-ins are deferred, the core tools stay loaded', async () => {
    const { session } = await open()
    const listed = await session.tools()
    const deferred = listed.filter((t) => t.deferred).map((t) => t.name)
    expect(deferred.sort()).toEqual(
      DEFERRED_BUILTIN_TOOLS.filter((n) => listed.some((t) => t.name === n)).sort(),
    )
    for (const name of ['web_fetch', 'web_search', 'request_directory_access']) {
      expect(deferred).toContain(name)
    }
    const loaded = listed.filter((t) => !t.deferred).map((t) => t.name)
    for (const name of [
      'read_file',
      'list_files',
      'grep',
      'glob',
      'edit_file',
      'write_file',
      'delete_file',
      'bash',
      'agent',
      'send_message',
      'todo_write',
      'ask_user_question',
      'tool_search',
    ]) {
      expect(loaded).toContain(name)
    }
  })

  test('deferTools: false in settings sends everything and adds no tool_search', async () => {
    const { session } = await open({
      '.coder/settings.json': JSON.stringify({ deferTools: false }),
    })
    const listed = await session.tools()
    expect(listed.some((t) => t.deferred)).toBe(false)
    expect(listed.map((t) => t.name)).not.toContain('tool_search')
  })

  test('a turn lists deferred names in the reminder, tool_search loads one, the next step can call it', async () => {
    const model = routerModel((r) =>
      r.toolResults === 0
        ? { toolCalls: [{ toolName: 'tool_search', input: { query: 'select:web_fetch' } }] }
        : { text: 'loaded' },
    )
    const { session } = await open({}, model)
    const result = await session.send('read the docs').result
    expect(result.stop).toBe('complete')
    const [first, second] = model.routes
    expect(first?.tools).not.toContain('web_fetch')
    expect(first?.tools).toContain('tool_search')
    expect(first?.conversation).toContain('Deferred tools')
    expect(first?.conversation).toContain('- web_fetch:')
    expect(second?.tools).toContain('web_fetch')
  })
})
