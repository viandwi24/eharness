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

/** The RPC text of an error (`FLOOD_WAIT_30`), or its message when it has none. */
export function rpcText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const t = (error as { text?: unknown }).text
    if (typeof t === 'string' && t !== '') return t
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
]

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
  if (INVALID.some((c) => upper.startsWith(c))) return { kind: 'invalid', text: upper }
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
