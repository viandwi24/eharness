/**
 * Telegram RPC errors by what the transport does about them. mtcute throws `RpcError` with a
 * `text` such as `FLOOD_WAIT_30`; the fake client in tests throws the same shape, so everything
 * is classified from the text alone.
 */

export type TgErrorKind =
  /** FLOOD_WAIT_X, FLOOD_PREMIUM_WAIT_X, SLOWMODE_WAIT_X: wait `seconds`, never retry tight. */
  | { kind: 'flood'; seconds: number; text: string }
  /** PEER_FLOOD and friends: the account is flagged for spam. Stop sending, alert a human. */
  | { kind: 'peer-flood'; text: string }
  /** The session is gone (revoked, deactivated, logged out elsewhere): reconnect needed. */
  | { kind: 'auth-lost'; text: string }
  /** Another client uses the same session: both die. Reconnect needed. */
  | { kind: 'duplicated'; text: string }
  | { kind: 'code-invalid'; text: string }
  | { kind: 'code-expired'; text: string }
  | { kind: 'password-needed'; text: string }
  | { kind: 'password-invalid'; text: string }
  | { kind: 'phone-invalid'; text: string }
  | { kind: 'app-invalid'; text: string }
  /** The request is wrong or not permitted (no rights, blocked, bad id): never retried. */
  | { kind: 'invalid'; text: string; detail?: string }
  | { kind: 'transient'; text: string }

export class TgRpcError extends Error {
  readonly text: string
  constructor(text: string, message?: string) {
    super(message ?? text)
    this.name = 'RpcError'
    this.text = text
  }
}

/** Fields where mtcute keeps the number it cut out of an RPC text (`FLOOD_WAIT_%d` + `seconds`). */
const NUMBER_FIELDS = ['seconds', 'duration', 'newDc', 'dc', 'codeLength', 'which'] as const

/**
 * The RPC text of an error (`FLOOD_WAIT_30`), or its message when it has none. mtcute rewrites
 * `FLOOD_WAIT_30` to `FLOOD_WAIT_%d` and keeps the 30 in `seconds`: the number is put back.
 */
export function rpcText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const t = (error as { text?: unknown }).text
    if (typeof t === 'string' && t !== '') {
      if (!t.includes('%d')) return t
      const o = error as Record<string, unknown>
      const n = NUMBER_FIELDS.map((k) => o[k]).find((v) => typeof v === 'number')
      return n === undefined ? t : t.replace('%d', String(n))
    }
    const m = (error as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return String(error)
}

