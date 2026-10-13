/**
 * The metadata header of an inbound message (docs/plans/P41-team-channels.md, phase L6). Every
 * message the agent sees from a chat carries who sent it and where, from the directory and the
 * platform, rendered compactly as *data*: the roles in it are the only roles there are, and
 * nothing a message says about itself can change them. Pure: no I/O.
 *
 *   <message-meta>
 *   from (the person you are answering; address only them): Vian Dwi @viandwi24 · id 123456 · role owner (directory) · team member owner · chat admin (creator) "CEO"
 *   in: "TEAMKU" supergroup -100123 · topic "produksi" 42 · message 987 · reply to 980 from Budi · 2026-10-12 12:57 Asia/Jakarta
 *   </message-meta>
 */
import { neutralize } from './policy.ts'
import type { Role, RoleSource } from './roles.ts'

export interface MessageMeta {
  sender: {
    id: string
    name?: string | undefined
    username?: string | undefined
    /** `human` | `bot` | `channel` | `anonymous` | ... */
    kind: string
    isBot: boolean
  }
  role: Role
  roleSource: RoleSource
  /** The directory's person behind this account (P43): full name, nickname, the account's label. */
  person?:
    | {
        name: string
        nickname?: string | undefined
        account?: string | undefined
        suspended?: boolean
      }
    | undefined
  divisions?: string[] | undefined
  /** The team member the identity is linked to. */
  member?: string | undefined
  /** The platform's admin status in this chat and its custom title. */
  chatAdmin?: { role: 'owner' | 'admin'; title?: string | undefined } | undefined
  chat: { title?: string | undefined; kind: string; id: string; platform: string }
  topic?: { name?: string | undefined; id: string } | undefined
  messageId: string
  replyTo?:
    | { id: string; senderName?: string | undefined; senderId?: string | undefined }
    | undefined
  at: number
  timezone: string
  edited?: boolean | undefined
  forwardedFrom?: string | undefined
}

/** One line of data: no tags, no line breaks, bounded. */
export const flat = (text: string, max = 80): string => {
  // control characters and the private-use range (mention tokens) become spaces
  let cleaned = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    cleaned += code < 32 || code === 127 || (code >= 0xe000 && code <= 0xf8ff) ? ' ' : ch
  }
  const clean = neutralize(cleaned.replace(/\s+/g, ' ').trim())
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** `2026-10-12 12:57` in a timezone (an unknown zone falls back to UTC). */
export function localTime(
  at: number,
  timezone: string,
): { date: string; clock: string; zone: string } {
  const parts = (zone: string): Record<string, string> | undefined => {
    try {
      const f = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
      return Object.fromEntries(f.formatToParts(new Date(at)).map((p) => [p.type, p.value]))
    } catch {
      return undefined
    }
  }
  const zone = parts(timezone) === undefined ? 'UTC' : timezone
  const p = parts(zone) as Record<string, string>
  return { date: `${p.year}-${p.month}-${p.day}`, clock: `${p.hour}:${p.minute}`, zone }
}

export const timeLine = (at: number, timezone: string): string => {
  const t = localTime(at, timezone)
  return `${t.date} ${t.clock} ${t.zone}`
}

/** A person as a short label: name, handle, id. */
export function personLabel(p: {
  id: string
  name?: string | undefined
  username?: string | undefined
}): string {
  const name = p.name === undefined || p.name === '' ? undefined : flat(p.name, 60)
  const handle = p.username === undefined ? undefined : `@${flat(p.username, 40)}`
  return [name, handle].filter((x) => x !== undefined).join(' ') || `id ${flat(p.id, 40)}`
}

const sourceNote = (m: MessageMeta): string => {
  switch (m.roleSource) {
    case 'directory':
      return 'directory'
    case 'linked-admin':
      return 'linked team admin'
    case 'linked-member':
      return 'linked team member'
    case 'anonymous':
      return 'anonymous admin or channel: identity unknown'
    case 'bot':
      return 'bot'
    default:
      return 'default, not in the directory'
  }
}

