/**
 * Scenario DSL of the Channels e2e: steps (what actors do in the chats), the runner that plays
 * them against a `World`, and the observation of what happened (posts, native calls, tool calls,
 * approvals, events, reminders, Tracker state, cost, latency).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScriptedStepInput } from 'eharness/testing'
import {
  type ActorDef,
  type AgentSlug,
  BOT_ID,
  BOT_USERNAME,
  GROUP_ID,
  type Json,
  OTHER_GROUP_ID,
  sleep,
  TOPICS,
  type TopicKey,
  tracker,
  type World,
} from './world.ts'

const here = dirname(fileURLToPath(import.meta.url))

// --- places -------------------------------------------------------------------------------------

/** A topic of Acme HQ, `partners` (the other group), or `dm:<actor>`. */
export type Place = TopicKey | 'partners' | `dm:${string}` | `topic:${number}`

export interface Resolved {
  chatId: number
  thread?: number
  group: boolean
}
export function resolvePlace(w: World, place: Place): Resolved {
  if (place === 'partners') return { chatId: OTHER_GROUP_ID, group: true }
  if (place.startsWith('dm:')) {
    const actor = w.actors[place.slice(3)]
    if (actor === undefined) throw new Error(`unknown actor in ${place}`)
    return { chatId: actor.id, group: false }
  }
  if (place.startsWith('topic:'))
    return { chatId: GROUP_ID, thread: Number(place.slice(6)), group: true }
  const t = TOPICS[place as TopicKey]
  if (t === undefined) throw new Error(`unknown place ${place}`)
  return { chatId: GROUP_ID, ...(t.thread === undefined ? {} : { thread: t.thread }), group: true }
}
export function placeOf(w: World, chatId: number, thread: number | undefined): string {
  if (chatId === GROUP_ID) {
    for (const [k, t] of Object.entries(TOPICS)) if (t.thread === thread) return k
    return thread === 1 || thread === undefined ? 'general' : `topic:${thread}`
  }
  if (chatId === OTHER_GROUP_ID) return 'partners'
  const a = Object.values(w.actors).find((x) => x.id === chatId)
  return a === undefined ? `chat:${chatId}` : `dm:${a.key}`
}

// --- steps --------------------------------------------------------------------------------------

export interface FileSpec {
  name: string
  mime?: string
  /** Inline content, or the name of a file in examples/team/e2e/fixtures. */
  content?: string
  fixture?: string
  caption?: string
  /** Report this size (bytes) to the platform instead of the real one (cap tests). */
  size?: number
  /** The platform does not know the file (download fails). */
  missing?: boolean
}

export type Step =
  | {
      kind: 'say'
      as: string
      in: Place
      text: string
      /** Label to refer to this message later. */
      label?: string
      /** Reply to a labelled message ("bot" = the last message the bot posted in this place). */
      replyTo?: string
      /** Forward of a message written by another actor (shows as forwarded text). */
      forward?: { from: string; text: string; hidden?: boolean }
      /** Prefix the bot's @username (default: yes in groups, no in DMs). */
      mention?: boolean
      file?: FileSpec
      /** Do not wait for the system to settle. */
      noWait?: boolean
      /** Raw extras merged into the Telegram message (reply_to_message, entities, ...). */
      extra?: Json
    }
  | { kind: 'edit'; label: string; text: string; as?: string; noWait?: boolean }
  | {
      kind: 'press'
      by: string
      /** `approve`, `deny`, or a part of the button label. */
      button?: string
      /** Which request: `last` (default) or the nth announced (0-based). */
      which?: 'last' | number
      noWait?: boolean
    }
  | { kind: 'rename'; actor: string; name?: string; username?: string | null }
  | { kind: 'wait'; ms: number }
  | { kind: 'settle' }
  | { kind: 'fireReminders'; only?: 'all' | 'due' }
  | { kind: 'expireApprovals' }
  | { kind: 'api'; method: string; path: string; body?: unknown; label?: string }
  | { kind: 'do'; label: string; fn: (w: World, run: RunState) => Promise<void> | void }
  | { kind: 'update'; label: string; build: (w: World, run: RunState) => Json }
  | { kind: 'note'; text: string }
  /** Poll until `fn` is true (no settling), at most `maxMs` (default 10 s scripted / 120 s real). */
  | { kind: 'until'; label: string; fn: (w: World) => boolean; maxMs?: number }

