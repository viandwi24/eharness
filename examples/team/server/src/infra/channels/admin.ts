/**
 * The admin side of the channels inbox (`ChannelInboxPort`): linking people without links, the
 * inbox of conversations with their channel logs, and the activity feed. A thin layer over the
 * gateway; platform neutral.
 */
import type { ChannelInboxPort } from '../../app/ports.ts'
import type { ChannelPersonView, ChannelReminderView } from '../../domain/channels.ts'
import { invalid, notFound } from '../../domain/errors.ts'
import type { ChannelGateway, PersonView } from './gateway.ts'
import { type ReminderRow, WEB_REMINDER_CONNECTION, webReminderSession } from './reminders.ts'

const personOf = (v: PersonView): ChannelPersonView => ({
  peerId: v.peerId,
  ...(v.name === null ? {} : { name: v.name }),
  ...(v.username === null ? {} : { username: v.username }),
  kind: v.kind,
  isBot: v.isBot,
  role: v.role,
  roleSource: v.roleSource,
  explicit: v.explicit,
  divisions: v.divisions,
  ...(v.memberId === null ? {} : { memberId: v.memberId }),
  platformAdmin: v.platformAdmin,
  ...(v.suggestion === undefined ? {} : { suggestion: v.suggestion }),
  ...(v.note === undefined ? {} : { note: v.note }),
  firstSeen: v.firstSeen,
  lastSeen: v.lastSeen,
  ignored: v.ignored,
  directMessages: v.directMessages,
})

const OWNER = 'owner'

export interface ChannelInboxOptions {
  gateway: ChannelGateway
  /** Resolves when the connection exists (a channel connection), rejects with not-found otherwise. */
  connection(id: string): Promise<unknown>
}

const clean = (value: string, what: string): string => {
  const v = value.trim()
  if (v === '' || v.length > 64) throw invalid(`${what} must be 1 to 64 characters`)
  return v
}

