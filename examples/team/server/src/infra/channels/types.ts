/**
 * Channels adapter contract (docs/plans/P41-team-channels.md, phase L5; bridgev2 shaped). Platform
 * neutral: nothing in this folder names a chat platform. An adapter is one transport of one
 * platform identity. It normalizes what the platform pushes into {@link RemoteEvent}s (with the
 * chain of nodes from the leaf to the root), describes nodes and identities with *patch semantics*
 * (`undefined` = unchanged, `null` = cleared), says per node what it can do, and sends. Everything
 * else (allowlist, wake, sessions, outbox, storage) is the gateway's.
 *
 * Required: `platform`, `idFormats`, `start` / `stop`, `self`, `getNodeInfo`, `getIdentityInfo`,
 * `getCapabilities`, `send`. Optional operations are discovered by presence: `edit`, `delete`,
 * `pin`, `react`, `typing`, `fetchHistory`, `listMembers`, `listNodes`, `fetchAttachment`,
 * `childNativeId`, `resolveIdentifier`, native `actions`. The gateway never branches on the
 * platform name.
 */
import type { z } from 'zod'
import type {
  IdentityKind,
  MemberRole,
  MessageEntity,
  NodeKind,
  NodeLinkRel,
  NodeState,
  NodeTraits,
} from './model.ts'

export type { NodeKind, NodeState, NodeTraits } from './model.ts'

// --- nodes -------------------------------------------------------------------------------------

/**
 * What an adapter knows about a node, as a patch: a missing field is unchanged, `null` clears.
 * `parent` is the native id of the parent (the chain says the same). `meta` is merged key by key
 * (a `null` value deletes a key) and validated by the adapter's schema.
 */
export interface NodeInfo {
  nativeId: string
  kind?: NodeKind
  traits?: Partial<NodeTraits>
  platformType?: string
  title?: string | null
  state?: NodeState
  stateReason?: string | null
  parent?: string | null
  originMessageNativeId?: string | null
  meta?: Record<string, unknown>
  /**
   * What this connection is in the node and may do there. `rights` are the platform's own
   * administrator rights of the connection (delete messages, pin, manage topics, ...), by name.
   */
  access?: {
    member?: MemberRole
    canPost?: boolean | null
    canRead?: boolean | null
    rights?: Record<string, boolean>
  }
  /** Relations to other nodes of the same connection, by native id. */
  links?: Array<{ rel: NodeLinkRel; to: string }>
}

/**
 * Where an event happened: the node and, leaf first, the chain up to the root. `chain[0]` is the
 * node itself, so the gateway can create missing ancestors without asking the platform.
 */
export interface NodeRef {
  nativeId: string
  chain?: NodeInfo[]
}

/** A stored node as the adapter sees it when it has to act on it (send, edit, read history). */
export interface ChannelNode {
  /** Internal id. */
  id: string
  connectionId: string
  nativeId: string
  kind: NodeKind
  traits: NodeTraits
  platformType: string
  title: string | undefined
  /** The parent's native id (a topic's chat). */
  parentNativeId: string | undefined
  meta: Record<string, unknown>
}

// --- identities --------------------------------------------------------------------------------

export interface Identity {
  /** The platform's id of the person (opaque; unique per connection). */
  id: string
  name?: string
  username?: string
  isBot?: boolean
  /** The identity of the connection itself (the bot or account the adapter runs as). */
  isSelf?: boolean
  kind?: IdentityKind
  /** Other ids of the same person (phone, LID, ...). */
  aliases?: Array<{ kind: string; value: string }>
  /** A per-node profile: a guild nick, a custom admin title. */
  profile?: { nick?: string; roles?: string[] }
}

/** A member as `listMembers` reports it: the identity plus the platform's role and title in the node. */
export interface MemberInfo extends Identity {
  role?: MemberRole
  /** A custom admin title (Telegram), shown to the agent as data. */
  title?: string
}

/** Patch semantics like {@link NodeInfo}. */
export interface IdentityInfo extends Identity {
  avatar?: string | null
  meta?: Record<string, unknown>
}

// --- messages and events -----------------------------------------------------------------------

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

export interface NormalizedMessage {
  nativeId: string
  sender: Identity
  text: string
  attachments: InboundAttachment[]
  entities?: MessageEntity[]
  replyTo?: ReplyInfo
  /** The root of a reply chain on platforms that thread replies as relations. */
  threadRoot?: string
  forwardOf?: Record<string, unknown>
  /** Platform order tie-breaker (a numeric id, a Slack `ts`). */
  sortKey?: string
  /** `out` = sent by this identity (from any of its devices). Default `in`. */
  direction?: 'in' | 'out'
  /** `message` (default), `service` (a join, a pin) or `system` (a moderation log entry). */
  kind?: 'message' | 'service' | 'system'
}