const AUTH_LOST = new Set([
  'AUTH_KEY_UNREGISTERED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',
  'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN',
  'AUTH_KEY_INVALID',
  'AUTH_KEY_PERM_EMPTY',
])
const INVALID = [
  'CHAT_WRITE_FORBIDDEN',
  'CHAT_ADMIN_REQUIRED',
  'CHANNEL_PRIVATE',
  'CHAT_RESTRICTED',
  'USER_IS_BLOCKED',
  'USER_PRIVACY_RESTRICTED',
  'PEER_ID_INVALID',
  'MESSAGE_ID_INVALID',
  'MESSAGE_NOT_MODIFIED',
  'MESSAGE_EMPTY',
  'MESSAGE_TOO_LONG',
  'MESSAGE_EDIT_TIME_EXPIRED',
  'MESSAGE_AUTHOR_REQUIRED',
  'INPUT_USER_DEACTIVATED',
  'USER_BANNED_IN_CHANNEL',
  'CHAT_ID_INVALID',
  'REACTION_INVALID',
  'MEDIA_EMPTY',
  'RIGHT_FORBIDDEN',
  'USER_NOT_MUTUAL_CONTACT',
  'ADMINS_TOO_MUCH',
  'USER_CREATOR',
  'USER_ADMIN_INVALID',
  'USER_NOT_PARTICIPANT',
  'USER_ID_INVALID',
  'USER_BOT',
  'BOT_CHANNELS_NA',
  'ADMIN_RANK_INVALID',
  'ADMIN_RANK_EMOJI_NOT_ALLOWED',
  'CHAT_ADMIN_INVITE_REQUIRED',
  'CHAT_NOT_MODIFIED',
  'CHANNEL_INVALID',
  'PARTICIPANT_ID_INVALID',
  'USER_PRIVACY_RESTRICTED',
  'USER_BANNED_IN_CHANNEL',
  'USERNAME_OCCUPIED',
  'USERNAME_INVALID',
  'USERNAME_NOT_MODIFIED',
  'USERNAME_NOT_OCCUPIED',
  'USERNAME_PURCHASE_AVAILABLE',
  'CHANNELS_ADMIN_PUBLIC_TOO_MUCH',
  'CHANNELS_ADMIN_LOCATED_TOO_MUCH',
  'CHANNELS_TOO_MUCH',
  'USER_CHANNELS_TOO_MUCH',
  'USER_KICKED',
  'USER_ALREADY_PARTICIPANT',
  'USERS_TOO_MUCH',
  'USER_RESTRICTED',
  'CHAT_MEMBER_ADD_FAILED',
  'CHAT_ABOUT_TOO_LONG',
  'CHAT_ABOUT_NOT_MODIFIED',
  'CHAT_TITLE_EMPTY',
  'CHAT_CREATOR_REQUIRED',
  'CHANNEL_TOO_LARGE',
  'CHAT_LINK_EXISTS',
  'LINK_NOT_MODIFIED',
  'BROADCAST_ID_INVALID',
  'MEGAGROUP_ID_INVALID',
  'MEGAGROUP_PREHISTORY_HIDDEN',
  'CHANNEL_FORUM_MISSING',
  'INVITE_HASH_EXPIRED',
  'INVITE_HASH_INVALID',
  'INVITE_HASH_EMPTY',
  'INVITE_REQUEST_SENT',
  'HIDE_REQUESTER_MISSING',
  'CHAT_INVITE_PERMANENT',
  'EXPIRE_DATE_INVALID',
  'USAGE_LIMIT_INVALID',
  'CONTACT_ID_INVALID',
  'CONTACT_NAME_EMPTY',
  'PASSWORD_MISSING',
  'BROADCAST_REQUIRED',
  'PARTICIPANTS_TOO_FEW',
  'POLL_VOTE_REQUIRED',
  'MESSAGE_POLL_CLOSED',
  'MESSAGE_AUTHOR_REQUIRED',
  'CHANNEL_PRIVATE',
  'REACTIONS_TOO_MANY',
  'CHAT_NOT_MODIFIED',
  'TTL_PERIOD_INVALID',
  'BOT_METHOD_INVALID',
  'SEND_AS_PEER_INVALID',
  'TOPIC_NOT_MODIFIED',
  'TOPIC_ID_INVALID',
  'MSG_ID_INVALID',
  'STATS_MIGRATE',
]

