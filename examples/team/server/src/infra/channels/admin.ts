/**
 * The admin side of the channels inbox (`ChannelInboxPort`): linking people without links, the
 * inbox of conversations with their channel logs, and the activity feed. A thin layer over the
 * gateway; platform neutral.
 */
import type { ChannelInboxPort } from '../../app/ports.ts'
import { invalid, notFound } from '../../domain/errors.ts'
import type { ChannelGateway } from './gateway.ts'

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
