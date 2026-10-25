/** The channels gateway contracts: every public type of `createChannelGateway` (types only, plus ChannelUserError). */
import type { Database } from 'bun:sqlite'
import type { Answer as QuestionAnswer, Question as QuestionSpec } from 'eharness/ask'
import type { SecretVault } from 'eharness/providers'
import type { EventAppender, NewRoutine, RoutinePatch, ThreadStore } from '../../../app/ports.ts'
import type { Routine, RoutineSpec } from '../../../domain/routines.ts'
import type { ApprovalStore, OutboxRow, OutboxStore } from '../delivery-store.ts'
import type {
  AuditQuery,
  ChannelEvent,
  ChannelEventType,
  EventPage,
  EventStore,
  EventTableQuery,
  NewChannelEvent,
} from '../events.ts'
import type { Governor } from '../governor.ts'
import type { IdentityStore } from '../identities.ts'
import type { ChannelLog } from '../messages.ts'
import type { NodeRow } from '../model.ts'
import type { NodeStore } from '../nodes.ts'
import type { Outbound, OutboundOptions } from '../outbound.ts'
import type { PeopleNotes } from '../people-notes.ts'
import type { Person, PersonAccount, PersonStore } from '../persons.ts'
import type {
  ConnectionConfig,
  ConnectionConfigInput,
  ResolvedScope,
  ScopePolicy,
} from '../policy.ts'
import type { ReminderRow, ReminderWhen } from '../reminders.ts'
import type { Role, RoleSource } from '../roles.ts'
import type { SessionStore } from '../sessions.ts'
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelNode,
  EventOf,
  NodeInfo,
  OutboundFile,
  RemoteEvent,
} from '../types.ts'

export class ChannelUserError extends Error {}

export interface FilePart {
  type: 'file'
  mediaType: string
  url: string
  filename?: string
}

export interface ApprovalAnswerInput {
  agentId: string
  sessionId: string
  /** `approvalId` of the pending item (`toolCallId` of a question). */
  itemId: string
  /** `question` = an `ask_user_question` item: answered with an error text instead of a decision. */
  kind?: 'approval' | 'question'
  approved: boolean
  /** `session` = the same tool is not asked again in this session (the library's session grant). */
  remember?: 'session'
  /** The reason the model reads for a decline (the user-note wording, `userDeclinedText`). */
  reason?: string
  /**
   * A question answered by a person: one answer per question (`null` = dismissed). Without it a
   * question is answered with `reason` as an error text (expiry, a declined turn).
   */
  answers?: QuestionAnswer[] | null
  actor: { id: string; name?: string }
}

/** Answers an item on the session that owns it; `questions` reads the questions of a pending question. */
export interface ApprovalAnswerer {
  (
    input: ApprovalAnswerInput,
  ): Promise<{
    status: 'resumed' | 'recorded' | 'already-answered' | 'not-found'
  }>
  questions?(input: {
    agentId: string
    sessionId: string
    itemId: string
  }): Promise<QuestionSpec[] | undefined>
}

/** The routines a reminder is scheduled on (`sys:reminder:<id>`): the narrow part of the routine store. */
export interface ReminderRoutines {
  insert(routine: NewRoutine): Routine
  update(id: string, patch: RoutinePatch, now: number): Routine | undefined
  delete(id: string): boolean
  get(id: string): Routine | undefined
}

/** The part of a turn's `pending` state the gateway reads (a structural subset of the library's). */
export interface PendingView {
  approvals: ReadonlyArray<{
    approvalId: string
    toolCallId: string
    toolName: string
    input?: unknown
    risk?: string
    granted?: true
    answer?: unknown
  }>
  clientTools: ReadonlyArray<{
    toolCallId: string
    toolName: string
    input?: unknown
    answer?: unknown
    result?: unknown
  }>
}

export interface WakeInput {
  text: string
  files?: FilePart[]
}

