/**
 * A fixture collector: one realistic, deterministic day of a community chat (about 5 000 items
 * over several channels) with planted incidents an auditor must find. It stands in for a real
 * source (a Telegram or Slack MCP server is another `Collector`): same interface, same files.
 *
 * Planted, and listed in `truth` so tests can check the pipeline found them:
 * - spam bursts: one new account posts the same promo dozens of times across channels in minutes;
 * - a join raid: dozens of accounts join within minutes and post the same scam link;
 * - a moderator who deletes one member's helpful messages and bullies them;
 * - admin actions, one of them a suspicious role change to a brand-new account;
 * - link shares: mostly harmless, some to shady domains.
 *
 * Same options, same items, byte for byte.
 */
import {
  byTimeThenId,
  type CollectedItem,
  type Collector,
  type PollOptions,
  type PollResult,
} from '../../domain/collectors.ts'

export const COMMUNITY_SOURCE = 'community'

export interface CommunityFixtureOptions {
  /** Seed of the generator. Default 7. */
  seed?: number
  /** UTC day `YYYY-MM-DD`. Default `2026-10-11`. */
  day?: string
  /** Items in the day. Default 5 000. */
  messages?: number
  /** Items per poll page. Default 1 000. */
  pageSize?: number
}

export interface FixtureTruth {
  /** Ids of the posts of each spam burst. */
  spamBursts: Array<{ author: string; ids: string[] }>
  /** Joins and first posts of the raid. */
  raid: { joinIds: string[]; postIds: string[] }
  /** The moderator, the bullying posts, the helpful posts they deleted and the delete actions. */
  modAbuse: { mod: string; victim: string; bullyIds: string[]; deleteIds: string[] }
  /** Admin action ids; `suspiciousRoleChangeId` is the role change to the new account. */
  adminActionIds: string[]
  suspiciousRoleChangeId: string
  /** Posts that share a link to a shady domain. */
  shadyLinkIds: string[]
}

