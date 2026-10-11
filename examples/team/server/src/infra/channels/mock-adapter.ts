/**
 * An in-memory channel adapter for tests and the dev-only demo (`scripts/channels-demo.ts`).
 * It behaves like a small chat platform: `say()` delivers a message from a person to the gateway,
 * what the agent sends is recorded in `sent`, and failures can be scripted (`failNext`).
 */
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  ChannelError,
  type ConversationKind,
  type ConversationRef,
  type EventSink,
  type HistoryEntry,
  type Identity,
  type InboundAttachment,
  type InboundEvent,
  type NativeAction,
  type OutboundMessage,
} from './types.ts'

export const MOCK_CAPABILITIES: ChannelCapabilities = {
  maxTextLength: 4096,
  maxCaptionLength: 1024,
  maxDownloadBytes: 20 * 1024 * 1024,
  topics: true,
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
}

export interface MockSent {
  conversationId: string
  at: number
  messageId: string
  message: OutboundMessage
}

export interface MockSay {
  /** The container (chat) id; default `room`. */
  chat?: string
  topic?: string
  kind?: ConversationKind
  from: Identity
  text: string
  /** Platform message id; default a counter. */
  id?: string
  mentionSelf?: boolean
  mentionOthers?: boolean
  replyToSelf?: boolean
  replyTo?: { messageId: string; senderName?: string; text?: string }
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
}

export interface MockAdapter extends ChannelAdapter {
  /** Everything the gateway sent, in order. */
  readonly sent: MockSent[]
  readonly reactions: Array<{ conversationId: string; messageId: string; emoji: string }>
  readonly edits: Array<{ conversationId: string; messageId: string; text: string }>
  readonly deletes: Array<{ conversationId: string; messageId: string }>
  readonly pins: Array<{ conversationId: string; messageId: string; pinned: boolean }>
  readonly typings: number[]
  /** Deliver a message from a person; resolves when the gateway handled it. */
  say(input: MockSay): Promise<string>
  /** A button pressed in a chat (an inbound `action` event). */
  press(input: {
    chat?: string
    topic?: string
    kind?: ConversationKind
    from: Identity
    name: string
    data?: string
    messageId?: string
  }): Promise<void>
  /** Deliver any event (edit, delete, a redelivery with the same id, ...). */
  emit(event: InboundEvent): Promise<void>
  /** The conversation reference the adapter builds for a chat. */
  ref(
    chat: string,
    options?: { topic?: string; kind?: ConversationKind; title?: string },
  ): ConversationRef
  /** The next `n` sends fail with this error. */
  failNext(error: ChannelError, n?: number): void
  /** Also deliver what this adapter sends to `other`, as a message from this identity (two bots in one room). */
  relayTo(other: MockAdapter): void
  /** Called for every send (after it is recorded). */
  onSend: Array<(sent: MockSent, ref: ConversationRef) => void>
}

export interface MockOptions {
  connectionId: string
  platform?: string
  self?: Identity
  capabilities?: Partial<ChannelCapabilities>
  actions?: NativeAction[]
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
  let counter = 0
  const failures: ChannelError[] = []
  const history = new Map<string, HistoryEntry[]>()
  const attachmentBytes = new Map<string, { bytes: Uint8Array; mediaType: string; name: string }>()
  const relays: MockAdapter[] = []

  const ref = (
    chat: string,
    opts: { topic?: string; kind?: ConversationKind; title?: string } = {},
  ): ConversationRef => ({
    id: opts.topic === undefined ? chat : `${chat}/${opts.topic}`,
    connectionId: options.connectionId,
    container: chat,
    ...(opts.topic === undefined ? {} : { topic: opts.topic }),
    kind: opts.kind ?? 'group',
    ...(opts.title === undefined ? {} : { title: opts.title }),
  })

  const keep = (conversationId: string, entry: HistoryEntry): void => {
    const list = history.get(conversationId) ?? []
    list.push(entry)
    history.set(conversationId, list)
  }

