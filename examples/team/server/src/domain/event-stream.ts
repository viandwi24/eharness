/**
 * The event stream: ONE readable view over what happens in the workspace. Pure.
 *
 * Two sources feed it without a second copy of the data: the platform events of the channel
 * connections (`ch_events`: messages, reactions, members, join requests, chat changes) and the
 * app events of the feed (`events`: alarms, programs, tasks, settings, ...). Each row of the view
 * is a {@link StreamEvent}. Message bodies are never in it: the log does not keep them, and the
 * summary names who did what where, never what was said.
 *
 * Ids sort by time: `ch:<uuidv7>` for a channel event, `app:<zero padded seq>` for an app event.
 */

/** Where an event comes from. */
export const STREAM_SOURCES = ['channel', 'app'] as const
export type StreamSource = (typeof STREAM_SOURCES)[number]

/** The platform event types the stream lists (what the gateway's activity log adds on top is not an event of the world). */
export const CHANNEL_STREAM_TYPES = [
  'message.created',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
  'member.joined',
  'member.left',
  'member.updated',
  'member.join_requested',
  'member.join_request_resolved',
  'node.created',
  'node.updated',
  'node.state_changed',
  'node.migrated',
  'action',
] as const
export type ChannelStreamType = (typeof CHANNEL_STREAM_TYPES)[number]

/** App events of the feed that are worth listening to, by the name the stream gives them. */
export const APP_STREAM_TYPES = [
  'alarm.raised',
  'task.changed',
  'program.changed',
  'routine.fired',
  'routine.changed',
  'decision.changed',
  'settings.changed',
  'mode.changed',
  'cache.reset',
  'providers.changed',
  'connectors.changed',
  'agent.changed',
  'heartbeat.changed',
] as const
export type AppStreamType = (typeof APP_STREAM_TYPES)[number]

export type StreamEventType = ChannelStreamType | AppStreamType
export const STREAM_TYPES: readonly StreamEventType[] = [
  ...CHANNEL_STREAM_TYPES,
  ...APP_STREAM_TYPES,
]

export const isStreamType = (t: string): t is StreamEventType =>
  (STREAM_TYPES as readonly string[]).includes(t)
export const isChannelType = (t: string): t is ChannelStreamType =>
  (CHANNEL_STREAM_TYPES as readonly string[]).includes(t)
export const isAppType = (t: string): t is AppStreamType =>
  (APP_STREAM_TYPES as readonly string[]).includes(t)
export const sourceOfType = (t: StreamEventType): StreamSource =>
  isChannelType(t) ? 'channel' : 'app'

/** The stream name of an app feed type (`alarm-raised` -> `alarm.raised`), or undefined when it is not listed. */
export function streamTypeOfFeed(feedType: string): AppStreamType | undefined {
  const t = feedType.replace('-', '.')
  return isAppType(t) ? t : undefined
}
/** The feed type of a stream type (`alarm.raised` -> `alarm-raised`). */
export const feedTypeOfStream = (t: AppStreamType): string => t.replace('.', '-')

/** Types that arrive by the hundred: their non-matching filters are counted, not logged. */
export const HIGH_VOLUME_TYPES: readonly StreamEventType[] = [
  'message.created',
  'message.edited',
  'message.deleted',
  'reaction.added',
  'reaction.removed',
]

/** How old an event may be and still fire a trigger (a catch-up after a restart replays old ones). */
export const FRESH_MS = 15 * 60_000
/** Join requests are slower to be noticed (a bot polls what Telegram queued while it was away). */
export const FRESH_JOIN_MS = 24 * 3_600_000
export const freshMs = (t: StreamEventType): number =>
  t === 'member.join_requested' ? FRESH_JOIN_MS : FRESH_MS

// --- the catalog -------------------------------------------------------------------------------

export interface EventTypeInfo {
  type: StreamEventType
  source: StreamSource
  /** One line: what it means. */
  label: string
  /** Filter fields the type offers (`StreamEvent.fields`). */
  fields: readonly string[]
  /** What each kind of connection delivers; absent for app events. */
  delivery?: { bot: string; account: string }
}

const D = (bot: string, account: string): { bot: string; account: string } => ({ bot, account })

