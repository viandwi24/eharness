/**
 * The `groupChat()` plugin: one agent in a chat with two humans and another bot. The agent answers
 * only when mentioned or replied to, sees the messages it missed (once, in order) with its next
 * answer, and cannot be dragged into a bot-to-bot loop.
 *
 *   bun examples/group-chat.ts
 */
import { defineHarnessAgent } from 'eharness'
import { groupChat, routeGroupMessage } from 'eharness/group'
import { exampleModel } from './shared/model.ts'

const model = exampleModel([
  { text: 'Noon works for me, Alice. Bob suggested the new ramen place.' },
  { text: 'Sure, here is the menu.' },
  { text: 'Acknowledged, helper bot.' },
  { text: 'Acknowledged again.' },
])

const group = groupChat({
  botId: 'harness-bot',
  botName: 'Harness',
  allowBots: ['helper-bot'],
  maxBotTurns: { count: 2, windowMs: 60_000 },
})

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  instructions: 'You are Harness, a friendly assistant in a team chat.',
  plugins: [group],
})

// `acceptClientMetadata` lets the speaker metadata (`metadata.group`) reach storage
const session = agent.session('team-chat', { acceptClientMetadata: true })

const alice = { id: 'u-alice', name: 'Alice' }
const bob = { id: 'u-bob', name: 'Bob' }
const helper = { id: 'helper-bot', name: 'HelperBot', isBot: true }

const incoming = [
  { author: alice, text: 'Lunch at noon?' },
  { author: bob, text: 'Let us try the new ramen place.' },
  { author: alice, text: '@Harness is noon ok for you?' },
  { author: bob, text: 'thanks!' },
  { author: bob, text: 'Reply: show the menu', replyToBot: true },
  { author: helper, text: 'ping @Harness', mentionsBot: true },
  { author: helper, text: 'ping again', mentionsBot: true },
  { author: helper, text: 'and again', mentionsBot: true },
]

for (const message of incoming) {
  const result = await routeGroupMessage(group, session, message)
  if (result.responded) {
    const done = await result.run.result
    console.log(`${message.author.name}: answered (${done.stop})`)
  } else {
    console.log(`${message.author.name}: ${result.reason}`)
  }
}

const history = await session.messages()
const kinds = history.filter((m) => m.metadata?.eharness?.kind === 'group.message')
console.log(`stored: ${history.length} messages, ${kinds.length} gated-out`)

await agent.close()