interface EventBase {
  /** Unique per connection: a replay of the same platform event carries the same key. */
  dedupeKey: string
  /** Epoch ms of the event on the platform. */
  at: number
  /** The place; null when the platform did not say (a deletion in a private chat). */
  node: NodeRef | null
  actor?: Identity
  /** pts / seq / update id, when the platform gives one. */
  streamOrder?: string
  /** The platform payload, for re-normalizing later. Stored only when the gateway keeps raw events (sealed). */
  raw?: unknown
}

export type RemoteEvent =
  | (EventBase & {
      type: 'message.created'
      message: NormalizedMessage
      signals: InboundSignals
    })
  | (EventBase & {
      type: 'message.edited'
      message: Pick<NormalizedMessage, 'nativeId' | 'sender' | 'text' | 'entities'>
    })
  | (EventBase & { type: 'message.deleted'; messageNativeIds: string[] })
  | (EventBase & {
      type: 'reaction.added' | 'reaction.removed'
      messageNativeId: string
      emoji: string
    })
  | (EventBase & { type: 'node.created' | 'node.updated' })
  | (EventBase & { type: 'node.state_changed'; state: NodeState; reason?: string })
  /** The chat got a new id (a basic group became a supergroup): `node` is the new one. */
  | (EventBase & { type: 'node.migrated'; from: string })
  | (EventBase & { type: 'member.joined' | 'member.left' | 'member.updated'; role?: MemberRole })
  | (EventBase & {
      /** A button press or slash action: treated like an addressed message. */
      type: 'action'
      name: string
      data?: string
      messageNativeId?: string
    })

export type RemoteEventType = RemoteEvent['type']
export type EventOf<T extends RemoteEventType> = Extract<RemoteEvent, { type: T }>

// --- capabilities ------------------------------------------------------------------------------

/** What one node supports right now (evaluated at send time, never cached across connections). */
export interface ChannelCapabilities {
  /** Longest text of one message; longer replies are split on newlines. */
  maxTextLength: number
  /** Longest caption of a file; longer ones are refused with a message the model reads. */
  maxCaptionLength?: number
  /** Largest file the adapter can download for the gateway. */
  maxDownloadBytes?: number
  /** Edits older than this are refused by the platform (ms). */
  editMaxAgeMs?: number
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
  /**
   * `id`: the text of an outbound message may carry mention tokens (`mentionToken`, `mentions.ts`)
   * that the adapter renders as a real mention by platform user id. Otherwise the gateway turns
   * them into plain names before sending. Default none.
   */
  mentions?: 'id'
  /** Deletions arrive as `message.deleted` events: ids only (no text, no actor). Default `none`. */
  deletions?: 'none' | 'ids'
  /** What `listMembers` returns: administrators only, a part of the list, or everybody. */
  membersScope?: 'admins' | 'partial' | 'full'
  /** How `fetchHistory` reads: `rest` = any page on request (a user account), `none` = no history. */
  historyMode?: 'none' | 'rest'
}

// --- outbound ----------------------------------------------------------------------------------

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
  /** Native message id to quote / reply to. */
  replyTo?: string
  /** On platforms that thread replies as relations: the root of the chain to answer in. */
  threadRoot?: string
  files?: OutboundFile[]
  silent?: boolean
  /** Only sent when the node's capabilities have `buttons`. */
  buttons?: OutboundButton[]
  /**
   * Transaction id: the outbox row id of this message, stable across retries. An adapter whose
   * platform can dedupe (or that keeps its own sent log) uses it so a retried send never posts
   * twice; the gateway records it on the message so the platform's echo is matched, not duplicated.
   */
  sendTxnId?: string
}

export interface SentMessage {
  /** The native id of the message that was posted. */
  nativeId: string
}

export interface HistoryEntry {
  nativeId: string
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
  /** Answers from what the gateway stored, never calling the platform: the API governor skips it. */
  local?: boolean
  /**
   * Only an owner of the team may ask for it (bans, invite links, joining): a chat turn of anybody
   * else is refused in code before it runs; a turn without a chat requester (the web app) is the client.
   */
  ownerOnly?: boolean
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
  /**
   * What a `rate_limit` applies to: the whole connection (default) or only the node of the
   * operation (a per-chat flood wait: other chats keep sending).
   */
  readonly scope: 'connection' | 'chat'
  constructor(
    kind: ChannelErrorKind,
    message: string,
    retryAfterMs?: number,
    scope: 'connection' | 'chat' = 'connection',
  ) {
    super(message)
    this.name = 'ChannelError'
    this.kind = kind
    this.retryAfterMs = retryAfterMs
    this.scope = scope
  }
}

