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
    'defineToolSource',
    'isHarnessError',
    'isKindMessage',
    'isUuidV7',
    'uuidv7',
    'version',
  ],
  'eharness/filesystem': ['experimental_placeholder'],
  'eharness/filesystem/memory': ['experimental_placeholder'],
  'eharness/storage/memory': ['experimental_placeholder'],
  'eharness/mcp': ['experimental_placeholder'],
  'eharness/testing': ['idGeneratorConformance'],
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

await rm(shim)
console.log(
  `smoke: ok (${Object.keys(entries).length} entry points${noMcp ? ', without @ai-sdk/mcp' : ''})`,
)