export interface CommunityFixture extends Collector {
  /** Every item of the day, in time order. */
  items(): CollectedItem[]
  truth(): FixtureTruth
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CHANNELS: Array<[string, number]> = [
  ['general', 0.34],
  ['help', 0.26],
  ['offtopic', 0.16],
  ['links', 0.1],
  ['showcase', 0.1],
  ['mods', 0.04],
]

// relative activity per UTC hour: quiet at night, busy in the evening
const HOURLY = [1, 1, 1, 1, 1, 2, 3, 5, 7, 8, 8, 9, 9, 9, 8, 8, 9, 10, 11, 12, 11, 9, 5, 2]

const OPENERS = [
  'Has anyone tried',
  'Quick question about',
  'I keep running into trouble with',
  'Does anybody know how to configure',
  'Looking for a good tutorial on',
  'Just finished my first project with',
  'Any tips for debugging',
  'What is the best way to learn',
]
const TOPICS = [
  'the new build pipeline',
  'async iterators',
  'docker compose on windows',
  'the typescript compiler flags',
  'database migrations',
  'cron jobs that overlap',
  'rate limiting an API',
  'unit tests for streams',
  'a monorepo setup',
  'the editor plugin',
  'caching responses',
  'webhooks retries',
]
const REPLIES = [
  'Thanks, that fixed it!',
  'I had the same problem last week, restarting the service helped.',
  'Check the logs first, the error is usually in the first few lines.',
  'You need to set that in the config file, not the environment.',
  'Works for me on the latest version.',
  'Good point, I will try that tonight.',
  'lol same',
  'That is a nice approach, do you have the repo?',
  'Which version are you on?',
  'Can you paste the exact error message?',
  'This is covered in the docs under "getting started".',
  'Great job, looks clean!',
  'I would not do that in production.',
  'Happy to help, ping me if it breaks again.',
  'Anyone up for a pairing session on Saturday?',
  'Morning everyone!',
  'Is the meetup still on for Thursday?',
  'Nice, congrats on the release.',
]
const GOOD_LINKS = [
  'https://github.com/oven-sh/bun',
  'https://developer.mozilla.org/en-US/docs/Web/API/Streams_API',
  'https://www.typescriptlang.org/docs/',
  'https://stackoverflow.com/questions/11227809',
  'https://docs.docker.com/compose/',
  'https://news.ycombinator.com/item?id=39000000',
  'https://en.wikipedia.org/wiki/Cron',
  'https://youtu.be/dQw4w9WgXcQ',
]
const SHADY_LINKS = [
  'https://bit.ly/3xFreeGift',
  'https://t.me/+airdropClaim77',
  'https://free-crypto-airdrop.xyz/claim',
  'https://discord-nitro-gift.xyz/redeem',
  'https://urlshort.top/win-iphone',
]
const BULLY = [
  "you're clueless, stop posting",
  'nobody wants your dumb questions here',
  'maybe try reading for once, idiot',
  'another useless post from you, get lost',
  'this is why people leave this community, because of you',
  'do us all a favour and quit',
  "you're a waste of space",
  'I will keep deleting your junk, deal with it',
]
const HELPFUL = [
  'For anyone hitting the timeout: raise it in the config and check your proxy.',
  'Here is a minimal repro for the stream bug, it fails after 3 chunks.',
  'Tip: run the migration in a transaction so it rolls back on failure.',
  'I wrote up how I set up CI for a monorepo, happy to share.',
  'The flag you want is --strict, it turns on the extra checks.',
  'Answer to the earlier question: yes, retries are safe if the handler is idempotent.',
  'Posted the fix for the cron overlap issue in the thread above.',
  'Small correction: the limit applies per key, not per IP.',
  'If you use docker on windows, enable WSL2 first.',
  'Notes from the meetup are in the pinned message.',
  'Sharing my dotfiles in case they help someone.',
  'The docs page was outdated, I opened an issue about it.',
]
const ADMIN_ACTIONS: Array<Record<string, unknown>> = [
  { action: 'mute', target: 'user_0077', reason: 'repeated off-topic posts', minutes: 60 },
  { action: 'pin', channel: 'announcements', note: 'Rules reminder' },
  { action: 'ban', target: 'promo_1', reason: 'spam' },
  { action: 'ban', target: 'promo_2', reason: 'spam' },
  { action: 'ban', target: 'promo_3', reason: 'spam' },
  { action: 'kick', target: 'user_0123', reason: 'asked to leave' },
  { action: 'unpin', channel: 'general', note: 'Old meetup post' },
  { action: 'slowmode', channel: 'general', seconds: 30 },
  { action: 'mute', target: 'user_0199', reason: 'heated argument', minutes: 30 },
  { action: 'role_change', target: 'user_0010', role: 'mod', reason: 'long-time helper' },
  { action: 'pin', channel: 'help', note: 'FAQ' },
  { action: 'unban', target: 'user_0150', reason: 'appeal accepted' },
  { action: 'slowmode', channel: 'general', seconds: 0 },
]

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

/** Build the day. Planted items carry a `tag` that is resolved to truth ids, then removed. */
function generate(options: Required<CommunityFixtureOptions>): {
  items: CollectedItem[]
  truth: FixtureTruth
} {
  const rand = rng(options.seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T
  const base = Date.parse(`${options.day}T00:00:00.000Z`)
  const at = (hour: number, minute: number, second = 0): number =>
    base + ((hour * 60 + minute) * 60 + second) * 1000

  interface NewDraft {
    channel: string
    at: number
    kind: string
    author: string
    authorRole: string
    tag?: string
    deleteTagOf?: string
    [key: string]: unknown
  }
  type Draft = NewDraft & { id: string }
  const drafts: Draft[] = []
  const add = (d: NewDraft): void => {
    drafts.push({ ...d, id: '' })
  }

  const members = Array.from({ length: 280 }, (_, i) => `user_${pad(i + 1, 4)}`)
  const mods = ['mod_dave', 'mod_ana', 'mod_li']
  const admins = ['admin_sam', 'admin_kim']

  // --- planted: spam bursts
  const bursts: Array<[string, number, number]> = [
    ['promo_1', 3, 12],
    ['promo_2', 11, 40],
    ['promo_3', 19, 5],
  ]
  for (const [author, hour, minute] of bursts) {
    add({ channel: 'general', at: at(hour, minute - 3), kind: 'join', author, authorRole: 'new' })
    for (let i = 0; i < 24; i++) {
      add({
        channel: pick(['general', 'help', 'offtopic', 'links']),
        at: at(hour, minute, Math.floor(rand() * 110)),
        kind: 'message',
        author,
        authorRole: 'new',
        text: `FREE crypto airdrop for the first 500 members! Claim now ${SHADY_LINKS[2]}?ref=${author}`,
        tag: `spam:${author}`,
      })
    }
  }

  // --- planted: join raid with one scam link, mid-afternoon
  const raiders = Array.from({ length: 50 }, (_, i) => `newacct_${pad(i + 1, 3)}`)
  for (const [i, author] of raiders.entries()) {
    const second = Math.floor((i / raiders.length) * 280)
    add({
      channel: 'general',
      at: at(14, 20, second),
      kind: 'join',
      author,
      authorRole: 'new',
      tag: 'raid-join',
    })
    add({
      channel: 'general',
      at: at(14, 21, second),
      kind: 'message',
      author,
      authorRole: 'new',
      text: `hi guys, claim your free nitro here ${SHADY_LINKS[3]}`,
      tag: 'raid-post',
    })
  }

  // --- planted: moderator abuse (helpful posts of the victim, deletions, bullying)
  const victim = 'user_0042'
  for (const [i, text] of HELPFUL.entries()) {
    add({
      channel: 'help',
      at: at(8 + Math.floor(i / 2), 5 + i * 3),
      kind: 'message',
      author: victim,
      authorRole: 'member',
      text,
      tag: `victim:${i}`,
    })
  }
  for (let i = 0; i < HELPFUL.length; i++) {
    add({
      channel: 'help',
      at: at(16, 30 + Math.floor(i * 2.5), 10),
      kind: 'delete',
      author: 'mod_dave',
      authorRole: 'mod',
      deleteTagOf: `victim:${i}`,
      reason: 'none given',
      tag: 'mod-delete',
    })
  }
  for (const [i, text] of BULLY.entries()) {
    add({
      channel: 'help',
      at: at(16, 32 + i * 5, 40),
      kind: 'message',
      author: 'mod_dave',
      authorRole: 'mod',
      text: `@${victim} ${text}`,
      replyToAuthor: victim,
      tag: 'mod-bully',
    })
  }

  // --- planted: admin actions, and a role change to a brand-new account
  for (const [i, extra] of ADMIN_ACTIONS.entries()) {
    add({
      channel: 'mods',
      at: at(6 + i, 15 + i),
      kind: 'admin',
      author: pick(admins),
      authorRole: 'admin',
      ...extra,
      tag: 'admin',
    })
  }
  add({
    channel: 'general',
    at: at(3, 58),
    kind: 'join',
    author: 'newacct_9f3a',
    authorRole: 'new',
  })
  add({
    channel: 'mods',
    at: at(4, 2),
    kind: 'admin',
    author: 'admin_kim',
    authorRole: 'admin',
    action: 'role_change',
    target: 'newacct_9f3a',
    role: 'admin',
    reason: 'none given',
    tag: 'admin-suspicious',
  })

  // --- planted: shady link shares among ordinary members
  for (let i = 0; i < 12; i++) {
    add({
      channel: 'links',
      at: at(Math.floor(rand() * 24), Math.floor(rand() * 60), Math.floor(rand() * 60)),
      kind: 'message',
      author: pick(members),
      authorRole: 'member',
      text: `check this out ${pick(SHADY_LINKS)}`,
      tag: 'shady',
    })
  }

  // --- organic traffic fills the rest of the day
  const hourTotal = HOURLY.reduce((a, b) => a + b, 0)
  const pickHour = (): number => {
    let r = rand() * hourTotal
    for (const [h, w] of HOURLY.entries()) {
      r -= w
      if (r <= 0) return h
    }
    return 23
  }
  const pickChannel = (): string => {
    let r = rand()
    for (const [name, weight] of CHANNELS) {
      r -= weight
      if (r <= 0) return name
    }
    return 'general'
  }
  while (drafts.length < options.messages) {
    const channel = pickChannel()
    const staff = channel === 'mods' || rand() < 0.04
    const author = staff
      ? pick([...mods.filter((m) => m !== 'mod_dave'), ...admins])
      : pick(members)
    const roll = rand()
    const text =
      roll < 0.07
        ? `${pick(['look at this', 'relevant:', 'docs here', 'see'])} ${pick(GOOD_LINKS)}`
        : roll < 0.45
          ? `${pick(OPENERS)} ${pick(TOPICS)}?`
          : pick(REPLIES)
    add({
      channel,
      at: at(pickHour(), Math.floor(rand() * 60), Math.floor(rand() * 60)),
      kind: 'message',
      author,
      authorRole: staff ? 'mod' : 'member',
      text,
    })
  }
  // an organic day never exceeds the requested size: trim organic extras only if planted overshot
  drafts.sort(
    (a, b) => a.at - b.at || a.author.localeCompare(b.author) || a.kind.localeCompare(b.kind),
  )
  const final = drafts.slice(0, options.messages)

  // --- ids in time order, then resolve the references and the truth
  const idOfTag = new Map<string, string[]>()
  for (const [i, d] of final.entries()) {
    d.id = `m${pad(i + 1, 6)}`
    if (d.tag !== undefined) {
      const list = idOfTag.get(d.tag) ?? []
      list.push(d.id)
      idOfTag.set(d.tag, list)
    }
  }
  const items: CollectedItem[] = final.map((d) => {
    const { tag: _tag, deleteTagOf, ...rest } = d
    if (deleteTagOf !== undefined) {
      const target = idOfTag.get(deleteTagOf)?.[0]
      return { ...rest, ...(target === undefined ? {} : { targetId: target }) }
    }
    return rest
  })
  items.sort(byTimeThenId)
  const ids = (tag: string): string[] => idOfTag.get(tag) ?? []
  const truth: FixtureTruth = {
    spamBursts: bursts.map(([author]) => ({ author, ids: ids(`spam:${author}`) })),
    raid: { joinIds: ids('raid-join'), postIds: ids('raid-post') },
    modAbuse: { mod: 'mod_dave', victim, bullyIds: ids('mod-bully'), deleteIds: ids('mod-delete') },
    adminActionIds: ids('admin'),
    suspiciousRoleChangeId: ids('admin-suspicious')[0] ?? '',
    shadyLinkIds: ids('shady'),
  }
  return { items, truth }
}

/** The collector of the fixture day. The cursor is the id of the last item delivered. */
export function communityFixture(options: CommunityFixtureOptions = {}): CommunityFixture {
  const resolved: Required<CommunityFixtureOptions> = {
    seed: options.seed ?? 7,
    day: options.day ?? '2026-10-11',
    messages: options.messages ?? 5_000,
    pageSize: options.pageSize ?? 1_000,
  }
  let cache: ReturnType<typeof generate> | undefined
  const day = (): ReturnType<typeof generate> => {
    cache ??= generate(resolved)
    return cache
  }
  return {
    id: COMMUNITY_SOURCE,
    description: `A fixture community chat for ${resolved.day} (${resolved.messages} items).`,
    items: () => day().items,
    truth: () => day().truth,
    async poll(cursor: string | null, poll: PollOptions = {}): Promise<PollResult> {
      const all = day().items
      const start = cursor === null ? 0 : all.findIndex((i) => i.id === cursor) + 1
      const size = Math.max(1, Math.min(poll.limit ?? resolved.pageSize, resolved.pageSize))
      const page = all.slice(start, start + size)
      return { items: page, cursor: page.length === 0 ? cursor : (page.at(-1) as CollectedItem).id }
    },
  }
}
