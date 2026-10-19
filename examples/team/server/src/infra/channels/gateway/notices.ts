/** Fixed texts a chat sees when a turn ends without an answer, and the reply constants (pure). */
import { HAND_OVER_NOTICE } from '../../../domain/prompts.ts'

/** An unlinked person is answered (when the connection replies to unknown people) at most this often. */
export const UNKNOWN_REPLY_EVERY_MS = 6 * 3_600_000
export const UNKNOWN_REPLY = "Sorry, I can't chat with you here."
/** Chunk size of a reply queued while its connection is down (under every platform limit we know). */
export const FALLBACK_TEXT_LENGTH = 4000

/** What a chat sees when a restart cut a turn short: asked again, never re-run (tools may have partly run). */
export const INTERRUPTED_NOTICE =
  'Sorry, I was interrupted while working on this and could not finish. Please send your request again.'

/** What a chat sees when a turn ends without an answer (by stop reason). */
export const FAILURE_NOTICE: Record<string, string> = {
  // a stop of the server (or of a person in the web app) cut the turn: asked again, never re-run
  aborted: INTERRUPTED_NOTICE,
  interrupted: INTERRUPTED_NOTICE,
  error:
    'Sorry, I could not answer that: something went wrong while I was working on it. Please try again; if it keeps happening, ask a teammate to check this conversation in the web app.',
  'cost-cap': 'I cannot answer right now: my spending limit is used up.',
  // never "ran out of steps": a chat turn at its cap is handed to the background worker
  // (`turnEnded`); this line is posted only when that hand-over failed
  'max-steps': HAND_OVER_NOTICE,
  stuck:
    'I got stuck on this and stopped instead of repeating myself. Please rephrase it or give me more detail.',
  length: 'My answer got cut off. Please ask me to continue.',
}

/** A turn the web app started in a chat thread: nothing it answers reaches the chat by itself. */
export const WEB_TURN_NOTE =
  'THIS message was typed in the web app by a team member looking at this chat thread, not sent in the chat. Your reply here is shown only in the web app; nothing reaches the chat unless you call channel_send (or another posting tool). When the person asks you to send, post or forward something to the chat, do it with the tool and say what you posted; never claim it was sent otherwise.'
export const CREDIT_NOTICE =
  'I cannot answer right now: the AI service this team uses has run out of credit. An admin needs to add credit; then ask me again.'

/** Stops whose last words (the wrap-up summary) are worth more than a generic notice. */
export const SAY_WHAT_WAS_DONE: ReadonlySet<string> = new Set(['stuck', 'length'])