export interface GatewayDeps {
  sqlite: Database
  /** Seals the message store (its own key, `vault.ts`). */
  vault: SecretVault
  agents: { get(id: string): { id: string; archivedAt: number | null } | undefined }
  threads: ThreadStore
  events?: EventAppender
  /** Deliver a wake into an agent session (`session.enqueue`). */
  sessions: {
    enqueue(
      agentId: string,
      sessionId: string,
      input: WakeInput,
      options: {
        mode: 'collect'
        id: string
        collect: { quietMs: number; maxWaitMs: number; maxItems: number }
      },
    ): Promise<void>
  }
  /**
   * Pause all with `holdChannels`: while true an inbound message is stored as context but does not
   * wake an agent. It is remembered, and `resumeHeld` answers it after Resume when the owner asked
   * for that. Read per message.
   */
  held?: () => boolean
  /**
   * Stops the session of a delegated agent (a child of a channel session): the requester's new
   * message cancels a foreground delegation instead of waiting for it. Absent = never interrupted.
   */
  delegation?: { abort(childSessionId: string, reason: string): Promise<boolean> }
  /** Inbound files become uploads of the library, like a file attached in the web app. */
  attachments: {
    store(file: {
      name: string
      mediaType: string
      bytes: Uint8Array
    }): Promise<{ url: string; mediaType: string; name: string; path: string }>
  }
  /** Reads a library file for `channel_send` uploads. */
  files: { read(path: string): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> }
  /**
   * Answers an approval of a channel session on the session that owns it (the library's
   * `answerAttention`, the same path as the web app). Absent = approvals cannot be answered from
   * a chat: the request only links to the web app.
   */
  approvals?: { answer: ApprovalAnswerer }
  /** Link to a channel thread in the web app, for requests that cannot use buttons. */
  webLink?: (target: { agentId: string; sessionId: string }) => string | undefined
  /** Retry timing of the outbox (tests use small values). */
  delivery?: { retryBaseMs?: number; retryMaxMs?: number; maxAttempts?: number }
  /**
   * Answer a Decision Center question from a chat (`announceDecision`): the option picked (or
   * `approved` / `rejected` for a question without options), by a named person. Throws when the
   * decision is no longer open.
   */
  answerDecision?(input: {
    decisionId: string
    choice: string
    by: { name: string }
  }): Promise<void>
  /** The web app page of a session, relative (`/a/<agent>?t=<thread>`), for bell notifications. */
  sessionPath?(input: { agentId: string; sessionId: string }): string | undefined
  /**
   * An approval nobody answered was declined, so the work behind it did not finish (P54: an
   * alarm for the owner). Called once per approval, never throws into the gateway.
   */
  onApprovalExpired?(info: {
    approvalId: string
    sessionId: string
    agentId: string
    toolName: string
    connectionId: string
    where: string
  }): void
  /** A bell notification (breaker opened). */
  notify?(n: {
    key: string
    title: string
    body: string
    agentId: string | null
    /** A page of the web app the notification opens. */
    link?: string
  }): void
  now?: () => number
  collect?: { quietMs: number; maxWaitMs: number; maxItems: number }
  /** Time and sleep of the outbound queue (tests). */
  outbound?: Pick<OutboundOptions, 'now' | 'sleep'>
  /** Typing refresh interval (ms, default 4000). */
  typingEveryMs?: number
  /** Default retention days of the message store (default 30). */
  retentionDays?: number
  /** Who the agent is in a chat: its name and the team's (configuration; never invented by the model). */
  identity?: (agentId: string) => { agentName?: string | undefined; teamName?: string | undefined }
  /** The team timezone (IANA): what today and 09:00 mean in a chat and in the message header. Default UTC. */
  timezone?: () => string
  /**
   * Reminders created from a chat are routines (`sys:reminder:<id>`, claimed and recovered by the
   * routine service). Absent = the `reminder` tool says reminders are not set up.
   */
  reminders?: {
    routines: ReminderRoutines
    schedule: {
      next(spec: RoutineSpec, afterMs: number): number | null
      validate(spec: RoutineSpec): void
    }
    ids?: () => string
    /** Most active repeating reminders one person may have (default 10; 0 = no limit). */
    maxRepeatingPerPerson?: number | (() => number)
    /**
     * Reminders made in a web chat thread (`connectionId` `web`): a fire posts the fixed text into
     * that thread and rings the bell, no model call. Absent = thread reminders are not set up.
     */
    web?: {
      deliver(reminder: ReminderRow, slot: number): Promise<{ posted: boolean; reason?: string }>
    }
  }
  /**
   * A message of somebody else was stored in a chat without waking the agent (observed): the
   * heartbeat may beat early because of it (debounced there). Never awaited, errors are ignored.
   */
  onObserved?: (event: { connectionId: string; nodeId: string; at: number }) => void
  /**
   * A platform event that was new (not a replay of one stored before) and was handled: the event
   * as the adapter delivered it (message text is in memory only, the log never holds it), the id
   * of its row in the log, and what the gateway did with it (for a listener of the app). Called
   * synchronously, never awaited; a throw is logged and ignored.
   */
  onEvent?: (info: {
    connectionId: string
    event: RemoteEvent
    eventId: string
    nodeId: string | null
    result: HandleResult
  }) => void
  /** Where `chat_recap_save` writes its note (the library). Absent = the tool cannot save. */
  library?: { write(path: string, text: string): Promise<void> }
  /** Period of the maintenance pass: approvals that expired, proactive posts that are due (default 60 s; 0 = off, tests call the methods). */
  maintenanceMs?: number
  /** Keep the platform payload of every event, sealed, so events can be re-normalized (default off). */
  keepRaw?: boolean
  log?: { warn(message: string): void }
  /**
   * Repairs or marks the public share links in a text the agent wrote, before it is sent (the final
   * text of a turn and `channel_send`). `where` names the place for the log. Absent = text as is.
   */
  fixLinks?: (text: string, where: string) => string
}

