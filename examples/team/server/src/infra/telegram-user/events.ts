/**
 * The events a Telegram user account delivers (MTProto), with what Telegram really sends. Reactions
 * of other people (sent to an account only as counts) and button presses are left out. Shown on the
 * channel's Events page and in the trigger form.
 */
import type { AdapterEventType } from '../channels/types.ts'

export const TELEGRAM_ACCOUNT_EVENTS: readonly AdapterEventType[] = [
  { type: 'message.created', note: 'Messages of the chats chosen for ingest, and direct chats.' },
  { type: 'message.edited', note: 'Edits in the same chats.' },
  {
    type: 'message.deleted',
    note: 'As ids only (no text, no person). A deletion in a channel or supergroup names the chat; one in a private chat or basic group is matched through the stored log.',
  },
  { type: 'member.joined', note: 'When the account is an administrator of the chat.' },
  { type: 'member.left', note: 'When the account is an administrator of the chat.' },
  {
    type: 'member.updated',
    note: 'When the account is an administrator of the chat; promotions and demotions carry the new role.',
  },
  {
    type: 'member.join_requested',
    note: 'When the account is an administrator of the chat and the chat is chosen. The request is saved and answered with answer_join_request.',
  },
  {
    type: 'member.join_request_resolved',
    note: 'Answered with the account tool. An answer given by another admin or in the Telegram app is not reported.',
  },
  { type: 'node.created', note: 'Topics of a forum and chats seen in the dialog list.' },
  { type: 'node.updated', note: 'Topic titles.' },
  { type: 'node.state_changed', note: 'A chat became active, was left or archived.' },
  { type: 'node.migrated', note: 'A group became a supergroup.' },
]
