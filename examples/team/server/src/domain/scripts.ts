/**
 * Scripts (docs/plans/P59-scripts-and-tables.md, ADR-0065): the shapes shared by the executor and
 * the features built on it. A script is TypeScript whose default export is
 * `async (event, ctx) => unknown`; it runs in QuickJS inside a Worker and reaches the system only
 * through `ctx`, whose methods are host calls checked by the caller. Pure.
 */

/** Limits of one run. */
export interface ScriptLimits {
  /** Heap of the QuickJS runtime. */
  memoryMb: number
  /** Time spent executing script code (waiting on host calls does not count). */
  cpuMs: number
  /** The whole run, host calls included; the Worker is terminated past it. */
  wallMs: number
  /** Host calls (`ctx.*`) one run may make. */
  maxHostCalls: number
  /** Log lines kept (`console.log`, `ctx.log`), and characters across them. */
  maxLogLines: number
  maxLogChars: number
  /** Characters of the JSON result and of one host call's arguments or answer. */
  maxValueChars: number
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = {
  memoryMb: 64,
  cpuMs: 5_000,
  wallMs: 30_000,
  maxHostCalls: 200,
  maxLogLines: 200,
  maxLogChars: 20_000,
  maxValueChars: 100_000,
}

/** How a run ended. */
export type ScriptOutcome =
  /** The default export returned (or its promise resolved). */
  | 'ok'
  /** The script threw or its promise rejected, or it is not a valid script. */
  | 'error'
  /** CPU time ran out (an endless loop). */
  | 'cpu'
  /** The heap limit was hit. */
  | 'memory'
  /** The wall time ran out (waiting forever, a host call that never answered). */
  | 'timeout'
  /** Too many host calls. */
  | 'limit'

/** One `ctx.*` call as the run trace keeps it. */
export interface HostCallRecord {
  method: string
  args: unknown
  ok: boolean
  result?: unknown
  error?: string
  ms: number
  /** A dry run: the call was recorded, not performed. */
  dryRun?: boolean
}

export interface ScriptRunResult {
  outcome: ScriptOutcome
  /** The returned value (JSON), when `ok`. */
  result?: unknown
  /** A sentence, when not `ok`. */
  error?: string
  logs: string[]
  calls: HostCallRecord[]
  durationMs: number
  /** Time spent executing script code. */
  cpuMs: number
}

/** A host method a script may call, with the documentation the generated `scripts.d.ts` shows. */
export interface HostMethodDoc {
  /** Dotted name under `ctx` (`channels.send`). */
  name: string
  /** TypeScript type of the single argument (`{ chat: string; text: string }`), or `void`. */
  args: string
  /** TypeScript type of the answer (without the Promise). */
  returns: string
  /** One sentence. */
  doc: string
  /** Changes something outside the script (a dry run records it instead of doing it). */
  sideEffect: boolean
}

const METHOD = /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){0,2}$/

/** Why a host method name is not usable, or undefined. */
export const hostMethodProblem = (name: string): string | undefined =>
  METHOD.test(name) ? undefined : `"${name}" is not a host method name (like channels.send)`