/** Sentences for refusals a person (or the model) has to act on. */
const INVALID_DETAIL: Array<[string, string]> = [
  [
    'USER_PRIVACY_RESTRICTED',
    "This person's privacy settings do not let this account add them to groups (USER_PRIVACY_RESTRICTED). Send them an invite link instead.",
  ],
  [
    'USER_BANNED_IN_CHANNEL',
    'This account is limited from adding people to chats right now, or that person is banned in the chat (USER_BANNED_IN_CHANNEL).',
  ],
  ['USERNAME_OCCUPIED', 'That public username is already taken (USERNAME_OCCUPIED). Pick another.'],
  [
    'USERNAME_INVALID',
    'That username is not valid (USERNAME_INVALID): 5 to 32 letters, digits or underscores, starting with a letter.',
  ],
  ['USERNAME_NOT_MODIFIED', 'The chat already has exactly that username (USERNAME_NOT_MODIFIED).'],
  ['USERNAME_NOT_OCCUPIED', 'No chat or person has that username (USERNAME_NOT_OCCUPIED).'],
  [
    'USERNAME_PURCHASE_AVAILABLE',
    'That username is reserved and can only be bought on Fragment (USERNAME_PURCHASE_AVAILABLE). Pick another.',
  ],
  [
    'CHANNELS_ADMIN_PUBLIC_TOO_MUCH',
    'This account already owns the most public chats Telegram allows (CHANNELS_ADMIN_PUBLIC_TOO_MUCH). Make one of them private or delete it first.',
  ],
  [
    'CHANNELS_ADMIN_LOCATED_TOO_MUCH',
    'This account already administers the most location-based chats Telegram allows (CHANNELS_ADMIN_LOCATED_TOO_MUCH).',
  ],
  [
    'CHANNELS_TOO_MUCH',
    'This account is already in the most chats Telegram allows (CHANNELS_TOO_MUCH). Leave some first.',
  ],
  [
    'USER_CHANNELS_TOO_MUCH',
    'That person is already in the most chats Telegram allows (USER_CHANNELS_TOO_MUCH): they cannot be added or join by link until they leave one.',
  ],
  [
    'USER_KICKED',
    'That person was removed from this chat and is banned there (USER_KICKED). unban_member lets them back in first.',
  ],
  ['USER_ALREADY_PARTICIPANT', 'That person is already in the chat (USER_ALREADY_PARTICIPANT).'],
  ['USERS_TOO_MUCH', 'The chat is full (USERS_TOO_MUCH).'],
  [
    'USER_RESTRICTED',
    'Telegram limits this account from adding people or creating chats right now (USER_RESTRICTED). Check the account in the Telegram app.',
  ],
  [
    'CHAT_MEMBER_ADD_FAILED',
    'Telegram could not add that person (CHAT_MEMBER_ADD_FAILED). Try an invite link instead.',
  ],
  [
    'CHAT_ABOUT_TOO_LONG',
    'The description is too long: at most 255 characters (CHAT_ABOUT_TOO_LONG).',
  ],
  ['CHAT_ABOUT_NOT_MODIFIED', 'The description is already exactly that (CHAT_ABOUT_NOT_MODIFIED).'],
  ['CHAT_TITLE_EMPTY', 'The title is empty (CHAT_TITLE_EMPTY).'],
  [
    'CHAT_CREATOR_REQUIRED',
    'Only the creator of the chat can do this (CHAT_CREATOR_REQUIRED). This account did not create it.',
  ],
  ['CHANNEL_TOO_LARGE', 'The chat is too large for this change (CHANNEL_TOO_LARGE).'],
  [
    'CHAT_LINK_EXISTS',
    'That channel is already linked to a discussion group, or the group to a channel (CHAT_LINK_EXISTS). Unlink first.',
  ],
  ['LINK_NOT_MODIFIED', 'Nothing changed: that link already exists (LINK_NOT_MODIFIED).'],
  ['BROADCAST_ID_INVALID', 'The first chat has to be a broadcast channel (BROADCAST_ID_INVALID).'],
  ['MEGAGROUP_ID_INVALID', 'The discussion chat has to be a supergroup (MEGAGROUP_ID_INVALID).'],
  [
    'MEGAGROUP_PREHISTORY_HIDDEN',
    'A group with hidden history cannot be a discussion group (MEGAGROUP_PREHISTORY_HIDDEN). Make its history visible first.',
  ],
  ['CHANNEL_FORUM_MISSING', 'The chat is not a forum (CHANNEL_FORUM_MISSING).'],
  ['INVITE_HASH_EXPIRED', 'That invite link has expired or was revoked (INVITE_HASH_EXPIRED).'],
  ['INVITE_HASH_INVALID', 'That is not a valid invite link (INVITE_HASH_INVALID).'],
  ['INVITE_HASH_EMPTY', 'That invite link is empty (INVITE_HASH_EMPTY).'],
  [
    'INVITE_REQUEST_SENT',
    'A join request was sent: an admin of that chat has to approve it (INVITE_REQUEST_SENT).',
  ],
  ['HIDE_REQUESTER_MISSING', 'That person has no pending join request (HIDE_REQUESTER_MISSING).'],
  [
    'CHAT_INVITE_PERMANENT',
    'The primary invite link cannot be edited; create another one (CHAT_INVITE_PERMANENT).',
  ],
  [
    'EXPIRE_DATE_INVALID',
    'That expiry date is not accepted (EXPIRE_DATE_INVALID): it must be in the future.',
  ],
  ['USAGE_LIMIT_INVALID', 'That usage limit is not accepted (USAGE_LIMIT_INVALID): 1 to 99999.'],
  [
    'CONTACT_ID_INVALID',
    'Telegram does not know that person as a contact target (CONTACT_ID_INVALID).',
  ],
  ['CONTACT_NAME_EMPTY', 'A contact needs a first name (CONTACT_NAME_EMPTY).'],
  ['PASSWORD_MISSING', 'The account has no two-step verification password (PASSWORD_MISSING).'],
  ['BROADCAST_REQUIRED', 'This works only in channels, not in groups (BROADCAST_REQUIRED).'],
  [
    'PARTICIPANTS_TOO_FEW',
    'The chat is too small for statistics (PARTICIPANTS_TOO_FEW): Telegram needs about 500 members.',
  ],
  [
    'STATS_MIGRATE',
    'Statistics for that chat live on another Telegram server this client cannot reach (STATS_MIGRATE).',
  ],
  [
    'POLL_VOTE_REQUIRED',
    'Votes are hidden until you vote or the poll closes (POLL_VOTE_REQUIRED).',
  ],
  ['MESSAGE_POLL_CLOSED', 'That poll is already closed (MESSAGE_POLL_CLOSED).'],
  ['MESSAGE_AUTHOR_REQUIRED', 'Only the author of a poll can close it (MESSAGE_AUTHOR_REQUIRED).'],
  [
    'CHANNEL_PRIVATE',
    'The account cannot see that chat (CHANNEL_PRIVATE): it is private or the account was removed.',
  ],
  ['REACTIONS_TOO_MANY', 'Too many reactions in the list (REACTIONS_TOO_MANY).'],
  ['CHAT_NOT_MODIFIED', 'Nothing changed: the chat already has that setting (CHAT_NOT_MODIFIED).'],
  [
    'TTL_PERIOD_INVALID',
    'That auto-delete period is not accepted (TTL_PERIOD_INVALID): use 1 day, 1 week, 1 month or off.',
  ],
  ['BOT_METHOD_INVALID', 'Telegram does not allow that here (BOT_METHOD_INVALID).'],
  ['SEND_AS_PEER_INVALID', 'That chat cannot be used to send as (SEND_AS_PEER_INVALID).'],
  ['TOPIC_NOT_MODIFIED', 'Nothing changed for that topic (TOPIC_NOT_MODIFIED).'],
  ['TOPIC_ID_INVALID', 'That topic does not exist (TOPIC_ID_INVALID).'],
  ['MSG_ID_INVALID', 'That message does not exist in this chat (MSG_ID_INVALID).'],
  [
    'CHAT_ADMIN_REQUIRED',
    'This account is not an admin of that chat, or lacks the admin right this needs (CHAT_ADMIN_REQUIRED).',
  ],
  [
    'RIGHT_FORBIDDEN',
    'The account may not grant one of those rights: an admin can only give rights it holds itself (RIGHT_FORBIDDEN).',
  ],
  [
    'USER_NOT_MUTUAL_CONTACT',
    'Telegram only lets an admin add this person if they are a mutual contact or already in the chat (USER_NOT_MUTUAL_CONTACT).',
  ],
  [
    'ADMINS_TOO_MUCH',
    'The chat already has the most admins Telegram allows (ADMINS_TOO_MUCH). Demote one first.',
  ],
  ['USER_CREATOR', 'That person created the chat: their rights cannot be changed (USER_CREATOR).'],
  [
    'USER_ADMIN_INVALID',
    'That person is an admin who was not promoted by this account: only the creator, or the admin who promoted them, can change them (USER_ADMIN_INVALID).',
  ],
  ['USER_NOT_PARTICIPANT', 'That person is not a member of the chat (USER_NOT_PARTICIPANT).'],
  ['USER_BOT', 'Telegram does not allow a bot here (USER_BOT / BOT_CHANNELS_NA).'],
  ['BOT_CHANNELS_NA', 'Telegram does not allow a bot here (BOT_CHANNELS_NA).'],
  [
    'ADMIN_RANK_INVALID',
    'The admin title is not accepted: at most 16 characters (ADMIN_RANK_INVALID).',
  ],
  [
    'ADMIN_RANK_EMOJI_NOT_ALLOWED',
    'The admin title may not contain emoji (ADMIN_RANK_EMOJI_NOT_ALLOWED).',
  ],
  [
    'CHAT_ADMIN_INVITE_REQUIRED',
    'The account needs the right to invite users to do that (CHAT_ADMIN_INVITE_REQUIRED).',
  ],
  [
    'CHAT_NOT_MODIFIED',
    'Nothing changed: the person already has exactly these rights (CHAT_NOT_MODIFIED).',
  ],
]