export type HandleResult =
  | { action: 'approval'; reason: string }
  | { action: 'wake'; reason: string }
  | { action: 'observe'; reason: string }
  | { action: 'drop'; reason: string }
  | { action: 'record'; reason: string }

export interface ConnectionInfo {
  connectionId: string
  platform: string
  agentId: string
  connected: boolean
  breaker: { open: boolean; until: number; reason: string } | undefined
}

/** A person's link to a team member. */
export interface PeerLink {
  connectionId: string
  peerId: string
  memberId: string
  name: string | null
  linkedAt: number
}

/** A person who wrote directly and is not linked: who and how often, never what. */
export interface UnlinkedSender {
  connectionId: string
  peerId: string
  name: string | null
  username: string | null
  firstSeen: number
  lastSeen: number
  messageCount: number
  ignored: boolean
}

export type ConversationKind = 'dm' | 'group' | 'channel'

/** One node of the inbox list. Metadata and a short preview; the log is read on demand. */
export interface InboxConversation {
  /** The node id. */
  conversationId: string
  kind: ConversationKind
  title: string
  /** The room the node belongs to (the chat of a topic); the node itself for a room. */
  container: string
  /** The thread's native id, for a topic. */
  topic?: string
  parentId?: string
  parentTitle?: string
  /** The agent that answers here now (the settings', else the connection's). */
  agentId: string
  /** The node passes the allowlist right now. */
  allowed: boolean
  woke: number
  observed: number
  dropped: number
  firstAt: number
  lastAt: number
  preview?: { text: string; at: number; self: boolean; sender?: string }
  /** The agent's session and thread, once the node woke the agent. */
  sessionId?: string
  threadId?: string
}

export interface InboxMessage {
  id: string
  platformId: string
  at: number
  self: boolean
  senderId?: string
  senderName?: string
  text: string
  attachments: Array<{ name?: string; mediaType?: string; size?: number }>
  replyTo?: { messageId: string; senderName?: string; text?: string }
  editedAt?: number
  deletedAt?: number
  edits?: Array<{ at: number; text: string }>
  disposition?: 'woke' | 'observed'
  /** The message is an approval request or question the agent posted, with how it ended. */
  approval?: {
    kind: 'approval' | 'question'
    toolName: string
    status: 'open' | 'answered'
    outcome?: string
    answeredBy?: string
    answeredAt?: number
  }
}

export interface InboxMessagePage {
  conversation: InboxConversation
  /** Oldest first. */
  items: InboxMessage[]
  /** Pass as `before` to load the older ones; undefined at the start of the log. */
  next?: string
}

export interface ActivityItem extends ChannelEvent {
  conversationTitle?: string
}

export interface TargetInput {
  connection?: string | undefined
  /** A node id, a native id or a title of a node of the connection. */
  conversation?: string | undefined
  /** A topic of the conversation (a child node: its native key, id or title). */
  topic?: string | undefined
  /** A mapped team member to DM. */
  member?: string | undefined
}

export interface ResolvedTarget {
  config: ConnectionConfig
  adapter: ChannelAdapter
  node: NodeRow
  /** The adapter-facing view of the node. */
  view: ChannelNode
  scope: ResolvedScope
}

export interface PostOptions {
  text: string
  /** Identity ids (ours) to mention; the only way to ping somebody (free text is neutralized). */
  mentions?: string[] | undefined
  replyTo?: string | undefined
  files?: OutboundFile[]
  /** The session whose tool call posts (kept on the outbox row). */
  sessionId?: string | undefined
}

/** The node a channel session answers in. */
export interface SessionTarget {
  connectionId: string
  sessionId: string
  agentId: string
  /** The node that owns the session. */
  nodeId: string
  /** Where the session answers by default (the node it last answered in). */
  node: NodeRow
  label: string | null
  generation: number
}