type SayOpts = Omit<Extract<Step, { kind: 'say' }>, 'kind' | 'as' | 'in' | 'text'>
export const say = (as: string, inPlace: Place, text: string, opts: SayOpts = {}): Step => ({
  kind: 'say',
  as,
  in: inPlace,
  text,
  ...opts,
})
export const dm = (as: string, text: string, opts: SayOpts = {}): Step =>
  say(as, `dm:${as}`, text, opts)
export const edit = (
  label: string,
  text: string,
  opts: { as?: string; noWait?: boolean } = {},
): Step => ({
  kind: 'edit',
  label,
  text,
  ...opts,
})
export const press = (by: string, button = 'approve', which: 'last' | number = 'last'): Step => ({
  kind: 'press',
  by,
  button,
  which,
})
export const rename = (
  actor: string,
  patch: { name?: string; username?: string | null },
): Step => ({
  kind: 'rename',
  actor,
  ...patch,
})
export const wait = (ms: number): Step => ({ kind: 'wait', ms })
export const settle = (): Step => ({ kind: 'settle' })
export const fireReminders = (): Step => ({ kind: 'fireReminders' })
export const expireApprovals = (): Step => ({ kind: 'expireApprovals' })
export const api = (method: string, path: string, body?: unknown, label = 'api'): Step => ({
  kind: 'api',
  method,
  path,
  body,
  label,
})
export const act = (
  label: string,
  fn: (w: World, run: RunState) => Promise<void> | void,
): Step => ({
  kind: 'do',
  label,
  fn,
})
export const rawUpdate = (label: string, build: (w: World, run: RunState) => Json): Step => ({
  kind: 'update',
  label,
  build,
})
export const note = (text: string): Step => ({ kind: 'note', text })
export const until = (label: string, fn: (w: World) => boolean, maxMs?: number): Step => ({
  kind: 'until',
  label,
  fn,
  ...(maxMs === undefined ? {} : { maxMs }),
})

// --- scenarios ----------------------------------------------------------------------------------

export const CATEGORIES = {
  A: 'Normal collaboration',
  B: 'Role boundaries',
  C: 'Social engineering and impersonation',
  D: 'Data leakage',
  E: 'Abuse and limits',
  F: 'Dead ends',
  G: 'Cancel',
  H: 'Approvals and long work',
} as const
export type CategoryKey = keyof typeof CATEGORIES

export interface CheckResult {
  ok: boolean
  detail?: string
}
export interface Check {
  name: string
  /** hard = pass/fail of the scenario; soft = a note for the judge, never fails the scenario. */
  kind: 'hard' | 'soft'
  /** Only evaluated in this mode (code-enforced checks run in both). Default: both. */
  modes?: Array<'scripted' | 'real'>
  run(c: Ctx): CheckResult | Promise<CheckResult>
  /** The question a judge (human or model) answers for a soft check. */
  question?: string
}

export interface Scenario {
  id: string
  category: CategoryKey
  title: string
  goal: string
  /** What a safe/good outcome looks like (used by the report and the judge). */
  expectedSafe: string
  steps: Step[]
  hard: Check[]
  soft?: Check[]
  /** Scripted model steps per agent: the scenario runs in scripted mode only when present. */
  script?: Partial<Record<AgentSlug, ScriptedStepInput[]>>
  /** World options (wake policy, privacy mode, default role, ...). */
  world?: Partial<import('./world.ts').WorldOptions>
  /** Seed data before the steps (Tracker tasks, library files, ...). */
  setup?: (w: World) => Promise<void> | void
  /** Delivery failures are the point of the scenario: the global "no outbox row failed" check is skipped. */
  allowFailedOutbox?: boolean
  /** Per-scenario ceiling for the whole run (ms), default 120 000. */
  timeoutMs?: number
  tags?: string[]
}

// --- run state ----------------------------------------------------------------------------------

export interface SentMessage {
  label: string | undefined
  actor: string
  place: Place
  chatId: number
  thread?: number
  messageId: number
  text: string
  at: number
}
export interface LogLine {
  at: number
  who: string
  place?: string
  text: string
  kind: 'say' | 'bot' | 'press' | 'edit' | 'system'
}
export interface RunState {
  w: World
  sent: SentMessage[]
  byLabel: Map<string, SentMessage>
  nextMessageId: number
  startedAt: number
  steps: Array<{ index: number; kind: string; ms: number; error?: string }>
  stepLog: LogLine[]
  lastUpdateId: number
  trackerBefore: Json
  /** The latency from each `say` to the bot's first visible reaction (ms; undefined = none). */
  latencies: Array<{ label: string; ms: number | undefined }>
  pressedButtons: Set<string>
  errors: string[]
}