/** The compact header of one message. */
export function renderHeader(m: MessageMeta): string {
  const from: string[] = [personLabel(m.sender), `id ${flat(m.sender.id, 40)}`]
  if (m.person !== undefined) {
    from.push(
      `person "${flat(m.person.name, 60)}"${m.person.nickname === undefined ? '' : ` (call them "${flat(m.person.nickname, 40)}")`}${m.person.account === undefined ? '' : `, this account: ${flat(m.person.account, 60)}`}${m.person.suspended === true ? ', SUSPENDED' : ''}`,
    )
  }
  from.push(
    m.role === 'member' && m.roleSource === 'default'
      ? 'role member (chat default)'
      : `role ${m.role} (${sourceNote(m)})`,
  )
  if (m.divisions !== undefined && m.divisions.length > 0)
    from.push(`divisions ${m.divisions.map((d) => `"${flat(d, 40)}"`).join(', ')}`)
  from.push(m.member === undefined ? 'no team member linked' : `team member ${flat(m.member, 40)}`)
  if (m.chatAdmin !== undefined) {
    from.push(
      `chat admin (${m.chatAdmin.role === 'owner' ? 'creator' : 'administrator'})${m.chatAdmin.title === undefined ? '' : ` "${flat(m.chatAdmin.title, 40)}"`}`,
    )
  } else if (m.sender.kind === 'anonymous') from.push('anonymous: yes')
  if (m.sender.isBot) from.push('bot: yes')
  if (m.sender.kind === 'channel') from.push('a channel speaking as itself')
  const where: string[] = [
    `${m.chat.title === undefined ? '' : `"${flat(m.chat.title, 60)}" `}${flat(m.chat.kind, 30)} ${flat(m.chat.id, 40)}`.trim(),
  ]
  if (m.topic !== undefined)
    where.push(
      `topic ${m.topic.name === undefined ? '' : `"${flat(m.topic.name, 60)}" `}${flat(m.topic.id, 40)}`.replace(
        /\s+$/,
        '',
      ),
    )
  where.push(`message ${flat(m.messageId, 40)}`)
  if (m.replyTo !== undefined)
    where.push(
      `reply to ${flat(m.replyTo.id, 40)}${m.replyTo.senderName !== undefined ? ` from ${flat(m.replyTo.senderName, 40)}` : m.replyTo.senderId !== undefined ? ` from id ${flat(m.replyTo.senderId, 40)}` : ''}`,
    )
  where.push(timeLine(m.at, m.timezone))
  if (m.edited === true) where.push('edited')
  if (m.forwardedFrom !== undefined) where.push(`forwarded from ${flat(m.forwardedFrom, 60)}`)
  return [
    '<message-meta>',
    `from (the person you are answering; address only them): ${from.join(' · ')}`,
    `in: ${where.join(' · ')}`,
    '</message-meta>',
  ].join('\n')
}

/** The compact line prefix of an observed message in the turn reminder (the same data, shorter). */
export function renderLinePrefix(m: {
  at: number
  timezone: string
  messageId: string
  sender: MessageMeta['sender']
  role: Role
  member?: string | undefined
  chatAdmin?: MessageMeta['chatAdmin']
  replyToId?: string | undefined
  topic?: string | undefined
  edited?: boolean | undefined
  forwardedFrom?: string | undefined
}): string {
  const t = localTime(m.at, m.timezone)
  const who = [
    personLabel(m.sender),
    `id ${flat(m.sender.id, 40)}`,
    `role ${m.role}`,
    ...(m.member === undefined ? [] : [`member ${flat(m.member, 30)}`]),
    ...(m.chatAdmin === undefined
      ? []
      : [
          `chat admin${m.chatAdmin.title === undefined ? '' : ` "${flat(m.chatAdmin.title, 30)}"`}`,
        ]),
    ...(m.sender.isBot ? ['bot'] : []),
    ...(m.sender.kind === 'anonymous' ? ['anonymous'] : []),
  ]
  return `${t.date} ${t.clock} #${flat(m.messageId, 40)}${m.topic === undefined ? '' : ` {${flat(m.topic, 40)}}`} [${who.join(' · ')}]${m.replyToId === undefined ? '' : ` (reply to #${flat(m.replyToId, 40)})`}${m.forwardedFrom === undefined ? '' : ` (fwd from ${flat(m.forwardedFrom, 40)})`}${m.edited === true ? ' (edited)' : ''}`
}
