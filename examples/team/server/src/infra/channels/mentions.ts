/**
 * Mentions (docs/plans/P41-team-channels.md, phase L6). Only the gateway builds a mention, from a
 * structured `mention: [personId | platformUserId]` on a send or a reminder; the model cannot ping
 * anybody by typing `@handle`. Free text from a model (or a person, through a reminder text) is
 * neutralized: handles are broken so no platform turns them into a ping, and the private-use
 * characters of the mention token are removed so nobody can forge one.
 *
 * A mention travels inside the message text as a token `<id><name>`
 * (`mentionToken`). An adapter whose capabilities say `mentions: 'id'` renders the token as a real
 * mention by id (Telegram `text_mention`, a `tg://user?id=` link); for every other adapter the
 * gateway has already replaced tokens by the plain name (`plainMentions`), which pings nobody.
 */

const OPEN = ''
const SEP = ''
const CLOSE = ''
const ZWSP = '​'

/** The token of a mention of identity `id` (the platform's own id) written as `name`. */
export function mentionToken(id: string, name: string): string {
  const safeId = id.replace(/[-]/g, '')
  return `${OPEN}${safeId}${SEP}${encodeURIComponent(name.replace(/[-]/g, ''))}${CLOSE}`
}

export interface ParsedMention {
  id: string
  name: string
  /** Offsets of the whole token in the text. */
  start: number
  end: number
}

const TOKEN = new RegExp(`${OPEN}([^${SEP}${CLOSE}]*)${SEP}([^${CLOSE}]*)${CLOSE}`, 'g')

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function parseMentions(text: string): ParsedMention[] {
  const out: ParsedMention[] = []
  for (const m of text.matchAll(TOKEN)) {
    out.push({
      id: m[1] as string,
      name: decode(m[2] as string),
      start: m.index as number,
      end: (m.index as number) + m[0].length,
    })
  }
  return out
}

/** Replace every mention token by the plain name (no `@`, so nothing can ping). */
export const plainMentions = (text: string): string =>
  text.replace(TOKEN, (_m, _id: string, name: string) => decode(name))

/** Does the text carry a mention token? */
export const hasMentions = (text: string): boolean => text.includes(OPEN)

/**
 * Make free text safe to post: strip forged tokens, and put a zero-width space after every `@`
 * that starts a handle (`@ana` becomes `@​ana`: readable, but no platform resolves it).
 * Emails (`a@b.com`) and text without handles are left alone.
 */
export function neutralizeHandles(text: string): string {
  // links keep their `@` (tiktok.com/@name, medium.com/@name): a handle inside a URL pings nobody,
  // and a zero-width space in it cuts the link where the platform stops linking
  return text
    .replace(/[-]/g, '')
    .split(URL_PART)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\p{L}\p{N}_])([@＠])(?=[\p{L}\p{N}_])/gu, `$1$2${ZWSP}`),
    )
    .join('')
}

/** A URL in free text (with a scheme, `www.` or a bare `t.me/`), captured so `split` keeps it. */
const URL_PART = /((?:https?:\/\/|www\.|t\.me\/)[^\s<>"]+)/giu

/** What the log and the people of a chat should read: the token shown as the name (with `@`). */
export const readableMentions = (text: string): string =>
  text.replace(TOKEN, (_m, _id: string, name: string) => `@${decode(name)}`)