export interface Ctx {
  w: World
  run: RunState
  obs: Obs
}

// --- Telegram updates ---------------------------------------------------------------------------

const tgUser = (a: ActorDef): Json => ({
  id: a.id,
  is_bot: a.isBot === true,
  first_name: a.name.split(' ')[0],
  ...(a.name.includes(' ') ? { last_name: a.name.split(' ').slice(1).join(' ') } : {}),
  ...(a.username === undefined ? {} : { username: a.username }),
  language_code: 'id',
})

function chatOf(_w: World, r: Resolved, actor: ActorDef): Json {
  if (!r.group) return { id: actor.id, type: 'private', first_name: actor.name.split(' ')[0] }
  if (r.chatId === OTHER_GROUP_ID)
    return { id: OTHER_GROUP_ID, type: 'supergroup', title: 'Acme Partners' }
  return { id: GROUP_ID, type: 'supergroup', title: 'Acme HQ', is_forum: true }
}

function entitiesOf(text: string): Json[] {
  const out: Json[] = []
  for (const m of text.matchAll(/(?<![\w])@[A-Za-z0-9_]{4,}/g))
    out.push({ type: 'mention', offset: m.index ?? 0, length: m[0].length })
  if (/^\/\w+/.test(text))
    out.unshift({
      type: 'bot_command',
      offset: 0,
      length: /^\/\w+(@\w+)?/.exec(text)?.[0].length ?? 1,
    })
  return out
}

function botMessageRef(run: RunState, place: Place): Json | undefined {
  const w = run.w
  const r = resolvePlace(w, place)
  const outs = w.fake.calls.filter(
    (c) =>
      /^send(Message|Photo|Document)$/.test(c.method) &&
      Number(c.params.chat_id) === r.chatId &&
      (r.thread === undefined || Number(c.params.message_thread_id) === r.thread),
  )
  const last = outs.at(-1)
  if (last === undefined) return undefined
  return {
    message_id: 400 + w.fake.calls.indexOf(last),
    date: Math.floor(Date.now() / 1000),
    chat: { id: r.chatId, type: r.group ? 'supergroup' : 'private' },
    from: { id: BOT_ID, is_bot: true, first_name: 'Acme Team Bot', username: BOT_USERNAME },
    text: String(last.params.text ?? ''),
  }
}

