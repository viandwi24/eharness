/**
 * Standing orders (docs/plans/P51-proactive-and-health.md). Pure.
 *
 * A standing order is an ongoing instruction a person gave the agent in a chat ("watch the
 * community channel all the time and report anything strange to me"). It lives as one readable list
 * item in the agent's own memory file `HEARTBEAT.md`, with a small machine-readable tail the server
 * parses to build the gate of the heartbeat:
 *
 *   - Watch the community channel, report anything strange. <!-- order:<id> by:<identity> name:Ana
 *       role:admin uid:<platform id> report:chat:<connection>/<node> mention:yes at:<ms> -->
 *
 * The owner reads and edits the file as text. A line without a valid tail is an ordinary checklist
 * item (the beat looks at it, but it has nowhere to report except the digest and the bell). The
 * fields of a tail are percent-encoded (`encodeURIComponent`), so a name can never close the comment.
 */

/** Where an order reports: a conversation of the agent's chat connections, or a web chat thread. */
export type OrderDestination =
  | { kind: 'chat'; connectionId: string; nodeId: string }
  | { kind: 'web'; sessionId: string }

/**
 * What kind of job an order is. Old lines carry no kind and are `watch`.
 *  - `watch`    ongoing: keep an eye on something and report what is worth it
 *  - `rule`     react when X happens ("if someone posts ... report it")
 *  - `deadline` one-shot at `due` (an exact wake), then `done` with its outcome
 *  - `ledger`   keeps a tracker file (`ledger`) of things it was told about, and warns on its rules
 */
export const ORDER_KINDS = ['watch', 'rule', 'deadline', 'ledger'] as const
export type OrderKind = (typeof ORDER_KINDS)[number]

export const isOrderKind = (v: unknown): v is OrderKind =>
  (ORDER_KINDS as readonly unknown[]).includes(v)

export interface StandingOrder {
  id: string
  /** The person's words, lightly cleaned. One line. */
  text: string
  /** Who asked: their identity id (a chat) or `web:owner` (the web app). */
  by: string
  name: string
  role: string
  /** The platform user id of the asker: what a mention takes. Absent for the web owner. */
  uid?: string
  report: OrderDestination
  /** Mention the asker when reporting. */
  mention: boolean
  at: number
  active: boolean
  /** Why an order is paused (the server paused it, or a person answered "pause it"); absent: by hand. */
  pausedReason?: string
  kind: OrderKind
  /** `deadline`: the instant (epoch ms) the exact wake fires. */
  due?: number
  /** After this instant the order is inactive (listed as expired). */
  expires?: number
  /** A finished deadline order: when, and what came out of it. */
  done?: { at: number; outcome: string }
  /** Context references: session ids, platform message ids ("General #12345"), URLs, library paths. */
  refs: string[]
  /** Tool groups the order needs: `web`, `browser`, `phone/<slug>`, `files:<library glob>`. */
  needs: string[]
  /** The library path of the order's tracker (always set for a `ledger` order). */
  ledger?: string
}

export const WEB_OWNER = 'web:owner'
export const STANDING_ORDER_TOOL = 'standing_order'
export const HEARTBEAT_REPORT_TOOL = 'heartbeat_report'

/** Posts a beat may make to one destination per local day (a constant: nobody tunes this). */
export const PER_DESTINATION_DAILY_CAP = 8
/** An early beat on chat activity starts at the earliest this long after the previous beat. */
export const ACTIVITY_MIN_GAP_MS = 10 * 60_000
export const MAX_ORDER_CHARS = 800

/** The key of a destination: the daily cap and the repeat check count per key. */
export const destKey = (d: OrderDestination): string =>
  d.kind === 'chat' ? `chat:${d.connectionId}/${d.nodeId}` : `web:${d.sessionId}`

export const sameDestination = (a: OrderDestination, b: OrderDestination): boolean =>
  destKey(a) === destKey(b)

// --- reading the file --------------------------------------------------------------------------

/**
 * The checklist's own content lines: headings, comments, rules and bare list markers do not count.
 * (An order line counts: its text is outside the comment.)
 */
