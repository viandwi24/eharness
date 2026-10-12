/**
 * An in-memory channel adapter for tests and the dev-only demo (`scripts/channels-demo.ts`).
 * It behaves like a small chat platform: `say()` delivers a message from a person to the gateway,
 * what the agent sends is recorded in `sent`, and failures can be scripted (`failNext`).
 *
 * Node ids: a chat is `<chat>`, a topic of it `<chat>/<topic>` (the topic is a child thread node).
 */
import {
  type AdapterHost,
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ChannelNode,
  type EventSink,
  type HistoryEntry,
  type Identity,
  type InboundAttachment,
  type MemberInfo,
  type NativeAction,
  type NodeInfo,
  type NodeRef,
  type OutboundMessage,
  type RemoteEvent,
} from './types.ts'

export const MOCK_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  maxDownloadBytes: 20 * 1024 * 1024,
  reactions: true,
  edit: true,
  delete: true,
  pin: true,
  typing: true,
  quote: true,
  history: true,
  members: true,
  upload: true,
  buttons: true,
  mentions: 'id',
}

export type MockKind = 'dm' | 'group' | 'channel'

export interface MockSent {
  /** The native id of the node (`<chat>` or `<chat>/<topic>`). */
  conversationId: string
  at: number
  /** The native id of the message. */
  messageId: string
  message: OutboundMessage
}

export interface MockSay {
  /** The chat id; default `room`. */
  chat?: string
  topic?: string
  kind?: MockKind
  from: Identity
  text: string
  /** Platform message id; default a counter. */
  id?: string
  mentionSelf?: boolean
  mentionOthers?: boolean
  replyToSelf?: boolean
  replyTo?: { messageId: string; senderName?: string; senderId?: string; text?: string }
  forwardOf?: Record<string, unknown>
  command?: { name: string; args: string }
  attachments?: Array<{
    id?: string
    name: string
    mediaType: string
    bytes: Uint8Array
    /** Report this size (default the byte length). */
    size?: number
  }>
  at?: number
  /** Deliver again with the same key to model a redelivery of one platform event. */
  dedupeKey?: string
}

export interface MockAdapter extends ChannelAdapter {
  /** Everything the gateway sent, in order. */
  readonly sent: MockSent[]
  readonly reactions: Array<{ conversationId: string; messageId: string; emoji: string }>
  readonly edits: Array<{ conversationId: string; messageId: string; text: string }>
  readonly deletes: Array<{ conversationId: string; messageId: string }>
  readonly pins: Array<{ conversationId: string; messageId: string; pinned: boolean }>
  readonly typings: number[]
  /** Deliver a message from a person; resolves with its native id when the gateway handled it. */
  say(input: MockSay): Promise<string>
  /** A person edited a message. */
  userEdit(input: {
    chat?: string
    topic?: string
    kind?: MockKind
    from: Identity
    id: string
    text: string
    at?: number
  }): Promise<void>
  /** Messages were deleted (ids only, like a platform that names no actor). */
  userDelete(input: {
    chat?: string
    topic?: string
    kind?: MockKind
    ids: string[]
    at?: number
    /** The platform does not say where (a private chat): the gateway must find the node. */
    unplaced?: boolean
  }): Promise<void>
  /** A button pressed in a chat (an inbound `action` event). */
  press(input: {
    chat?: string
    topic?: string
    kind?: MockKind
    from: Identity
    name: string
    data?: string
    messageId?: string
  }): Promise<void>
  /** Deliver any event (a redelivery with the same key, a node update, ...). */
  emit(event: RemoteEvent): Promise<void>
  /** The node reference (with its chain) the adapter builds for a chat. */
  ref(chat: string, options?: { topic?: string; kind?: MockKind; title?: string }): NodeRef
  /** The next `n` sends fail with this error. */
  failNext(error: ChannelError, n?: number): void
  /** Also deliver what this adapter sends to `other`, as a message from this identity (two bots in one room). */
  relayTo(other: MockAdapter): void
  /** Called for every send (after it is recorded). */
  onSend: Array<(sent: MockSent, node: ChannelNode) => void>
  /** What the gateway offered at start. */
  host(): AdapterHost | undefined
}

export interface MockOptions {
  connectionId: string
  platform?: string
  self?: Identity
  capabilities?: Partial<ChannelCapabilities>
  /** Capabilities that depend on the node (overrides `capabilities` for what it returns). */
  capabilitiesOf?: (node: ChannelNode) => Partial<ChannelCapabilities>
  actions?: NativeAction[]
  /** What `listMembers` returns (default: the mock's own identity). */
  members?: MemberInfo[]
  /** What `status` returns, for `channel_status`. */
  status?: { readsEverything?: boolean; notes?: string[] }
  now?: () => number
  /** Time of sends, for rate limit assertions (default `Date.now`). */
  clock?: () => number
}