/** Who a turn answers to: the sender of the message(s) that woke the agent, with the directory role. */
/** The people directory as the web app and the agent tools use it (P43). */
export interface PeopleDirectory {
  persons: PersonStore
  /** The platform family of a connection (`telegram` for a bot and a user account alike). */
  platformOf(connectionId: string): string | undefined
  /** The linked person of a platform user of a connection. */
  personOfPeer(
    connectionId: string,
    peerId: string,
  ): { person: Person; account: PersonAccount } | undefined
  /** The identities seen on any connection for a person's linked accounts. */
  identitiesOf(personId: string): Array<{
    accountId: string
    platform: string
    nativeId: string
    label: string | null
    connectionId: string | undefined
    name: string | undefined
    username: string | undefined
  }>
  /** Observed people (any connection) whose account is linked to nobody: candidates to attach. */
  unassigned(limit: number): Array<{
    connectionId: string
    platform: string
    peerId: string
    name: string | undefined
    username: string | undefined
  }>
  /** The person of a platform user, created from what the account shows when none exists (an owner action). */
  ensureFor(connectionId: string, peerId: string, actor: string): Person | undefined
}

export interface Requester {
  connectionId: string
  /** The node the message was written in. */
  nodeId: string
  identityId: string
  /** The platform user id. */
  nativeId: string
  name?: string
  username?: string
  role: Role
  source: RoleSource
  /** Node ids (topics or rooms) the person belongs to. */
  divisions: string[]
  /** The team member the identity is linked to. */
  memberId?: string
  /** Every message that started the turn only greets or thanks (no memory read is needed for it). */
  smallTalk?: boolean
  /** A message that started the turn was forwarded: its words are somebody else's. */
  forwarded?: boolean
}

/** One person of a connection as the People tab and `member_lookup` show them. */
export interface PersonView {
  connectionId: string
  /** The platform user id. */
  peerId: string
  name: string | null
  username: string | null
  kind: string
  isBot: boolean
  role: Role
  roleSource: RoleSource
  /** A directory entry exists (the role was set by the team, not derived). */
  explicit: boolean
  divisions: Array<{ nodeId: string; title: string }>
  /** The team member the account is linked to. */
  memberId: string | null
  /** What the platform says this person is in the chats (imported, a suggestion only). */
  platformAdmin: Array<{
    nodeId: string
    title: string
    role: 'owner' | 'admin'
    customTitle?: string
  }>
  /** Set when the platform says admin/creator and the team has not decided: one click confirms it. */
  suggestion?: { role: Role; reason: string }
  /** What they asked to be called or how they like answers (a stated preference; P42). */
  note?: string
  firstSeen: number
  lastSeen: number
  /** Hidden from "Not linked yet". */
  ignored: boolean
  /** Direct messages sent while not linked (a count). */
  directMessages: number
}

export interface PeopleApi {
  list(connectionId: string): PersonView[]
  /** One page of the directory (SQL filter, sort and count); only the page is turned into views. */
  table(
    connectionId: string,
    query: {
      q?: string | undefined
      sort?: string | undefined
      order?: 'asc' | 'desc' | undefined
      role?: string | undefined
      linked?: boolean | undefined
      kind?: string | undefined
      ignored?: boolean | undefined
      page: number
      limit: number
    },
  ): { items: PersonView[]; total: number }
  /** `nodeId`: the chat the question is asked in (its default role for unknown people applies). */
  get(connectionId: string, peerId: string, nodeId?: string): PersonView | undefined
  /** By platform user id, username or part of a name (the directory entry of each match). */
  lookup(connectionId: string, query: string, limit: number, nodeId?: string): PersonView[]
  /** Give somebody a role (and divisions); only authorized actions call this, never chat text. */
  setRole(
    connectionId: string,
    peerId: string,
    input: { role: Role; divisions?: string[] | undefined },
    by: string,
  ): PersonView
  /** Back to the default (derived) role. */
  clearRole(connectionId: string, peerId: string): PersonView | undefined
  /**
   * Ask the platform for the administrators of a chat (or of every allowed chat) and keep their
   * status as suggestions. Never changes a role.
   */
  importAdmins(
    connectionId: string,
    nodeId?: string,
  ): Promise<{ chats: number; people: number; problems: string[] }>
}

