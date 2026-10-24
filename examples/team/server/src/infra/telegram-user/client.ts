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
  /** Its title, when the adapter knows it (filled from the topic cache, never by the client). */
  topicTitle?: string
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
/** A forum topic of a supergroup. */
export interface TgTopic {
  id: number
  title: string
  closed: boolean
}

/** A chat as `getChatInfo` reads it (more than the dialog list knows). */
export interface TgChatInfo extends TgChat {
  description?: string
  admins?: number
  linkedChatId?: string
  /** The account can list the members (hidden members groups say no). */
  canListMembers?: boolean
  /** Joining needs an admin's approval. */
  joinRequests?: boolean
  /** A channel signs its posts with the author's name. */
  signatures?: boolean
}

/** What members may do by default: `true` allows, `false` forbids, absent keeps the current value. */
export interface TgPermissionChange {
  sendMessages?: boolean
  sendMedia?: boolean
  sendStickers?: boolean
  sendPolls?: boolean
  embedLinks?: boolean
  inviteUsers?: boolean
  pinMessages?: boolean
  changeInfo?: boolean
  manageTopics?: boolean
}

/** An invite link as `getInviteLinks` reads it. */
export interface TgInviteLink {
  link: string
  title?: string
  primary: boolean
  revoked: boolean
  /** Epoch ms. */
  expiresAt?: number
  usageLimit?: number
  usage: number
  withApproval: boolean
  pendingRequests: number
}

/** Somebody waiting for an admin to let them in. */
export interface TgJoinRequest {
  user: TgUser
  at: number
  bio?: string
}

export interface TgContact extends TgUser {
  /** The person has the account in their contacts too (mutual). */
  mutual?: boolean
}

export type TgMemberStatus = 'creator' | 'admin' | 'member' | 'restricted' | 'banned' | 'left'

export interface TgMember {
  user: TgUser
  status: TgMemberStatus
  /** The admin title, when it has one. */
  title?: string
  joinedAt?: number
  /** Admins: the exact rights they hold (snake_case names, e.g. `change_info`). */
  rights?: string[]
  /** Restricted or banned members: what they may NOT do (snake_case names). */
  forbidden?: string[]
  /** Who promoted an admin. */
  promotedBy?: { id: string; name: string }
  /** The account may edit this admin's rights. */
  canEdit?: boolean
}

export interface TgPoll {
  question: string
  closed: boolean
  quiz: boolean
  multiple: boolean
  /** Voters are visible to admins and the creator of the poll. */
  public: boolean
  totalVoters: number
  options: Array<{
    text: string
    voters: number
    correct?: boolean
    recentVoters: Array<{ id: string; name: string }>
  }>
}

export interface TgMessageStat {
  id: number
  views?: number
  forwards?: number
  replies?: number
  hasComments?: boolean
  reactions: Array<{ emoji: string; count: number }>
}

/** What a public username or a t.me link resolves to (nothing is joined). */
export interface TgChatPreview {
  id?: string
  kind: TgChatKind | 'user'
  title: string
  username?: string
  members?: number
  description?: string
  /** Joining needs approval (invite links). */
  withApproval?: boolean
  /** The account is in it already. */
  joined?: boolean
}

/** Statistics as readable lines: label and the current and the previous period. */
export interface TgStats {
  kind: 'channel' | 'group'
  periodDays?: number
  lines: string[]
}

/** A scheduled message of the account (Telegram sends it at `at`, even when we are offline). */
export interface TgScheduled {
  id: number
  at: number
  text: string
  topicId?: number
}

export interface TgPollInput {
  question: string
  options: string[]
  multiple?: boolean
  /** Voters are visible (not possible in channels). */
  publicVoters?: boolean
  /** Quiz: the index of the right option. */
  correct?: number
}

export interface TgPostOptions {
  topicId?: number
  silent?: boolean
  /** Epoch ms: Telegram sends it then (a scheduled message). */
  at?: number
}

export interface TgRestrictions {
  sendMessages?: boolean
  sendMedia?: boolean
  sendPolls?: boolean
  sendOther?: boolean
  embedLinks?: boolean
  inviteUsers?: boolean
  pinMessages?: boolean
  changeInfo?: boolean
  manageTopics?: boolean
}

export interface TgDelete {
  ids: number[]
  chatId?: string
}

