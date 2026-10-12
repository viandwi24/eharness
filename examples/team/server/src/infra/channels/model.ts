/**
 * The generic conversation model (docs/plans/P41-team-channels.md, phase L5). Platform neutral:
 * a place is a *node* in a tree, a message belongs to a node, a person is an *identity* of one
 * connection. Core logic branches only on {@link NodeKind} and {@link NodeTraits}; `platformType`
 * is for display and debugging.
 */

export type NodeKind = 'space' | 'room' | 'thread' | 'direct'
export type NodeState = 'active' | 'closed' | 'archived' | 'deleted' | 'left'

/** How threads inside a node appear: not at all, as a relation between messages, or as child nodes. */
export type ThreadingMode = 'none' | 'relation' | 'node'

export interface NodeTraits {
  /** More than two participants. */
  multiUser: boolean
  /** One to many: ordinary members cannot post (a channel, an announcement room). */
  broadcast: boolean
  /** Has child nodes (a forum, a guild, a category). */
  container: boolean
  threading: ThreadingMode
  /** Messages may be attached here at all (a forum parent, a category, a workspace are not). */
  postable: boolean
  /** Children expire by themselves (Discord threads). */
  ephemeral: boolean
  /** Members from other organizations. */
  external: boolean
  /** Only thread children may be created (a forum or media channel). */
  threadsOnly: boolean
}

export const DEFAULT_TRAITS: NodeTraits = {
  multiUser: false,
  broadcast: false,
  container: false,
  threading: 'none',
  postable: true,
  ephemeral: false,
  external: false,
  threadsOnly: false,
}

export const traitsOf = (patch?: Partial<NodeTraits>): NodeTraits => ({
  ...DEFAULT_TRAITS,
  ...(patch ?? {}),
})

/** Relations that are not parent and child. */
export type NodeLinkRel =
  | 'discussion_of'
  | 'monoforum_of'
  | 'follows'
  | 'alias_of'
  | 'migrated_from'

export type MemberRole = 'member' | 'admin' | 'owner' | 'none' | 'unknown'
export type IdentityKind = 'human' | 'bot' | 'app' | 'channel' | 'webhook' | 'system' | 'anonymous'

/** A node as stored. `meta` is validated by the adapter's schema. */
export interface NodeRow {
  /** Internal id (uuidv7). */
  id: string
  connectionId: string
  /** Opaque, composed by the adapter; unique per connection. */
  nativeId: string
  parentId: string | null
  /** `/<root id>/.../<id>`: ancestors and subtree in one prefix query. */
  path: string
  kind: NodeKind
  traits: NodeTraits
  platformType: string
  originMessageNativeId: string | null
  title: string | null
  state: NodeState
  stateReason: string | null
  meta: Record<string, unknown>
  metaVersion: number
  /** The conversation id of before L5 (old session and log keys). */
  legacyRefId: string | null
  firstSeenAt: number
  lastEventAt: number
}

export interface NodeAccessRow {
  nodeId: string
  connectionId: string
  member: MemberRole
  canPost: boolean | null
  canRead: boolean | null
  muted: boolean
  lastReadNativeId: string | null
  history: NodeHistory
  extra: Record<string, unknown>
  updatedAt: number
}

/** Backfill bookkeeping of a node (generic: any adapter with a history capability). */
export interface NodeHistory {
  /** Highest native id stored (live, backfill or gap fill). */
  highNativeId?: string
  /** Lowest native id seen live: backfill walks below it. */
  firstLiveNativeId?: string
  /** The window in days; absent = no backfill. */
  days?: number
  /** `idle` | `queued` | `running` | `parked` | `done` | `error`. */
  state?: string
  oldestNativeId?: string
  oldestAt?: number
  count?: number
  error?: string
  /** A flood wait: jobs of this node resume at this time (epoch ms). */
  parkedUntil?: number
  complete?: boolean
  cursor?: string
}

export interface IdentityRow {
  id: string
  connectionId: string
  nativeId: string
  kind: IdentityKind
  /** The team member this identity is linked to. */
  personId: string | null
  linkedAt: number | null
  isSelf: boolean
  displayName: string | null
  username: string | null
  avatar: string | null
  meta: Record<string, unknown>
  firstSeenAt: number
  lastSeenAt: number
  /** Direct messages from this identity while it was not linked (reset when it is linked). */
  dmFirstAt: number | null
  dmLastAt: number | null
  dmCount: number
  ignored: boolean
}

// --- message content --------------------------------------------------------------------------

/** UIMessage compatible parts of a stored message (text, file references). Never bytes. */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'file'
      mediaType: string
      filename?: string
      /** `channel-file:<attachment id>`: bytes are fetched from the platform on demand. */
      url: string
      providerMetadata?: { channel: { id: string; kind?: string; size?: number } }
    }

/** Normalized formatting and references inside the text (offsets in UTF-16 code units). */
export interface MessageEntity {
  type:
    | 'mention'
    | 'link'
    | 'command'
    | 'hashtag'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strike'
    | 'code'
    | 'pre'
    | 'quote'
    | 'spoiler'
  offset: number
  length: number
  /** `mention`: the native id of the identity mentioned, when the platform says (not a username). */
  identity?: string
  /** `mention`: the handle as written, when the platform gave only a handle. */
  handle?: string
  url?: string
  language?: string
}

/** What a stored message says once opened (the sealed content). */
export interface MessageContent {
  parts: ContentPart[]
  entities?: MessageEntity[]
  /** An excerpt of the message replied to, as the platform delivered it. */
  reply?: { senderName?: string; text?: string }
  /** Origin of a forwarded message. */
  forwardOf?: Record<string, unknown>
}

export const textOfContent = (content: MessageContent): string =>
  content.parts
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

export const filesOfContent = (
  content: MessageContent,
): Array<Extract<ContentPart, { type: 'file' }>> =>
  content.parts.filter((p): p is Extract<ContentPart, { type: 'file' }> => p.type === 'file')

export const FILE_URL_PREFIX = 'channel-file:'