export const EVENT_CATALOG: readonly EventTypeInfo[] = [
  {
    type: 'message.created',
    source: 'channel',
    label: 'A message was posted',
    fields: ['sender', 'attachments'],
    delivery: D(
      'Yes: every message the bot receives (in a group with privacy mode on: mentions, replies and commands, or everything when the bot is an admin).',
      'Yes: chats chosen for ingest and direct chats.',
    ),
  },
  {
    type: 'message.edited',
    source: 'channel',
    label: 'A message was edited',
    fields: ['sender'],
    delivery: D('Yes.', 'Yes.'),
  },
  {
    type: 'message.deleted',
    source: 'channel',
    label: 'Messages were deleted',
    fields: ['count'],
    delivery: D(
      'No: the Bot API does not report deletions.',
      'Yes, as ids only (no text, no person). A deletion in a channel or supergroup names the chat; one in a private chat or basic group is matched through the stored log.',
    ),
  },
  {
    type: 'reaction.added',
    source: 'channel',
    label: 'Somebody reacted to a message',
    fields: ['emoji', 'sender'],
    delivery: D(
      'Yes, in chats where the bot is an administrator and in direct chats.',
      'No: Telegram sends reactions of other people to a user account only as counts, which the app does not follow.',
    ),
  },
  {
    type: 'reaction.removed',
    source: 'channel',
    label: 'A reaction was removed',
    fields: ['emoji', 'sender'],
    delivery: D('Yes, like reactions added.', 'No.'),
  },
  {
    type: 'member.joined',
    source: 'channel',
    label: 'Somebody joined a chat',
    fields: ['user', 'role', 'by'],
    delivery: D(
      'Yes, when the bot is an administrator of the chat.',
      'Yes, when the account is an administrator of the chat.',
    ),
  },
  {
    type: 'member.left',
    source: 'channel',
    label: 'Somebody left or was removed',
    fields: ['user', 'role', 'by'],
    delivery: D(
      'Yes, when the bot is an administrator of the chat.',
      'Yes, when the account is an administrator of the chat.',
    ),
  },
  {
    type: 'member.updated',
    source: 'channel',
    label: 'A member was promoted, demoted or restricted',
    fields: ['user', 'role', 'by'],
    delivery: D(
      'Yes, when the bot is an administrator of the chat.',
      'Yes, when the account is an administrator of the chat.',
    ),
  },
  {
    type: 'member.join_requested',
    source: 'channel',
    label: 'Somebody asked to join a chat that needs approval',
    fields: ['user', 'username', 'link', 'pending'],
    delivery: D(
      'Yes, when the bot is an administrator with the "invite users" right. The request is saved and answered with join_requests.',
      'Yes, when the account is an administrator of the chat and the chat is chosen. The request is saved and answered with answer_join_request.',
    ),
  },
  {
    type: 'member.join_request_resolved',
    source: 'channel',
    label: 'A join request was approved or declined',
    fields: ['user', 'resolution', 'bySelf'],
    delivery: D(
      'Yes: answered with the bot tool, or approved by another admin (seen as the person joining). A decline by another admin is not reported by the Bot API.',
      'Yes: answered with the account tool. An answer given by another admin or in the Telegram app is not reported.',
    ),
  },
  {
    type: 'node.created',
    source: 'channel',
    label: 'A chat or topic appeared',
    fields: [],
    delivery: D('Yes.', 'Yes (topics of a forum and chats seen in the dialog list).'),
  },
  {
    type: 'node.updated',
    source: 'channel',
    label: 'A chat or topic changed (title, settings)',
    fields: [],
    delivery: D('Yes.', 'Yes (topic titles).'),
  },
  {
    type: 'node.state_changed',
    source: 'channel',
    label: 'A chat became active, left or archived',
    fields: ['state'],
    delivery: D('Yes (the bot was added, removed or blocked).', 'Yes.'),
  },
  {
    type: 'node.migrated',
    source: 'channel',
    label: 'A group became a supergroup (new chat id)',
    fields: ['from'],
    delivery: D('Yes.', 'Yes.'),
  },
  {
    type: 'action',
    source: 'channel',
    label: 'A button was pressed',
    fields: ['name'],
    delivery: D('Yes (inline buttons).', 'No.'),
  },
  {
    type: 'alarm.raised',
    source: 'app',
    label: 'An alarm was raised (a failed run, a broken connection, ...)',
    fields: ['kind', 'subject', 'program'],
  },
  {
    type: 'task.changed',
    source: 'app',
    label: 'A task or run changed status',
    fields: ['status', 'title', 'program'],
  },
  {
    type: 'program.changed',
    source: 'app',
    label: 'A program was created, edited, paused or deleted',
    fields: ['change', 'name'],
  },
  {
    type: 'routine.fired',
    source: 'app',
    label: 'A routine slot fired, was skipped or failed',
    fields: ['status', 'trigger', 'reason'],
  },
  {
    type: 'routine.changed',
    source: 'app',
    label: 'A routine was created, edited or paused',
    fields: ['change', 'name'],
  },
  {
    type: 'decision.changed',
    source: 'app',
    label: 'A decision was asked or answered',
    fields: ['change'],
  },
  {
    type: 'settings.changed',
    source: 'app',
    label: 'Settings or Pause all changed',
    fields: ['keys', 'change'],
  },
  { type: 'mode.changed', source: 'app', label: 'A permission mode changed', fields: ['mode'] },
  {
    type: 'cache.reset',
    source: 'app',
    label: 'An agent lost its prompt cache',
    fields: ['reason'],
  },
  {
    type: 'providers.changed',
    source: 'app',
    label: 'A model provider profile changed',
    fields: ['action'],
  },
  { type: 'connectors.changed', source: 'app', label: 'A connector changed', fields: [] },
  { type: 'agent.changed', source: 'app', label: 'An agent or its persona changed', fields: [] },
  {
    type: 'heartbeat.changed',
    source: 'app',
    label: 'A heartbeat setting changed',
    fields: ['change'],
  },
]