export interface ReminderCreate {
  connectionId: string
  nodeId: string
  agentId: string
  text: string
  /** Identity ids (ours) to mention. */
  mentions: string[]
  when: ReminderWhen
  createdBy?: { identityId?: string; name?: string; role?: Role } | undefined
}

export interface ThreadReminderCreate {
  /** The web chat thread (session) the reminder is delivered into. */
  sessionId: string
  agentId: string
  text: string
  when: ReminderWhen
  createdBy?: { name?: string; role?: Role } | undefined
}

export interface RemindersApi {
  create(input: ReminderCreate): { reminder: ReminderRow } | { error: string }
  /** A reminder that fires into a web chat thread (self-reminders of the person using the app). */
  createInThread(input: ThreadReminderCreate): { reminder: ReminderRow } | { error: string }
  list(
    connectionId: string,
    filter?: { status?: ReminderRow['status']; nodeIds?: readonly string[]; createdBy?: string },
  ): ReminderRow[]
  /** One page of the reminders of a connection (SQL filter, sort and count). */
  table(
    connectionId: string,
    query: {
      q?: string | undefined
      sort?: string | undefined
      order?: 'asc' | 'desc' | undefined
      status?: ReminderRow['status'] | undefined
      nodeId?: string | undefined
      page: number
      limit: number
    },
  ): { items: ReminderRow[]; total: number }
  get(id: string): ReminderRow | undefined
  /** The next fire of an active reminder (one-time: its time; repeating: the next slot of its routine). */
  nextAt(reminder: ReminderRow): number | undefined
  cancel(id: string): ReminderRow | undefined
  update(
    id: string,
    patch: { text?: string; mentions?: string[]; when?: ReminderWhen; nodeId?: string },
  ): { reminder: ReminderRow } | { error: string }
  /** The routine fire: post the reminder through the outbox (no model call). */
  fire(id: string, input: { slot: number }): Promise<{ posted: boolean; reason?: string }>
  /** Delete finished reminders (and their routines) after the retention. */
  purge(): number
}

export type ProactiveResult =
  | { status: 'sent' | 'held' | 'silent'; message: string }
  | { status: 'refused'; message: string }

export interface ProactiveApi {
  /**
   * A post the agent makes unasked (a routine, the heartbeat): refused unless the node allows
   * proactive posts, silent when there is nothing to say, held in quiet hours and while a digest
   * collects posts, otherwise sent.
   */
  submit(input: {
    connectionId: string
    nodeId: string
    agentId: string
    text: string
    mentions: string[]
  }): Promise<ProactiveResult>
  /**
   * Would the policy let an unasked post that cannot wait (a file) go out right now? Returns the
   * reason when not (not allowed here, quiet hours, inside the digest gap), undefined when it may.
   */
  check(input: { connectionId: string; nodeId: string }): Promise<string | undefined>
  /** Send what is due (outside quiet hours, after the gap): one message per node. Returns the nodes served. */
  flush(at?: number): Promise<number>
}

/** A message whose delivery needs a person to look: still being checked, or failed and not dismissed. */
export interface OutboxAttentionItem {
  id: string
  /** Node id of the chat or topic the message was for. */
  chatId: string
  /** Chat (and topic) name; the node id when it is unknown now. */
  chat: string
  kind: OutboxRow['kind']
  /** `held` = the server stopped while sending and is checking the chat; `failed` = given up. */
  status: 'held' | 'failed'
  /** The platform could not say whether the message arrived (it was not resent). */
  uncertain: boolean
  /** The beginning of the message text. */
  preview: string
  reason: string | null
  attempts: number
  createdAt: number
  updatedAt: number
  /** "Send again" is offered. */
  retryable: boolean
  /** "Dismiss" is offered. */
  dismissable: boolean
}

export interface OutboxAttentionPage {
  items: OutboxAttentionItem[]
  next?: string
}

export type OutboxAction = 'queued' | 'dismissed' | 'not-found' | 'not-allowed'

/** The error text recovery writes when the platform cannot say whether a message arrived. */
export const UNCERTAIN_DELIVERY_REASON =
  'the process stopped while sending and the platform cannot say whether it arrived; not resent to avoid a duplicate'

