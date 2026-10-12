/**
 * Collector (use case U1): the channel log of the observe-only chats of a Telegram user
 * connection as a source for the big-data tools (`ingest_source` of the Data work connector,
 * decision D7.1). A community-audit program ingests it by day into the library like the demo
 * collector, then works on the hourly JSONL files in chunks.
 *
 * The cursor is the log's change counter (`channel_messages.rev`): an item is emitted when a
 * message is stored, again when it is edited (`kind: 'edit'`, with the earlier text) or deleted
 * (`kind: 'delete'`), and for admin-log events (`kind: 'event'`). Ingest dedupes by item id.
 */
import { type CollectedItem, type Collector, channelSegment } from '../../domain/collectors.ts'
import { type ConnectionConfig, resolveScope } from '../channels/policy.ts'
import type { ChannelLog, LogChange } from '../channels/store.ts'
import { kindOfChatId, refOf, splitConversationId } from './normalize.ts'
import type { ChatStore } from './store.ts'

export const ADMIN_EVENT_PREFIX = 'admin:'

/** The source id of a connection: `telegram-<connection id>` squeezed into the source id rules. */
export function collectorId(connectionId: string): string {
  const slug = connectionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-24)
  return `telegram-${slug === '' ? 'account' : slug}`
}

export interface UserCollectorOptions {
  connectionId: string
  log: Pick<ChannelLog, 'changes'>
  chats: ChatStore
  config: () => ConnectionConfig | undefined
  description?: string
}

export function telegramUserCollector(options: UserCollectorOptions): Collector {
  const { connectionId, log, chats } = options
  const id = collectorId(connectionId)

  /** Observe-only: the chat is in the allowlist with `wake: 'never'`. */
  const observed = (config: ConnectionConfig, conversationId: string): boolean => {
    const { chatId, topicId } = splitConversationId(conversationId)
    const scope = resolveScope(
      config,
      refOf(connectionId, { id: chatId, kind: kindOfChatId(chatId) }, topicId),
    )
    return scope.allowed && scope.wake === 'never'
  }

  const itemOf = (row: LogChange): CollectedItem => {
    const { chatId, topicId } = splitConversationId(row.conversationId)
    const chat = chats.get(connectionId, chatId)
    const isEvent = row.platformId.startsWith(ADMIN_EVENT_PREFIX)
    const kind = isEvent
      ? 'event'
      : row.deletedAt !== undefined
        ? 'delete'
        : row.editedAt !== undefined
          ? 'edit'
          : 'message'
    const plain = kind === 'message' || kind === 'event'
    const edited = row.edits?.at(-1)
    return {
      id: plain
        ? `${row.conversationId}:${row.platformId}`
        : `${row.conversationId}:${row.platformId}~${row.rev}`,
      channel: channelSegment(`${chat?.title ?? 'chat'}-${chatId.replace(/^-/, '')}`),
      at: row.at,
      kind,
      messageId: row.platformId,
      chat: chatId,
      ...(topicId === undefined ? {} : { topic: topicId }),
      ...(row.sender === undefined
        ? {}
        : {
            author: {
              id: row.sender.id,
              ...(row.sender.name === undefined ? {} : { name: row.sender.name }),
              ...(row.sender.username === undefined ? {} : { username: row.sender.username }),
            },
          }),
      text: row.text,
      ...(row.replyTo === undefined ? {} : { replyTo: row.replyTo.messageId }),
      ...(row.attachments.length === 0
        ? {}
        : {
            attachments: row.attachments.map((a) => ({ kind: a.kind, name: a.name, size: a.size })),
          }),
      ...(row.editedAt === undefined ? {} : { editedAt: new Date(row.editedAt).toISOString() }),
      ...(edited === undefined ? {} : { previousText: edited.text }),
      ...(row.deletedAt === undefined ? {} : { deletedAt: new Date(row.deletedAt).toISOString() }),
    }
  }

  return {
    id,
    description:
      options.description ??
      'Messages, edits and deletions of the observe-only chats of a Telegram account (channel log).',
    async poll(cursor, pollOptions) {
      let after = cursor === null ? 0 : Number(cursor) || 0
      const limit = Math.min(pollOptions?.limit ?? 500, 1000)
      const config = options.config()
      // pages with nothing to emit (other chats, chats that wake the agent) are skipped, not reported
      // as "nothing more": ingest would stop there and never move its cursor
      for (let pages = 0; pages < 50; pages++) {
        const rows = await log.changes(connectionId, after, limit)
        if (rows.length === 0)
          return { items: [], cursor: String(after) === '0' ? cursor : String(after) }
        after = (rows.at(-1) as LogChange).rev
        const items: CollectedItem[] = []
        if (config !== undefined) {
          for (const row of rows) if (observed(config, row.conversationId)) items.push(itemOf(row))
        }
        if (items.length > 0) return { items, cursor: String(after) }
      }
      return { items: [], cursor: String(after) }
    },
  }
}
