/**
 * Basic CLI: an agent with the filesystem plugin on an in-memory file system, rendered in the
 * terminal with AI SDK's `readUIMessageStream`.
 *
 *   bun examples/basic-cli.ts "Start a todo list in /notes/todo.md"
 *
 * Offline (no `AI_GATEWAY_API_KEY`) a scripted model plays a fixed conversation; see
 * `examples/shared/model.ts`. The AI SDK TUI (`@ai-sdk/tui`) needs the `Agent` interface adapter,
 * which is on the roadmap; until then a UI message stream reader is all a terminal needs.
 */
import { getToolName, isToolUIPart, readUIMessageStream } from 'ai'
import { defineHarnessAgent, type HarnessRun, type InferHarnessUIMessage } from 'eharness'
import { classifyToolResult, filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { exampleModel } from './shared/model.ts'

const fs = memoryFs({ '/README.md': '# Notes\n\nKeep notes as Markdown files under /notes.\n' })

const agent = defineHarnessAgent({
  model: exampleModel([
    {
      toolCalls: [
        {
          toolName: 'write_file',
          input: { path: '/notes/todo.md', content: '# Todo\n\n- [ ] Try eharness\n' },
        },
      ],
    },
    { text: 'I created /notes/todo.md with a first item.' },
  ]),
  contextWindow: 200_000,
  instructions: 'You are a concise assistant. Keep notes as Markdown files under /notes.',
  plugins: [filesystem({ fs })],
})

type Message = InferHarnessUIMessage<typeof agent>

/** Print a turn as it streams: text deltas, tool calls with their result kind, file changes. */
async function render(run: HarnessRun<Message>): Promise<void> {
  const printed = new Map<string, number>() // part key → characters or states already printed
  for await (const message of readUIMessageStream<Message>({ stream: run.stream })) {
    for (const [index, part] of message.parts.entries()) {
      const key = `${index}`
      if (part.type === 'text') {
        const done = printed.get(key) ?? 0
        process.stdout.write(part.text.slice(done))
        printed.set(key, part.text.length)
      } else if (isToolUIPart(part)) {
        const stage = part.state === 'output-available' || part.state === 'output-error' ? 2 : 1
        if ((printed.get(key) ?? 0) >= stage || part.state === 'input-streaming') continue
        if (stage === 1) {
          console.log(`\n→ ${getToolName(part)} ${JSON.stringify(part.input)}`)
        } else if (part.state === 'output-available') {
          const kind = classifyToolResult(part.output)
          console.log(`← ${kind}: ${String(part.output).split('\n')[0]}`)
        } else if (part.state === 'output-error') {
          console.log(`← error: ${part.errorText}`)
        }
        printed.set(key, stage)
      } else if (part.type === 'data-filesystem.change' && !printed.has(key)) {
        console.log(`✎ ${part.data.action} ${part.data.path}`)
        printed.set(key, 1)
      }
    }
  }
}

const prompt = process.argv[2] ?? 'Start a todo list in /notes/todo.md'
const session = agent.session('cli')
console.log(`> ${prompt}`)
const run = session.send(prompt)
await render(run)
const result = await run.result
console.log(
  `\n[${result.stop} · ${result.steps} steps · ${result.usage.outputTokens} output tokens]`,
)

const file = await fs.read('/notes/todo.md')
console.log(file === null ? '/notes/todo.md was not written' : `\n/notes/todo.md:\n${file.content}`)
await agent.close()
