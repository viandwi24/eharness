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
import type { ChannelLog, LogChange } from '../channels/messages.ts'
import type { NodeStore } from '../channels/nodes.ts'
import type { ResolvedScope } from '../channels/policy.ts'
import { splitNativeId } from './normalize.ts'

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
  nodes: Pick<NodeStore, 'get' | 'byNative'>
  /** The effective settings of a node (undefined when the connection is not bound). */
  scopeOf: (nodeId: string) => ResolvedScope | undefined
  description?: string
}

export function telegramUserCollector(options: UserCollectorOptions): Collector {
  const { connectionId, log, nodes } = options
  const id = collectorId(connectionId)

  /** Observe-only: the node is in the allowlist with `wake: 'never'`. */
  const observed = (nodeId: string, memo: Map<string, boolean>): boolean => {
    const hit = memo.get(nodeId)
    if (hit !== undefined) return hit
    const scope = options.scopeOf(nodeId)
    const value = scope?.allowed === true && scope.wake === 'never'
    memo.set(nodeId, value)
    return value
  }

  const itemOf = (row: LogChange): CollectedItem => {
    const node = nodes.get(row.nodeId)
    const nativeNode = node?.nativeId ?? row.nodeId
    const { chatId, topicId } = splitNativeId(nativeNode)
    const chat = nodes.byNative(connectionId, chatId)
    const isEvent = row.kind === 'system' || row.nativeId.startsWith(ADMIN_EVENT_PREFIX)
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
      // the id keeps the shape of before L5 (`<chat>[/<topic>]:<message id>`): ingest dedupes by it
      id: plain ? `${nativeNode}:${row.nativeId}` : `${nativeNode}:${row.nativeId}~${row.rev}`,
      channel: channelSegment(`${chat?.title ?? 'chat'}-${chatId.replace(/^-/, '')}`),
      at: row.at,
      kind,
      messageId: row.nativeId,
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
      const memo = new Map<string, boolean>()
      // pages with nothing to emit (other chats, chats that wake the agent) are skipped, not reported
      // as "nothing more": ingest would stop there and never move its cursor
      for (let pages = 0; pages < 50; pages++) {
        const rows = await log.changes(connectionId, after, limit)
        if (rows.length === 0)
          return { items: [], cursor: String(after) === '0' ? cursor : String(after) }
        after = (rows.at(-1) as LogChange).rev
        const items: CollectedItem[] = []
        for (const row of rows) if (observed(row.nodeId, memo)) items.push(itemOf(row))
        if (items.length > 0) return { items, cursor: String(after) }
      }
      return { items: [], cursor: String(after) }
    },
  }
}