// --- the adapter -------------------------------------------------------------------------------

export type EventSink = (event: RemoteEvent) => Promise<void>

/** What the gateway offers an adapter when it starts (hints, never required for correctness). */
export interface AdapterHost {
  /**
   * Is a node (by native id) one the gateway would act on? An adapter that reads everything its
   * account can see uses this to skip chats nobody chose, instead of delivering and being dropped.
   */
  isAllowed(nodeNativeId: string): boolean
  /**
   * Messages the gateway stored with these native ids (a deletion that names no chat): the nodes
   * they live in. With `within`, only nodes whose native id equals it or starts with it.
   */
  locate(
    messageNativeIds: readonly string[],
    within?: string,
  ): Array<{ nodeNativeId: string; messageNativeId: string }>
  /** Did this connection send message `nativeId` of the node (the platform does not say who a reply points at)? */
  isOwn(nodeNativeId: string, messageNativeId: string): boolean
}

/** One platform identity on one transport. */
export interface ChannelAdapter {
  /** Free-form platform label for display and tool names (`telegram`, `mock`). */
  readonly platform: string
  readonly connectionId: string
  /** Human readable description of the native id formats the adapter composes (covered by its fixtures). */
  readonly idFormats: string
  /** `user` = a person's account driven through an API client (stricter API limits than a `bot`, the default). */
  readonly actsAs?: 'bot' | 'user'
  /** The adapter's schema for `NodeInfo.meta`, and its version (bumped when the shape changes). */
  readonly nodeMeta?: { schema: z.ZodType; version: number }
  /** The identity the adapter runs as (so the gateway can drop its own messages). */
  self(): Identity
  /** Begin delivering events to `sink`; resolves when listening. */
  start(sink: EventSink, host: AdapterHost): Promise<void>
  stop(): Promise<void>
  /** Ask the platform about a node (patch semantics: undefined = unchanged, null = cleared). */
  getNodeInfo(nativeId: string): Promise<NodeInfo | undefined>
  getIdentityInfo(nativeId: string, scope?: string): Promise<IdentityInfo | undefined>
  /** What this node supports now. */
  getCapabilities(node: ChannelNode): ChannelCapabilities
  send(node: ChannelNode, message: OutboundMessage): Promise<SentMessage>
  /** Replace the text of a message. Editing removes its buttons (a message edited this way has none). */
  edit?(node: ChannelNode, nativeId: string, text: string): Promise<void>
  delete?(node: ChannelNode, nativeId: string): Promise<void>
  pin?(node: ChannelNode, nativeId: string, pinned: boolean): Promise<void>
  react?(node: ChannelNode, nativeId: string, emoji: string): Promise<void>
  typing?(node: ChannelNode): Promise<void>
  fetchHistory?(
    node: ChannelNode,
    options: { limit: number; before?: string },
  ): Promise<HistoryEntry[]>
  listMembers?(
    node: ChannelNode,
    options: { limit: number },
  ): Promise<{ members: MemberInfo[]; scope: 'admins' | 'partial' | 'full' }>
  /**
   * What this connection sees in a node and why (privacy mode, rights): facts for `channel_status`
   * that are not stored on the node. Absent = nothing more to say.
   */
  status?(node: ChannelNode): { readsEverything?: boolean; notes?: string[] }
  /** The nodes of the identity (dialog sync). With `parent`, only its children. */
  listNodes?(parent?: ChannelNode): Promise<NodeInfo[]>
  resolveIdentifier?(query: string): Promise<IdentityInfo | undefined>
  /** Download an attachment of a message the gateway logged earlier. */
  fetchAttachment?(
    node: ChannelNode,
    messageNativeId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; mediaType?: string; name?: string }>
  /**
   * The node of a direct chat with an identity, composed without asking the platform (so the
   * gateway can address a person who never wrote first). Absent = such a chat cannot be started.
   */
  openDirect?(identityNativeId: string): NodeInfo
  /**
   * The native id of a child of `parent` named by a short key (a topic number). Lets a tool say
   * "this chat, topic 6" without knowing how ids are composed.
   */
  childNativeId?(parent: ChannelNode, key: string): string | undefined
  readonly actions?: readonly NativeAction[]
}