export const catalogOf = (t: StreamEventType): EventTypeInfo =>
  EVENT_CATALOG.find((c) => c.type === t) as EventTypeInfo

// --- the event ---------------------------------------------------------------------------------

export interface StreamActor {
  /** The platform user id (channel events). */
  id?: string
  name?: string
  username?: string
  /** The directory role of the person on that connection; absent when unknown. */
  role?: string
  /** The connection's own identity: the agent itself. */
  self?: boolean
}

export interface StreamChat {
  /** Internal node id. */
  nodeId: string
  /** The room (chat) of a topic. */
  roomId?: string
  nativeId: string
  title: string
}

export interface StreamEvent {
  /** `ch:<id>` or `app:<seq>`; sorts by time. */
  id: string
  /** Epoch ms. */
  at: number
  source: StreamSource
  /** The connection of a channel event. */
  connectionId?: string
  /** The label of the connection (or `app`). */
  sourceLabel: string
  type: StreamEventType
  chat?: StreamChat
  actor?: StreamActor
  /** One readable sentence: who did what where. Never a message body. */
  summary: string
  /** Flat facts the filters of a trigger and the detail sheet read. */
  fields: Record<string, string>
  /** The app page of the detail (a chat, a program, the health page), when there is one. */
  link: string | null
  /** The agent itself caused it (its own message, its own admin action, a run a trigger started). */
  agentCaused: boolean
  /** The agent of an app event. */
  agentId?: string
  /** The session of an app event. */
  sessionId?: string
}

export interface StreamQuery {
  source?: StreamSource | undefined
  connectionId?: string | undefined
  /** Only the chat events of these connections (a scope the caller was granted); app events are not limited. */
  connectionIds?: readonly string[] | undefined
  types?: readonly string[] | undefined
  /** A node id, or part of a chat title. */
  chat?: string | undefined
  /** A platform user id, or part of a name or username. */
  actor?: string | undefined
  from?: number | undefined
  to?: number | undefined
  limit: number
  cursor?: string | undefined
}

export interface StreamPage {
  items: StreamEvent[]
  /** Pass as `cursor` for older events; absent at the end. */
  next?: string
}

export const STREAM_DEFAULT_LIMIT = 50
export const STREAM_MAX_LIMIT = 200

/** The cursor holds the last id returned of each source, so a page never repeats or skips. */
export interface StreamCursor {
  ch: string | null
  app: number | null
}
export const encodeCursor = (c: StreamCursor): string =>
  btoa(JSON.stringify([c.ch, c.app])).replace(/=+$/, '')