export function createChannelInboxPort(options: ChannelInboxOptions): ChannelInboxPort {
  const { gateway } = options
  const known = async (id: string): Promise<void> => {
    await options.connection(id)
  }
  return {
    async members(id) {
      await known(id)
      // the example has one principal; admins and already linked members are offered too
      const ids = new Set<string>([OWNER])
      for (const a of gateway.config(id)?.admins ?? []) ids.add(a)
      for (const l of gateway.pairing.members(id)) ids.add(l.memberId)
      return [...ids].map((memberId) => ({
        id: memberId,
        name: memberId === OWNER ? 'Owner' : memberId,
      }))
    },
    async unlinked(id, opts) {
      await known(id)
      return gateway.unlinked.list(id, opts).map((u) => ({
        peerId: u.peerId,
        ...(u.name === null ? {} : { name: u.name }),
        ...(u.username === null ? {} : { username: u.username }),
        firstSeen: u.firstSeen,
        lastSeen: u.lastSeen,
        messageCount: u.messageCount,
        ignored: u.ignored,
      }))
    },
    async link(id, input) {
      await known(id)
      const link = gateway.pairing.link(
        id,
        clean(input.peerId, 'peerId'),
        clean(input.memberId, 'memberId'),
        input.name === undefined ? undefined : clean(input.name, 'name'),
      )
      return {
        peerId: link.peerId,
        memberId: link.memberId,
        ...(link.name === null ? {} : { name: link.name }),
        linkedAt: link.linkedAt,
      }
    },
    async ignore(id, peerId, ignored) {
      await known(id)
      if (!gateway.unlinked.ignore(id, peerId, ignored)) throw notFound('person', peerId)
    },
    async inbox(id, opts) {
      await known(id)
      return gateway.inbox.conversations(id, opts)
    },
    async inboxTable(id, query) {
      await known(id)
      const page = await gateway.inbox.table(id, query)
      return { items: page.items, total: page.total, page: query.page, limit: query.limit }
    },
    async conversation(id, conversationId, opts) {
      await known(id)
      const page = await gateway.inbox.messages(id, conversationId, opts)
      if (page === undefined) throw notFound('conversation', conversationId)
      return page
    },
    async activity(id, query) {
      await known(id)
      return gateway.activity.list(id, query)
    },
    async people(id) {
      await known(id)
      return gateway.people.list(id).map(personOf)
    },
    async peopleTable(id, query) {
      await known(id)
      const page = gateway.people.table(id, query)
      return {
        items: page.items.map(personOf),
        total: page.total,
        page: query.page,
        limit: query.limit,
      }
    },
    async person(id, peerId) {
      await known(id)
      const p = gateway.people.get(id, peerId)
      if (p === undefined) throw notFound('person', peerId)
      return personOf(p)
    },
    async activityActions(id) {
      await known(id)
      return gateway.activity.actions(id)
    },
    async activityTable(id, query) {
      await known(id)
      const page = gateway.activity.table(id, query)
      return { items: page.items, total: page.total, page: query.page, limit: query.limit }
    },
    async setRole(id, peerId, input) {
      await known(id)
      try {
        return personOf(gateway.people.setRole(id, clean(peerId, 'peerId'), input, OWNER))
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : String(error))
      }
    },
    async clearRole(id, peerId) {
      await known(id)
      if (gateway.people.clearRole(id, peerId) === undefined) throw notFound('person', peerId)
    },
    async importAdmins(id) {
      await known(id)
      try {
        return await gateway.people.importAdmins(id)
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : String(error))
      }
    },
    async peopleSettings(id) {
      await known(id)
      const c = gateway.config(id)
      return {
        defaultRole: c?.people.defaultRole ?? 'guest',
        approvalTtlHours: Math.round(((c?.approvalTtlMs ?? 86_400_000) / 3_600_000) * 100) / 100,
      }
    },
    async setPeopleSettings(id, input) {
      await known(id)
      const c = gateway.config(id)
      if (c === undefined) throw invalid('Bind the connection to an agent first.')
      gateway.configure({
        ...c,
        people: {
          ...c.people,
          ...(input.defaultRole === undefined ? {} : { defaultRole: input.defaultRole }),
        },
        ...(input.approvalTtlHours === undefined
          ? {}
          : { approvalTtlMs: Math.max(60_000, Math.round(input.approvalTtlHours * 3_600_000)) }),
      })
      const n = gateway.config(id)
      return {
        defaultRole: n?.people.defaultRole ?? 'guest',
        approvalTtlHours: Math.round(((n?.approvalTtlMs ?? 86_400_000) / 3_600_000) * 100) / 100,
      }
    },
    async reminders(id, opts) {
      await known(id)
      return gateway.reminders
        .list(id, opts.all ? {} : { status: 'active' })
        .slice(0, 200)
        .map(view)
    },
    async remindersTable(id, query) {
      await known(id)
      const page = gateway.reminders.table(id, query)
      return {
        items: page.items.map(view),
        total: page.total,
        page: query.page,
        limit: query.limit,
      }
    },
    async allReminders(opts) {
      // reminders made in web chat threads ride along with the channel ones
      const rows = [...gateway.connections().map((c) => c.connectionId), WEB_REMINDER_CONNECTION]
        .flatMap((id) => gateway.reminders.list(id, opts.all ? {} : { status: 'active' }))
        .filter((r) => opts.agentId === undefined || r.agentId === opts.agentId)
      // active first (soonest first), then the finished ones, newest first, capped
      const active = rows
        .filter((r) => r.status === 'active')
        .sort((a, b) => (nextAtOf(a) ?? Infinity) - (nextAtOf(b) ?? Infinity))
      const finished = rows
        .filter((r) => r.status !== 'active')
        .sort((a, b) => (b.lastFiredAt ?? b.createdAt) - (a.lastFiredAt ?? a.createdAt))
        .slice(0, 50)
      return [...active, ...finished].map(view)
    },
    async cancelReminder(id, reminderId) {
      if (id !== WEB_REMINDER_CONNECTION) await known(id)
      const r = gateway.reminders.get(reminderId)
      if (r === undefined || r.connectionId !== id) throw notFound('reminder', reminderId)
      gateway.reminders.cancel(reminderId)
    },
  }

  function nextAtOf(r: ReminderRow): number | undefined {
    return gateway.reminders.nextAt(r)
  }

  function view(r: ReminderRow): ChannelReminderView {
    const thread = webReminderSession(r)
    if (thread !== undefined) {
      const next = r.status === 'active' ? nextAtOf(r) : undefined
      return {
        id: r.id,
        connectionId: r.connectionId,
        agentId: r.agentId,
        nodeId: r.nodeId,
        sessionId: thread,
        chatTitle: 'This chat',
        place: 'This chat',
        ...(next === undefined ? {} : { nextAt: next }),
        text: r.body,
        whenText: r.whenText,
        status: r.status,
        mentions: [],
        ...(r.createdByName === null ? {} : { createdByName: r.createdByName }),
        ...(r.createdByRole === null ? {} : { createdByRole: r.createdByRole }),
        createdAt: r.createdAt,
        ...(r.lastFiredAt === null ? {} : { lastFiredAt: r.lastFiredAt }),
        fireCount: r.fireCount,
        ...(r.lastError === null ? {} : { lastError: r.lastError }),
      }
    }
    const node = gateway.nodes.get(r.nodeId)
    const parent = node?.parentId == null ? undefined : gateway.nodes.get(node.parentId)
    const next = r.status === 'active' ? nextAtOf(r) : undefined
    return {
      id: r.id,
      connectionId: r.connectionId,
      agentId: r.agentId,
      nodeId: r.nodeId,
      chatTitle: node === undefined ? r.nodeId : (node.title ?? node.nativeId),
      place:
        node === undefined
          ? r.nodeId
          : parent === undefined
            ? (node.title ?? node.nativeId)
            : `${parent.title ?? parent.nativeId}/${node.title ?? node.nativeId}`,
      ...(next === undefined ? {} : { nextAt: next }),
      text: r.body,
      whenText: r.whenText,
      status: r.status,
      mentions: r.mentions.map((m) => {
        const i = gateway.identities.get(m)
        return i?.displayName ?? i?.username ?? i?.nativeId ?? m
      }),
      ...(r.createdByName === null ? {} : { createdByName: r.createdByName }),
      ...(r.createdByRole === null ? {} : { createdByRole: r.createdByRole }),
      createdAt: r.createdAt,
      ...(r.lastFiredAt === null ? {} : { lastFiredAt: r.lastFiredAt }),
      fireCount: r.fireCount,
      ...(r.lastError === null ? {} : { lastError: r.lastError }),
    }
  }
}

/** The inbox port, delegating to a service built later (it needs the gateway). */
export function lazyInboxPort(get: () => ChannelInboxPort | undefined): ChannelInboxPort {
  return new Proxy({} as ChannelInboxPort, {
    get: (_t, name) => {
      const target = get()
      if (target === undefined) throw new Error('channels are not ready yet')
      return (target as unknown as Record<string | symbol, unknown>)[name]
    },
  })
}
