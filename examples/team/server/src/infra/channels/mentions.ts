/**
 * Mentions (docs/plans/P41-team-channels.md, phase L6): the library's structured mention tokens
 * (`eharness/channels`, spec 31 §4). Only the gateway builds a mention, from a structured
 * `mention: [personId | platformUserId]` on a send or a reminder; the model cannot ping anybody by
 * typing `@handle`. An adapter whose capabilities say `mentions: 'id'` renders a token as a real
 * mention by id (Telegram `text_mention`, a `tg://user?id=` link); for every other adapter the
 * gateway replaces tokens by the plain name (`plainMentions`), which pings nobody.
 */
import { parseMentionTokens } from 'eharness/channels'

export {
  hasMentionTokens as hasMentions,
  mentionToken,
  neutralizeHandles,
  plainMentions,
  readableMentions,
} from 'eharness/channels'

export interface ParsedMention {
  id: string
  name: string
  /** Offsets of the whole token in the text. */
  start: number
  end: number
}

/** Every mention token of `text`, in order (the label as `name`). */
export function parseMentions(text: string): ParsedMention[] {
  return parseMentionTokens(text).map((m) => ({
    id: m.id,
    name: m.label,
    start: m.start,
    end: m.end,
  }))
}