export function contentLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return []
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !/^[-*_=\s]{3,}$/.test(l))
    .filter((l) => !/^([-*+]|\d+[.)])(\s*\[[ xX]?\])?$/.test(l))
}

const ORDER_LINE = /^(\s*[-*+]\s+)(.*?)\s*<!--\s*order:([^\s>]+)((?:\s+[a-z]+:[^\s>]*)*)\s*-->\s*$/
const dec = (v: string): string => {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function destinationOf(raw: string | undefined): OrderDestination | undefined {
  if (raw === undefined) return undefined
  if (raw.startsWith('web:')) {
    const sessionId = dec(raw.slice(4))
    return sessionId === '' ? undefined : { kind: 'web', sessionId }
  }
  if (raw.startsWith('chat:')) {
    const [connection, node, ...rest] = raw.slice(5).split('/')
    if (connection === undefined || node === undefined || rest.length > 0) return undefined
    const connectionId = dec(connection)
    const nodeId = dec(node)
    return connectionId === '' || nodeId === '' ? undefined : { kind: 'chat', connectionId, nodeId }
  }
  return undefined
}

const decList = (v: string | undefined): string[] =>
  v === undefined || v === ''
    ? []
    : v
        .split(',')
        .map((x) => dec(x).trim())
        .filter((x) => x !== '')

const instant = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** One line as an order, or undefined when it has no valid tail (then it is a plain checklist item). */
export function parseOrderLine(line: string): StandingOrder | undefined {
  const m = ORDER_LINE.exec(line)
  if (m === null) return undefined
  const fields = new Map<string, string>()
  for (const part of (m[4] ?? '').trim().split(/\s+/)) {
    const i = part.indexOf(':')
    if (i > 0) fields.set(part.slice(0, i), part.slice(i + 1))
  }
  const report = destinationOf(fields.get('report'))
  const text = (m[2] ?? '').trim()
  if (report === undefined || text === '') return undefined
  const at = Number(fields.get('at'))
  const uid = fields.get('uid')
  const kind = fields.get('kind')
  const due = instant(fields.get('due'))
  const expires = instant(fields.get('expires'))
  const doneAt = instant(fields.get('done'))
  const ledger = fields.get('ledger')
  const why = fields.get('why')
  return {
    id: m[3] as string,
    text,
    by: dec(fields.get('by') ?? WEB_OWNER),
    name: dec(fields.get('name') ?? ''),
    role: fields.get('role') ?? 'member',
    ...(uid === undefined || uid === '' ? {} : { uid: dec(uid) }),
    report,
    mention: fields.get('mention') === 'yes',
    at: Number.isFinite(at) ? at : 0,
    active: fields.get('active') !== 'no',
    ...(why === undefined || why === '' ? {} : { pausedReason: dec(why) }),
    // a line from before kinds existed is an ongoing watch
    kind: isOrderKind(kind) ? kind : 'watch',
    ...(due === undefined ? {} : { due }),
    ...(expires === undefined ? {} : { expires }),
    ...(doneAt === undefined
      ? {}
      : { done: { at: doneAt, outcome: dec(fields.get('outcome') ?? '') } }),
    refs: decList(fields.get('refs')),
    needs: decList(fields.get('needs')),
    ...(ledger === undefined || ledger === '' ? {} : { ledger: dec(ledger) }),
  }
}

/** `active` (the beat acts on it), `paused`, `done` (a finished deadline) or `expired` (past `expires`). */
export type OrderState = 'active' | 'paused' | 'done' | 'expired'

export function orderState(o: StandingOrder, now?: number): OrderState {
  if (o.done !== undefined) return 'done'
  if (now !== undefined && o.expires !== undefined && o.expires <= now) return 'expired'
  return o.active ? 'active' : 'paused'
}

/** The beat acts on it: not paused, not done, not past its expiry (`now` unset: expiry is not looked at). */
export const isLive = (o: StandingOrder, now?: number): boolean => orderState(o, now) === 'active'

export interface ParsedChecklist {
  /** Every order of the file (also the paused ones). */
  orders: StandingOrder[]
  /** The orders the heartbeat acts on. */
  active: StandingOrder[]
  /** Checklist lines that are not orders: the owner's own items. */
  plain: string[]
}

export function parseChecklist(text: string | null | undefined, now?: number): ParsedChecklist {
  const orders: StandingOrder[] = []
  const rest: string[] = []
  for (const line of (text ?? '').split('\n')) {
    const order = parseOrderLine(line)
    if (order === undefined) rest.push(line)
    else orders.push(order)
  }
  return {
    orders,
    active: orders.filter((o) => isLive(o, now)),
    plain: contentLines(rest.join('\n')),
  }
}

/** Nothing to do: no plain item and no active order. The beat is then skipped without a model call. */
export const checklistIsBlank = (text: string | null | undefined, now?: number): boolean => {
  const p = parseChecklist(text, now)
  return p.plain.length === 0 && p.active.length === 0
}

// --- writing the file --------------------------------------------------------------------------

/** What the file holds before the first order. */
export const CHECKLIST_TEMPLATE = [
  '# Heartbeat checklist',
  '',
  '<!-- Standing orders: ongoing instructions people gave the agent in chat are listed here, one per',
  '     line, with a machine-readable tail after the text. Read, edit or delete them like any text. A',
  '     line without a tail is an ordinary item the heartbeat looks at (it reports to the digest and',
  '     the bell only). With only headings or comments in this file the heartbeat does not run (no',
  '     model call). The server already checks stuck, failed and waiting work, open decisions,',
  '     failing programs and routines, connectors that need sign-in and the budget. -->',
  '',
].join('\n')

export const cleanOrderText = (text: string): string =>
  text
    .replace(/<!--|-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ORDER_CHARS)
    .trim()

const destText = (d: OrderDestination): string =>
  d.kind === 'chat'
    ? `chat:${encodeURIComponent(d.connectionId)}/${encodeURIComponent(d.nodeId)}`
    : `web:${encodeURIComponent(d.sessionId)}`

export function formatOrderLine(o: StandingOrder): string {
  const tail = [
    `order:${o.id}`,
    `by:${encodeURIComponent(o.by)}`,
    `name:${encodeURIComponent(o.name)}`,
    `role:${o.role}`,
    ...(o.uid === undefined ? [] : [`uid:${encodeURIComponent(o.uid)}`]),
    `report:${destText(o.report)}`,
    `mention:${o.mention ? 'yes' : 'no'}`,
    `at:${o.at}`,
    ...(o.active ? [] : ['active:no']),
    ...(o.pausedReason === undefined || o.active
      ? []
      : [`why:${encodeURIComponent(o.pausedReason.slice(0, 200))}`]),
    // kinds are written only when they say something: a plain watch keeps the old, short tail
    ...(o.kind === 'watch' ? [] : [`kind:${o.kind}`]),
    ...(o.due === undefined ? [] : [`due:${o.due}`]),
    ...(o.expires === undefined ? [] : [`expires:${o.expires}`]),
    ...(o.done === undefined
      ? []
      : [`done:${o.done.at}`, `outcome:${encodeURIComponent(o.done.outcome)}`]),
    ...(o.refs.length === 0 ? [] : [`refs:${o.refs.map(encodeURIComponent).join(',')}`]),
    ...(o.needs.length === 0 ? [] : [`needs:${o.needs.map(encodeURIComponent).join(',')}`]),
    ...(o.ledger === undefined ? [] : [`ledger:${encodeURIComponent(o.ledger)}`]),
  ]
  return `- ${cleanOrderText(o.text)} <!-- ${tail.join(' ')} -->`
}

/** The file with the order appended (a missing file starts from the template). */
export function withOrder(text: string | null | undefined, order: StandingOrder): string {
  const base = text === null || text === undefined || text.trim() === '' ? CHECKLIST_TEMPLATE : text
  return `${base.replace(/\s*$/, '\n')}${formatOrderLine(order)}\n`
}

/** The file without the order's line; the other lines stay exactly as they are. */
export function withoutOrder(text: string, id: string): string {
  return text
    .split('\n')
    .filter((line) => parseOrderLine(line)?.id !== id)
    .join('\n')
}

/** A new order of the same words for the same place and asker already exists (do not stack copies). */
export function sameOrder(
  a: Pick<StandingOrder, 'text' | 'by' | 'report' | 'due'>,
  b: Pick<StandingOrder, 'text' | 'by' | 'report' | 'due'>,
): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()
  return (
    norm(a.text) === norm(b.text) &&
    a.by === b.by &&
    a.due === b.due &&
    sameDestination(a.report, b.report)
  )
}

