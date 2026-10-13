import { describe, expect, test } from 'bun:test'
import { ASK_TOOL } from '../ask/index.ts'
import { INSTALL_PACKAGES_TOOL, RUN_PYTHON_TOOL } from '../code/index.ts'
import { filesystem } from '../filesystem/index.ts'
import { inMemoryFs } from '../filesystem/memory.ts'
import { defineHarnessAgent } from '../index.ts'
import { MEMORY_TOOLS } from '../memory/index.ts'
import {
  AGENT_OUTPUT_TOOL,
  AGENT_STOP_TOOL,
  AGENT_TOOL,
  SEND_MESSAGE_TOOL,
} from '../subagent/index.ts'
import { scriptedModel } from '../testing/index.ts'
import { TODO_TOOL } from '../todos/index.ts'
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from '../web/index.ts'
import { BUILTIN_TOOLS, builtinConnectors } from './builtin.ts'

// `src/connectors` may not import the plugins in non-test files (ADR-0008), so BUILTIN_TOOLS
// copies their tool names. This test is the link: renaming a tool in a plugin fails here.
describe('BUILTIN_TOOLS match the shipped plugins', () => {
  test('constants of the plugins', () => {
    expect(BUILTIN_TOOLS.planning).toEqual([TODO_TOOL])
    expect(BUILTIN_TOOLS.webSearch).toEqual([WEB_SEARCH_TOOL])
    expect(BUILTIN_TOOLS.webRead).toEqual([WEB_FETCH_TOOL])
    expect(BUILTIN_TOOLS.ask).toEqual([ASK_TOOL])
    expect(BUILTIN_TOOLS.teamDelegate).toEqual([AGENT_TOOL, AGENT_OUTPUT_TOOL, AGENT_STOP_TOOL])
    expect(BUILTIN_TOOLS.teamMessage).toEqual([SEND_MESSAGE_TOOL])
    expect(BUILTIN_TOOLS.memoryRead).toEqual([MEMORY_TOOLS[0]])
    expect<string[]>([...BUILTIN_TOOLS.memoryWrite]).toEqual(MEMORY_TOOLS.slice(1))
  })

  test('code tool names', () => {
    expect(BUILTIN_TOOLS.filesRun).toEqual([RUN_PYTHON_TOOL])
    expect(BUILTIN_TOOLS.filesInstall).toEqual([INSTALL_PACKAGES_TOOL])
  })

  test('files code capabilities exist only when asked for: run allowed, install asks', () => {
    const files = (code?: boolean | { install?: boolean }) =>
      builtinConnectors({ files: { plugin: () => [], ...(code === undefined ? {} : { code }) } })[0]
        ?.capabilities ?? []
    expect(files().map((c) => c.id)).toEqual(['read', 'edit', 'delete'])
    expect(files(false).map((c) => c.id)).toEqual(['read', 'edit', 'delete'])
    const run = files(true)
    expect(run.map((c) => c.id)).toEqual(['read', 'edit', 'delete', 'run'])
    expect(run[3]).toMatchObject({ kind: 'write', tools: ['run_python'], defaultMode: 'allow' })
    const both = files({ install: true })
    expect(both[4]).toMatchObject({
      id: 'install',
      tools: ['install_packages'],
      defaultMode: 'ask',
    })
  })

  test('file tools registered by filesystem()', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'x' }]),
      contextWindow: 100_000,
      plugins: [filesystem({ fs: inMemoryFs() })],
    })
    const names = new Set((await agent.session('a').tools()).map((t) => t.name))
    for (const name of [
      ...BUILTIN_TOOLS.filesRead,
      ...BUILTIN_TOOLS.filesEdit,
      ...BUILTIN_TOOLS.filesDelete,
    ]) {
      expect(names.has(name)).toBe(true)
    }
    await agent.close()
  })
})
