/**
 * The `memory()` plugin: per-user memory files plus a read-only organisation root, a pinned
 * profile in every turn reminder, an `onWrite` audit log, and memory hidden from the generic file
 * tools.
 *
 *   bun examples/memory.ts
 */
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { executeMemoryCommand, memory } from 'eharness/memory'
import { exampleModel } from './shared/model.ts'

// One file system for the app; memory lives under /memories (seeded with a shared policy file).
const fs = memoryFs({
  '/memories/org/style.md': '- Answer in short paragraphs.\n- Never promise delivery dates.\n',
  '/workspace/README.md': '# Project\n',
})

const model = exampleModel([
  // turn 1 (user u1): look at memory, then record the user's preference
  { toolCalls: [{ toolName: 'memory_view', input: { path: '/memories/users/u1' } }] },
  {
    toolCalls: [
      {
        toolName: 'memory_create',
        input: { path: '/memories/users/u1/profile.md', file_text: 'Prefers tea over coffee.\n' },
      },
    ],
  },
  // the org root is read-only for the model
  {
    toolCalls: [
      {
        toolName: 'memory_str_replace',
        input: { path: '/memories/org/style.md', old_str: 'short', new_str: 'long' },
      },
    ],
  },
  { text: 'Noted: tea it is.' },
  // turn 2 (same user): the pinned profile is already in the turn reminder
  { text: 'Here is your tea recipe.' },
])

const audit: string[] = []
const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  instructions: 'You are a helpful assistant.',
  plugins: [
    // the generic file tools never see /memories
    filesystem({ fs, hiddenPrefixes: ['/memories'] }),
    memory({
      roots: (ctx) => [
        { path: `/memories/users/${String(ctx.runtime.userId)}`, write: true, label: 'this user' },
        { path: '/memories/org', label: 'company style guide' },
      ],
      pinned: (ctx) => [`/memories/users/${String(ctx.runtime.userId)}/profile.md`],
      onWrite: (e, ctx) => {
        audit.push(`${ctx.runtime.userId} ${e.op} ${e.path} (${e.after?.size ?? 0} bytes)`)
      },
    }),
  ],
})

const session = agent.session('chat-1', { runtime: { userId: 'u1' } })
const first = session.send('Remember that I like tea.')
for await (const chunk of first.stream) {
  if (chunk.type === 'tool-output-available') console.log(`tool: ${String(chunk.output)}`)
}
console.log(`turn 1: ${(await first.result).stop}`)
const second = await session.send('Suggest a drink.').result
console.log(`turn 2: ${second.stop}`)
console.log(`audit: ${audit.join('; ')}`)
console.log(`profile: ${(await fs.read('/memories/users/u1/profile.md'))?.content.trim()}`)

// The same executor works outside the agent, e.g. for an admin screen.
console.log(
  `admin: ${await executeMemoryCommand(
    { command: 'view', path: '/memories/users/u1' },
    { fs, roots: [{ path: '/memories/users/u1' }] },
  )}`.replaceAll('\t', ' '),
)

await agent.close()