/** The `scripts.d.ts` an author (person or agent) writes against. */
export function scriptTypes(methods: readonly HostMethodDoc[]): string {
  // a tree of namespaces from the dotted names
  interface Node {
    children: Map<string, Node>
    method?: HostMethodDoc
  }
  const root: Node = { children: new Map() }
  for (const m of [...methods].sort((a, b) => a.name.localeCompare(b.name))) {
    let node = root
    for (const part of m.name.split('.')) {
      let next = node.children.get(part)
      if (next === undefined) {
        next = { children: new Map() }
        node.children.set(part, next)
      }
      node = next
    }
    node.method = m
  }
  const render = (node: Node, indent: string): string[] => {
    const out: string[] = []
    for (const [key, child] of node.children) {
      if (child.method !== undefined) {
        const m = child.method
        out.push(
          `${indent}/** ${m.doc}${m.sideEffect ? ' (recorded, not done, in a dry run)' : ''} */`,
        )
        out.push(
          `${indent}${key}(${m.args === 'void' ? '' : `input: ${m.args}`}): Promise<${m.returns}>`,
        )
      } else {
        out.push(`${indent}${key}: {`, ...render(child, `${indent}  `), `${indent}}`)
      }
    }
    return out
  }
  return [
    '/** What a script receives: its trigger event, and `ctx`, the only way to reach the system. */',
    'interface ScriptContext {',
    '  /** A line in the run trace (also `console.log`). */',
    '  log(...values: unknown[]): void',
    '  /** Wait (at most 10 seconds; counts toward the run time limit). */',
    '  sleep(ms: number): Promise<void>',
    ...render(root, '  '),
    '}',
    '',
    '/** What started the run. Which fields are set depends on `type`. */',
    'interface ScriptEvent {',
    '  /** `message.created`, `reaction.added`, `member.joined`, … (chat), `row.created` / `row.updated` / `row.deleted` (table), `schedule`, `manual`. */',
    '  type: string',
    '  /** Chat events: the connection (Channels page) and the id of the event in the log. */',
    '  connectionId?: string',
    '  eventId?: string',
    '  /** When it happened (epoch ms). */',
    '  at?: number',
    '  /** Chat events: the chat (for a forum topic, `root*` is its group). */',
    '  chat?: { nodeId: string; nativeId: string; title: string | null; rootNativeId: string; rootTitle: string | null }',
    '  /** Chat events: who did it. `isSelf` = the agent itself. */',
    "  actor?: { id: string; name?: string; username?: string; role?: 'owner' | 'admin' | 'member' | 'guest'; isSelf?: boolean }",
    '  /** Message events: the text (never stored; a dry run uses the text you type). */',
    '  text?: string',
    '  /** Message and reaction events: the platform id of the message. */',
    '  messageId?: string',
    '  /** A reply: the message it answers (its platform id, and its sender when the platform says). */',
    '  replyTo?: { messageId: string; senderId?: string; senderName?: string }',
    '  /** Message events: its files (save one with ctx.channels.download, then post it with channels.send files). */',
    '  attachments?: ScriptAttachment[]',
    '  /** Message events: formatting and references in the text or caption (offsets in UTF-16 code units). */',
    "  entities?: Array<{ type: 'mention' | 'link' | 'command' | 'hashtag' | 'cashtag' | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'pre' | 'quote' | 'spoiler' | 'custom_emoji' | 'email' | 'phone'; offset: number; length: number; url?: string; language?: string; identity?: string; handle?: string; customEmojiId?: string }>',",
    '  /** A forwarded message: the original sender or chat (name and ids, as far as the platform tells), its message id and time. */',
    '  forward?: { name?: string; chat?: string; user?: string; messageId?: string; at?: number }',
    '  /** Album id shared by messages sent together. */',
    '  groupId?: string',
    '  /** An album (photos/videos sent together): every message of it in order. The event itself is the first one, `text` is the caption. */',
    '  album?: Array<{ messageId: string; text?: string; attachments?: ScriptAttachment[]; entities?: ScriptEvent["entities"] }>',
    '  /** A place, contact, poll or dice roll instead of text. */',
    "  content?: { type: 'location'; latitude: number; longitude: number; live?: boolean } | { type: 'venue'; latitude: number; longitude: number; title: string; address: string } | { type: 'contact'; phone: string; firstName: string; lastName?: string; userId?: string } | { type: 'poll'; question: string; options: string[]; quiz?: boolean; multiple?: boolean; anonymous?: boolean } | { type: 'dice'; emoji: string; value: number }",
    '  /** Reaction events. */',
    '  emoji?: string',
    '  /** Table events: the table, the changed row ids, the rows after the change (up to 20; none for deletions) and who changed them. */',
    '  table?: string',
    '  rowIds?: string[]',
    '  rows?: Array<{ id: string; version: number; data: Record<string, unknown> }>',
    '  by?: string',
    '  /** Schedule events: the slot (epoch ms) and when it fired. */',
    '  slot?: number',
    '  firedAt?: number',
    '  /** App events: the agent and session it is about, its feed number and its fields. */',
    '  agentId?: string',
    '  agentSlug?: string',
    '  sessionId?: string',
    '  seq?: number',
    '  payload?: Record<string, any>',
    '  /** Webhook events: the request (body as JSON when it parses, else text). */',
    '  method?: string',
    '  query?: Record<string, string>',
    '  headers?: Record<string, string>',
    '  body?: any',
    '}',
    '',
    '/** A file of a chat message. */',
    'interface ScriptAttachment {',
    '  id: string',
    '  /** Broad kind. */',
    "  kind: 'image' | 'file' | 'audio' | 'video'",
    '  /** What it is on the platform (animation = GIF; sticker: see `sticker`). */',
    "  media?: 'photo' | 'video' | 'animation' | 'video_note' | 'voice' | 'audio' | 'document' | 'sticker'",
    '  name?: string',
    '  mediaType?: string',
    '  size?: number',
    '  width?: number',
    '  height?: number',
    '  /** Seconds. */',
    '  duration?: number',
    "  sticker?: { emoji?: string; setName?: string; format: 'static' | 'animated' | 'video'; customEmojiId?: string }",
    '  /** A platform reference that sends the same file again without a download (Telegram bot file id). */',
    '  ref?: string',
    '}',
    '',
    '/** A script: `export default async function (event, ctx) { ... }`. Imports are not allowed. */',
    'type Script = (event: ScriptEvent, ctx: ScriptContext) => unknown | Promise<unknown>',
    '',
  ].join('\n')
}