/** The admin rights the account may hand out: a safe subset, never `addAdmins`, never anonymous. */
export interface TgAdminRights {
  changeInfo?: boolean
  deleteMessages?: boolean
  banUsers?: boolean
  inviteUsers?: boolean
  pinMessages?: boolean
  manageTopics?: boolean
  manageCall?: boolean
  /** Add new admins (the receiving admin may promote others with rights up to its own). */
  addAdmins?: boolean
  /** The admin acts anonymously (their name is hidden behind the chat). */
  anonymous?: boolean
  /** Channels only: publish posts. */
  postMessages?: boolean
  /** Channels only: edit the posts of others. */
  editMessages?: boolean
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

/** What happened to a member of a chat the account administers (Telegram tells administrators only). */
export interface TgMemberUpdate {
  chat: { id: string; kind: TgChatKind; title: string; forum: boolean; username?: string }
  /** The member whose status changed. */
  user: TgUser
  /** Who did it (an administrator, or the member). */
  actor?: TgUser
  type:
    | 'joined'
    | 'added'
    | 'left'
    | 'kicked'
    | 'unkicked'
    | 'restricted'
    | 'unrestricted'
    | 'promoted'
    | 'demoted'
    | 'owner_changed'
    | 'other'
  /** The member's status after the change. */
  status: TgMemberStatus
  /** The invite link used to join, when there was one. */
  link?: string
  /** Epoch ms. */
  at: number
}

/** The pending join requests of a chat the account administers changed (who recently asked, and the total). */
export interface TgJoinRequestsUpdate {
  chat: { id: string; kind: TgChatKind; title: string; forum: boolean; username?: string }
  users: TgUser[]
  /** Pending requests the chat has now. */
  total: number
  /** Epoch ms (the update carries no date: the time it arrived). */
  at: number
}

export interface TgUpdateHandlers {
  message(message: TgMessage): void
  edit(message: TgMessage): void
  delete(deletion: TgDelete): void
  /** Optional: a member joined, left, or was promoted, demoted, restricted (administrators only). */
  member?(update: TgMemberUpdate): void
  /** Optional: join requests are pending in a chat the account administers. */
  joinRequests?(update: TgJoinRequestsUpdate): void
  /** The connection to Telegram failed in a way the client cannot recover from itself. */
  error(error: unknown): void
}

/** A mention inside a text (UTF-16 offsets): `@handle` text, or a name linked to the user id. */
export interface TgMention {
  offset: number
  length: number
  userId: string
  /** The text at the offset is `@handle` (pings by username); else a name linked to the id. */
  byHandle: boolean
}

export interface TgSendOptions {
  replyTo?: number
  topicId?: number
  silent?: boolean
  mentions?: TgMention[]
  /**
   * The text is Telegram HTML (bold, italic, code, links, `tg://user` mentions); `handles` are
   * `@username` mentions in it that get a mention entity. Bad HTML falls back to the plain text.
   */
  html?: { handles: string[] }
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
  /**
   * Messages of a chat, newest first, strictly older than `offsetId` when given. With `topicId`,
   * only that forum topic (Telegram's chat history has no topic filter of its own).
   */
  history(
    chatId: string,
    options: { limit: number; offsetId?: number; topicId?: number },
  ): Promise<TgMessage[]>
  /** Messages by id (null = missing, deleted). */
  messagesById(chatId: string, ids: number[]): Promise<Array<TgMessage | null>>
  /** The moderation log of a chat (the account must be an admin), newest first. */
  adminLog(
    chatId: string,
    options: { minId?: string; maxId?: string; limit: number },
  ): Promise<TgAdminEvent[]>
  members(chatId: string, limit: number): Promise<TgUser[]>
  // --- platform actions (the account's native tools, `actions.ts`) --------------------------
  getChatInfo?(chatId: string): Promise<TgChatInfo>
  /** A person by id or `@username` (a username lookup is rate limited by Telegram: use sparingly). */
  getUserInfo?(ref: string): Promise<TgUser>
  listMembers?(
    chatId: string,
    options: {
      type: 'recent' | 'admins' | 'banned' | 'restricted' | 'bots' | 'all'
      query?: string
      limit: number
    },
  ): Promise<{ total: number; members: TgMember[] }>
  /** Server-side search in one chat, newest first. */
  searchMessages?(
    chatId: string,
    options: {
      query: string
      fromUser?: string
      topicId?: number
      limit: number
      minDate?: number
      maxDate?: number
    },
  ): Promise<TgMessage[]>
  forwardMessages?(
    fromChatId: string,
    ids: number[],
    toChatId: string,
    options?: TgPostOptions & { dropAuthor?: boolean },
  ): Promise<number[]>
  sendPoll?(chatId: string, poll: TgPollInput, options?: TgPostOptions): Promise<{ id: number }>
  /** Text sent by Telegram at `options.at`. */
  scheduleText?(
    chatId: string,
    text: string,
    options: TgPostOptions & { at: number },
  ): Promise<{ id: number }>
  listScheduled?(chatId: string): Promise<TgScheduled[]>
  cancelScheduled?(chatId: string, ids: number[]): Promise<void>
  createTopic?(chatId: string, title: string): Promise<{ id: number }>
  editTopic?(chatId: string, topicId: number, title: string): Promise<void>
  setTopicClosed?(chatId: string, topicId: number, closed: boolean): Promise<void>
  banMember?(chatId: string, userId: string, untilMs?: number): Promise<void>
  unbanMember?(chatId: string, userId: string): Promise<void>
  /** Make a person an admin with exactly these rights (`editAdmin`); `title` is the badge. */
  promoteMember?(
    chatId: string,
    userId: string,
    rights: TgAdminRights,
    title?: string,
  ): Promise<void>
  /** Take every admin right away (the person stays a member). */
  demoteMember?(chatId: string, userId: string): Promise<void>
  restrictMember?(
    chatId: string,
    userId: string,
    restrictions: TgRestrictions,
    untilMs?: number,
  ): Promise<void>
  deleteMemberMessages?(chatId: string, userId: string): Promise<void>
  createInviteLink?(
    chatId: string,
    options: { expiresAt?: number; usageLimit?: number; withApproval?: boolean; title?: string },
  ): Promise<{ link: string }>
  /** The primary invite link of the account in a chat (created by Telegram when it has none). */
  primaryInviteLink?(chatId: string): Promise<{ link: string }>
  listInviteLinks?(
    chatId: string,
    options: { revoked: boolean; limit: number },
  ): Promise<TgInviteLink[]>
  /** `expiresAt: 0` removes the expiry, `usageLimit: 0` the limit. */
  editInviteLink?(
    chatId: string,
    link: string,
    options: { expiresAt?: number; usageLimit?: number; withApproval?: boolean; title?: string },
  ): Promise<TgInviteLink>
  revokeInviteLink?(chatId: string, link: string): Promise<void>
  listJoinRequests?(
    chatId: string,
    options: { limit: number; link?: string },
  ): Promise<TgJoinRequest[]>
  /** One person (`userId`) or everybody waiting (`all`, optionally of one `link`). */
  answerJoinRequests?(
    chatId: string,
    options: { action: 'approve' | 'decline'; userId?: string; all?: boolean; link?: string },
  ): Promise<void>
  // --- creating and managing chats ----------------------------------------------------------
  createSupergroup?(options: {
    title: string
    description?: string
    forum?: boolean
  }): Promise<TgChat>
  createChannel?(options: { title: string; description?: string }): Promise<TgChat>
  /**
   * Add one person to a group or channel. `added: false` = Telegram skipped them without failing
   * (their privacy settings); other refusals throw an RPC error (`USER_NOT_MUTUAL_CONTACT`, ...).
   */
  addMember?(chatId: string, userRef: string): Promise<{ added: boolean }>
  setChatTitle?(chatId: string, title: string): Promise<void>
  setChatDescription?(chatId: string, description: string): Promise<void>
  setChatPhoto?(chatId: string, file: TgFile): Promise<void>
  /** `null` removes the public username (the chat becomes private). */
  setChatUsername?(chatId: string, username: string | null): Promise<void>
  setJoinRequests?(chatId: string, enabled: boolean): Promise<void>
  setDefaultPermissions?(chatId: string, change: TgPermissionChange): Promise<void>
  /** Seconds between messages of one person: 0 (off), 10, 30, 60, 300, 900 or 3600. */
  setSlowMode?(chatId: string, seconds: number): Promise<void>
  setForum?(chatId: string, enabled: boolean): Promise<void>
  /** Delete a group or channel for everybody (the account must be the creator). */
  deleteChat?(chatId: string): Promise<void>
  setChannelSignatures?(chatId: string, enabled: boolean): Promise<void>
  /** Link a supergroup as the discussion group of a channel; `groupId: null` unlinks. */
  linkDiscussionGroup?(channelId: string, groupId: string | null): Promise<void>
  // --- members, settings, topics -----------------------------------------------------------
  getMember?(chatId: string, userId: string): Promise<TgMember | null>
  /** Remove a person now; they may join again (ban and unban in one). */
  kickMember?(chatId: string, userId: string): Promise<void>
  /** Auto-delete timer of new messages: 0 off, else seconds (86400, 604800, 2678400 ...). */
  setChatTtl?(chatId: string, seconds: number): Promise<void>
  setContentProtection?(chatId: string, enabled: boolean): Promise<void>
  /** Supergroups: hide the member list from ordinary members. */
  setMembersHidden?(chatId: string, hidden: boolean): Promise<void>
  /** Supergroups: new members see the history from before they joined. */
  setHistoryVisible?(chatId: string, visible: boolean): Promise<void>
  setReactions?(
    chatId: string,
    options: { mode: 'all' | 'none' | 'some'; emojis?: string[] },
  ): Promise<void>
  /** Default identity (a channel the account administers) to send as in a chat. */
  setDefaultSendAs?(chatId: string, asChatId: string): Promise<void>
  setTopicPinned?(chatId: string, topicId: number, pinned: boolean): Promise<void>
  deleteTopic?(chatId: string, topicId: number): Promise<void>
  setGeneralHidden?(chatId: string, hidden: boolean): Promise<void>
  // --- messages -------------------------------------------------------------------------------
  markRead?(chatId: string): Promise<void>
  /** `clear` = for the account only, `revoke` = for everybody where Telegram allows. */
  clearHistory?(chatId: string, mode: 'clear' | 'revoke'): Promise<void>
  pinWithOptions?(chatId: string, id: number, options: { notify: boolean }): Promise<void>
  unpinAll?(chatId: string, topicId?: number): Promise<void>
  getPoll?(chatId: string, id: number): Promise<TgPoll>
  stopPoll?(chatId: string, id: number): Promise<void>
  copyMessage?(
    fromChatId: string,
    id: number,
    toChatId: string,
    options?: { topicId?: number; silent?: boolean },
  ): Promise<{ id: number }>
  messageStats?(chatId: string, ids: number[]): Promise<TgMessageStat[]>
  /** A comment under a channel post (in the discussion group), or a reply when it is no post. */
  commentOnPost?(chatId: string, postId: number, text: string): Promise<{ id: number }>
  // --- discovery and the chat list ------------------------------------------------------------
  resolveChat?(ref: string): Promise<TgChatPreview>
  checkInviteLink?(link: string): Promise<TgChatPreview>
  chatStats?(chatId: string): Promise<TgStats>
  /** `untilMs` = until then; `null` = unmute; `Infinity` = for good. */
  muteChat?(chatId: string, untilMs: number | null): Promise<void>
  archiveChat?(chatId: string, archived: boolean): Promise<void>
  pinDialog?(chatId: string, pinned: boolean): Promise<void>
  // --- contacts -------------------------------------------------------------------------------
  addContact?(options: {
    user: string
    firstName: string
    lastName?: string
    phone?: string
    sharePhone: boolean
  }): Promise<TgUser>
  listContacts?(): Promise<TgContact[]>
  /** Join by invite link, `@username` or t.me link. */
  joinChat?(ref: string): Promise<{ status: 'joined'; chat: TgChat } | { status: 'requested' }>
  leaveChat?(chatId: string): Promise<void>

  /**
   * Forum topics of a supergroup: the ones named by `ids`, else the first `limit` (default 100).
   * Optional: a client without it leaves topics untitled.
   */
  forumTopics?(chatId: string, options?: { ids?: number[]; limit?: number }): Promise<TgTopic[]>
  sendText(chatId: string, text: string, options?: TgSendOptions): Promise<{ id: number }>
  sendFiles(
    chatId: string,
    files: TgFile[],
    caption: string,
    options?: TgSendOptions,
  ): Promise<{ id: number }>
  /** `html` = the text is Telegram HTML (as `TgSendOptions.html`). */
  editText(chatId: string, id: number, text: string, html?: { handles: string[] }): Promise<void>
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