  const adapter: MockAdapter = {
    platform: options.platform ?? 'mock',
    connectionId: options.connectionId,
    capabilities,
    sent: [],
    reactions: [],
    edits: [],
    deletes: [],
    pins: [],
    typings: [],
    onSend: [],
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    self: () => selfIdentity,
    async start(s) {
      sink = s
    },
    async stop() {
      sink = undefined
    },
    async send(conversation, message) {
      const next = failures.shift()
      if (next !== undefined) throw next
      const messageId = `m${++counter}-${options.connectionId}`
      const record: MockSent = { conversationId: conversation.id, at: clock(), messageId, message }
      adapter.sent.push(record)
      keep(conversation.id, {
        messageId,
        at: record.at,
        sender: selfIdentity,
        text: message.text,
        ...(message.replyTo === undefined ? {} : { replyToId: message.replyTo }),
      })
      for (const fn of adapter.onSend) fn(record, conversation)
      for (const other of relays) {
        // the other bot sees this as a message from a bot in the same chat
        const relayed: InboundEvent = {
          type: 'message',
          conversation: other.ref(conversation.container, {
            ...(conversation.topic === undefined ? {} : { topic: conversation.topic }),
            kind: conversation.kind,
          }),
          at: record.at,
          messageId,
          sender: { ...selfIdentity, isSelf: false },
          text: message.text,
          attachments: [],
          signals: { mentionedSelf: false, replyToSelf: false },
        }
        void other.emit(relayed).catch(() => undefined)
      }
      return { messageId }
    },
    async edit(conversation, messageId, text) {
      adapter.edits.push({ conversationId: conversation.id, messageId, text })
    },
    async delete(conversation, messageId) {
      adapter.deletes.push({ conversationId: conversation.id, messageId })
    },
    async pin(conversation, messageId, pinned) {
      adapter.pins.push({ conversationId: conversation.id, messageId, pinned })
    },
    async react(conversation, messageId, emoji) {
      adapter.reactions.push({ conversationId: conversation.id, messageId, emoji })
    },
    async typing() {
      adapter.typings.push(clock())
    },
    async fetchHistory(conversation, opts) {
      const all = history.get(conversation.id) ?? []
      const end =
        opts.before === undefined ? all.length : all.findIndex((e) => e.messageId === opts.before)
      const upTo = end < 0 ? all.length : end
      return all.slice(Math.max(0, upTo - opts.limit), upTo)
    },
    async members() {
      return [selfIdentity]
    },
    async fetchAttachment(_conversation, messageId, attachmentId) {
      const found = attachmentBytes.get(`${messageId}:${attachmentId}`)
      if (found === undefined) throw new ChannelError('invalid', 'no such attachment')
      return found
    },
    conversationRef: (input) =>
      ref(input.container, {
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        kind: input.kind ?? 'channel',
      }),
    async emit(event) {
      if (sink === undefined) throw new Error('the mock adapter is not started')
      if (event.type === 'message') {
        keep(event.conversation.id, {
          messageId: event.messageId,
          at: event.at,
          sender: event.sender,
          text: event.text,
        })
      }
      await sink(event)
    },
    async say(input) {
      const id = input.id ?? `p${++counter}`
      const at = input.at ?? clock()
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
        type: 'message',
        conversation: ref(input.chat ?? 'room', {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          title: input.kind === 'dm' ? (input.from.name ?? input.from.id) : 'Room',
        }),
        at,
        messageId: id,
        sender: input.from,
        text: input.text,
        attachments,
        ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
        signals: {
          mentionedSelf: input.mentionSelf === true,
          ...(input.mentionOthers === true ? { mentionedOthers: true } : {}),
          replyToSelf: input.replyToSelf === true,
          ...(input.command === undefined ? {} : { command: input.command }),
        },
      })
      return id
    },
    async press(input) {
      await adapter.emit({
        type: 'action',
        conversation: ref(input.chat ?? 'room', {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          title: input.kind === 'dm' ? (input.from.name ?? input.from.id) : 'Room',
        }),
        at: clock(),
        name: input.name,
        sender: input.from,
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
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
  return adapter
}