/** The file with one order's line replaced by `change(order)` (the other lines stay as they are). */
export function withOrderChanged(
  text: string,
  id: string,
  change: (o: StandingOrder) => StandingOrder,
): string {
  return text
    .split('\n')
    .map((line) => {
      const o = parseOrderLine(line)
      return o?.id === id ? formatOrderLine(change(o)) : line
    })
    .join('\n')
}

// --- needs, ledgers, references ----------------------------------------------------------------

export type Need =
  | { kind: 'web' }
  | { kind: 'browser' }
  | { kind: 'phone'; slug: string }
  | { kind: 'files'; glob: string }

/** `web`, `browser`, `phone/<connection slug>` or `files:<library glob>`; undefined when it is none of them. */
export function parseNeed(raw: string): Need | undefined {
  const t = raw.trim()
  if (t === 'web') return { kind: 'web' }
  if (t === 'browser') return { kind: 'browser' }
  const phone = /^phone\/([a-z0-9][a-z0-9-]{0,40})$/.exec(t)
  if (phone !== null) return { kind: 'phone', slug: phone[1] as string }
  if (t.startsWith('files:')) {
    const glob = t.slice('files:'.length).trim()
    return isLibraryPath(glob) ? { kind: 'files', glob } : undefined
  }
  return undefined
}

