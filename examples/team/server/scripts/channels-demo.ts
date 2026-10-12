/**
 * Dev-only demo of the channels gateway on the in-memory mock adapter (no platform, no model
 * call: a scripted model answers). `bun scripts/channels-demo.ts` composes a server in memory,
 * binds the lead to a mock connection with one group, says a few things in it and prints what
 * the agent posted back.
 */
import { scriptedModel } from 'eharness/testing'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import { scriptedModelConfig } from '../src/infra/eh/provider.ts'
import { compose } from '../src/main.ts'

const server = compose({
  dbFile: ':memory:',
  env: {},
  models: scriptedModelConfig(
    scriptedModel([
      { text: 'Standup is at 10:00, Ana. Budi asked about the deploy: it is green.' },
    ]),
  ),
  channels: { collect: { quietMs: 50, maxWaitMs: 500, maxItems: 20 } },
})
await server.ready
const lead = server.deps.agents.list().find((a) => a.role === 'lead')
if (lead === undefined) throw new Error('no lead agent')

server.channels.configure({ connectionId: 'demo', agentId: lead.id })
const mock = createMockAdapter({ connectionId: 'demo' })
await server.channels.register(mock)
// the group is a node of the tree; switch it on (settings inherit down the tree)
const room = server.channels.settings.ensureNode('demo', {
  nativeId: 'room',
  kind: 'room',
  title: 'Demo room',
})
server.channels.settings.set(room.id, { enabled: true, label: 'Demo room' })

const ana = { id: 'u1', name: 'Ana', username: 'ana' }
const budi = { id: 'u2', name: 'Budi', username: 'budi' }
await mock.say({ from: budi, text: 'did the deploy go through?', id: '1' })
await mock.say({ from: ana, text: '@demo_bot when is standup?', id: '2', mentionSelf: true })

const end = Date.now() + 15_000
while (mock.sent.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
for (const s of mock.sent) {
  console.log(
    `[${s.conversationId}] bot -> ${s.message.text} (quoting ${s.message.replyTo ?? 'nothing'})`,
  )
}
console.log(
  `threads of the lead: ${server.deps.threads
    .list(lead.id)
    .map((t) => `${t.sourceLabel ?? t.title}`)
    .join(', ')}`,
)
await server.close()