export interface ChannelGateway {
  configure(input: ConnectionConfigInput): ConnectionConfig
  removeConnection(connectionId: string): void
  config(connectionId: string): ConnectionConfig | undefined
  configs(): ConnectionConfig[]
  /** Attach an adapter to its connection and start it. */
  register(adapter: ChannelAdapter): Promise<void>
  unregister(connectionId: string): Promise<void>
  connections(): ConnectionInfo[]
  adapter(connectionId: string): ChannelAdapter | undefined
  /** One event of an adapter (adapters call this through the sink given to `start`). */
  handle(connectionId: string, event: RemoteEvent): Promise<HandleResult>
  pairing: {
    /**
     * Link a platform account to a team member by hand (the account id is the platform user id).
     * The name comes from the person's first message when we saw one.
     */
    link(connectionId: string, peerId: string, memberId: string, name?: string): PeerLink
    members(connectionId: string): PeerLink[]
    unlink(connectionId: string, peerId: string): boolean
  }
  /** People who wrote directly and are not linked: who and how often, never what. */
  unlinked: {
    list(connectionId: string, options?: { includeIgnored?: boolean }): UnlinkedSender[]
    ignore(connectionId: string, peerId: string, ignored: boolean): boolean
  }
  /** The nodes of a connection and their message logs (decrypted here, for the web token holder). */
  inbox: {
    conversations(
      connectionId: string,
      options: { limit: number; cursor?: string | undefined },
    ): Promise<{ items: InboxConversation[]; next?: string }>
    /** One page of the conversations (SQL filter, sort and count). */
    table(
      connectionId: string,
      query: {
        q?: string | undefined
        sort?: string | undefined
        order?: 'asc' | 'desc' | undefined
        kind?: 'dm' | 'group' | 'channel' | 'topic' | undefined
        page: number
        limit: number
      },
    ): Promise<{ items: InboxConversation[]; total: number }>
    messages(
      connectionId: string,
      nodeId: string,
      options: { limit: number; before?: string | undefined },
    ): Promise<InboxMessagePage | undefined>
  }
  /** What happened on a connection (metadata only). */
  activity: {
    record(event: Omit<NewChannelEvent, 'at'> & { at?: number }): void
    list(
      connectionId: string,
      query: {
        type?: ChannelEventType | undefined
        direction?: 'in' | 'out' | undefined
        action?: string | undefined
        conversationId?: string | undefined
        before?: string | undefined
        limit: number
      },
    ): Omit<EventPage, 'items'> & { items: ActivityItem[] }
    /** One page of activity (SQL filter and count), newest first by default. */
    table(connectionId: string, query: EventTableQuery): { items: ActivityItem[]; total: number }
    /** The action and read names recorded so far. */
    actions(connectionId: string): string[]
    /** Platform actions and reads of every connection, newest first, cursor paged (the audit). */
    audit(query: AuditQuery): Omit<EventPage, 'items'> & { items: ActivityItem[] }
    /** Delete events past the events retention (age and count). */
    prune(options: { olderThan?: number; keepLast?: number }): number
  }
  /** The tree of nodes, their links and per-connection access. */
  nodes: NodeStore
  identities: IdentityStore
  /** Settings that inherit down the tree. */
  settings: {
    /** What is stored on the node itself. */
    get(nodeId: string): ScopePolicy
    /** Set keys on the node; a `null` value removes the key (inherit again). */
    set(nodeId: string, patch: { [K in keyof ScopePolicy]?: ScopePolicy[K] | null }): void
    /** The node's effective settings, with where each one came from. */
    resolve(nodeId: string): ResolvedScope | undefined
    /** Create (or return) a node the platform has not shown us yet, so it can be configured and posted to. */
    ensureNode(connectionId: string, info: NodeInfo, parentNativeId?: string): NodeRow
  }
  /** The people directory: roles and divisions, what the platform says about admins. */
  people: PeopleApi
  /** Notes on directory profiles: how a person likes to be addressed (never roles or permissions). */
  notes: PeopleNotes
  /** Reminders created from a chat. */
  reminders: RemindersApi
  /** What the agent posts without being asked. */
  proactive: ProactiveApi
  /** The team timezone (IANA). */
  timezone(): string
  /**
   * Who the turn of a session answers to (the sender of the message that woke it, lowest role
   * when several people triggered it); undefined for a turn no chat message started.
   */
  requesterOf(sessionId: string): Promise<Requester | undefined>
  /** The current turn of the session was started by the signed-in owner in the web app (never a chat message). */
  webTurn(sessionId: string): boolean
  /**
   * True when a chat message woke the turn but its sender could not be resolved (row purged,
   * identity unset): such a turn is treated as a guest, never as unrestricted. Turns no chat
   * message started (web, program) are unrestricted by design and are not flagged.
   */
  unresolvedChatTurn(sessionId: string): boolean
  /** What an identity is today (directory role); undefined when the identity is gone. */
  roleOfIdentity(identityId: string): Role | undefined
  /**
   * A child session (worker, delegated agent) of a channel session opens: it acts for the person
   * who asked in the parent turn (their role and scope). Call when the child session opens.
   */
  adoptChild(childSessionId: string, parentSessionId: string): void
  /**
   * Is this call exactly what an owner or admin just asked for in this chat (a direct instruction)?
   * Then it needs no second confirmation. Decided in code: the live chat message that started the
   * turn, its sender's directory role, the target (the same chat), and every person mentioned being
   * named in that message. Anything else (and anything destructive) still asks.
   */
  directInstruction(sessionId: string, call: { toolName: string; input: unknown }): Promise<boolean>
  /** The room a node belongs to: itself, or the nearest ancestor that is not a thread. */
  roomOf(node: NodeRow): NodeRow
  /** The adapter's view of a stored node (for optional adapter operations). */
  viewOf(node: NodeRow): ChannelNode
  /** " Chats: …" listing the allowed group chats of a connection (a hint for a call that named none). */
  chatsHint(connectionId: string): string
  /** The people directory (P43): persons, their accounts, and how a platform user resolves to one. */
  directory: PeopleDirectory
  /**
   * A Decision Center question of a run that belongs to a chat (the program was proposed there) is
   * asked in that chat too: owners and admins answer with an option number, its text, or ya/tidak.
   */
  announceDecision(input: {
    sessionId: string
    decisionId: string
    title: string
    question: string
    options: readonly string[]
  }): Promise<void>
  /** May this requester read what was said in the node? Staff: any node; a member: their own node and their divisions; a guest: none. */
  canRead(requester: Requester, node: NodeRow): boolean
  /** Resolve who to mention: a team member id, a platform user id or an identity id. */
  resolveMentions(
    connectionId: string,
    refs: readonly string[],
  ): { ids: string[] } | { error: string }
  /** Approvals nobody answered within `approvalTtlMs` are declined ("not answered"). Returns how many. */
  expireApprovals(at?: number): Promise<number>
  /**
   * Message the owners of the people directory in their direct chat (alarms, P54): through the
   * normal outbox, on the first connection where the owner has an account. `unavailable` when no
   * owner could be reached (no owner, no linked account, no connected transport).
   */
  notifyOwners(text: string): Promise<'sent' | 'unavailable'>
  /** Sessions bound to nodes. */
  sessions: SessionStore
  /** The event log (platform events and gateway activity). */
  events: EventStore
  log: ChannelLog
  /** The outbox: every message is a row before it is sent (replies, posts, approval requests). */
  outbox: OutboxStore
  /** Approvals and questions announced in chat nodes. */
  approvals: ApprovalStore
  /** Send what is due in the outbox of a connection (default: all). Resolves when the pass is done. */
  flush(connectionId?: string): Promise<void>
  /** Messages of a connection that need a look (held, or failed and not dismissed), newest first. */
  outboxAttention(
    connectionId: string,
    query?: { limit?: number; before?: string },
  ): Promise<OutboxAttentionPage>
  /** Re-queue a failed message ("Send again"); it may appear twice when it had arrived after all. */
  retryOutbox(connectionId: string, id: string): Promise<OutboxAction>
  /** Mark a failed message reviewed; it leaves the list and nothing is deleted. */
  dismissOutbox(connectionId: string, id: string): Promise<OutboxAction>
  /**
   * An item of a channel session stopped waiting (answered in the web app, by the classifier, or
   * from a chat): updates the announcement. Fed from the activity feed (`pending-changed`).
   */
  pendingChanged(event: { sessionId: string; waiting: readonly string[] }): Promise<void>
  /** Tool names of the read-risk native actions of the connections an agent has (allowed without asking). */
  readActionTools(agentId: string): string[]
  outbound: Outbound
  /** The API governor of every connection: buckets, the shared park state and the audit of platform calls. */
  governor: Governor
  /** Where `chat_recap_save` writes (undefined = notes cannot be saved). */
  library: GatewayDeps['library']
  /** Library access of the tools (uploads out, attachments in). */
  files: GatewayDeps['files']
  attachments: GatewayDeps['attachments']
  /** Connections an agent answers for (the connection's own agent or an agent set on a node). */
  connectionsOf(agentId: string): ConnectionInfo[]
  isBound(agentId: string, connectionId: string): boolean
  /** A node of a connection by node id, native id, old conversation id or exact title. */
  nodeOf(connectionId: string, ref: string): NodeRow | undefined
  /** The node a channel session answers in (undefined for any other session). */
  conversationOf(sessionId: string): SessionTarget | undefined
  resolveTarget(agentId: string, sessionId: string | undefined, input: TargetInput): ResolvedTarget
  post(target: ResolvedTarget, options: PostOptions): Promise<string[]>
  /** What a node supports now (the adapter's answer for this node). */
  capabilities(connectionId: string, node: NodeRow): ChannelCapabilities | undefined
  /** Instructions of a channel session (static for the session). */
  sessionNote(sessionId: string): string | undefined
  /**
   * The per-turn medium reminder (where the agent is, default reply length). `turn` tells a turn the
   * web app started (no chat message behind it) from a chat turn: its reply is not posted.
   */
  mediumNote(
    sessionId: string,
    turn?: { kind?: string; keys?: readonly string[] | undefined },
  ): string | undefined
  /** What the people of the turn asked to be called (their directory notes), as a turn reminder. */
  peopleNote(sessionId: string, keys?: readonly string[]): Promise<string | undefined>
  /** Rename legacy channel threads to "<chat> / <topic>" (boot, once; returns how many changed). */
  retitleThreads(): number
  /** The observed messages since the last reply, as a turn reminder (undefined when none). */
  reminder(sessionId: string): Promise<string | undefined>
  turnStarted(sessionId: string, keys: readonly string[]): void
  /** `turnStarted` plus the requester of the turn (the hook awaits it: tools run after it). */
  beginTurn(
    sessionId: string,
    keys: readonly string[] | undefined,
    turn?: { kind: string; id: string },
  ): Promise<void>
  turnEnded(end: {
    sessionId: string
    stop: string
    messages: ReadonlyArray<{ role: string; parts?: unknown; metadata?: unknown }>
    pending?: PendingView | undefined
    /** Why a turn that stopped with `error` failed (provider text; never posted as is). */
    error?: { code: string; message: string } | undefined
    /** The failure is transient and the same turn is tried again later: no notice now. */
    retrying?: boolean | undefined
  }): Promise<void>
  /**
   * A delegated agent (a child of a channel session) ended a turn. When it waits for an approval
   * or an answer, the request is posted in the conversation that asked for the work (answerable by
   * the allowed roles); when it is done its announcements are closed.
   */
  delegatedTurnEnded(end: {
    parentSessionId: string
    childSessionId: string
    childAgentId: string
    agentName?: string | undefined
    stop: string
    pending?: PendingView | undefined
  }): Promise<void>
  /** A delegated agent starts a turn; `foreground` = the launcher's turn waits for it (see `interruptForeground`). */
  delegatedTurnStarted(start: {
    parentSessionId: string
    childSessionId: string
    foreground: boolean
  }): void
  /**
   * Boot recovery closed the turn of a channel session a restart interrupted: the person who
   * wrote last is told once to send the request again (never re-run: tools may have partly run).
   */
  turnInterrupted(sessionId: string): Promise<boolean>
  /** Delete messages past their retention. Returns the number removed. */
  purge(): number
  /** Place events that arrived without a node (a deletion that named no chat) when their messages are known now. */
  resolveUnresolved(connectionId?: string): number
  /**
   * Store a message that came from history (a backfill, a moderation log) without acting on it:
   * never wakes an agent. Only for nodes that pass the allowlist. False when it was stored before
   * or is not wanted.
   */
  ingest(connectionId: string, event: EventOf<'message.created'>): Promise<boolean>
  /**
   * Messages found in a gap after the transport was down (oldest first), of one chat. When the
   * connection answers missed messages (`replyMissed`) and a message is within the window, it goes
   * through the same inbound path as a live one (policy, people, pause) and the agent is woken once
   * for the chat with a note that the messages arrived while it was offline. Every other message
   * is only stored, like `ingest`. A message answered once is never answered again.
   */
  catchUp(
    connectionId: string,
    events: ReadonlyArray<EventOf<'message.created'>>,
  ): Promise<{ stored: number; woke: number }>
  /**
   * Resume after Pause all: the messages the hold kept from waking an agent. With `answer`, each
   * conversation wakes once with the ones younger than `maxAgeMs`; without, they are dropped.
   * Held messages are settled either way, so none is ever answered at a later resume.
   */
  resumeHeld(options: {
    answer: boolean
    maxAgeMs: number
  }): Promise<{ conversations: number; messages: number }>
  /** Resolves when the boot-time data migration of the old tables has finished. */
  ready(): Promise<void>
  stop(): Promise<void>
}