/** A path inside the library, with no way out of it (`..`) and no spaces. */
export const isLibraryPath = (p: string): boolean =>
  p.startsWith('/library/') && p.length <= 200 && !p.includes('..') && !/\s/.test(p)

export const NEEDS_HELP =
  'needs: any of "web" (web_search/web_fetch), "browser" (the browser tools), "phone/<connection slug>" (that phone connection), "files:<library path glob>" (files to read).'

/** The needs of a list, normalised and de-duplicated; `invalid` lists the ones that are no need. */
export function normalizeNeeds(raw: readonly string[]): { needs: string[]; invalid: string[] } {
  const needs: string[] = []
  const invalid: string[] = []
  for (const r of raw) {
    const n = parseNeed(r)
    if (n === undefined) {
      invalid.push(r)
      continue
    }
    const text =
      n.kind === 'phone' ? `phone/${n.slug}` : n.kind === 'files' ? `files:${n.glob}` : n.kind
    if (!needs.includes(text)) needs.push(text)
  }
  return { needs, invalid }
}

export const MAX_REFS = 8
export const MAX_REF_CHARS = 200

export function cleanRefs(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const r of raw) {
    const t = r
      .replace(/<!--|-->/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_REF_CHARS)
    if (t !== '' && !out.includes(t)) out.push(t)
  }
  return out.slice(0, MAX_REFS)
}

const slugWords = (text: string, max: number): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')

/** `/library/trackers/<slug>.md`, the slug from the order's words (`taken`: paths other orders already use). */
export function defaultLedgerPath(text: string, id: string, taken: readonly string[] = []): string {
  const base = `/library/trackers/${slugWords(text, 40) || slugWords(id, 12) || 'order'}`
  if (!taken.includes(`${base}.md`)) return `${base}.md`
  return `${base}-${slugWords(id, 8) || 'x'}.md`
}

