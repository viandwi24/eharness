/**
 * The Signal Router template: one call sets up an agent that reads a source chat as a feed and
 * copies trading signals (and their follow-ups) to several target chats, with a `trade_ideas`
 * table as its memory. It starts in trial mode: the agent decides and records, nothing is sent.
 * Everything it creates is ordinary (an agent, a table, chat settings) and can be edited after.
 */
import type { AgentDef } from '../domain/agents.ts'
import type { ChannelNodeView, ChannelPolicyInput } from '../domain/channels.ts'
import { conflict, invalid } from '../domain/errors.ts'
import { createAgent } from './agents.ts'
import type { Deps } from './ports.ts'
import { createTable } from './tables.ts'

export interface SignalRouterInput {
  connectionId: string
  /** The chat the signals are posted in: its title, platform id or node id. */
  source: string
  /** The chats the signals are shared out to. */
  targets: string[]
  /** Default "Signal Router". */
  name?: string | undefined
  /** Default true: copies are only recorded until it is turned off on the Channels page. */
  trial?: boolean | undefined
  /** Default `trade_ideas`. */
  table?: string | undefined
  /** More rules, appended to the instructions (the analyst's habits, which posts to skip). */
  rules?: string | undefined
}

export interface SignalRouterResult {
  agent: AgentDef
  table: string
  source: ChannelNodeView
  targets: ChannelNodeView[]
  trial: boolean
}

const TOOLS = ['channel_copy', 'channel_copies', 'channel_read', 'tables_read', 'tables_write']

const COLUMNS = [
  {
    name: 'idea',
    type: 'string',
    unique: true,
    description: 'The id of the signal message that opened the idea',
  },
  { name: 'direction', type: 'string', description: 'buy or sell' },
  { name: 'channel', type: 'string', description: 'The target chat the idea went to' },
  { name: 'status', type: 'string', default: 'open', description: 'open, tp, closed, cut' },
  { name: 'entry', type: 'string' },
  { name: 'sl', type: 'string' },
  { name: 'tp', type: 'string' },
  { name: 'opened_at', type: 'date' },
  {
    name: 'last_message',
    type: 'string',
    description: 'The last source message that belongs to it',
  },
  { name: 'reason', type: 'string', description: 'Why the router decided so' },
]

