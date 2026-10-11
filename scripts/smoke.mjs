// Node smoke test for the packed tarball (CI job `node-compat`, docs/engineering/release.md §6).
// Run from a clean project that has `eharness` installed: `node smoke.mjs [--no-mcp]`.
// The expected exports come from scripts/exports.snapshot.json, never from a list in this file.
import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
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

/**
 * Expected runtime exports per entry point: the committed export snapshot
 * (`scripts/exports.snapshot.json`, derived from `package.json#exports`; update it with
 * `bun scripts/exports-snapshot.ts --write`). The packed tarball must provide exactly these.
 */
const entries = JSON.parse(
  await readFile(new URL('./exports.snapshot.json', import.meta.url), 'utf8'),
)

if (noMcp) {
  await assert.rejects(load('@ai-sdk/mcp'), 'expected @ai-sdk/mcp to be absent with --no-mcp')
}

for (const [specifier, names] of Object.entries(entries)) {
  const mod = await load(specifier)
  assert.deepEqual(
    Object.keys(mod).sort(),
    names,
    `${specifier}: exports differ from scripts/exports.snapshot.json`,
  )
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

// one scripted two-step turn (tool call → answer) against inMemoryMessages() under Node
const { inMemoryMessages, inMemoryState } = await load('eharness/storage/memory')
const { scriptedModel, messageAdapterConformance } = await load('eharness/testing')
const { tool } = await load('ai')
const { z } = await load('zod/v4')
for (const c of messageAdapterConformance(() => inMemoryMessages())) await c.run()
const messages = inMemoryMessages()
const model = scriptedModel([
  { toolCalls: [{ toolName: 'weather', input: { city: 'Oslo' } }] },
  { text: 'It is 20 degrees.' },
])
const turnAgent = core.defineHarnessAgent({
  model,
  contextWindow: 100_000,
  storage: { messages, state: inMemoryState() },
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

// filesystem plugin under Node: conformance of inMemoryFs, then read → edit in one scripted turn
const { filesystem, classifyToolResult } = await load('eharness/filesystem')
const { inMemoryFs } = await load('eharness/filesystem/memory')
const { fileSystemConformance } = await load('eharness/testing')
for (const c of fileSystemConformance(() => inMemoryFs())) await c.run()
const fs = inMemoryFs({ seed: { '/notes.md': 'hello world\n' } })
const fsAgent = core.defineHarnessAgent({
  model: scriptedModel([
    { toolCalls: [{ toolName: 'read_file', input: { path: '/notes.md' } }] },
    {
      toolCalls: [
        {
          toolName: 'edit_file',
          input: { path: '/notes.md', old_string: 'world', new_string: 'node' },
        },
      ],
    },
    { text: 'Edited.' },
  ]),
  contextWindow: 100_000,
  plugins: [filesystem({ fs })],
})
const fsResult = await fsAgent.session('smoke-fs').send('Edit the notes').result
assert.equal(fsResult.stop, 'complete')
assert.equal((await fs.read('/notes.md')).content, 'hello node\n')
assert.equal(classifyToolResult('STALE: x'), 'stale')
await fsAgent.close()

// eharness/memory under Node: one scripted turn creates a memory file inside the user's root
const { memory, executeMemoryCommand } = await load('eharness/memory')
const memFs = inMemoryFs({ seed: { '/memories/org/policy.md': 'Be kind.\n' } })
const memAgent = core.defineHarnessAgent({
  model: scriptedModel([
    {
      toolCalls: [
        {
          toolName: 'memory_create',
          input: { path: '/memories/u1/notes.md', file_text: 'likes tea\n' },
        },
      ],
    },
    { text: 'Noted.' },
  ]),
  contextWindow: 100_000,
  plugins: [
    filesystem({ fs: memFs, hiddenPrefixes: ['/memories'] }),
    memory({
      roots: (ctx) => [
        { path: `/memories/${ctx.runtime.userId}`, write: true },
        { path: '/memories/org' },
      ],
    }),
  ],
})
const memResult = await memAgent
  .session('smoke-memory', { runtime: { userId: 'u1' } })
  .send('Remember').result
assert.equal(memResult.stop, 'complete')
assert.equal((await memFs.read('/memories/u1/notes.md')).content, 'likes tea\n')
assert.equal(
  await executeMemoryCommand(
    { command: 'delete', path: '/memories/org/policy.md' },
    { fs: memFs, roots: [{ path: '/memories/org' }] },
  ),
  'REJECTED: /memories/org/policy.md is read-only.',
)
await memAgent.close()

// eharness/mcp: an in-process MCP server behind a custom transport (no network)
const { mcpServerSource } = await load('eharness/mcp')
/** A minimal MCP server speaking JSON-RPC over an in-memory `MCPTransport`. */
const fakeTransport = () => {
  const transport = {
    open: false,
    async start() {
      transport.open = true
    },
    async close() {
      transport.open = false
      transport.onclose?.()
    },
    async send(message) {
      if (!('id' in message) || !('method' in message)) return
      const results = {
        initialize: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'smoke', version: '1.0.0' },
        },
        'tools/list': {
          tools: [
            { name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} } },
          ],
        },
        'tools/call': { content: [{ type: 'text', text: 'pong' }], isError: false },
      }
      queueMicrotask(() =>
        transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: results[message.method] }),
      )
    },
  }
  return transport
}
const mcpWarnings = []
const mcpModel = scriptedModel([
  { toolCalls: [{ toolName: 'smoke_ping', input: {} }] },
  { text: 'pong received' },
])
const mcpAgent = core.defineHarnessAgent({
  model: mcpModel,
  contextWindow: 100_000,
  onWarning: (w) => mcpWarnings.push(w),
  // without @ai-sdk/mcp the scripted call hits an unavailable tool (logged as an error)
  ...(noMcp ? { logger: { debug() {}, info() {}, warn() {}, error() {} } } : {}),
  mcp: [mcpServerSource({ name: 'smoke', transport: () => fakeTransport() })],
})
const mcpResult = await mcpAgent.session('smoke-mcp').send('Ping').result
assert.equal(mcpResult.stop, 'complete')
if (noMcp) {
  // lazy connect without @ai-sdk/mcp: W_TOOL_SOURCE_FAILED, the turn still completes
  const failed = mcpWarnings.find((w) => w.code === 'W_TOOL_SOURCE_FAILED')
  assert.ok(failed?.message.includes('install @ai-sdk/mcp'), 'expected W_TOOL_SOURCE_FAILED')
  // eager connect without @ai-sdk/mcp: the session open fails with EH_CONFIG_INVALID
  const eagerAgent = core.defineHarnessAgent({
    model: scriptedModel([]),
    contextWindow: 100_000,
    onWarning: () => {},
    mcp: [mcpServerSource({ name: 'smoke', connect: 'eager', transport: () => fakeTransport() })],
  })
  await assert.rejects(eagerAgent.session('eager').ready(), (e) =>
    core.isHarnessError(e, 'EH_CONFIG_INVALID'),
  )
  await eagerAgent.close()
} else {
  const part = mcpResult.messages
    .find((m) => m.id === mcpResult.messageId)
    .parts.find((p) => p.type === 'dynamic-tool')
  assert.equal(part?.output?.content?.[0]?.text, 'pong')
  assert.equal(mcpWarnings.length, 0)
}
await mcpAgent.close()