export function createMockAdapter(options: MockOptions): MockAdapter {
  const capabilities: ChannelCapabilities = { ...MOCK_CAPABILITIES, ...options.capabilities }
  const selfIdentity: Identity = {
    id: `${options.connectionId}-bot`,
    name: options.self?.name ?? 'Team Bot',
    username: options.self?.username ?? `${options.connectionId}_bot`,
    isBot: true,
    isSelf: true,
    ...options.self,
  }
  const clock = options.clock ?? options.now ?? (() => Date.now())
  let sink: EventSink | undefined
  let hostApi: AdapterHost | undefined
  let counter = 0
  const failures: ChannelError[] = []
  const history = new Map<string, HistoryEntry[]>()
  const attachmentBytes = new Map<string, { bytes: Uint8Array; mediaType: string; name: string }>()
  const relays: MockAdapter[] = []

  const nativeOf = (chat: string, topic?: string): string =>
    topic === undefined ? chat : `${chat}/${topic}`

  const ref = (
    chat: string,
    opts: { topic?: string; kind?: MockKind; title?: string } = {},
  ): NodeRef => {
    const kind = opts.kind ?? 'group'
    const room: NodeInfo = {
      nativeId: chat,
      kind: kind === 'dm' ? 'direct' : 'room',
      platformType: `mock:${kind}`,
      title: opts.title ?? (kind === 'dm' ? chat : 'Room'),
      traits: {
        multiUser: kind !== 'dm',
        broadcast: kind === 'channel',
        threading: opts.topic === undefined ? 'relation' : 'node',
        ...(opts.topic === undefined ? {} : { container: true }),
      },
    }
    if (opts.topic === undefined) return { nativeId: chat, chain: [room] }
    const thread: NodeInfo = {
      nativeId: nativeOf(chat, opts.topic),
      kind: 'thread',
      platformType: 'mock:topic',
      title: opts.topic,
      parent: chat,
      traits: { multiUser: true, threading: 'relation' },
    }
    return { nativeId: thread.nativeId, chain: [thread, room] }
  }

  const keep = (nativeNodeId: string, entry: HistoryEntry): void => {
    const list = history.get(nativeNodeId) ?? []
    list.push(entry)
    history.set(nativeNodeId, list)
  }

  const instanceKey = crypto.randomUUID().slice(0, 8)
  const nextKey = (): string => `mock:${options.connectionId}:${instanceKey}:${++counter}`

  const adapter: MockAdapter = {
    platform: options.platform ?? 'mock',
    connectionId: options.connectionId,
    idFormats: 'chat `<chat>`, topic `<chat>/<topic>`, direct chat `<person id>`, message `<id>`',
    sent: [],
    reactions: [],
    edits: [],
    deletes: [],
    pins: [],
    typings: [],
    onSend: [],
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    self: () => selfIdentity,
    async start(s, host) {
      sink = s
      hostApi = host
    },
    async stop() {
      sink = undefined
    },
    host: () => hostApi,
    async getNodeInfo(nativeId) {
      return { nativeId, title: nativeId }
    },
    async getIdentityInfo(nativeId) {
      return { id: nativeId }
    },
    getCapabilities(node) {
      return { ...capabilities, ...(options.capabilitiesOf?.(node) ?? {}) }
    },
    openDirect: (identityNativeId) => ({
      nativeId: identityNativeId,
      kind: 'direct',
      title: identityNativeId,
      traits: { multiUser: false },
    }),
    childNativeId: (parent, key) => nativeOf(parent.nativeId, key),
    async send(node, message) {
      const next = failures.shift()
      if (next !== undefined) throw next
      const messageId = `m${++counter}-${options.connectionId}`
      const record: MockSent = {
        conversationId: node.nativeId,
        at: clock(),
        messageId,
        message,
      }
      adapter.sent.push(record)
      keep(node.nativeId, {
        nativeId: messageId,
        at: record.at,
        sender: selfIdentity,
        text: message.text,
        ...(message.replyTo === undefined ? {} : { replyToId: message.replyTo }),
      })
      for (const fn of adapter.onSend) fn(record, node)
      for (const other of relays) {
        // the other bot sees this as a message from a bot in the same chat
        const chain = nodeChainOf(node)
        void other
          .emit({
            type: 'message.created',
            dedupeKey: nextKey(),
            node: { nativeId: node.nativeId, chain },
            at: record.at,
            message: {
              nativeId: messageId,
              sender: { ...selfIdentity, isSelf: false },
              text: message.text,
              attachments: [],
            },
            signals: { mentionedSelf: false, replyToSelf: false },
          })
          .catch(() => undefined)
      }
      return { nativeId: messageId }
    },
    async edit(node, nativeId, text) {
      adapter.edits.push({ conversationId: node.nativeId, messageId: nativeId, text })
    },
    async delete(node, nativeId) {
      adapter.deletes.push({ conversationId: node.nativeId, messageId: nativeId })
    },
    async pin(node, nativeId, pinned) {
      adapter.pins.push({ conversationId: node.nativeId, messageId: nativeId, pinned })
    },
    async react(node, nativeId, emoji) {
      adapter.reactions.push({ conversationId: node.nativeId, messageId: nativeId, emoji })
    },
    async typing() {
      adapter.typings.push(clock())
    },
    async fetchHistory(node, opts) {
      const all = history.get(node.nativeId) ?? []
      const end =
        opts.before === undefined ? all.length : all.findIndex((e) => e.nativeId === opts.before)
      const upTo = end < 0 ? all.length : end
      return all.slice(Math.max(0, upTo - opts.limit), upTo)
    },
    async listMembers() {
      return { members: options.members ?? [selfIdentity], scope: 'admins' as const }
    },
    ...(options.status === undefined ? {} : { status: () => options.status as never }),
    async fetchAttachment(_node, messageNativeId, attachmentId) {
      const found = attachmentBytes.get(`${messageNativeId}:${attachmentId}`)
      if (found === undefined) throw new ChannelError('invalid', 'no such attachment')
      return found
    },
    async emit(event) {
      if (sink === undefined) throw new Error('the mock adapter is not started')
      if (event.type === 'message.created' && event.node !== null) {
        keep(event.node.nativeId, {
          nativeId: event.message.nativeId,
          at: event.at,
          sender: event.message.sender,
          text: event.message.text,
        })
      }
      await sink(event)
    },
    async say(input) {
      const id = input.id ?? `p${++counter}`
      const at = input.at ?? clock()
      const chat = input.chat ?? 'room'
      const attachments: InboundAttachment[] = (input.attachments ?? []).map((a, i) => {
        const aid = a.id ?? `a${i + 1}`
        attachmentBytes.set(`${id}:${aid}`, {
          bytes: a.bytes,
          mediaType: a.mediaType,
          name: a.name,
        })
        return {
          id: aid,
          kind: a.mediaType.startsWith('image/') ? 'image' : 'file',
          name: a.name,
          mediaType: a.mediaType,
          size: a.size ?? a.bytes.byteLength,
          fetch: async () => ({ bytes: a.bytes, mediaType: a.mediaType, name: a.name }),
        }
      })
      await adapter.emit({
        type: 'message.created',
        dedupeKey: input.dedupeKey ?? nextKey(),
        node: ref(chat, {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          title: input.kind === 'dm' ? (input.from.name ?? input.from.id) : 'Room',
        }),
        at,
        message: {
          nativeId: id,
          sender: input.from,
          text: input.text,
          attachments,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(input.forwardOf === undefined ? {} : { forwardOf: input.forwardOf }),
        },
        signals: {
          mentionedSelf: input.mentionSelf === true,
          ...(input.mentionOthers === true ? { mentionedOthers: true } : {}),
          replyToSelf: input.replyToSelf === true,
          ...(input.command === undefined ? {} : { command: input.command }),
        },
      })
      return id
    },
    async userEdit(input) {
      const chat = input.chat ?? 'room'
      await adapter.emit({
        type: 'message.edited',
        dedupeKey: nextKey(),
        node: ref(chat, {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          title: input.kind === 'dm' ? (input.from.name ?? input.from.id) : 'Room',
        }),
        at: input.at ?? clock(),
        message: { nativeId: input.id, sender: input.from, text: input.text },
      })
    },
    async userDelete(input) {
      const chat = input.chat ?? 'room'
      await adapter.emit({
        type: 'message.deleted',
        dedupeKey: nextKey(),
        node:
          input.unplaced === true
            ? null
            : ref(chat, {
                ...(input.topic === undefined ? {} : { topic: input.topic }),
                ...(input.kind === undefined ? {} : { kind: input.kind }),
              }),
        at: input.at ?? clock(),
        messageNativeIds: input.ids,
      })
    },
    async press(input) {
      await adapter.emit({
        type: 'action',
        dedupeKey: nextKey(),
        node: ref(input.chat ?? 'room', {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          title: input.kind === 'dm' ? (input.from.name ?? input.from.id) : 'Room',
        }),
        at: clock(),
        name: input.name,
        actor: input.from,
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.messageId === undefined ? {} : { messageNativeId: input.messageId }),
      })
    },
    ref,
    failNext(error, n = 1) {
      for (let i = 0; i < n; i++) failures.push(error)
    },
    relayTo(other) {
      relays.push(other)
    },
  }

  /** The chain of a stored node: itself and its parent (a topic's chat), leaf first. */
  function nodeChainOf(node: ChannelNode): NodeInfo[] {
    const own: NodeInfo = {
      nativeId: node.nativeId,
      kind: node.kind,
      traits: node.traits,
      ...(node.title === undefined ? {} : { title: node.title }),
      ...(node.parentNativeId === undefined ? {} : { parent: node.parentNativeId }),
    }
    return node.parentNativeId === undefined
      ? [own]
      : [own, { nativeId: node.parentNativeId, kind: 'room', traits: { container: true } }]
  }

  return adapter
}
