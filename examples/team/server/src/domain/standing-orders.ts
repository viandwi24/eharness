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
}

export const WEB_OWNER = 'web:owner'
export const STANDING_ORDER_TOOL = 'standing_order'
export const HEARTBEAT_REPORT_TOOL = 'heartbeat_report'

/** Posts a beat may make to one destination per local day (a constant: nobody tunes this). */
export const PER_DESTINATION_DAILY_CAP = 8
/** An early beat on chat activity starts at the earliest this long after the previous beat. */
export const ACTIVITY_MIN_GAP_MS = 10 * 60_000
export const MAX_ORDER_CHARS = 500

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
  }
}

export interface ParsedChecklist {
  /** Every order of the file (also the paused ones). */
  orders: StandingOrder[]
  /** The orders the heartbeat acts on. */
  active: StandingOrder[]
  /** Checklist lines that are not orders: the owner's own items. */
  plain: string[]
}

export function parseChecklist(text: string | null | undefined): ParsedChecklist {
  const orders: StandingOrder[] = []
  const rest: string[] = []
  for (const line of (text ?? '').split('\n')) {
    const order = parseOrderLine(line)
    if (order === undefined) rest.push(line)
    else orders.push(order)
  }
  return {
    orders,
    active: orders.filter((o) => o.active),
    plain: contentLines(rest.join('\n')),
  }
}

/** Nothing to do: no plain item and no active order. The beat is then skipped without a model call. */
export const checklistIsBlank = (text: string | null | undefined): boolean => {
  const p = parseChecklist(text)
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
  a: Pick<StandingOrder, 'text' | 'by' | 'report'>,
  b: Pick<StandingOrder, 'text' | 'by' | 'report'>,
): boolean {
  const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(a.text) === norm(b.text) && a.by === b.by && sameDestination(a.report, b.report)
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
  'By default it reports exactly where the person asked ("chat saya disini"): this chat. Set ' +
  '`connection`/`chat`/`topic` only when the person explicitly names another chat of yours. ' +
  '`mention` defaults to true in a group (the asker is tagged); pass false when they did not want it. ' +
  'Only an owner or an admin can have a report posted into a group; a member gets reports privately, ' +
  'in their direct chat with you. `list` shows the orders you can see; `remove` stops one (the person ' +
  'who asked, an owner or an admin): use it when someone says "stop", "berhenti memantau", ' +
  '"cukup", pass the order `id` (or words of it in `match`). Echo back, in one plain sentence, what ' +
  'you will watch and where you will report.'

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
].join('\n')
