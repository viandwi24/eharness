/**
 * `standing-orders` plugin (docs/plans/P51-proactive-and-health.md): the `standing_order` tool of a
 * person's own chat, in the web app and in a chat channel. When a person gives the agent an
 * ongoing instruction ("analisis setiap saat ... laporkan ke saya") the agent adds a standing
 * order: one readable line in its memory file `HEARTBEAT.md`, which the heartbeat then carries out
 * and reports back to the place the person asked in (or to another chat of the agent only when
 * the person names it).
 *
 * Who may: the web app is the owner. In a chat the role of the person who asked decides, in code:
 * an owner or an admin may have reports posted into a group (and may remove any order); a member
 * only gets reports back privately, in their direct chat with the agent, and removes only their
 * own orders; a guest gets nothing. Every answer is text the model can read and relay.
 *
 * Only a person's own chat gets the tool: tasks, programs, routines, heartbeats and rehearsals do
 * not (no orders from orders).
 */
import { tool } from 'ai'
import { definePlugin, errorText, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import { originOfSession } from '../../domain/run-profiles.ts'
import {
  cleanOrderText,
  mayPostToGroups,
  mayRemoveOrder,
  NEEDS_HELP,
  ORDER_KINDS,
  type OrderDestination,
  type OrderKind,
  orderState,
  STANDING_ORDER_DESCRIPTION,
  STANDING_ORDER_TOOL,
  type StandingOrder,
  WEB_OWNER,
} from '../../domain/standing-orders.ts'
import { resolveConnectionRef } from '../channels/connection-ref.ts'
import type { ChannelGateway } from '../channels/gateway.ts'
import { resolveOrderTime } from './order-due.ts'

/** What the tool needs of the app (`app/standing-orders.ts` over the deps, built in `main.ts`). */
export interface StandingOrderApi {
  list(agentId: string): Promise<StandingOrder[]>
  add(
    agentId: string,
    input: {
      text: string
      by: string
      name: string
      role: string
      uid?: string | undefined
      report: OrderDestination
      mention: boolean
      kind?: OrderKind | undefined
      due?: number | undefined
      expires?: number | undefined
      refs?: string[] | undefined
      needs?: string[] | undefined
      ledger?: string | undefined
    },
  ): Promise<{ order: StandingOrder; created: boolean }>
  remove(agentId: string, id: string): Promise<StandingOrder | undefined>
  /** Finish a deadline order with its outcome. */
  complete(agentId: string, id: string, outcome: string): Promise<StandingOrder | undefined>
  /** The chats the agent may report to (postable, allowed), with whether unasked posts are allowed there. */
  chats(
    agentId: string,
  ): Array<{ connectionId: string; nodeId: string; label: string; proactive: boolean }>
  /** A destination named for a person. */
  label(agentId: string, d: OrderDestination): string
}

export interface StandingOrderPluginOptions {
  /** Late-bound: the plugin is built before the gateway. */
  gateway: () => ChannelGateway | undefined
  /** The agent (id) of a hook context (`ctx.agent.id` is the slug of the definition). */
  agentOf: (slug: string) => { id: string } | undefined
  orders: () => StandingOrderApi | undefined
  /** The heartbeat of the agent (slug) is on (an agent with it off is not offered the tool). */
  enabled: (agentSlug: string) => boolean
  /** The team timezone and the clock: `due` and `expires` are read in that zone. */
  zone: () => string
  now: () => number
}

const schema = z.object({
  action: z.enum(['add', 'list', 'remove', 'done']),
  instruction: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "add: the person's own words about what to watch and when to report, lightly cleaned.",
    ),
  connection: z
    .string()
    .optional()
    .describe(
      'add: only when the person names another chat of yours to report to: its connection.',
    ),
  chat: z
    .string()
    .optional()
    .describe(
      'add: only when the person names another chat to report to: its id, native id or exact title.',
    ),
  topic: z.string().optional().describe('add: a topic of that chat.'),
  mention: z
    .boolean()
    .optional()
    .describe(
      'add: tag the person when reporting. Default: yes in a group where they asked, no elsewhere.',
    ),
  kind: z
    .enum(ORDER_KINDS)
    .optional()
    .describe(
      'add: watch (ongoing, default), rule (react when X happens), deadline (one-shot at `due`, then done) or ledger (keeps a tracker file).',
    ),
  due: z
    .string()
    .max(60)
    .optional()
    .describe(
      'add, deadline: when to check, exactly: "YYYY-MM-DD HH:MM" in the team timezone, "today 12:00", "tomorrow 09:00" or "in 2 hours". Resolve words like "Friday around noon" to a date yourself.',
    ),
  expires: z
    .string()
    .max(60)
    .optional()
    .describe('add: after this time the order is inactive. Same formats as due.'),
  refs: z
    .array(z.string().max(200))
    .max(8)
    .optional()
    .describe(
      'add: where the context is: session ids, or chat message ids like "General #12345" the beat opens with session_read.',
    ),
  needs: z.array(z.string().max(120)).max(6).optional().describe(`add: ${NEEDS_HELP}`),
  ledger: z
    .string()
    .max(200)
    .optional()
    .describe(
      'add: library path of the tracker the order keeps (a ledger order defaults to /library/trackers/<name>.md).',
    ),
  outcome: z.string().max(600).optional().describe('done: what came out of the order.'),
  id: z.string().optional().describe('remove, done: the id of the order (from list).'),
  match: z.string().optional().describe('remove: words of the order, when you have no id.'),
})

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

