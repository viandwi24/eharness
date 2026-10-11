/** Known chats of a bot connection (`channel_known_chats`): what the bot has seen, no message text. */
import type { Database } from 'bun:sqlite'
import type { ConversationKind } from '../channels/types.ts'
import type { SeenChat } from './normalize.ts'

export interface KnownChat {
  connectionId: string
  chatId: string
  kind: ConversationKind
  title: string
  username: string | undefined
  forum: boolean
  topics: Record<string, string>
  /** What the bot is in the chat (`member`, `administrator`, `left`, `kicked`, ...), when known. */
  botStatus: string | undefined
  canPost: boolean | undefined
  firstSeen: number
  lastSeen: number
}

interface Row {
  connection_id: string
  chat_id: string
  kind: string
  title: string
  username: string | null
  forum: number
  topics: string
  bot_status: string | null
  can_post: number | null
  first_seen: number
  last_seen: number
}

const toKnown = (r: Row): KnownChat => ({
  connectionId: r.connection_id,
  chatId: r.chat_id,
  kind: r.kind as ConversationKind,
  title: r.title,
  username: r.username ?? undefined,
  forum: r.forum === 1,
  topics: JSON.parse(r.topics) as Record<string, string>,
  botStatus: r.bot_status ?? undefined,
  canPost: r.can_post === null ? undefined : r.can_post === 1,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
})

export interface KnownChatStore {
  /** Record what an update said about a chat (a topic name is merged, a title is refreshed). */
  see(connectionId: string, chat: SeenChat): void
  list(connectionId: string): KnownChat[]
  get(connectionId: string, chatId: string): KnownChat | undefined
  remove(connectionId: string): void
}

export function sqliteKnownChats(sqlite: Database): KnownChatStore {
  const get = sqlite.query<Row, [string, string]>(
    'SELECT * FROM channel_known_chats WHERE connection_id = ? AND chat_id = ?',
  )
  return {
    see(connectionId, chat) {
      const existing = get.get(connectionId, chat.chatId)
      const topics =
        existing === null ? {} : (JSON.parse(existing.topics) as Record<string, string>)
      if (
        chat.topic !== undefined &&
        (chat.topic.name !== undefined || topics[chat.topic.id] === undefined)
      ) {
        topics[chat.topic.id] = chat.topic.name ?? topics[chat.topic.id] ?? `Topic ${chat.topic.id}`
      }
      sqlite
        .query(
          `INSERT INTO channel_known_chats
             (connection_id, chat_id, kind, title, username, forum, topics, bot_status, can_post, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (connection_id, chat_id) DO UPDATE SET
             kind = excluded.kind, title = excluded.title, username = excluded.username,
             forum = MAX(forum, excluded.forum), topics = excluded.topics,
             bot_status = COALESCE(excluded.bot_status, bot_status),
             can_post = COALESCE(excluded.can_post, can_post),
             last_seen = MAX(last_seen, excluded.last_seen)`,
        )
        .run(
          connectionId,
          chat.chatId,
          chat.kind,
          chat.title,
          chat.username ?? null,
          chat.forum || chat.topic !== undefined ? 1 : 0,
          JSON.stringify(topics),
          chat.botStatus ?? null,
          chat.canPost === undefined ? null : chat.canPost ? 1 : 0,
          chat.at,
          chat.at,
        )
    },
    list: (connectionId) =>
      sqlite
        .query<Row, [string]>(
          'SELECT * FROM channel_known_chats WHERE connection_id = ? ORDER BY last_seen DESC',
        )
        .all(connectionId)
        .map(toKnown),
    get: (connectionId, chatId) => {
      const r = get.get(connectionId, chatId)
      return r === null ? undefined : toKnown(r)
    },
    remove: (connectionId) => {
      sqlite.query('DELETE FROM channel_known_chats WHERE connection_id = ?').run(connectionId)
    },
  }
}