/** A ledger path a person or the model may name: a plain file in the library (no glob, no `..`). */
export const isLedgerPath = (p: string): boolean =>
  isLibraryPath(p) && !p.endsWith('/') && !/[*?[\]{}]/.test(p) && !p.startsWith('/library/notes/')

/** Owners and admins may give an order its tools and its ledger; a member's order only looks. */
export const isStaffRole = (role: string | undefined): boolean =>
  role === 'owner' || role === 'admin'

/**
 * What a beat may use because of the live orders: the needs and the ledger paths of the orders whose
 * giver is an owner or an admin now (`currentRole` says what the giver is today; undefined = unknown
 * or gone, which grants nothing). Pure.
 */
export function grantsOf(
  orders: readonly StandingOrder[],
  currentRole: (o: StandingOrder) => string | undefined,
  now: number,
): { needs: string[]; writes: string[] } {
  const needs = new Set<string>()
  const writes = new Set<string>()
  for (const o of orders) {
    if (!isLive(o, now)) continue
    if (!isStaffRole(o.role) || !isStaffRole(currentRole(o))) continue
    for (const n of o.needs) needs.add(n)
    if (o.ledger !== undefined && isLedgerPath(o.ledger)) writes.add(o.ledger)
  }
  return { needs: [...needs], writes: [...writes] }
}

/** A tool the agent has, as the gate sees it. */
export interface ToolFact {
  name: string
  connectorId: string
  /** Slugs of the connections that expose it. */
  connectionSlugs: string[]
  /** `read`, `write`, ... (the capability kind); undefined when unknown. */
  kind: string | undefined
}

/**
 * The tools a set of needs opens, among the tools the agent actually has: `web` the web connector,
 * `browser` the browser connector, `phone/<slug>` the tools of that connection. Reads always (unless
 * the connector has them off); a tool that acts needs its mode to be "allowed", never "ask first"
 * (nobody can answer in a beat). `files:` opens no tool: the beat reads the library anyway.
 */
export function needTools(
  needs: readonly string[],
  tools: readonly ToolFact[],
  rules: { deny: readonly string[]; ask: readonly string[] },
): string[] {
  const out = new Set<string>()
  const wanted = needs.flatMap((n) => {
    const p = parseNeed(n)
    return p === undefined ? [] : [p]
  })
  for (const t of tools) {
    if (rules.deny.includes(t.name)) continue
    const acts = t.kind !== 'read'
    if (acts && rules.ask.includes(t.name)) continue
    const hit = wanted.some(
      (n) =>
        (n.kind === 'web' && t.connectorId === 'web') ||
        (n.kind === 'browser' && t.connectorId === 'browser') ||
        (n.kind === 'phone' && t.connectionSlugs.includes(n.slug)),
    )
    if (hit) out.add(t.name)
  }
  return [...out]
}

// --- who may -----------------------------------------------------------------------------------

/** Owners and admins act for the team: they may order reports into a group, and remove any order. */
export const mayPostToGroups = (role: string): boolean => role === 'owner' || role === 'admin'

/** Who may remove an order: its requester, an owner or an admin. */
export const mayRemoveOrder = (
  order: Pick<StandingOrder, 'by'>,
  asker: { by: string; role: string },
): boolean => mayPostToGroups(asker.role) || order.by === asker.by

// --- what the model reads ----------------------------------------------------------------------

