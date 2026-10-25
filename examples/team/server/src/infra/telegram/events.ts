/**
 * The events a Telegram bot delivers (Bot API), with what Telegram really sends. A type the Bot API
 * never reports (message deletions) is left out. Shown on the channel's Events page and in the
 * trigger form.
 */
import type { AdapterEventType } from '../channels/types.ts'

export const TELEGRAM_BOT_EVENTS: readonly AdapterEventType[] = [
  {
    type: 'message.created',
    note: 'Every message the bot receives: in a group with privacy mode on only mentions, replies and commands; everything when the bot is an admin.',
  },
  { type: 'message.edited', note: 'Edits of messages the bot received.' },
  {
    type: 'reaction.added',
    note: 'In chats where the bot is an administrator and in direct chats.',
  },
  { type: 'reaction.removed', note: 'Like reactions added.' },
  { type: 'member.joined', note: 'When the bot is an administrator of the chat.' },
  { type: 'member.left', note: 'When the bot is an administrator of the chat.' },
  { type: 'member.updated', note: 'When the bot is an administrator of the chat.' },
  {
    type: 'member.join_requested',
    note: 'When the bot is an administrator with the "invite users" right. The request is saved and answered with join_requests.',
  },
  {
    type: 'member.join_request_resolved',
    note: 'Answered with the bot tool, or approved by another admin (seen as the person joining). A decline by another admin is not reported by the Bot API.',
  },
  { type: 'node.created', note: 'The bot was added to a chat, or a topic was created.' },
  { type: 'node.updated', note: 'A title or a setting of a chat or topic changed.' },
  { type: 'node.state_changed', note: 'The bot was added, removed or blocked.' },
  { type: 'node.migrated', note: 'A group became a supergroup.' },
  { type: 'action', note: 'An inline button was pressed.' },
]