// approval → handleChatRequest (useChat body) → continuation of the same message, under Node
const paid = []
const approvalModel = scriptedModel([
  { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
  { text: 'Paid.' },
])
const approvalAgent = core.defineHarnessAgent({
  model: approvalModel,
  contextWindow: 100_000,
  approval: { policy: { pay: 'user-approval' } },
  tools: {
    pay: tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        paid.push(amount)
        return 'ok'
      },
    }),
  },
})
const approvalSession = approvalAgent.session('approval')
const pendingTurn = await approvalSession.send('pay 5').result
assert.equal(pendingTurn.stop, 'tool-pending')
const [pendingMessage] = (await approvalSession.messages()).slice(-1)
const answered = {
  ...pendingMessage,
  parts: pendingMessage.parts.map((p) =>
    p.type === 'tool-pay'
      ? { ...p, state: 'approval-responded', approval: { ...p.approval, approved: true } }
      : p,
  ),
}
const continued = await core.handleChatRequest(approvalSession, { messages: [answered] }).result
assert.equal(continued.stop, 'complete')
assert.equal(continued.messageId, pendingTurn.messageId)
assert.deepEqual(paid, [5])
await approvalAgent.close()

// eharness/guard under Node: the judge denies a call, the model reads the reason
const { guard } = await load('eharness/guard')
const sent = []
const guardAgent = core.defineHarnessAgent({
  model: scriptedModel([
    { toolCalls: [{ toolName: 'send', input: { to: 'evil@example.com' } }] },
    { text: 'Not sent.' },
  ]),
  contextWindow: 100_000,
  approval: { risk: { external: 'approved' } },
  plugins: [
    guard({
      model: scriptedModel([
        { text: JSON.stringify({ decision: 'deny', reason: 'unknown recipient.' }) },
      ]),
    }),
  ],
  tools: {
    send: tool({
      inputSchema: z.object({ to: z.string() }),
      metadata: { risk: 'external' },
      execute: async ({ to }) => {
        sent.push(to)
        return 'sent'
      },
    }),
  },
})
const guardResult = await guardAgent.session('smoke-guard').send('Send the report').result
assert.equal(guardResult.stop, 'complete')
assert.deepEqual(sent, [])
await guardAgent.close()

await rm(shim)
console.log(
  `smoke: ok (${Object.keys(entries).length} entry points, six scripted turns${noMcp ? ', without @ai-sdk/mcp' : ''})`,
)