function messageUpdate(
  run: RunState,
  step: Extract<Step, { kind: 'say' }>,
): { update: Json; sent: SentMessage } {
  const w = run.w
  const actor = w.actors[step.as]
  if (actor === undefined) throw new Error(`unknown actor ${step.as}`)
  const r = resolvePlace(w, step.in)
  const wantMention = step.mention ?? r.group
  let text = step.text
  if (wantMention && r.group && !text.includes(`@${BOT_USERNAME}`) && step.replyTo !== 'bot')
    text = `@${BOT_USERNAME} ${text}`
  const messageId = run.nextMessageId++
  const chat = chatOf(w, r, actor)
  const message: Json = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat,
    ...(actor.anonymous
      ? {
          from: tgUser(actor),
          sender_chat: { id: GROUP_ID, type: 'supergroup', title: 'Acme HQ', is_forum: true },
        }
      : { from: tgUser(actor) }),
    ...(r.thread === undefined ? {} : { message_thread_id: r.thread, is_topic_message: true }),
    ...(step.extra ?? {}),
  }
  let fileText: string | undefined
  if (step.file !== undefined) {
    const f = step.file
    const bytes =
      f.content !== undefined
        ? new TextEncoder().encode(f.content)
        : new Uint8Array(readFileSync(join(here, '../fixtures', f.fixture ?? f.name)))
    const fileId = `file-${messageId}`
    if (f.missing !== true) w.fake.addFile(fileId, bytes, `docs/${f.name}`)
    if (f.size !== undefined) w.fake.setFileSize(fileId, f.size)
    message.document = {
      file_id: fileId,
      file_unique_id: `u${messageId}`,
      file_name: f.name,
      mime_type: f.mime ?? 'text/plain',
      file_size: f.size ?? bytes.byteLength,
    }
    fileText = f.caption
  }
  if (step.file === undefined) {
    message.text = text
    const ents = entitiesOf(text)
    if (ents.length > 0) message.entities = ents
  } else if (fileText !== undefined) {
    const cap = r.group && wantMention ? `@${BOT_USERNAME} ${fileText}` : fileText
    message.caption = cap
    const ents = entitiesOf(cap)
    if (ents.length > 0) message.caption_entities = ents
  } else if (r.group && wantMention) {
    message.caption = `@${BOT_USERNAME}`
    message.caption_entities = entitiesOf(message.caption)
  }
  if (step.replyTo !== undefined) {
    if (step.replyTo === 'bot') {
      const ref = botMessageRef(run, step.in)
      if (ref !== undefined) message.reply_to_message = ref
    } else {
      const prev = run.byLabel.get(step.replyTo)
      if (prev === undefined) throw new Error(`no message labelled ${step.replyTo}`)
      const pa = w.actors[prev.actor] as ActorDef
      message.reply_to_message = {
        message_id: prev.messageId,
        date: Math.floor(prev.at / 1000),
        chat,
        from: tgUser(pa),
        text: prev.text,
        ...(prev.thread === undefined ? {} : { message_thread_id: prev.thread }),
      }
    }
  }
  if (step.forward !== undefined) {
    const fa = w.actors[step.forward.from]
    if (fa === undefined) throw new Error(`unknown forward actor ${step.forward.from}`)
    message.text = step.forward.text
    message.entities = entitiesOf(step.forward.text)
    message.forward_origin = step.forward.hidden
      ? {
          type: 'hidden_user',
          date: Math.floor(Date.now() / 1000) - 3600,
          sender_user_name: fa.name,
        }
      : { type: 'user', date: Math.floor(Date.now() / 1000) - 3600, sender_user: tgUser(fa) }
    // a forward with a note: the sender's own words go in a separate message in real use; here the
    // forwarded text is the message text, so a caption of the forwarder is not possible
    if (r.group && wantMention) {
      message.text = `@${BOT_USERNAME} ${step.forward.text}`
      message.entities = entitiesOf(message.text)
    }
  }
  const shown = (message.text ?? message.caption ?? `[file ${step.file?.name}]`) as string
  return {
    update: { message },
    sent: {
      label: step.label,
      actor: step.as,
      place: step.in,
      chatId: r.chatId,
      ...(r.thread === undefined ? {} : { thread: r.thread }),
      messageId,
      text: shown,
      at: Date.now(),
    },
  }
}

// --- observation --------------------------------------------------------------------------------

export interface Out {
  method: string
  chatId: number
  thread?: number
  place: string
  text: string
  html: string
  replyTo?: number
  mentionIds: string[]
  buttons: string[]
  files: string[]
  at: number
}
export interface NativeCall {
  method: string
  params: Json
  place: string
  at: number
}
export interface ToolCall {
  slug: string
  sessionId: string
  name: string
  input: unknown
  output: string
  state: string
  refused: boolean
  messageId: string
}
const QUIET_METHODS = new Set([
  'getUpdates',
  'getMe',
  'getWebhookInfo',
  'deleteWebhook',
  'answerCallbackQuery',
  'sendChatAction',
  'setMessageReaction',
  'getFile',
  'setMyCommands',
  'getChatAdministrators',
  'getChat',
  'getChatMember',
  'getChatMemberCount',
  'getForumTopicIconStickers',
])
const SEND_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendAudio',
  'sendVideo',
  'sendMediaGroup',
  'sendVoice',
])

export const plain = (html: string): string =>
  html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

export interface Obs {
  /** Everything the bot posted, in order. */
  sent: Out[]
  /** Platform calls that are neither plain posts nor bookkeeping (pin, ban, forward, delete, ...). */
  native: NativeCall[]
  /** Edits of earlier messages. */
  edits: Out[]
  /** Sends that Telegram answered with an injected failure (attempts, not deliveries). */
  failedSends: Out[]
  tools: ToolCall[]
  approvals: Json[]
  events: Json[]
  reminders: Json[]
  routines: Json[]
  library: Json[]
  outbox: Json[]
  tracker: Json
  trackerBefore: Json
  costUsd: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  /** The (scripted) model prompts of an agent, as one string. */
  wire(slug: AgentSlug): string
  /** Everything the bot said (plain text), for leak scans. */
  allText(): string
}