export const STANDING_ORDER_DESCRIPTION =
  'Keep or remove a STANDING ORDER: an ongoing instruction that the heartbeat carries out for you ' +
  'in the background. Use `add` when a person gives you something to do all the time or whenever it ' +
  'happens: "setiap saat", "terus", "pantau", "awasi", "watch", "keep an eye on", "monitor", ' +
  '"if you notice ..., tell/report/tag me", "kalau ada ... kabari/laporkan", "be proactive". ' +
  "Pass `instruction` as the person's own words, lightly cleaned (what to watch and what counts as " +
  'worth a report). Do NOT use it for a one-off task now (just do it), for something at a fixed time ' +
  '(a reminder, a routine or a program) or for a rule about how to talk (memory/persona). ' +
  'If the instruction is about what an existing program\'s runs do ("put it in the daily report"), ' +
  "save it as that program's note (program_note) instead: one instruction lives in ONE place, never both. " +
  'By default it reports exactly where the person asked ("chat saya disini"): this chat. Set ' +
  '`connection`/`chat`/`topic` only when the person explicitly names another chat of yours. ' +
  '`mention` defaults to true in a group (the asker is tagged); pass false when they did not want it. ' +
  'Only an owner or an admin can have a report posted into a group; a member gets reports privately, ' +
  'in their direct chat with you. `list` shows the orders you can see; `remove` stops one (the person ' +
  'who asked, an owner or an admin): use it when someone says "stop", "berhenti memantau", ' +
  '"cukup", pass the order `id` (or words of it in `match`). Echo back, in one plain sentence, what ' +
  'you will watch and where you will report. ' +
  'KINDS (`kind`): `watch` (default, ongoing); `rule` ("if someone posts X, report it": the beat looks ' +
  'for exactly that); `deadline` (a one-shot check at an exact time: pass `due`, resolved in the team ' +
  'timezone; "today around 12:00" means due today 12:00; the beat wakes at that minute, does it and ends ' +
  'the order with an outcome; optional `expires`); `ledger` (keep a tracker: "when I say I took videos, ' +
  'record the date and count; warn if not uploaded in 2 days": the order keeps a file, default ' +
  '/library/trackers/<name>.md). Pass `refs` for context the beat must open ("General #12345", a session id) ' +
  'and `needs` for what it must be able to do (web, browser, phone/<connection slug>); the tools follow ' +
  'the order, for owners and admins only. If the order names a penalty or a warning to a member, keep it in ' +
  'the words of the order: the beat records and reports to the giver, may post only what the order says in ' +
  "the order's own report chat, and never removes or bans anyone. `done` ends a deadline order " +
  'with its `outcome`.'

/** Said (once, static) in the chats of agents that have the tool. */
export const STANDING_ORDERS_NOTE = [
  '## Standing orders',
  '',
  'You have a heartbeat: a quiet check-in every half hour (and when chats you watch get new messages).',
  'When a person gives you an ONGOING job ("watch the community channel all the time and tell me',
  'anything strange", "audit this group, write notes, ping me when it matters") call `standing_order`',
  'with action `add`; do not just answer once and forget it. They are kept as readable lines in your',
  'memory file `HEARTBEAT.md`, which the owner can read and edit. Words like "setiap saat", "terus",',
  '"pantau", "proaktif", "kalau ada ... kabari" mean an ongoing job. "Stop watching" means `remove`.',
  'The heartbeat reads and keeps notes; it posts only where an order says to report.',
  'Give the order its kind: `deadline` with an exact `due` for a one-time check at a time, `rule` for',
  '"if X happens, report", `ledger` for a tracker it keeps; add `refs` and `needs` when it must open',
  'earlier messages or use the web, the browser or a phone.',
].join('\n')

// --- what a beat may read, and where it may carry what it read ---------------------------------

/**
 * A conversation of the agent as the privacy rule sees it (`WatchNode` of `domain/heartbeat.ts` has
 * these fields too).
 */
export interface ReadNode {
  connectionId: string
  nodeId: string
  /** `direct` is a private chat with one person. */
  kind: string
  /** The chat is allowed for the agent (its settings let it in). */
  allowed: boolean
}

/**
 * What a beat may read of the chats and where it may carry it (P51 open question: the beat can read
 * every chat the agent can, so a member's private order or a DM could end up in a group report).
 * Written at the start of a beat; the gate reads it on every call.
 *  - `nodes`: the chats it may read
 *  - `carriers`: for each private chat (a DM) among them, the destinations (`destKey`) that may
 *    receive what was read there
 *  - `seen`: the private chats this beat has actually read so far
 */
export interface ReadScope {
  nodes: string[]
  carriers: Record<string, string[]>
  seen: string[]
  /** The groups (not direct chats) this beat has read so far, with the ids of their ancestors. */
  groups?: ReadGroup[]
}

