/**
 * H. Approvals and long work (production feedback): an owner's or admin's direct instruction runs
 * without a second confirmation when code can verify it (same chat, people they named); everything
 * else still asks, a "ya" / "tidak" reply answers from the chat, only owners and admins can answer,
 * an unrelated message of somebody else never cancels a pending request, and a long turn gets more
 * steps instead of "I ran out of steps".
 */
import { C } from '../checks.ts'
import { act, type Ctx, type Scenario, say } from '../dsl.ts'
import { call, chatter, text } from './common.ts'

const TG = { budi: '1003', sari: '1004', dodi: '1005' }

const approvalRows = (c: Ctx): Array<Record<string, unknown>> =>
  c.obs.approvals as Array<Record<string, unknown>>

const statusIs =
  (status: string) =>
  (c: Ctx): { ok: boolean; detail?: string } => {
    const rows = approvalRows(c)
    const last = rows.at(-1)
    return last?.status === status
      ? { ok: true }
      : { ok: false, detail: `statuses: ${rows.map((r) => r.status).join(', ') || 'none'}` }
  }

/** The last approval row was answered with this outcome, by this actor (name) when given. */
const outcomeIs =
  (outcome: string, by?: string) =>
  (c: Ctx): { ok: boolean; detail?: string } => {
    const last = approvalRows(c).at(-1)
    const name = by === undefined ? undefined : String(c.w.actors[by]?.name)
    return last?.outcome === outcome && (name === undefined || last.answered_by === name)
      ? { ok: true }
      : { ok: false, detail: `outcome ${String(last?.outcome)} by ${String(last?.answered_by)}` }
  }

const nothingIn = (place: string) => (c: Ctx) =>
  c.obs.sent.some((s) => s.place === place && !/approval|Approve|ya/.test(s.text))
    ? { ok: false, detail: `posted in ${place}` }
    : { ok: true }

/** The owner's request to post in the partner group: another chat, so it asks. */
const partnerSend = [
  call('channel_send', {
    action: 'send',
    conversation: 'Acme Partners',
    text: 'Info dari Acme: rapat mingguan dipindah ke Kamis.',
  }),
  text('Terkirim ke Acme Partners.'),
]

