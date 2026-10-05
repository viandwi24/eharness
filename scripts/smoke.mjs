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
    'FINAL_ANSWER_DESCRIPTION',
    'FINAL_ANSWER_RECORDED',
    'FLUSH_APPROVAL_DENIED',
    'HarnessError',
    'HarnessToolError',
    'INTERRUPTED_CRASH',
    'INTERRUPTED_TURN',
    'INTERRUPTED_UNKNOWN',
    'MAX_STEPS_WRAP_UP',
    'NOT_EXECUTED_NEW_INPUT',
    'OUTPUT_INSTRUCTION',
    'OUTPUT_RETRY',
    'PROGRESS_NUDGE',
    'TOOL_OUTPUT_TRUNCATED',
    'computeCost',
    'createKindMessage',
    'defineDataPart',
    'defineHarnessAgent',
    'defineMessageKind',
    'definePlugin',
    'defineSkill',
    'defineSkillSource',
    'defineToolSource',
    'handleChatRequest',
    'isHarnessError',
    'isKindMessage',
    'isUuidV7',
    'lookupModel',
    'modelsDevCatalog',
    'parseSkillMarkdown',
    'uuidv7',
    'validateSkillPath',
    'version',
  ],
  'eharness/filesystem': [
    'DEFAULT_MAX_READ_CHARS',
    'DEFAULT_TOOL_OUTPUTS_DIR',
    'classifyToolResult',
    'contentVersion',
    'filesystem',
    'fsSkillSource',
    'normalizePath',
  ],
  'eharness/filesystem/memory': ['memoryFs'],
  'eharness/storage/memory': ['memoryMessages', 'memoryState'],
  'eharness/mcp': ['MCP_AUTO_DEFER_THRESHOLD', 'clearMcpPins', 'mcpServer'],
  'eharness/todos': [
    'TODOS_CONTINUE',
    'TODOS_INSTRUCTION',
    'TODOS_REMINDER',
    'TODO_TOOL',
    'latestTodos',
    'openTodos',
    'renderTodos',
    'todos',
  ],
  'eharness/memory': [
    'DEFAULT_MAX_FILE_CHARS',
    'DEFAULT_MAX_PINNED_CHARS',
    'MEMORY_FLUSH_PROMPT',
    'MEMORY_FLUSH_TOOLS',
    'MEMORY_PROTOCOL',
    'MEMORY_TOOLS',
    'PINNED_PREAMBLE',
    'executeMemoryCommand',
    'memory',
  ],
  'eharness/testing': [
    'SKILL_SOURCE_FIXTURE',
    'fileSystemConformance',
    'idGeneratorConformance',
    'messageAdapterConformance',
    'scriptedModel',
    'skillSourceConformance',
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

// filesystem plugin under Node: conformance of memoryFs, then read → edit in one scripted turn
const { filesystem, classifyToolResult } = await load('eharness/filesystem')
const { memoryFs } = await load('eharness/filesystem/memory')
const { fileSystemConformance } = await load('eharness/testing')
for (const c of fileSystemConformance(() => memoryFs())) await c.run()
const fs = memoryFs({ '/notes.md': 'hello world\n' })
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
const memFs = memoryFs({ '/memories/org/policy.md': 'Be kind.\n' })
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
const { mcpServer } = await load('eharness/mcp')
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
  mcp: [mcpServer({ name: 'smoke', transport: () => fakeTransport() })],
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
    mcp: [mcpServer({ name: 'smoke', connect: 'eager', transport: () => fakeTransport() })],
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

await rm(shim)
console.log(
  `smoke: ok (${Object.keys(entries).length} entry points, five scripted turns${noMcp ? ', without @ai-sdk/mcp' : ''})`,
)