/** A group, channel or topic a beat read: what the group-to-group rule compares a post against. */
export interface ReadGroup {
  nodeId: string
  title: string
  /** What people call it: its title and its native id. */
  names: string[]
  /** The node and its ancestors. */
  ids: string[]
}

/**
 * The reach of a beat: the chats of the live orders. A chat is readable when the person who gave a
 * live order can read it themselves today (an owner or an admin: every chat the agent is allowed
 * in, the web owner too; a member: the chats they belong to, their divisions and their own direct
 * chat), or when the owner's own plain checklist items are on the list (they are the owner's: all
 * allowed chats). A chat an order merely names (its report chat, its refs) adds nothing for a
 * member: naming a chat is not the right to read it. A giver who is gone reads nothing.
 *
 * What was read in a DM may go only back to that DM, or to the DM or the web chat of a person who
 * can read that DM (an owner or an admin: any; a member: only their own). Never into a group.
 * Pure.
 */
export function readScopeOf(input: {
  orders: readonly StandingOrder[]
  /** The owner's plain checklist items exist (not an order: no giver to bound them). */
  plainItems: boolean
  nodes: readonly ReadNode[]
  /** Can the giver of the order read this chat today? */
  giverCanRead: (o: StandingOrder, nodeId: string) => boolean
  /** The role of the giver today; undefined = gone. */
  giverRole: (o: StandingOrder) => string | undefined
}): ReadScope {
  const allowed = input.nodes.filter((n) => n.allowed)
  const readable = new Set<string>(input.plainItems ? allowed.map((n) => n.nodeId) : [])
  const givers: StandingOrder[] = []
  for (const o of input.orders) {
    if (input.giverRole(o) === undefined) continue
    givers.push(o)
    for (const n of allowed) if (input.giverCanRead(o, n.nodeId)) readable.add(n.nodeId)
  }
  const carriers: Record<string, string[]> = {}
  for (const p of input.nodes) {
    if (p.kind !== 'direct' || !readable.has(p.nodeId)) continue
    const keys = new Set<string>([
      destKey({ kind: 'chat', connectionId: p.connectionId, nodeId: p.nodeId }),
    ])
    for (const o of givers) {
      if (!input.giverCanRead(o, p.nodeId)) continue
      if (o.report.kind === 'web') keys.add(destKey(o.report))
      else {
        const dest = input.nodes.find((n) => n.nodeId === (o.report as { nodeId: string }).nodeId)
        if (dest?.kind === 'direct') keys.add(destKey(o.report))
      }
    }
    carriers[p.nodeId] = [...keys]
  }
  return { nodes: [...readable], carriers, seen: [] }
}

/** A readable reason when a beat may not read this chat (the node and its ancestors), else undefined. */
export function readRefusal(
  scope: ReadScope | undefined,
  target: { title: string; ids: readonly string[] },
): string | undefined {
  if (scope !== undefined && target.ids.some((id) => scope.nodes.includes(id))) return undefined
  return `Not read: "${target.title}" is outside what this heartbeat may read. A beat reads only chats that the person who gave a live standing order can read themselves (an owner or an admin: any allowed chat; a member: their own chats). Put what you need in the result as an item, or ask the owner to cover it with an order.`
}

/**
 * A readable reason when a post to `to` (`destKey`) would carry what a private chat said into a
 * place that is not for it, else undefined. `title` names a private chat that was read.
 */
export function privatePostRefusal(
  scope: ReadScope | undefined,
  to: string,
  titleOf: (nodeId: string) => string,
): string | undefined {
  if (scope === undefined) return undefined
  for (const p of scope.seen) {
    if ((scope.carriers[p] ?? []).includes(to)) continue
    return `Not posted: this beat read a private chat ("${titleOf(p)}"), and what a direct chat said may go only back to that chat or to the direct chat or web chat of a person who can read it, never to a group. Leave this report out, or put it in the result as an item (it reaches the owners' digest).`
  }
  return undefined
}

// --- where a post may go, and what it may carry (P51 privacy follow-ups) ----------------------

