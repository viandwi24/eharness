/**
 * Structured mentions. A model (or a person, through free text) can never ping anybody by typing
 * `@handle`: free text is neutralized, and only a structured token built with {@link mentionToken}
 * becomes a real mention in an adapter that supports it.
 *
 * A token is `U+E010 id U+E012 encodedLabel U+E011` (private-use characters). Adapters render it
 * as a platform mention by id; for any other adapter replace it with {@link plainMentions}.
 *
 * @see docs/specs/31-channels.md#4-mentions
 */

const OPEN = ''
const SEP = ''
const CLOSE = ''
const ZWSP = '​'
const FORGED = /[-]/g
const TOKEN = new RegExp(`${OPEN}([^${SEP}${CLOSE}]*)${SEP}([^${CLOSE}]*)${CLOSE}`, 'g')
/** A URL in free text, captured so `split` keeps it at odd indexes. */
const URL_PART = /((?:https?:\/\/|www\.|t\.me\/)[^\s<>"]+)/giu

/** One mention token found in a text. */
export interface ParsedMention {
  /** The platform's own id of the mentioned identity. */
  id: string
  /** The label the mention is written as. */
  label: string
  /** Offsets of the whole token in the text (`end` exclusive). */
  start: number
  end: number
}

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The token of a mention of identity `id` written as `label`. Forged control characters are removed. */
export function mentionToken(id: string, label: string): string {
  return `${OPEN}${id.replace(FORGED, '')}${SEP}${encodeURIComponent(label.replace(FORGED, ''))}${CLOSE}`
}

/** Every well-formed mention token of `text`, in order. */
export function parseMentionTokens(text: string): ParsedMention[] {
  const out: ParsedMention[] = []
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index as number
    out.push({
      id: m[1] as string,
      label: decode(m[2] as string),
      start,
      end: start + m[0].length,
    })
  }
  return out
}

/** Does the text carry a mention token? */
export function hasMentionTokens(text: string): boolean {
  return text.includes(OPEN)
}

/** Replace every token by its plain label (no `@`, so nothing can ping). */
export function plainMentions(text: string): string {
  return text.replace(TOKEN, (_m, _id: string, label: string) => decode(label))
}

/** What a log or a reader should see: every token as `@label` (text only; it pings nobody). */
export function readableMentions(text: string): string {
  return text.replace(TOKEN, (_m, _id: string, label: string) => `@${decode(label)}`)
}

/**
 * Make free text safe to post: strip forged tokens and put a zero-width space after every `@` that
 * starts a handle (`@ana` becomes `@​ana`). URLs (`tiktok.com/@name`) and emails (`a@b.com`)
 * are left alone. Idempotent.
 */
export function neutralizeHandles(text: string): string {
  return text
    .replace(FORGED, '')
    .split(URL_PART)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/(^|[^\p{L}\p{N}_])([@＠])(?=[\p{L}\p{N}_])/gu, `$1$2${ZWSP}`),
    )
    .join('')
}
