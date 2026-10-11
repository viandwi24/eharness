/**
 * Channels contract (docs/plans/P41-team-channels.md, phase L1). Platform neutral: nothing in
 * this folder names a chat platform. An adapter (one transport of one platform identity)
 * normalizes inbound events into {@link InboundEvent} and implements the outbound operations it
 * supports; the gateway (`gateway.ts`) does everything else.
 */
import type { z } from 'zod'

export type ConversationKind = 'dm' | 'group' | 'channel'

/**
 * Where a message lives. `id` is opaque and stable: the adapter composes it so that everything
 * that must share a session shares an id (a group; a forum topic of a group gets its own id).
 * The gateway never parses it, it only keys sessions and the log by it.
 */
export interface ConversationRef {
  id: string
  connectionId: string
  /** Workspace / server / guild the container belongs to, when the platform has one. */
  space?: string
  /** The chat, channel or DM peer. */
  container: string
  /** A topic of a forum-style container (its own session). */
  topic?: string
  /** The root message of a reply chain, when the platform threads replies. */
  thread?: string
  kind: ConversationKind
  /** Display name (group title, peer name), for labels and the thread list. */
  title?: string
}

export interface Identity {
  id: string
  name?: string
  username?: string
  isBot?: boolean
  /** The identity of the connection itself (the bot or account the adapter runs as). */
  isSelf?: boolean
}

/** A file attached to an inbound message. Bytes are fetched lazily, only when the policy allows. */
export interface InboundAttachment {
  id: string
  kind: 'image' | 'file' | 'audio' | 'video'
  name?: string
  mediaType?: string
  size?: number
  fetch(): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>
}

/** What the adapter saw about the message that the gateway needs to decide a wake. */
export interface InboundSignals {
  mentionedSelf: boolean
  /** The message mentions somebody else and not this identity. */
  mentionedOthers?: boolean
  replyToSelf: boolean
  command?: { name: string; args: string }
}

export interface ReplyInfo {
  messageId: string
  senderId?: string
  senderName?: string
  /** A short excerpt of the message replied to, when the platform delivers it. */
  text?: string
}

interface EventBase {
  conversation: ConversationRef
  /** Epoch ms of the event on the platform. */
  at: number
  /** The platform payload, for the adapter's own use only: never stored, never shown to a model. */
  raw?: unknown
}

export type InboundEvent =
  | (EventBase & {
      type: 'message'
      messageId: string
      sender: Identity
      text: string
      attachments: InboundAttachment[]
      replyTo?: ReplyInfo
      signals: InboundSignals
    })
  | (EventBase & {
      type: 'edit'
      messageId: string
      sender: Identity
      text: string
    })
  | (EventBase & { type: 'delete'; messageIds: string[] })
  | (EventBase & {
      type: 'reaction'
      messageId: string
      sender: Identity
      emoji: string
      added: boolean
    })
  | (EventBase & {
      type: 'action'
      /** A button press or slash action: treated like an addressed message. */
      name: string
      sender: Identity
      data?: string
      messageId?: string
    })

export interface ChannelCapabilities {
  /** Longest text of one message; longer replies are split on newlines. */
  maxTextLength: number
  /** Longest caption of a file; longer ones are refused with a message the model reads. */
  maxCaptionLength?: number
  /** Largest file the adapter can download for the gateway. */
  maxDownloadBytes?: number
  topics: boolean
  reactions: boolean
  edit: boolean
  delete: boolean
  pin: boolean
  typing: boolean
  /** Replies can quote a message. */
  quote: boolean
  history: boolean
  members: boolean
  upload: boolean
  /**
   * Messages can carry action buttons (`OutboundMessage.buttons`); a press arrives as an inbound
   * `action` event. Without it the gateway falls back to a link to the web app.
   */
  buttons?: boolean
}

export interface OutboundFile {
  name: string
  mediaType: string
  bytes: Uint8Array
}

/** An action button under a message. `name` and `data` come back in the inbound `action` event. */
export interface OutboundButton {
  name: string
  label: string
  data?: string
}

export interface OutboundMessage {
  text: string
  /** Platform message id to quote / reply to. */
  replyTo?: string
  files?: OutboundFile[]
  silent?: boolean
  /** Only sent when the adapter has the `buttons` capability. */
  buttons?: OutboundButton[]
  /**
   * The outbox row id of this message: stable across retries. An adapter whose platform can dedupe
   * (or that keeps its own sent log) uses it so a retried send never posts twice.
   */
  key?: string
}

export interface SentMessage {
  messageId: string
}

export interface HistoryEntry {
  messageId: string
  at: number
  sender?: Identity
  text: string
  attachments?: Array<{ id: string; name?: string; mediaType?: string; size?: number }>
  replyToId?: string
}

export type ActionRisk = 'read' | 'write' | 'external' | 'destructive'

/**
 * A platform operation that is not part of the common surface (create a poll, ban a member,
 * pin with notification, ...). Each becomes one deferred tool with this static risk.
 */
export interface NativeAction {
  name: string
  risk: ActionRisk
  /** One line for the tool description. */
  summary: string
  schema: z.ZodObject
  run(input: Record<string, unknown>): Promise<string>
}

export type ChannelErrorKind =
  /** The platform asked to slow down: park and retry after `retryAfterMs`. */
  | 'rate_limit'
  /** A glitch worth a few retries. */
  | 'transient'
  /** The request itself is wrong (bad id, missing right): never retried. */
  | 'invalid'
  /** The identity cannot act anymore (revoked, banned): opens the circuit breaker. */
  | 'fatal'

/** What adapters throw from outbound operations; the outbound queue acts on `kind`. */
export class ChannelError extends Error {
  readonly kind: ChannelErrorKind
  readonly retryAfterMs: number | undefined
  constructor(kind: ChannelErrorKind, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ChannelError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

export type EventSink = (event: InboundEvent) => Promise<void>

/** One platform identity on one transport. Optional members are capabilities. */
export interface ChannelAdapter {
  /** Free-form platform label for display and tool names (`telegram`, `mock`). */
  readonly platform: string
  readonly connectionId: string
  readonly capabilities: ChannelCapabilities
  /** The identity the adapter runs as (so the gateway can drop its own messages). */
  self(): Identity
  /** Begin delivering events to `sink`; resolves when listening. */
  start(sink: EventSink): Promise<void>
  stop(): Promise<void>
  send(ref: ConversationRef, message: OutboundMessage): Promise<SentMessage>
  /** Replace the text of a message. Editing removes its buttons (a message edited this way has none). */
  edit?(ref: ConversationRef, messageId: string, text: string): Promise<void>
  delete?(ref: ConversationRef, messageId: string): Promise<void>
  pin?(ref: ConversationRef, messageId: string, pinned: boolean): Promise<void>
  react?(ref: ConversationRef, messageId: string, emoji: string): Promise<void>
  typing?(ref: ConversationRef): Promise<void>
  fetchHistory?(
    ref: ConversationRef,
    options: { limit: number; before?: string },
  ): Promise<HistoryEntry[]>
  members?(ref: ConversationRef, options: { limit: number }): Promise<Identity[]>
  /** Download an attachment of a message the gateway logged earlier. */
  fetchAttachment?(
    ref: ConversationRef,
    messageId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>
  /** Build the reference of a conversation the gateway has not seen inbound (a channel to post to, a DM). */
  conversationRef?(input: {
    container: string
    topic?: string
    thread?: string
    kind?: ConversationKind
  }): ConversationRef
  readonly actions?: readonly NativeAction[]
}