interface Asker {
  by: string
  name: string
  role: string
  uid?: string
  /** Where the person is: undefined in the web app. */
  here?: { connectionId: string; nodeId: string; direct: boolean }
}

export function standingOrders(
  options: StandingOrderPluginOptions,
): HarnessPlugin<'standing-orders'> {
  return definePlugin({
    name: 'standing-orders',
    session: (rawCtx) => {
      const ctx = rawCtx as HarnessContext
      const sessionId = ctx.session.id
      const gw = options.gateway()
      if (gw === undefined) return {}
      const agent = options.agentOf(ctx.agent.id)
      if (agent === undefined) return {}
      // only a person's own chat: not a delegation, task, program, routine, heartbeat or rehearsal
      if (originOfSession(sessionId, ctx.session.parent !== undefined) !== 'dm') return {}
      if (!options.enabled(ctx.agent.id)) return {}
      const agentId = agent.id
      const inChannel = gw.conversationOf(sessionId) !== undefined

      const api = (): StandingOrderApi => {
        const found = options.orders()
        if (found === undefined) throw new Error('standing orders are not ready')
        return found
      }

      /** Who is asking: the web owner, or the requester of the chat turn (undefined: nobody to attribute). */
      const askerOf = async (): Promise<Asker | undefined> => {
        if (!inChannel || gw.webTurn(sessionId))
          return { by: WEB_OWNER, name: 'the owner', role: 'owner' }
        const r = await gw.requesterOf(sessionId)
        if (r === undefined) return undefined
        const node = gw.nodes.get(r.nodeId)
        return {
          by: r.identityId,
          name: r.name ?? r.username ?? r.nativeId,
          role: r.role,
          uid: r.nativeId,
          here: {
            connectionId: r.connectionId,
            nodeId: r.nodeId,
            direct: node?.kind === 'direct',
          },
        }
      }

      /** The orders this person may see: staff and the web owner all, a member their own. */
      const visible = (orders: StandingOrder[], asker: Asker): StandingOrder[] =>
        mayPostToGroups(asker.role) ? orders : orders.filter((o) => o.by === asker.by)

      const stateTag = (o: StandingOrder): string => {
        const st = orderState(o, options.now())
        return st === 'active' ? '' : ` [${st}]`
      }
      const extras = (o: StandingOrder): string =>
        [
          o.due === undefined
            ? ''
            : `, due ${new Date(o.due).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          o.expires === undefined
            ? ''
            : `, expires ${new Date(o.expires).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          o.refs.length === 0 ? '' : `, refs: ${o.refs.join(' | ')}`,
          o.needs.length === 0 ? '' : `, needs: ${o.needs.join(', ')}`,
          o.ledger === undefined ? '' : `, ledger ${o.ledger}`,
          o.done === undefined ? '' : `, outcome: ${clip(o.done.outcome, 160)}`,
        ].join('')

      const describe = (o: StandingOrder): string =>
        `- ${o.id}${o.kind === 'watch' ? '' : ` [${o.kind}]`}${stateTag(o)} "${clip(o.text, 200)}": asked by ${o.name === '' ? o.by : o.name} (${o.role}), reports to ${api().label(agentId, o.report)}${o.mention ? ', tagging them' : ''}, given ${new Date(o.at).toISOString().slice(0, 16).replace('T', ' ')} UTC${extras(o)}`

      const add = async (input: z.infer<typeof schema>, asker: Asker): Promise<string> => {
        const text = cleanOrderText(input.instruction ?? '')
        if (text === '')
          return "ERROR: add needs instruction: the person's own words about what to watch and when to report, lightly cleaned."
        if (asker.role === 'guest')
          return 'Not allowed: a guest only gets answers. Only a team member can give a standing order: tell the person, in one plain sentence, to ask a team member.'
        const named =
          input.connection !== undefined || input.chat !== undefined || input.topic !== undefined
        let report: OrderDestination
        let here = true
        if (named) {
          if (!mayPostToGroups(asker.role))
            return 'Not allowed: reports of a member go back to that member privately, in their direct chat with me. Leave out connection, chat and topic, or ask an owner or an admin to have the report posted in another chat.'
          if (gw.connectionsOf(agentId).length === 0)
            return 'ERROR: I have no chat connection, so I can only report in this chat. Leave out connection, chat and topic.'
          let chat: { connectionId: string; nodeId: string }
          try {
            let connection: string | undefined
            if (input.connection !== undefined) {
              const ref = resolveConnectionRef(gw.connectionsOf(agentId), input.connection)
              if (!ref.ok) return `ERROR: ${ref.text}`
              connection = ref.id
            }
            const t = gw.resolveTarget(agentId, sessionId, {
              ...(connection === undefined ? {} : { connection }),
              ...(input.chat === undefined ? {} : { conversation: input.chat }),
              ...(input.topic === undefined ? {} : { topic: input.topic }),
            })
            chat = { connectionId: t.config.connectionId, nodeId: t.node.id }
          } catch (error) {
            return `ERROR: ${errorText(error)}`
          }
          if (
            !api()
              .chats(agentId)
              .some((c) => c.connectionId === chat.connectionId && c.nodeId === chat.nodeId)
          ) {
            return 'ERROR: that chat is not one I can report to (it is not allowed for me, or I cannot post there). Pick one of my connected chats, or report here.'
          }
          report = { kind: 'chat', ...chat }
          here = asker.here?.nodeId === chat.nodeId
        } else if (asker.here === undefined) {
          report = { kind: 'web', sessionId }
        } else {
          // exactly where it was asked: "chat saya disini"
          if (!mayPostToGroups(asker.role) && !asker.here.direct)
            return 'Not allowed: a member gets reports privately. Write this to me in a direct chat and I will report back there; for a report posted in a group, ask an owner or an admin.'
          report = {
            kind: 'chat',
            connectionId: asker.here.connectionId,
            nodeId: asker.here.nodeId,
          }
        }

        // a person is tagged where they asked, in a group; a member's private report needs no tag
        const group = report.kind === 'chat' && asker.here !== undefined && !asker.here.direct
        const mention =
          input.mention ?? (here && group && mayPostToGroups(asker.role) && asker.uid !== undefined)
        if (mention && asker.uid === undefined)
          return 'ERROR: I cannot tag the person here (no chat account): leave out mention.'

        const kind = input.kind ?? 'watch'
        const staff = mayPostToGroups(asker.role)
        if (
          !staff &&
          (input.needs !== undefined || input.ledger !== undefined || kind === 'ledger')
        ) {
          return 'Not allowed: tools (needs) and a ledger belong to orders of an owner or an admin. A member gets a plain watch that only looks. Leave out needs and ledger, or ask an owner or an admin.'
        }
        let due: number | undefined
        let expires: number | undefined
        for (const [name, raw] of [
          ['due', input.due],
          ['expires', input.expires],
        ] as const) {
          if (raw === undefined) continue
          const at = resolveOrderTime(raw, options.zone(), options.now())
          if ('error' in at) return `ERROR: ${name}: ${at.error}`
          if (name === 'due') due = at.at
          else expires = at.at
        }
        if (kind === 'deadline' && due === undefined)
          return 'ERROR: a deadline order needs due: the exact time it must be checked ("YYYY-MM-DD HH:MM" in the team timezone).'
        const out = await api().add(agentId, {
          text,
          by: asker.by,
          name: asker.name,
          role: asker.role,
          uid: asker.uid,
          report,
          mention,
          kind,
          due,
          expires,
          refs: input.refs,
          needs: input.needs,
          ledger: input.ledger,
        })
        const where =
          report.kind === 'web'
            ? 'in this chat (and the bell)'
            : `in ${api().label(agentId, report)}${mention ? `, tagging ${asker.name}` : ''}`
        if (!out.created)
          return `Already ongoing: order ${out.order.id} ("${clip(out.order.text, 120)}") reports ${where}. Nothing changed.`
        const chat =
          report.kind === 'chat'
            ? api()
                .chats(agentId)
                .find((c) => c.connectionId === report.connectionId && c.nodeId === report.nodeId)
            : undefined
        const warn =
          chat !== undefined && !chat.proactive
            ? ' Note: that chat does not allow unasked posts yet (its settings), so a report there is refused until an owner allows "proactive" posts for it; tell the person.'
            : ''
        const when =
          out.order.kind === 'deadline' && out.order.due !== undefined
            ? `A beat runs for it at exactly ${new Date(out.order.due).toISOString().slice(0, 16).replace('T', ' ')} UTC, ends it with an outcome, and reports ${where}.`
            : `The heartbeat looks at it about every 30 minutes (and early when the chats I watch get new messages) and reports ${where}.`
        const ledger = out.order.ledger === undefined ? '' : ` Its tracker is ${out.order.ledger}.`
        return `Standing order saved (id ${out.order.id}, ${out.order.kind}): "${clip(out.order.text, 200)}". ${when}${ledger} It is a readable line in my HEARTBEAT.md. To end it, say "stop" and I remove it.${warn} Tell the person, in one plain sentence, what you will watch and where you will report.`
      }

      const run = async (input: z.infer<typeof schema>): Promise<string> => {
        try {
          const asker = await askerOf()
          if (asker === undefined)
            return 'ERROR: I cannot tell who asked, so I cannot keep a standing order for them.'
          if (input.action === 'add') return await add(input, asker)
          const orders = visible(await api().list(agentId), asker)
          if (input.action === 'list') {
            if (orders.length === 0) return 'There are no standing orders.'
            return `Standing orders (${orders.length}):\n${orders.map(describe).join('\n')}`
          }
          if (input.action === 'done') {
            const found = visible(await api().list(agentId), asker).find((o) => o.id === input.id)
            if (found === undefined)
              return `ERROR: no standing order ${input.id ?? ''} of yours. Use list.`
            if (found.kind !== 'deadline')
              return 'ERROR: only a deadline order is ended with done; use remove to stop a watch, rule or ledger.'
            if (!mayRemoveOrder(found, asker))
              return 'Not allowed: only the person who gave this order, an owner or an admin can end it.'
            const outcome = input.outcome?.trim()
            if (outcome === undefined || outcome === '')
              return 'ERROR: done needs outcome: what came out of the order.'
            await api().complete(agentId, found.id, outcome)
            return `Order ${found.id} is done: ${clip(outcome, 160)}`
          }
          // remove
          const all = await api().list(agentId)
          let found: StandingOrder | undefined
          if (input.id !== undefined) {
            found = all.find((o) => o.id === input.id)
            if (found === undefined) return `ERROR: no standing order ${input.id}. Use list.`
          } else {
            const mine = visible(all, asker).filter((o) => o.active)
            const words = input.match?.trim().toLowerCase()
            const hits =
              words === undefined || words === ''
                ? mine
                : mine.filter((o) => o.text.toLowerCase().includes(words))
            if (hits.length === 0)
              return mine.length === 0
                ? 'There is no standing order of yours to remove.'
                : `ERROR: no standing order matches "${input.match}". Yours:\n${mine.map(describe).join('\n')}`
            if (hits.length > 1)
              return `Several standing orders fit: say which one (id):\n${hits.map(describe).join('\n')}`
            found = hits[0]
          }
          if (found === undefined) return 'ERROR: nothing to remove.'
          if (!mayRemoveOrder(found, asker))
            return 'Not allowed: only the person who gave this order, an owner or an admin can end it.'
          await api().remove(agentId, found.id)
          return `Stopped: order ${found.id} ("${clip(found.text, 120)}") is removed from my HEARTBEAT.md. I will not watch for it any more.`
        } catch (error) {
          return `ERROR: ${errorText(error)}`
        }
      }

      return {
        tools: {
          [STANDING_ORDER_TOOL]: tool({
            description: STANDING_ORDER_DESCRIPTION,
            inputSchema: schema,
            metadata: { risk: 'write', idempotent: false },
            execute: (input): Promise<string> => run(input),
          }),
        } as never,
      }
    },
  })
}