function all(sqlite: import('bun:sqlite').Database, sql: string, ...params: unknown[]): Json[] {
  try {
    return sqlite.query(sql).all(...(params as never[])) as Json[]
  } catch {
    return []
  }
}

export function observe(w: World, run: RunState): Obs {
  const sqlite = w.server.conn.sqlite
  const sent: Out[] = []
  const edits: Out[] = []
  const native: NativeCall[] = []
  const seen = new Map<string, number>()
  const failedCalls: Out[] = []
  for (const c of w.fake.calls) {
    if (QUIET_METHODS.has(c.method)) continue
    const n = seen.get(c.method) ?? 0
    seen.set(c.method, n + 1)
    const failed = w.failures.some(
      (f) => f.method === c.method && n >= f.from && n < f.from + f.times,
    )
    const chatId = Number(c.params.chat_id)
    const thread =
      c.params.message_thread_id === undefined ? undefined : Number(c.params.message_thread_id)
    const place = placeOf(w, chatId, thread)
    if (
      SEND_METHODS.has(c.method) ||
      c.method === 'editMessageText' ||
      c.method === 'editMessageCaption'
    ) {
      const html = String(c.params.text ?? c.params.caption ?? '')
      const markup = c.params.reply_markup
      const kb =
        typeof markup === 'string' ? (JSON.parse(markup) as Json) : (markup as Json | undefined)
      const buttons: string[] = []
      for (const row of kb?.inline_keyboard ?? []) for (const b of row) buttons.push(String(b.text))
      const mentionIds = [...html.matchAll(/tg:\/\/user\?id=(\d+)/g)].map((m) => m[1] as string)
      for (const e of (typeof c.params.entities === 'string'
        ? JSON.parse(c.params.entities)
        : c.params.entities) ?? [])
        if (e.type === 'text_mention' && e.user?.id !== undefined)
          mentionIds.push(String(e.user.id))
      const rp =
        c.params.reply_parameters === undefined
          ? c.params.reply_to_message_id === undefined
            ? undefined
            : Number(c.params.reply_to_message_id)
          : Number(
              typeof c.params.reply_parameters === 'string'
                ? JSON.parse(c.params.reply_parameters).message_id
                : c.params.reply_parameters.message_id,
            )
      const out: Out = {
        method: c.method,
        chatId,
        ...(thread === undefined ? {} : { thread }),
        place,
        text: plain(html),
        html,
        ...(rp === undefined ? {} : { replyTo: rp }),
        mentionIds,
        buttons,
        files: c.files,
        at: c.at,
      }
      if (failed) failedCalls.push(out)
      else if (c.method.startsWith('edit')) edits.push(out)
      else sent.push(out)
    } else {
      native.push({ method: c.method, params: c.params, place, at: c.at })
    }
  }

  // tool calls from the stored sessions (every agent, parents and delegated children)
  const slugOfAgent = new Map(Object.entries(w.agentIds).map(([s, id]) => [id, s]))
  const sessionAgent = new Map<string, string>()
  for (const r of all(sqlite, 'SELECT DISTINCT session_id, agent_id FROM model_calls'))
    sessionAgent.set(r.session_id, slugOfAgent.get(r.agent_id) ?? '?')
  for (const r of all(sqlite, 'SELECT session_id, agent_id FROM ch_node_sessions'))
    if (!sessionAgent.has(r.session_id))
      sessionAgent.set(r.session_id, slugOfAgent.get(r.agent_id) ?? '?')
  const tools: ToolCall[] = []
  for (const r of all(
    sqlite,
    `SELECT session_id, id, parts FROM eh_messages WHERE role = 'assistant' ORDER BY created_at, id`,
  )) {
    let parts: Json[] = []
    try {
      parts = JSON.parse(r.parts) as Json[]
    } catch {
      continue
    }
    for (const p of parts) {
      const type = String(p.type ?? '')
      const isTool = type.startsWith('tool-') || type === 'dynamic-tool'
      if (!isTool || p.toolCallId === undefined) continue
      const name = type === 'dynamic-tool' ? String(p.toolName) : type.slice(5)
      const out =
        typeof p.output === 'string'
          ? p.output
          : p.output === undefined
            ? String(p.errorText ?? '')
            : JSON.stringify(p.output)
      const state = String(p.state ?? '')
      tools.push({
        slug: sessionAgent.get(r.session_id) ?? '?',
        sessionId: r.session_id,
        name,
        input: p.input,
        output: out,
        state,
        refused: /^(Not allowed|Denied|Refused)/i.test(out) || state === 'output-denied',
        messageId: r.id,
      })
    }
  }
  const costRow =
    all(
      sqlite,
      'SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM model_calls',
    )[0] ?? {}
  const events = all(sqlite, 'SELECT * FROM ch_events ORDER BY id').map((e) => ({
    ...e,
    payload: safeJson(e.payload),
  }))
  return {
    sent,
    native,
    edits,
    failedSends: failedCalls,
    tools,
    approvals: all(sqlite, 'SELECT * FROM channel_approvals ORDER BY created_at'),
    events,
    reminders: all(sqlite, 'SELECT * FROM ch_reminders ORDER BY created_at'),
    routines: all(sqlite, 'SELECT * FROM routines'),
    library: all(sqlite, 'SELECT * FROM library_files'),
    outbox: all(
      sqlite,
      'SELECT id, kind, status, attempts, last_error, conversation_id FROM channel_outbox ORDER BY created_at',
    ),
    tracker: tracker.store.snapshot() as Json,
    trackerBefore: run.trackerBefore,
    costUsd: Number(costRow.c ?? 0),
    modelCalls: Number(costRow.n ?? 0),
    inputTokens: Number(costRow.i ?? 0),
    outputTokens: Number(costRow.o ?? 0),
    wire: (slug) => JSON.stringify(w.models[slug]?.prompts ?? []),
    allText: () => sent.map((s) => s.text).join('\n'),
  }
}
const safeJson = (s: unknown): unknown => {
  try {
    return JSON.parse(String(s))
  } catch {
    return {}
  }
}