export function decodeCursor(text: string | undefined): StreamCursor {
  if (text === undefined || text === '') return { ch: null, app: null }
  try {
    const v = JSON.parse(atob(text)) as unknown
    if (Array.isArray(v)) {
      return {
        ch: typeof v[0] === 'string' ? v[0] : null,
        app: typeof v[1] === 'number' ? v[1] : null,
      }
    }
  } catch {}
  return { ch: null, app: null }
}

export const appEventId = (seq: number): string => `app:${String(seq).padStart(12, '0')}`
export const channelEventId = (id: string): string => `ch:${id}`
export function parseEventId(
  id: string,
): { source: 'channel'; id: string } | { source: 'app'; seq: number } | undefined {
  if (id.startsWith('ch:') && id.length > 3) return { source: 'channel', id: id.slice(3) }
  if (id.startsWith('app:')) {
    const n = Number(id.slice(4))
    return Number.isInteger(n) && n > 0 ? { source: 'app', seq: n } : undefined
  }
  return undefined
}

// --- text --------------------------------------------------------------------------------------

/** One line of data: no control characters, bounded. */
export function oneLine(text: string, max = 80): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    out += code < 32 || code === 127 ? ' ' : ch
  }
  const clean = out.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

export function actorLabel(a: StreamActor | undefined): string {
  if (a === undefined) return 'somebody'
  const name = a.name === undefined || a.name === '' ? undefined : oneLine(a.name, 60)
  const handle = a.username === undefined ? undefined : `@${oneLine(a.username, 40)}`
  const label =
    [name, handle].filter((x) => x !== undefined).join(' ') ||
    (a.id === undefined ? 'somebody' : `user ${a.id}`)
  return a.self === true ? `${label} (the agent)` : label
}

/** The summary of a channel event: names, places, counts, never text. */
export function summarizeChannel(
  type: ChannelStreamType,
  input: {
    actor?: StreamActor | undefined
    chat?: string | undefined
    fields: Record<string, string>
  },
): string {
  const who = actorLabel(input.actor)
  const where = input.chat === undefined ? '' : ` in "${oneLine(input.chat, 60)}"`
  const f = input.fields
  switch (type) {
    case 'message.created': {
      const n = Number(f.attachments ?? 0)
      return `${who} wrote${where}${n > 0 ? ` (${n} attachment${n === 1 ? '' : 's'})` : ''}${f.reply === 'true' ? ', as a reply' : ''}`
    }
    case 'message.edited':
      return `${who} edited a message${where}`
    case 'message.deleted': {
      const n = Number(f.count ?? 1)
      return `${n} message${n === 1 ? ' was' : 's were'} deleted${where}`
    }
    case 'reaction.added':
      return `${who} reacted ${f.emoji ?? ''}${where}`.replace('  ', ' ')
    case 'reaction.removed':
      return `${who} removed the reaction ${f.emoji ?? ''}${where}`.replace('  ', ' ')
    case 'member.joined':
      return `${who} joined${where}${f.by === undefined || f.by === who ? '' : `, added by ${f.by}`}`
    case 'member.left':
      return `${who} left or was removed${where}${f.by === undefined || f.by === who ? '' : ` by ${f.by}`}`
    case 'member.updated':
      return `${who} is now ${f.role ?? 'changed'}${where}${f.by === undefined || f.by === who ? '' : ` (by ${f.by})`}`
    case 'member.join_requested':
      return `${who} asked to join${where}${f.link === undefined ? '' : ' through an invite link'}${f.pending === undefined ? '' : `; ${f.pending} pending`}`
    case 'member.join_request_resolved':
      return `The request of ${who} to join${where} was ${f.resolution ?? 'answered'}${f.bySelf === 'true' ? ' by the agent' : ''}`
    case 'node.created':
      return `A chat appeared${where}`
    case 'node.updated':
      return `A chat changed${where}`
    case 'node.state_changed':
      return `The chat${where} is now ${f.state ?? 'changed'}${f.reason === undefined ? '' : ` (${oneLine(f.reason, 40)})`}`
    case 'node.migrated':
      return `A group${where} became a supergroup`
    case 'action':
      return `${who} pressed the button ${f.name ?? ''}${where}`.replace('  ', ' ')
  }
}

