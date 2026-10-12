/**
 * The MTProto layer the Telegram user transport talks to (P41 L4). Everything above this file
 * (login flow, adapter, backfill, admin log, service) sees only these plain types, so tests inject
 * a fake and never touch the network. `mtcute-client.ts` is the one real implementation.
 *
 * Chat ids are Bot API style strings ("marked" ids): a user is its positive id, a basic group is
 * `-<id>`, a channel or supergroup is `-100<id>`.
 */

export interface TgUser {
  id: string
  name: string
  username?: string
  phone?: string
  isBot: boolean
}

export type TgChatKind = 'dm' | 'group' | 'channel'

export interface TgChat {
  id: string
  kind: TgChatKind
  title: string
  username?: string
  forum: boolean
  /** The account is an administrator (or the creator) of the chat. */
  admin: boolean
  members?: number
}

export interface TgAttachment {
  id: string
  kind: 'image' | 'file' | 'audio' | 'video'
  name?: string
  mediaType?: string
  size?: number
}

export interface TgMessage {
  chat: { id: string; kind: TgChatKind; title: string; forum: boolean; username?: string }
  id: number
  /** The forum topic (its root message id), when the message is in one. */
  topicId?: number
  /** Epoch ms. */
  at: number
  editedAt?: number
  text: string
  sender?: { id: string; name: string; username?: string; isBot: boolean }
  /** Sent by this account (from any of its devices). */
  outgoing: boolean
  replyTo?: { id: number; text?: string; senderId?: string; senderName?: string }
  /** The message mentions this account (a mention entity or the platform's own flag). */
  mention: boolean
  /** The message mentions somebody else. */
  mentionsOthers: boolean
  attachments: TgAttachment[]
  /** A service message (joins, pins, title changes): never stored as a message. */
  service: boolean
}

/** A deletion: ids only. A channel (or supergroup) deletion names the chat; the common box does not. */
export interface TgDelete {
  ids: number[]
  chatId?: string
}

export interface TgAdminEvent {
  id: string
  at: number
  /** `delete` | `edit` | `ban` | `unban` | `promote` | `demote` | `join` | `leave` | `invite` | `pin` | `other`. */
  kind: string
  actor?: { id: string; name: string }
  target?: { id: string; name: string }
  messageId?: number
  text?: string
  previousText?: string
  detail?: string
}

export interface TgSentCode {
  phoneCodeHash: string
  type: string
  nextType: string
  timeoutSec?: number
}

export interface TgUpdateHandlers {
  message(message: TgMessage): void
  edit(message: TgMessage): void
  delete(deletion: TgDelete): void
  /** The connection to Telegram failed in a way the client cannot recover from itself. */
  error(error: unknown): void
}

export interface TgSendOptions {
  replyTo?: number
  topicId?: number
  silent?: boolean
  /** Stable per message: Telegram dedupes a send with the same key (`random_id`). */
  key?: string
}

export interface TgFile {
  name: string
  mediaType: string
  bytes: Uint8Array
}

export interface TgUserClient {
  /** `signedIn` when Telegram logs the number in without a code (a rare shortcut). */
  sendCode(phone: string): Promise<TgSentCode | { signedIn: TgUser }>
  resendCode(phone: string, phoneCodeHash: string): Promise<TgSentCode>
  /** Throws `SESSION_PASSWORD_NEEDED`, `PHONE_CODE_INVALID`, `PHONE_CODE_EXPIRED`. */
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<TgUser>
  /** Throws `PASSWORD_HASH_INVALID`. The password is used once and never stored. */
  checkPassword(password: string): Promise<TgUser>
  /**
   * Log in with a QR code: `onUrl` is called with every new token url (it rotates about every 30
   * seconds); `password` is awaited only when the account has 2FA.
   */
  signInQr(options: {
    onUrl(url: string, expiresAt: number): void
    onScanned?(): void
    password(): Promise<string>
    onBadPassword?(): void
    signal: AbortSignal
  }): Promise<TgUser>
  getMe(): Promise<TgUser>
  /** The session string (a credential: handle like a password). */
  exportSession(): Promise<string>
  /** The dialogs of the account (chats it is in, and people it talks to). */
  listChats(): Promise<TgChat[]>
  /** Open the updates loop. Must not read history or mark anything as read. */
  startUpdates(handlers: TgUpdateHandlers, options: { catchUp: boolean }): Promise<void>
  /** Stop the updates loop and close the connection (the session stays valid). */
  stop(): Promise<void>
  /** Messages of a chat, newest first, strictly older than `offsetId` when given. */
  history(chatId: string, options: { limit: number; offsetId?: number }): Promise<TgMessage[]>
  /** Messages by id (null = missing, deleted). */
  messagesById(chatId: string, ids: number[]): Promise<Array<TgMessage | null>>
  /** The moderation log of a chat (the account must be an admin), newest first. */
  adminLog(
    chatId: string,
    options: { minId?: string; maxId?: string; limit: number },
  ): Promise<TgAdminEvent[]>
  members(chatId: string, limit: number): Promise<TgUser[]>
  sendText(chatId: string, text: string, options?: TgSendOptions): Promise<{ id: number }>
  sendFiles(
    chatId: string,
    files: TgFile[],
    caption: string,
    options?: TgSendOptions,
  ): Promise<{ id: number }>
  editText(chatId: string, id: number, text: string): Promise<void>
  deleteMessages(chatId: string, ids: number[]): Promise<void>
  pin(chatId: string, id: number, pinned: boolean): Promise<void>
  react(chatId: string, id: number, emoji: string): Promise<void>
  download(
    chatId: string,
    id: number,
  ): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>
}

export interface TgClientParams {
  apiId: number
  apiHash: string
  /** A session string to continue; absent = a fresh login. */
  session?: string
}

/** Builds a client. Tests pass a fake; the server default is `createMtcuteClient`. */
export type TgClientFactory = (params: TgClientParams) => TgUserClient