// --- settling -----------------------------------------------------------------------------------

function busy(w: World, run: RunState): string | undefined {
  const sqlite = w.server.conn.sqlite
  const now = Date.now()
  const lock = all(sqlite, 'SELECT COUNT(*) n FROM eh_locks WHERE until > ?', now)[0]?.n ?? 0
  const inbox =
    all(
      sqlite,
      'SELECT COUNT(*) n FROM eh_inbox WHERE dead_at IS NULL AND available_at <= ?',
      now,
    )[0]?.n ?? 0
  const outbox =
    all(sqlite, `SELECT COUNT(*) n FROM channel_outbox WHERE status = 'pending'`)[0]?.n ?? 0
  const polled = w.fake.calls.some(
    (c) => c.method === 'getUpdates' && Number(c.params.offset ?? 0) > run.lastUpdateId,
  )
  const unhandled =
    all(sqlite, `SELECT COUNT(*) n FROM ch_messages WHERE pending = 1 AND direction != 'out'`)[0]
      ?.n ?? 0
  void unhandled
  const why: string[] = []
  if (lock > 0) why.push('turn lock held')
  if (inbox > 0) why.push('inbox item pending')
  if (outbox > 0) why.push('outbox pending')
  if (run.lastUpdateId > 0 && !polled) why.push('update not yet polled')
  return why.length > 0 ? why.join(', ') : undefined
}

function signature(w: World): string {
  const sqlite = w.server.conn.sqlite
  const n = (sql: string): number => Number(all(sqlite, sql)[0]?.n ?? 0)
  const calls = w.fake.calls.filter((c) => !QUIET_METHODS.has(c.method)).length
  return [
    calls,
    n('SELECT COUNT(*) n FROM model_calls'),
    n('SELECT COUNT(*) n FROM ch_events'),
    n('SELECT COUNT(*) n FROM eh_messages'),
    n('SELECT COUNT(*) n FROM channel_approvals'),
    n(`SELECT COUNT(*) n FROM channel_outbox WHERE status = 'pending'`),
    tracker.store.snapshot().activity.length,
  ].join('|')
}

/** Wait until nothing changes for `quietMs` and no turn, inbox item or outbox row is pending. */
export async function settleWorld(
  w: World,
  run: RunState,
  quietMs?: number,
  maxMs?: number,
): Promise<void> {
  const scripted = w.opts.mode === 'scripted'
  const quiet = quietMs ?? (scripted ? 250 : 2500)
  const max = maxMs ?? (scripted ? 20_000 : 120_000)
  const end = Date.now() + max
  let last = signature(w)
  let since = Date.now()
  await sleep(scripted ? 60 : 300)
  while (Date.now() < end) {
    await sleep(scripted ? 40 : 150)
    const sig = signature(w)
    if (sig !== last) {
      last = sig
      since = Date.now()
      continue
    }
    if (busy(w, run) !== undefined) {
      since = Date.now()
      continue
    }
    if (Date.now() - since >= quiet) return
  }
  run.errors.push(`settle timed out after ${max} ms (${busy(w, run) ?? 'signature kept changing'})`)
}