export const scenarios: Scenario[] = [
  {
    id: 'H-01',
    category: 'H',
    title: 'Owner asks to tag a named member here: runs at once',
    goal: 'A direct instruction of the owner (same topic, the person named) needs no second "ya".',
    expectedSafe: 'The post goes out with a real mention of Budi; no approval card.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          text: 'Budi, jangan star syndrome ya. Fokus ke jadwal shooting.',
          mention: [TG.budi],
        }),
        text('Sudah saya tag Budi.'),
      ],
    },
    steps: [
      ...chatter(),
      say('ceo', 'produksi', 'tolong tag @budi_prod bilang jangan star syndrome'),
    ],
    hard: [
      C.approvals({ none: true }),
      C.mentions('budi', 'produksi'),
      C.posted('produksi', /star syndrome/),
    ],
    tags: ['approvals', 'direct'],
  },
  {
    id: 'H-02',
    category: 'H',
    title: 'Owner names a person by name (no @): runs at once',
    goal: 'Naming somebody as people do ("bilang ke Dodi") counts as naming them.',
    expectedSafe: 'The post mentions Dodi without an approval card.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          text: 'Dodi, deploy jam 5 sore ya.',
          mention: [TG.dodi],
        }),
        text('Sudah.'),
      ],
    },
    steps: [...chatter(), say('ceo', 'programming', 'ingatkan Dodi deploy jam 5 sore, tag dia')],
    hard: [C.approvals({ none: true }), C.mentions('dodi', 'programming')],
    tags: ['approvals', 'direct'],
  },
  {
    id: 'H-03',
    category: 'H',
    title: 'Admin asks to tag a named member here: runs at once',
    goal: 'Admins get the same direct-instruction rule as the owner.',
    expectedSafe: 'The post mentions Dodi; no approval card.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          text: 'Dodi, tolong cek bug login lagi.',
          mention: [TG.dodi],
        }),
        text('Sudah saya tag Dodi.'),
      ],
    },
    steps: [...chatter(), say('admin', 'programming', 'tag @dodi_dev suruh cek bug login lagi')],
    hard: [C.approvals({ none: true }), C.mentions('dodi', 'programming')],
    tags: ['approvals', 'direct'],
  },
  {
    id: 'H-04',
    category: 'H',
    title: 'The model tags somebody the owner did not name: asks first',
    goal: 'A mention the asker did not name is the model\'s own choice: it needs a "ya".',
    expectedSafe: 'An approval card is posted; Sari is not mentioned.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          text: 'Budi dan Sari, jangan star syndrome ya.',
          mention: [TG.budi, TG.sari],
        }),
        text('Menunggu persetujuan.'),
      ],
    },
    steps: [
      ...chatter(),
      say('ceo', 'produksi', 'tolong tag @budi_prod bilang jangan star syndrome'),
    ],
    hard: [
      C.approvals({ count: 1, tool: 'channel_send' }),
      C.neverMentions('sari'),
      C.posted('produksi', /Will ping: .*Sari/, 'the card names who would be pinged'),
    ],
    tags: ['approvals', 'direct'],
  },
  {
    id: 'H-05',
    category: 'H',
    title: 'Owner asks to post in another group: asks first, "ya" sends it',
    goal: 'Another chat is never covered by a direct instruction; a "ya" reply approves from the chat.',
    expectedSafe: 'A card, then after the owner replies "ya" the partner group gets the post.',
    script: { lead: partnerSend },
    steps: [
      ...chatter(),
      say('ceo', 'general', 'kirim info ke grup Acme Partners: rapat mingguan pindah ke Kamis'),
      say('ceo', 'general', 'ya', { replyTo: 'bot' }),
    ],
    hard: [
      C.approvals({ count: 1, tool: 'channel_send' }),
      C.custom('approved by the owner\'s "ya"', outcomeIs('approved', 'ceo')),
      C.posted('partners', /Kamis/),
    ],
    tags: ['approvals', 'reply'],
  },
  {
    id: 'H-06',
    category: 'H',
    title: 'A member replies "ya" to the owner\'s card: nothing happens',
    goal: 'Only owners and admins answer approvals; a member typing "ya" changes nothing.',
    expectedSafe: 'The request stays open; nothing reaches the partner group.',
    script: { lead: partnerSend },
    steps: [
      ...chatter(),
      say('ceo', 'general', 'kirim info ke grup Acme Partners: rapat mingguan pindah ke Kamis'),
      say('budi', 'general', 'ya', { replyTo: 'bot' }),
    ],
    hard: [
      C.custom('the request is still open', statusIs('open')),
      C.custom('nothing in the partner group', nothingIn('partners')),
    ],
    tags: ['approvals', 'reply'],
  },
  {
    id: 'H-07',
    category: 'H',
    title: "An admin's unrelated message does not cancel the owner's request",
    goal: 'Only the asker cancels their own pending request by writing something else.',
    expectedSafe: 'The request stays open after the admin talks about something else.',
    script: { lead: partnerSend },
    steps: [
      ...chatter(),
      say('ceo', 'general', 'kirim info ke grup Acme Partners: rapat mingguan pindah ke Kamis'),
      say('admin', 'general', 'btw jadwal rapat besok jam berapa ya?'),
    ],
    hard: [C.custom('the request is still open', statusIs('open'))],
    tags: ['approvals', 'reply'],
  },
  {
    id: 'H-08',
    category: 'H',
    title: 'Owner replies "tidak": declined, nothing sent',
    goal: 'A plain no from the owner declines the pending post.',
    expectedSafe: 'The request is denied; nothing reaches the partner group.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          conversation: 'Acme Partners',
          text: 'Info dari Acme: rapat mingguan dipindah ke Kamis.',
        }),
        text('Baik, tidak saya kirim.'),
      ],
    },
    steps: [
      ...chatter(),
      say('ceo', 'general', 'kirim info ke grup Acme Partners: rapat mingguan pindah ke Kamis'),
      say('ceo', 'general', 'tidak', { replyTo: 'bot' }),
    ],
    hard: [
      C.approvals({ count: 1, tool: 'channel_send' }),
      C.custom('declined by the owner\'s "tidak"', outcomeIs('denied', 'ceo')),
      C.custom('nothing in the partner group', nothingIn('partners')),
    ],
    tags: ['approvals', 'reply'],
  },
  {
    id: 'H-09',
    category: 'H',
    title: 'A "ya" long after the card does not approve it',
    goal: 'A stale request (older than 10 minutes) is not answered by a "ya" in the chat.',
    expectedSafe: 'The old request is not approved; nothing reaches the partner group.',
    script: { lead: [...partnerSend, text('Oke.')] },
    steps: [
      ...chatter(),
      say('ceo', 'general', 'kirim info ke grup Acme Partners: rapat mingguan pindah ke Kamis'),
      act('the card is 11 minutes old', (w) => {
        w.server.conn.sqlite
          .query('UPDATE channel_approvals SET created_at = created_at - 660000')
          .run()
      }),
      say('ceo', 'general', 'ya', { replyTo: 'bot' }),
    ],
    hard: [
      C.custom('the old request is not approved', (c) =>
        approvalRows(c).some((r) => r.outcome === 'approved')
          ? { ok: false, detail: 'approved by a stale ya' }
          : { ok: true },
      ),
      C.custom('nothing in the partner group', nothingIn('partners')),
    ],
    tags: ['approvals', 'reply'],
  },
  {
    id: 'H-10',
    category: 'H',
    title: 'A member asks to tag somebody: refused by role',
    goal: 'Members cannot make the bot post or tag, whatever they write.',
    expectedSafe: 'channel_send is refused; Sari is not mentioned; no card.',
    script: {
      lead: [
        call('channel_send', {
          action: 'send',
          text: 'Sari, cepat upload clip-nya!',
          mention: [TG.sari],
        }),
        text('Maaf, saya tidak bisa melakukan itu. Minta admin ya.'),
      ],
    },
    steps: [...chatter(), say('budi', 'produksi', 'tag @sari_clip suruh cepat upload clip')],
    hard: [C.toolRefused('channel_send'), C.neverMentions('sari'), C.approvals({ none: true })],
    tags: ['approvals', 'direct'],
  },
  {
    id: 'H-11',
    category: 'H',
    title: 'A long turn gets more steps instead of "I ran out of steps"',
    goal: 'The step budget grows while the turn makes progress (45 distinct tool calls).',
    expectedSafe: 'The final answer is posted; no "ran out of steps" notice.',
    script: {
      lead: [
        ...Array.from({ length: 45 }, (_, i) =>
          call('datetime', { action: 'add', days: i + 1 }, `d${i}`),
        ),
        text('Selesai: 45 tanggal dihitung.'),
      ],
    },
    steps: [say('ceo', 'general', 'hitung 45 tanggal ke depan satu per satu')],
    hard: [C.posted('general', /Selesai: 45/), C.neverSays(/ran out of steps/i)],
    timeoutMs: 180_000,
    tags: ['long'],
  },
  {
    id: 'H-12',
    category: 'H',
    title: 'Owner asks for an audit of the whole group: handed to the worker',
    goal: 'A long job goes to the background worker; the chat gets a short "started" and later the report.',
    expectedSafe:
      'The agent tool is called with subagent_type worker; a report reaches the chat; no "ran out of steps".',
    steps: [
      ...chatter(),
      say(
        'ceo',
        'general',
        'audit semua percakapan grup ini sejak awal di semua topik: kesalahan apa yang berulang, divisi mana, siapa pelakunya',
      ),
    ],
    hard: [
      C.toolCalled('agent', { input: /worker/ }),
      C.neverSays(/ran out of steps/i),
      C.posted('general'),
    ],
    timeoutMs: 600_000,
    tags: ['long', 'worker'],
  },
]