/** The instructions of the router agent (editable afterwards on the agent's page). */
export function signalRouterInstructions(input: {
  source: string
  targets: string[]
  table: string
  rules?: string | undefined
}): string {
  const targets = input.targets.map((t, i) => `${i + 1}. "${t}"`).join('\n')
  return `You route trading signals from the source chat "${input.source}" to these target chats:
${targets}

The source chat is a feed: you read every message there and decide what to do. Nobody talks to you. You act only with tools; your final text is a one-line log.

## What a message can be

- New signal: a buy or sell idea with an entry (a price such as "@ 4018", or a zone such as "E: 4023 - 4024 - 4026"), often with SL and TP levels. Informal words count: "sel" or "sell", "buy", "cicil" (scale in), "stnby" or "standby", "entry", "re entry".
- Early entry: "cicil buy", "cicil sel", "cent akun buy dulu", "masuk duluan buy @ ...": an entry before the real zone. It belongs to the same trade idea as the zone setup that usually follows (same direction, within about an hour): both go to the same chat.
- Follow-up of an open idea: a reply to a signal or to a follow-up, or an instruction such as "TP all", "TP sekarang" (take profit now, at any price), "cut loss sekarang", "SL" without a level, "re entry", "switch buy", a screenshot of positions or of profit. It goes where its idea went.
- Other: daily reports, greetings, stickers, marketing, giveaways, news. Copy none of them. A daily report lists every signal of the source chat, which is wrong for a target chat that got only some of them.

When a signal names no TP, the defaults are TP1 = entry +/- 20 pips, TP2 = +/- 60 pips, TP3 = +/- 100 pips. Use them only in your table; never change the analyst's text.

## How to route

1. Read the message meta: the message id, the message it replies to, its album id.
2. A reply: call channel_copies for the message it replies to. If that was copied, copy this one to the same chat with channel_copy (it goes under the copy by itself). If it was not copied, decide as for a new message.
3. A new signal: query the open ideas of today in table ${input.table} (tables_read, filter { status: "open" }). If it continues an open idea (an early entry and then its zone, same direction, close in time), send it to that idea's chat. Otherwise send it to the target chat with the fewest ideas opened today (on a tie, the first in the list) and record a new idea.
4. A follow-up that is not a reply ("TP all", "cut loss"): attach it to the most recent open idea it fits (direction, time) and copy it to that idea's chat. If none fits, do not copy it.
5. An album arrives as several messages with the same album id: copy all of their ids in one channel_copy call.
6. Never copy a message twice: check channel_copies when unsure.
7. Record every decision in table ${input.table} with tables_write:
   - a new idea: insert { idea: the source message id, direction, channel, status: "open", entry, sl, tp, opened_at, last_message, reason };
   - a follow-up: update the idea (filter { idea }): last_message, and status "tp", "closed" or "cut" when the instruction says so, with a short reason.
8. Your final text: one line such as "120: new sell idea -> VIP", "121: follow-up of 120 -> VIP" or "122: daily report, not copied".

Edits and deletions of a copied message reach its copies on their own: do nothing for them.${input.rules === undefined || input.rules.trim() === '' ? '' : `\n\n## More rules\n\n${input.rules.trim()}`}
`
}

const matchChat = (chats: ChannelNodeView[], ref: string): ChannelNodeView | undefined => {
  const want = ref.trim().toLowerCase()
  return chats.find(
    (c) =>
      c.id === ref ||
      c.nativeId.toLowerCase() === want ||
      c.title.toLowerCase() === want ||
      (c.username !== undefined && `@${c.username.toLowerCase()}` === want),
  )
}

export async function setupSignalRouter(
  deps: Deps,
  input: SignalRouterInput,
): Promise<SignalRouterResult> {
  // any chat connection (the gateway itself); the connector port only knows Telegram connections
  const port = deps.channelSettings?.()
  const chats =
    port !== undefined
      ? port.chats(input.connectionId)
      : await deps.channels.chats(input.connectionId)
  const setPolicy = async (nodeId: string, policy: ChannelPolicyInput): Promise<ChannelNodeView> =>
    port !== undefined
      ? port.setChatPolicy(input.connectionId, nodeId, policy)
      : deps.channels.setChatPolicy(input.connectionId, nodeId, policy)
  const chatOf = async (nodeId: string): Promise<ChannelNodeView> =>
    port !== undefined
      ? port.chat(input.connectionId, nodeId)
      : deps.channels.chat(input.connectionId, nodeId)
  const source = matchChat(chats, input.source)
  if (source === undefined)
    throw invalid(
      `no chat "${input.source}" on this connection: pick one of its chats`,
      'UNKNOWN_CHAT',
    )
  if (input.targets.length === 0) throw invalid('name at least one target chat', 'NO_TARGETS')
  const targets: ChannelNodeView[] = []
  for (const ref of input.targets) {
    const t = matchChat(chats, ref)
    if (t === undefined) throw invalid(`no chat "${ref}" on this connection`, 'UNKNOWN_CHAT')
    if (t.id === source.id) throw invalid('a target cannot be the source chat', 'INVALID_TARGET')
    if (!t.postable)
      throw invalid(
        `"${t.title}" holds no messages of its own: pick one of its topics`,
        'INVALID_TARGET',
      )
    if (!targets.some((x) => x.id === t.id)) targets.push(t)
  }
  const table = (input.table ?? 'trade_ideas').trim()
  const trial = input.trial !== false
  const name = (input.name ?? 'Signal Router').trim() || 'Signal Router'
  if (source.effective.feed && source.effective.agentId !== '')
    throw conflict(
      `"${source.title}" is a feed of another agent already: remove that first on the Channels page`,
      'ALREADY_ROUTED',
    )
  if (deps.tables.get(table) === undefined)
    createTable(deps, 'web owner', {
      name: table,
      description: `Trade ideas the ${name} agent opened from "${source.title}", where they went and how they ended.`,
      schema: { columns: COLUMNS },
    })
  const agent = createAgent(deps, {
    name,
    description: `Reads "${source.title}" and shares signals out to ${targets.map((t) => `"${t.title}"`).join(', ')}.`,
    instructions: signalRouterInstructions({
      source: source.title,
      targets: targets.map((t) => t.title),
      table,
      rules: input.rules,
    }),
    rules: { allow: TOOLS },
  })
  for (const t of targets) if (!t.effective.allowed) await setPolicy(t.id, { enabled: true })
  const routed = await setPolicy(source.id, {
    enabled: true,
    agentId: agent.id,
    feed: true,
    copyTrial: trial,
  })
  const fresh = await Promise.all(targets.map((t) => chatOf(t.id)))
  return { agent, table, source: routed, targets: fresh, trial }
}