/**
 * Request and content errors: the one message (or file) is wrong, the account is fine. They fail
 * that message only and never count toward the outbound breaker. The auth-lost codes are
 * classified before this runs.
 */
const CONTENT_PREFIXES = ['PHOTO_', 'MEDIA_', 'FILE_', 'IMAGE_', 'WEBPAGE_']
const CONTENT_SUFFIXES = ['_INVALID', '_EMPTY', '_TOO_LONG', '_TOO_BIG']

/** The RPC code at the start of a text (`PHOTO_EXT_INVALID`), when the text is one. */
const rpcCodeOf = (upper: string): string | undefined =>
  /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])/.exec(upper)?.[1]

function contentError(upper: string): { text: string; detail: string } | undefined {
  const code = rpcCodeOf(upper)
  if (code === undefined) return undefined
  if (
    !CONTENT_PREFIXES.some((p) => code.startsWith(p)) &&
    !CONTENT_SUFFIXES.some((s) => code.endsWith(s))
  ) {
    return undefined
  }
  if (code.startsWith('PHOTO_') || code === 'IMAGE_PROCESS_FAILED') {
    return {
      text: code,
      detail: `Telegram does not accept this file as a photo (${code}). Send it as a document instead.`,
    }
  }
  if (code.startsWith('FILE_') || code.startsWith('MEDIA_') || code.startsWith('IMAGE_')) {
    return {
      text: code,
      detail: `Telegram does not accept this file (${code}): it may be empty, too big or damaged. The message was not sent.`,
    }
  }
  return {
    text: code,
    detail: `Telegram did not accept this message (${code}); it was not sent. Check its text and attachments.`,
  }
}