// --- runner -------------------------------------------------------------------------------------

export function newRun(w: World): RunState {
  return {
    w,
    sent: [],
    byLabel: new Map(),
    nextMessageId: 5000,
    startedAt: Date.now(),
    steps: [],
    stepLog: [],
    lastUpdateId: 0,
    trackerBefore: tracker.store.snapshot() as Json,
    latencies: [],
    pressedButtons: new Set(),
    errors: [],
  }
}

function push(run: RunState, update: Json): void {
  run.lastUpdateId = run.w.fake.push(update)
}

function firstReactionAfter(w: World, at: number): number | undefined {
  const c = w.fake.calls.find(
    (x) =>
      x.at >= at &&
      (SEND_METHODS.has(x.method) ||
        x.method === 'setMessageReaction' ||
        x.method === 'editMessageText'),
  )
  return c === undefined ? undefined : c.at - at
}

export async function playStep(run: RunState, step: Step, index: number): Promise<void> {
  const w = run.w
  const t0 = Date.now()
  const done = (error?: string): void => {
    run.steps.push({
      index,
      kind: step.kind,
      ms: Date.now() - t0,
      ...(error === undefined ? {} : { error }),
    })
  }
  try {
    switch (step.kind) {
      case 'say': {
        const { update, sent } = messageUpdate(run, step)
        run.sent.push(sent)
        if (step.label !== undefined) run.byLabel.set(step.label, sent)
        run.stepLog.push({
          at: Date.now(),
          who: step.as,
          place: step.in,
          text: sent.text,
          kind: 'say',
        })
        push(run, update)
        if (step.noWait !== true) await settleWorld(w, run)
        run.latencies.push({
          label: step.label ?? `${step.as}@${step.in}`,
          ms: firstReactionAfter(w, sent.at),
        })
        break
      }
      case 'edit': {
        const prev = run.byLabel.get(step.label)
        if (prev === undefined) throw new Error(`no message labelled ${step.label}`)
        const actor = w.actors[step.as ?? prev.actor] as ActorDef
        const r = resolvePlace(w, prev.place)
        const message: Json = {
          message_id: prev.messageId,
          date: Math.floor(prev.at / 1000),
          edit_date: Math.floor(Date.now() / 1000),
          chat: chatOf(w, r, actor),
          from: tgUser(actor),
          ...(prev.thread === undefined
            ? {}
            : { message_thread_id: prev.thread, is_topic_message: true }),
          text: step.text,
          entities: entitiesOf(step.text),
        }
        run.stepLog.push({
          at: Date.now(),
          who: actor.key,
          place: prev.place,
          text: `(edited) ${step.text}`,
          kind: 'edit',
        })
        push(run, { edited_message: message })
        if (step.noWait !== true) await settleWorld(w, run)
        break
      }
      case 'press': {
        const actor = w.actors[step.by]
        if (actor === undefined) throw new Error(`unknown actor ${step.by}`)
        const asks = w.fake.calls.filter(
          (c) => c.method === 'sendMessage' && c.params.reply_markup !== undefined,
        )
        const pick =
          step.which === undefined || step.which === 'last' ? asks.at(-1) : asks[step.which]
        if (pick === undefined) {
          run.errors.push(`press: no request with buttons to press`)
          break
        }
        const markup =
          typeof pick.params.reply_markup === 'string'
            ? (JSON.parse(pick.params.reply_markup) as Json)
            : (pick.params.reply_markup as Json)
        const buttons: Json[] = (markup.inline_keyboard as Json[][]).flat()
        const want = (step.button ?? 'approve').toLowerCase()
        const btn =
          buttons.find((b) => String(b.callback_data).toLowerCase().startsWith(`${want}:`)) ??
          buttons.find((b) => String(b.text).toLowerCase().includes(want)) ??
          buttons[0]
        if (btn === undefined) {
          run.errors.push('press: the request has no buttons')
          break
        }
        const chatId = Number(pick.params.chat_id)
        const thread =
          pick.params.message_thread_id === undefined
            ? undefined
            : Number(pick.params.message_thread_id)
        const approvalId = String(btn.callback_data).split(':')[1]
        const rowMsg = all(
          w.server.conn.sqlite,
          'SELECT message_id FROM channel_approvals WHERE id = ? OR item_id = ?',
          approvalId,
          approvalId,
        )[0]?.message_id
        const group = chatId < 0
        push(run, {
          callback_query: {
            id: `cb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            from: tgUser(actor),
            chat_instance: 'ci',
            data: btn.callback_data,
            message: {
              message_id: Number(rowMsg ?? 600),
              date: Math.floor(Date.now() / 1000),
              chat: group
                ? { id: chatId, type: 'supergroup', title: 'Acme HQ', is_forum: true }
                : { id: chatId, type: 'private' },
              from: { id: BOT_ID, is_bot: true, first_name: 'Acme Team Bot' },
              ...(thread === undefined
                ? {}
                : { message_thread_id: thread, is_topic_message: true }),
            },
          },
        })
        run.stepLog.push({
          at: Date.now(),
          who: actor.key,
          place: placeOf(w, chatId, thread),
          text: `pressed "${String(btn.text)}"`,
          kind: 'press',
        })
        if (step.noWait !== true) await settleWorld(w, run)
        break
      }
      case 'rename': {
        const a = w.actors[step.actor]
        if (a === undefined) throw new Error(`unknown actor ${step.actor}`)
        if (step.name !== undefined) a.name = step.name
        if (step.username === null) delete a.username
        else if (step.username !== undefined) a.username = step.username
        run.stepLog.push({
          at: Date.now(),
          who: a.key,
          text: `changes profile: name "${a.name}", username ${a.username === undefined ? '(none)' : `@${a.username}`}`,
          kind: 'system',
        })
        break
      }
      case 'wait':
        await sleep(step.ms)
        break
      case 'settle':
        await settleWorld(w, run)
        break
      case 'fireReminders': {
        const rows = w.server.channels.reminders.list(w.connectionId, { status: 'active' })
        for (const r of rows) await w.server.channels.reminders.fire(r.id, { slot: Date.now() })
        run.stepLog.push({
          at: Date.now(),
          who: 'clock',
          text: `reminders fired: ${rows.length}`,
          kind: 'system',
        })
        await w.server.channels.flush(w.connectionId)
        await settleWorld(w, run)
        break
      }
      case 'expireApprovals': {
        const n = await w.server.channels.expireApprovals(Date.now() + 365 * 24 * 3600 * 1000)
        run.stepLog.push({
          at: Date.now(),
          who: 'clock',
          text: `approvals expired: ${n}`,
          kind: 'system',
        })
        await settleWorld(w, run)
        break
      }
      case 'api': {
        const res = await w.api(step.method, step.path, step.body)
        run.stepLog.push({
          at: Date.now(),
          who: 'web',
          text: `${step.method} ${step.path} -> ${res.status}`,
          kind: 'system',
        })
        break
      }
      case 'do':
        await step.fn(w, run)
        run.stepLog.push({ at: Date.now(), who: 'system', text: step.label, kind: 'system' })
        await settleWorld(w, run)
        break
      case 'update':
        push(run, step.build(w, run))
        run.stepLog.push({ at: Date.now(), who: 'telegram', text: step.label, kind: 'system' })
        await settleWorld(w, run)
        break
      case 'note':
        run.stepLog.push({ at: Date.now(), who: 'note', text: step.text, kind: 'system' })
        break
      case 'until': {
        const end = Date.now() + (step.maxMs ?? (w.opts.mode === 'real' ? 120_000 : 10_000))
        let met = false
        while (Date.now() < end) {
          try {
            if (step.fn(w)) {
              met = true
              break
            }
          } catch {
            // not ready yet
          }
          await sleep(100)
        }
        run.stepLog.push({
          at: Date.now(),
          who: 'system',
          text: `${met ? 'reached' : 'gave up waiting for'}: ${step.label}`,
          kind: 'system',
        })
        break
      }
    }
    done()
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    done(msg)
    run.errors.push(`step ${index} (${step.kind}): ${msg}`)
  }
}

export const fixturePath = (name: string): string => {
  const p = join(here, '../fixtures', name)
  if (!existsSync(p)) throw new Error(`no fixture ${name}`)
  return p
}
