/**
 * H. Approvals and long work (production feedback): an owner's or admin's direct instruction runs
 * without a second confirmation when code can verify it (same chat, people they named); everything
 * else still asks, a "ya" / "tidak" reply answers from the chat, only owners and admins can answer,
 * an unrelated message of somebody else never cancels a pending request, and a long turn gets more
 * steps instead of "I ran out of steps".
 */
import { C } from '../checks.ts'
import { act, type Ctx, type Scenario, say, until, wait } from '../dsl.ts'
import { call, chatter, text } from './common.ts'

/** Distinct cheap tool calls (distinct inputs keep the progress guard quiet). */
const clockCalls = (n: number, from = 0, tag = 'd') =>
  Array.from({ length: n }, (_, i) =>
    call('datetime', { action: 'add', days: from + i + 1 }, `${tag}${from + i}`),
  )

const workerCall = (description: string) =>
  call(
    'agent',
    {
      subagent_type: 'worker',
      description,
      prompt: `Audit the whole group over weeks. Brief: ${description}. Already found: 120 dates checked.`,
      run_in_background: true,
    },
    'w1',
  )

const checkpoint = (n: number) =>
  call('long_run_checkpoint', { note: `Chunk ${n} done: continue with the next dates.` }, `cp${n}`)

/** A worker task row and its long-run job, read through the HTTP API (the web page's source). */
const workerJobs = async (
  c: Ctx,
): Promise<Array<{ status: string; job: Record<string, unknown> | null }>> => {
  const list = await c.w.api('GET', '/tasks?limit=100')
  const rows = (list.json.tasks as Array<{ id: string; sessionId: string }>).filter((t) =>
    t.sessionId.includes(':worker:'),
  )
  const out: Array<{ status: string; job: Record<string, unknown> | null }> = []
  for (const t of rows) {
    const d = await c.w.api('GET', `/tasks/${t.id}`)
    out.push({ status: String(d.json.task?.status), job: (d.json.job as never) ?? null })
  }
  return out
}

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
    id: 'H-13',
    category: 'H',
    title: 'A laugh emoji in reply to the bot does not wake it',
    goal: 'A reply that is only an emoji is a reaction, not a request: no model call, no answer.',
    expectedSafe: 'One answer to the greeting; the "😆" reply gets nothing.',
    script: { lead: [text('Halo Rini, ada yang bisa saya bantu?')] },
    steps: [say('ceo', 'general', 'halo'), say('budi', 'general', '😆', { replyTo: 'bot' })],
    hard: [C.maxPosts(1, 'general'), C.maxModelCalls(1)],
    tags: ['wake'],
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
  {
    id: 'H-14',
    category: 'H',
    title: 'A chat turn that reaches its step cap hands the job to the worker',
    goal: 'A chat audit runs into the 120-step cap: the agent is told to hand the rest to its worker instead of wrapping up.',
    expectedSafe:
      'The worker is started with a brief, the chat hears one short "continues in the background", the worker report arrives, and nothing says "ran out of steps".',
    script: {
      lead: [
        ...clockCalls(120),
        workerCall('audit of the group, part 2'),
        text('Saya lanjutkan di latar belakang dan kabari hasilnya di sini.'),
        // the worker (a copy of the lead: same scripted model) works and reports
        ...clockCalls(2, 200, 'k'),
        text('Laporan audit lengkap: tidak ada kesalahan berulang.'),
        // the report wakes the lead, which answers the chat
        text('Hasil audit: tidak ada kesalahan berulang.'),
      ],
    },
    steps: [say('ceo', 'general', 'audit semua percakapan grup ini sejak awal, semua topik')],
    hard: [
      C.toolCalled('agent', { slug: 'lead', input: /worker/ }),
      C.neverSays(/out of steps|ran out/i),
      C.posted('general', /latar belakang/),
      C.posted('general', /Hasil audit/),
    ],
    timeoutMs: 600_000,
    tags: ['long', 'worker', 'hand-over'],
  },
  {
    id: 'H-15',
    category: 'H',
    title: 'A worker job longer than 400 steps runs across chunks and reports once',
    goal: 'A worker has no fixed step cap: it runs as a long-run job in chunks of 80 steps with checkpoints.',
    expectedSafe:
      'Several chunks (checkpoints), one final report to the chat, the job is finished, no "out of steps".',
    script: {
      lead: [
        workerCall('audit over weeks'),
        text('Dimulai di latar belakang.'),
        // worker: five chunks of 79 steps and a checkpoint, then a short last chunk and the report
        ...[1, 2, 3, 4, 5].flatMap((n) => [
          ...clockCalls(79, (n - 1) * 79, `c${n}-`),
          checkpoint(n),
        ]),
        ...clockCalls(10, 400, 'last'),
        text('Laporan akhir audit: 405 tanggal diperiksa.'),
        text('Hasil audit: 405 tanggal diperiksa, tidak ada masalah.'),
      ],
    },
    steps: [say('ceo', 'general', 'tolong audit panjang di latar belakang dan kabari hasilnya')],
    hard: [
      C.toolCalled('long_run_checkpoint', { min: 5 }),
      C.neverSays(/out of steps|ran out/i),
      C.posted('general', /Hasil audit: 405/),
      C.custom('the worker report reaches the chat exactly once', (c) => {
        const n = c.obs.sent.filter((s) => /Hasil audit: 405/.test(s.text)).length
        return n === 1 ? { ok: true } : { ok: false, detail: `${n} posts` }
      }),
      C.custom('the worker job finished with more than 400 steps', async (c) => {
        const jobs = await workerJobs(c)
        const job = jobs[0]?.job
        return job?.status === 'finished' && Number(job.steps) > 400
          ? { ok: true, detail: JSON.stringify(job) }
          : { ok: false, detail: JSON.stringify(jobs) }
      }),
    ],
    timeoutMs: 900_000,
    tags: ['long', 'worker'],
  },
  {
    id: 'H-16',
    category: 'H',
    title: 'The server restarts in the middle of a worker job: it resumes',
    goal: 'A running long-run job survives a restart: boot reconcile continues it and the report still arrives once.',
    expectedSafe: 'After the restart the worker continues, finishes, and the chat gets one report.',
    script: {
      lead: [
        workerCall('audit that spans a restart'),
        text('Dimulai di latar belakang.'),
        // worker, first chunk: a slow step the restart cuts
        ...clockCalls(3, 0, 'pre'),
        {
          toolCalls: [
            { toolName: 'datetime', input: { action: 'add', days: 99 }, toolCallId: 'slow' },
          ],
          delayMs: 6000,
        },
        // worker after the restart (the continuation of the interrupted chunk)
        ...clockCalls(3, 100, 'post'),
        text('Laporan akhir audit: selesai setelah restart.'),
        text('Hasil audit: selesai setelah restart.'),
        // the cut turn of the stopped server still wakes up after its delay and calls the model
        // once more (a test artifact of an in-process "crash"): absorb it
        text('(old process)'),
        text('(old process)'),
      ],
    },
    steps: [
      say('ceo', 'general', 'audit panjang di latar belakang, kabari hasilnya', { noWait: true }),
      until(
        'the worker started its job',
        (w) =>
          (
            w.server.conn.sqlite
              .query("SELECT COUNT(*) n FROM tasks WHERE session_id LIKE '%:worker:%'")
              .get() as { n: number }
          ).n >= 1,
        60_000,
      ),
      wait(1200),
      act('restart the server mid-chunk', (w) => w.restart()),
      wait(15_000),
    ],
    hard: [
      C.neverSays(/out of steps|ran out/i),
      C.custom('the report reaches the chat exactly once', (c) => {
        const n = c.obs.sent.filter((s) => /Hasil audit: selesai/.test(s.text)).length
        return n === 1 ? { ok: true } : { ok: false, detail: `${n} posts` }
      }),
      C.custom('the worker job finished', async (c) => {
        const jobs = await workerJobs(c)
        return jobs[0]?.job?.status === 'finished'
          ? { ok: true }
          : { ok: false, detail: JSON.stringify(jobs) }
      }),
    ],
    timeoutMs: 300_000,
    tags: ['long', 'worker', 'restart'],
  },
  {
    id: 'H-17',
    category: 'H',
    title:
      'A chat turn that still ends at the cap is handed over by the gateway, never "ran out of steps"',
    goal: 'The model ignores the hand-over reminder and the turn ends max-steps: the gateway wakes the same session once to start the worker.',
    expectedSafe:
      'The wrap-up text is not posted; the woken session starts the worker; the chat hears "continues in the background" and later the result.',
    script: {
      lead: [
        ...clockCalls(124),
        // the wrap-up step (no tools) after the budget: this text must never reach the chat
        text('Maaf, saya kehabisan langkah (ran out of steps) sebelum selesai.'),
        // the hand-over wake
        workerCall('audit of the group, hand-over by the gateway'),
        text('Saya lanjutkan di latar belakang dan kabari hasilnya di sini.'),
        ...clockCalls(1, 300, 'k'),
        text('Laporan audit lengkap: selesai.'),
        text('Hasil audit: selesai.'),
      ],
    },
    steps: [say('ceo', 'general', 'audit semua percakapan grup ini sejak awal, semua topik')],
    hard: [
      C.neverSays(/out of steps|ran out|kehabisan langkah/i),
      C.toolCalled('agent', { slug: 'lead', input: /worker/ }),
      C.posted('general', /latar belakang/),
      C.posted('general', /Hasil audit: selesai/),
    ],
    timeoutMs: 600_000,
    tags: ['long', 'worker', 'hand-over'],
  },
]