/** The sentence for a chat or person the account has no access data for (mtcute's peer cache). */
export function unknownPeerDetail(text: string): string {
  const id = /Peer (-?\d+)/i.exec(text)?.[1]
  return `Telegram does not let this account reach ${id === undefined ? 'that chat' : `the chat or person ${id}`}: it is not among the account's conversations (it has to be a chat the account is a member of, or a person who wrote to it). A chat joined a moment ago may need a minute; otherwise it cannot be read or written from this account.`
}

/** Classify an error thrown by the client. */
export function classifyError(error: unknown): TgErrorKind {
  const text = rpcText(error)
  const upper = text.toUpperCase()
  if (/not found in local cache/i.test(text)) {
    return { kind: 'invalid', text: 'PEER_UNKNOWN', detail: unknownPeerDetail(text) }
  }
  const wait = /^(?:FLOOD_(?:PREMIUM_)?WAIT|SLOWMODE_WAIT)_(\d+)/.exec(upper)
  if (wait !== null) return { kind: 'flood', seconds: Number(wait[1]), text: upper }
  if (upper.startsWith('PEER_FLOOD')) return { kind: 'peer-flood', text: upper }
  if (upper.startsWith('AUTH_KEY_DUPLICATED')) return { kind: 'duplicated', text: upper }
  if (
    AUTH_LOST.has(upper.split(/\W/)[0] ?? '') ||
    [...AUTH_LOST].some((c) => upper.startsWith(c))
  ) {
    return { kind: 'auth-lost', text: upper }
  }
  if (upper.startsWith('PHONE_CODE_INVALID') || upper.startsWith('PHONE_CODE_EMPTY')) {
    return { kind: 'code-invalid', text: upper }
  }
  if (upper.startsWith('PHONE_CODE_EXPIRED')) return { kind: 'code-expired', text: upper }
  if (upper.startsWith('SESSION_PASSWORD_NEEDED')) return { kind: 'password-needed', text: upper }
  if (upper.startsWith('PASSWORD_HASH_INVALID')) return { kind: 'password-invalid', text: upper }
  if (upper.startsWith('PHONE_NUMBER_INVALID') || upper.startsWith('PHONE_NUMBER_BANNED')) {
    return { kind: 'phone-invalid', text: upper }
  }
  if (upper.startsWith('API_ID_INVALID') || upper.startsWith('API_ID_PUBLISHED_FLOOD')) {
    return { kind: 'app-invalid', text: upper }
  }
  if (INVALID.some((c) => upper.startsWith(c))) {
    const detail = INVALID_DETAIL.find(([c]) => upper.startsWith(c))?.[1]
    return { kind: 'invalid', text: upper, ...(detail === undefined ? {} : { detail }) }
  }
  const content = contentError(upper)
  if (content !== undefined) return { kind: 'invalid', ...content }
  return { kind: 'transient', text: text.slice(0, 200) }
}