// --- stored scripts (W4) -----------------------------------------------------------------------

export type ScriptStatus = 'draft' | 'active' | 'disabled'
export type AuthorKind = 'person' | 'agent'
export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected'
export type RunTrigger = 'channel' | 'schedule' | 'table' | 'app' | 'webhook' | 'manual'
export type RunOutcome = ScriptOutcome | 'skipped'

export interface Script {
  id: string
  name: string
  description: string
  agentId: string
  status: ScriptStatus
  latestVersion: number
  activeVersion: number | null
  authorKind: AuthorKind
  createdBy: string
  approval: {
    state: ApprovalState
    version: number | null
    by: string | null
    at: number | null
    note: string | null
  }
  routineId: string | null
  lastRunAt: number | null
  runCount: number
  errorCount: number
  consecutiveFailures: number
  disabledReason: string | null
  createdAt: number
  updatedAt: number
}

export interface ScriptVersion {
  scriptId: string
  version: number
  source: string
  /** The parsed manifest (`domain/script-manifest.ts`). */
  manifest: Record<string, unknown>
  hash: string
  note: string
  createdBy: string
  authorKind: AuthorKind
  createdAt: number
}

export interface ScriptRun {
  id: string
  scriptId: string
  version: number
  trigger: RunTrigger
  dryRun: boolean
  outcome: RunOutcome
  reason: string | null
  error: string | null
  event: unknown
  result: unknown
  logs: string[]
  calls: HostCallRecord[]
  durationMs: number
  cpuMs: number
  startedBy: string
  startedAt: number
}

const SCRIPT_NAME = /^[a-z][a-z0-9-]{0,62}$/

/** Why a script name is not usable, or undefined. */
export const scriptNameProblem = (name: string): string | undefined =>
  SCRIPT_NAME.test(name)
    ? undefined
    : `"${name.slice(0, 80)}" is not a script name: use lowercase letters, digits and -, starting with a letter (at most 63 characters)`

/** Key-value state of a script: key and value limits. */
export const KV_LIMITS = { keyChars: 200, valueChars: 100_000, keys: 1_000 } as const