/** A live order of the running beat as the post check sees it (stored at the start of the beat). */
export interface PostOrder {
  id: string
  text: string
  refs: string[]
  /** Its report destination (`destKey`). */
  report: string
  /** The giver is an owner or an admin today (a member's order is private to the member). */
  staff: boolean
}

export const postOrderOf = (o: StandingOrder, staff: boolean): PostOrder => ({
  id: o.id,
  text: o.text,
  refs: o.refs,
  report: destKey(o.report),
  staff,
})

const words = (t: string): string[] =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((w) => w !== '')

/**
 * Does `text` repeat a run of `source` word for word? The run is five words (the whole source when
 * it has three or four). The gate cannot judge a paraphrase; this catches the copy and the near copy.
 */
export function repeatsRun(text: string, source: string): boolean {
  const s = words(source)
  if (s.length < 3) return false
  const n = Math.min(5, s.length)
  const hay = ` ${words(text).join(' ')} `
  for (let i = 0; i + n <= s.length; i++) {
    if (hay.includes(` ${s.slice(i, i + n).join(' ')} `)) return true
  }
  return false
}

/**
 * A member's standing order is private to the member, yet its text is in the beat's prompt. While
 * one is live every post must name the order it is for (`order`), and goes only to that order's own
 * report destination. A post for an order of an owner or an admin must not repeat what a member's
 * order says (a copied run of words). Pure.
 */
export function privateOrderRefusal(
  orders: readonly PostOrder[],
  post: { to: string; text: string; order?: string | undefined },
  labelOf: (destKey: string) => string,
): string | undefined {
  const privates = orders.filter((o) => !o.staff)
  if (privates.length === 0) return undefined
  const id = post.order?.trim() ?? ''
  if (id === '') {
    return `Not posted: a member's standing order is live in this beat, so every post must name the order it is for (pass \`order\` with its id: ${orders
      .map((o) => `${o.id} reports to ${labelOf(o.report)}`)
      .join('; ')}). A post for an order goes only to that order's own destination.`
  }
  const named = orders.find((o) => o.id === id)
  if (named === undefined)
    return `Not posted: there is no live standing order "${id}" in this beat.`
  if (named.report !== post.to) {
    return `Not posted: order ${named.id} reports to ${labelOf(named.report)}, and a post for it goes only there${named.staff ? '' : " (a member's order never goes to another chat)"}. Leave this out or put it in the result as an item.`
  }
  for (const p of privates) {
    if (p.id === named.id || p.report === post.to) continue
    if (repeatsRun(post.text, p.text)) {
      return `Not posted: this text repeats what a member's private standing order says (${p.id}); that order is for its own chat only. Leave it out.`
    }
  }
  return undefined
}

const namesChat = (o: PostOrder, g: ReadGroup): boolean => {
  const text = `${o.text} ${o.refs.join(' ')}`.toLowerCase()
  return (
    [g.title, ...g.names].some((n) => {
      const name = n.trim().toLowerCase()
      return name.length >= 3 && text.includes(name)
    }) || g.ids.some((id) => id.length >= 8 && text.includes(id.toLowerCase()))
  )
}

/**
 * What was read in group A may be posted into another group B only when a live order of an owner or
 * an admin reports to B and names A as a place to watch (its text or refs: the title or the id).
 * The same chat (a topic and its forum) is not "another group". Pure.
 */
export function crossGroupRefusal(
  scope: ReadScope | undefined,
  orders: readonly PostOrder[],
  dest: { to: string; ids: readonly string[] },
): string | undefined {
  for (const g of scope?.groups ?? []) {
    if (g.ids.some((id) => dest.ids.includes(id))) continue
    if (orders.some((o) => o.staff && o.report === dest.to && namesChat(o, g))) continue
    return `Not posted: this beat read "${g.title}", and what a group said may go into another group only when a standing order of an owner or an admin reports to that group and names "${g.title}" as a place to watch. Leave this report out, or put it in the result as an item.`
  }
  return undefined
}