/** A person-readable sentence for the errors a flow or the Channels page shows. */
export function describeError(kind: TgErrorKind): string {
  switch (kind.kind) {
    case 'flood':
      return `Telegram asked the account to slow down (${kind.text}); it waits ${kind.seconds} s.`
    case 'peer-flood':
      return 'Telegram limits this account for sending too many messages to people (PEER_FLOOD). Sending is paused: check the account in the Telegram app.'
    case 'auth-lost':
      return 'Telegram ended this session (the account was logged out, the session revoked or the account deactivated). Sign in again.'
    case 'duplicated':
      return 'Telegram saw the same session used from two places at once and ended it (AUTH_KEY_DUPLICATED). Only one process may run an account. Sign in again.'
    case 'code-invalid':
      return 'That code is not right.'
    case 'code-expired':
      return 'That code has expired. Ask for a new one.'
    case 'password-needed':
      return 'This account has two-step verification: enter its password.'
    case 'password-invalid':
      return 'That password is not right.'
    case 'phone-invalid':
      return 'Telegram does not accept this phone number. Use the international format, for example +62812.'
    case 'app-invalid':
      return 'Telegram rejected the api_id / api_hash. Check them at my.telegram.org/apps.'
    case 'invalid':
      return kind.detail ?? `Telegram refused the request (${kind.text}).`
    case 'transient':
      return `Telegram request failed: ${kind.text}`
  }
}

/**
 * A short heading for a failed sign-in step, so the error view says what went wrong ("Wrong code")
 * and not just "Could not connect". The flow error view has no title field (it is part of the
 * library's flow types), so the connector puts it before the message as `<Title>: <message>`;
 * `splitErrorTitle` (web) reads it back.
 */
export function errorTitle(kind: TgErrorKind): string {
  switch (kind.kind) {
    case 'flood':
      return `Too many tries, wait ${Math.max(1, Math.ceil(kind.seconds / 60))} min`
    case 'peer-flood':
      return 'Sending is limited'
    case 'auth-lost':
      return 'Session ended'
    case 'duplicated':
      return 'Session in use elsewhere'
    case 'code-invalid':
      return 'Wrong code'
    case 'code-expired':
      return 'Code expired'
    case 'password-needed':
      return 'Password needed'
    case 'password-invalid':
      return 'Wrong password'
    case 'phone-invalid':
      return 'Phone number not accepted'
    case 'app-invalid':
      return 'api_id or api_hash rejected'
    case 'invalid':
      return 'Telegram refused the request'
    case 'transient':
      return 'Telegram could not be reached'
  }
}

/** `describeError` with its heading in front: `Wrong code: That code is not right.` */
export const describeErrorTitled = (kind: TgErrorKind): string =>
  `${errorTitle(kind)}: ${describeError(kind)}`
