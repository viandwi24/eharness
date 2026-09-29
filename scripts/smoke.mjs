// Node smoke test for the packed tarball (CI job `node-compat`, docs/engineering/release.md §6).
// Run from a clean project that has `eharness` installed: `node smoke.mjs [--no-mcp]`.
// Grows with each phase: add the exports every entry point must provide.
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const noMcp = process.argv.includes('--no-mcp')

// Bare specifiers resolve relative to the importing file. This script lives in the repo, where
// `eharness` would self-resolve to the workspace, so import through a shim in the current
// directory to exercise the installed tarball.
const shim = join(process.cwd(), '.eharness-smoke-import.mjs')
await writeFile(shim, 'export default (specifier) => import(specifier)\n')
/** @type {(specifier: string) => Promise<Record<string, unknown>>} */
const load = (await import(pathToFileURL(shim).href)).default

/** Expected runtime exports per entry point. */
const entries = {
  eharness: [
    'DENIED_NEW_INPUT',
    'HarnessError',
    'HarnessToolError',
    'INTERRUPTED_CRASH',
    'INTERRUPTED_TURN',
    'INTERRUPTED_UNKNOWN',
    'NOT_EXECUTED_NEW_INPUT',
    'TOOL_OUTPUT_TRUNCATED',
    'createKindMessage',
    'defineDataPart',
    'defineHarnessAgent',
    'defineMessageKind',
    'definePlugin',
    'defineSkill',
    'defineSkillSource',
    'defineToolSource',
    'isHarnessError',
    'isKindMessage',
    'isUuidV7',
    'parseSkillMarkdown',
    'uuidv7',
    'validateSkillPath',
    'version',
  ],
  'eharness/filesystem': ['experimental_placeholder'],
  'eharness/filesystem/memory': ['experimental_placeholder'],
  'eharness/storage/memory': ['memoryMessages', 'memoryState'],
  'eharness/mcp': ['experimental_placeholder'],
  'eharness/testing': [
    'idGeneratorConformance',
    'messageAdapterConformance',
    'scriptedModel',
    'stateAdapterConformance',
  ],
}

if (noMcp) {
  await assert.rejects(load('@ai-sdk/mcp'), 'expected @ai-sdk/mcp to be absent with --no-mcp')
}

for (const [specifier, names] of Object.entries(entries)) {
  const mod = await load(specifier)
  for (const name of names) {
    assert.ok(name in mod, `${specifier} is missing export '${name}'`)
  }
}

const core = await load('eharness')
const error = new core.HarnessError('EH_CONFIG_INVALID', 'smoke')
assert.ok(error instanceof Error)
assert.equal(error.code, 'EH_CONFIG_INVALID')

// boot: a plugin with a namespaced data part, and a boot error with its code
const plugin = core.definePlugin({ name: 'smoke', provides: ['x'] })
const agent = core.defineHarnessAgent({ model: 'openai/gpt-5', plugins: [plugin] })
assert.equal(agent.id, 'agent')
assert.throws(
  () => core.defineHarnessAgent({ model: 'openai/gpt-5', plugins: [plugin, plugin] }),
  (e) => core.isHarnessError(e, 'EH_CONFIG_INVALID'),
)
const a = core.uuidv7()
assert.ok(core.isUuidV7(a) && core.uuidv7() > a)

// one scripted two-step turn (tool call → answer) against memoryMessages() under Node
const { memoryMessages, memoryState } = await load('eharness/storage/memory')
const { scriptedModel, messageAdapterConformance } = await load('eharness/testing')
const { tool } = await load('ai')
const { z } = await load('zod/v4')
for (const c of messageAdapterConformance(() => memoryMessages())) await c.run()
const messages = memoryMessages()
const model = scriptedModel([
  { toolCalls: [{ toolName: 'weather', input: { city: 'Oslo' } }] },
  { text: 'It is 20 degrees.' },
])
const turnAgent = core.defineHarnessAgent({
  model,
  contextWindow: 100_000,
  storage: { messages, state: memoryState() },
  tools: {
    weather: tool({
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, temp: 20 }),
    }),
  },
})
const run = turnAgent.session('smoke').send('Weather in Oslo?')
const chunkTypes = []
for await (const chunk of run.stream) chunkTypes.push(chunk.type)
const result = await run.result
assert.equal(result.stop, 'complete')
assert.equal(result.steps, 2)
assert.equal(chunkTypes.at(0), 'start')
assert.equal(chunkTypes.at(-1), 'finish')
const stored = await messages.load({ sessionId: 'smoke' })
assert.deepEqual(
  stored.map((m) => m.role),
  ['user', 'assistant'],
)
assert.equal(stored[1].metadata.eharness.stop, 'complete')
await turnAgent.close()

await rm(shim)
console.log(
  `smoke: ok (${Object.keys(entries).length} entry points, one scripted turn${noMcp ? ', without @ai-sdk/mcp' : ''})`,
)