/** The summary of an app event. */
export function summarizeApp(type: AppStreamType, f: Record<string, string>): string {
  switch (type) {
    case 'alarm.raised':
      return `Alarm (${f.kind ?? 'system'}): ${oneLine(f.text ?? f.subject ?? '', 160)}`
    case 'task.changed':
      return `${f.program === undefined ? 'Task' : `Program run of ${f.program}`}${f.title === undefined ? '' : ` "${oneLine(f.title, 60)}"`} is now ${f.status ?? 'changed'}`
    case 'program.changed':
      return `Program ${f.name === undefined ? '' : `"${oneLine(f.name, 60)}" `}${f.change ?? 'changed'}`.replace(
        '  ',
        ' ',
      )
    case 'routine.fired':
      return `Routine fired: ${f.status ?? 'fired'}${f.reason === undefined ? '' : ` (${oneLine(f.reason, 60)})`}`
    case 'routine.changed':
      return `Routine ${f.name === undefined ? '' : `"${oneLine(f.name, 60)}" `}${f.change ?? 'changed'}`.replace(
        '  ',
        ' ',
      )
    case 'decision.changed':
      return `A decision ${f.change ?? 'changed'}`
    case 'settings.changed':
      return f.change !== undefined
        ? `Pause all: ${f.change}`
        : `Settings changed${f.keys === undefined ? '' : `: ${oneLine(f.keys, 80)}`}`
    case 'mode.changed':
      return `Permission mode is now ${f.mode ?? 'changed'}`
    case 'cache.reset':
      return `An agent lost its prompt cache${f.reason === undefined ? '' : `: ${oneLine(f.reason, 80)}`}`
    case 'providers.changed':
      return `A model provider profile ${f.action ?? 'changed'}`
    case 'connectors.changed':
      return 'A connector changed'
    case 'agent.changed':
      return 'An agent or its persona changed'
    case 'heartbeat.changed':
      return `A heartbeat ${f.change ?? 'changed'}`
  }
}

/** Flatten an app event payload into the filter fields (strings only, bounded). */
export function appFields(
  type: AppStreamType,
  payload: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: unknown): void => {
    if (v === undefined || v === null || v === '') return
    out[k] = Array.isArray(v) ? v.map(String).join(',') : String(v)
    if (out[k].length > 300) out[k] = out[k].slice(0, 300)
  }
  switch (type) {
    case 'alarm.raised':
      put('kind', payload.kind)
      put('subject', payload.subject)
      put('program', payload.program)
      put('text', payload.text)
      break
    case 'task.changed': {
      put('status', payload.status)
      put('title', payload.title)
      const m = /^Program run: (.+)$/.exec(String(payload.title ?? ''))
      if (m?.[1] !== undefined) put('program', m[1])
      break
    }
    case 'program.changed':
    case 'routine.changed':
      put('change', payload.change)
      put('name', payload.name)
      break
    case 'routine.fired':
      put('status', payload.status)
      put('trigger', payload.trigger)
      put('reason', payload.reason)
      break
    case 'settings.changed':
      put('keys', payload.keys)
      put('change', payload.change)
      break
    case 'mode.changed':
      put('mode', payload.mode)
      break
    case 'cache.reset':
      put('reason', payload.reason)
      break
    case 'providers.changed':
      put('action', payload.action)
      break
    case 'heartbeat.changed':
      put('change', payload.change)
      break
    default:
      put('change', payload.change)
  }
  return out
}

/** Where an app event leads in the web app. */
export function appLink(type: AppStreamType, payload: Record<string, unknown>): string | null {
  switch (type) {
    case 'alarm.raised':
      return '/attention'
    case 'program.changed':
      return typeof payload.programId === 'string' ? `/programs/${payload.programId}` : '/programs'
    case 'task.changed':
      return typeof payload.taskId === 'string' ? `/tasks/${payload.taskId}` : '/tasks'
    case 'routine.fired':
    case 'routine.changed':
      return '/routines'
    case 'decision.changed':
      return '/decisions'
    case 'settings.changed':
    case 'providers.changed':
    case 'mode.changed':
      return '/settings'
    case 'connectors.changed':
      return '/connectors'
    default:
      return null
  }
}

/** One line of an event for a tool or a log: time, source, type, place, summary, id. */
export function eventLine(e: StreamEvent, time: (at: number) => string): string {
  return [
    time(e.at),
    e.source === 'channel' ? e.sourceLabel : 'app',
    e.type,
    e.summary,
    `id ${e.id}`,
  ].join(' · ')
}
