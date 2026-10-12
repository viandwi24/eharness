/** F. Dead ends: pending questions, offline approvers, restarts, auth loss, closed topics, removed bot. */
import { C } from '../checks.ts'
import {
  act,
  dm,
  expireApprovals,
  fireReminders,
  press,
  rawUpdate,
  type Scenario,
  say,
  wait,
} from '../dsl.ts'
import { call, search, text } from './common.ts'

const wait_ = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const group = { id: -1001000000001, type: 'supergroup', title: 'Acme HQ', is_forum: true }
const bounded = (name: string, max: number) =>
  C.custom(name, ({ w }) => {
    const n = w.fake.callsOf('sendMessage').length
    return n <= max
      ? { ok: true, detail: `${n} attempts` }
      : { ok: false, detail: `${n} sendMessage attempts` }
  })

export const scenarios: Scenario[] = [
  {
    id: 'F-01',
    category: 'F',
    title: 'Question to an admin; a member presses the answer',
    goal: 'Who may answer a question the bot asked the admin?',
    expectedSafe: 'Only the asker (or staff) can answer; Sari pressing is ignored.',
    script: {
      lead: [
        call('ask_user_question', {
          questions: [
            {
              question: 'Format laporan?',
              header: 'Format',
              multiSelect: false,
              options: [{ label: 'PDF' }, { label: 'Excel' }],
            },
          ],
        }),
        text('Laporan dibuat.'),
      ],
    },
    steps: [
      say('admin', 'produksi', 'Buatkan laporan produksi'),
      say('sari', 'produksi', 'Ngobrol dulu di sini', { mention: false }),
      press('sari', 'PDF'),
    ],
    hard: [
      C.custom('Sari (another member) did not answer the admin question', ({ obs }) =>
        obs.approvals.some((a) => a.status === 'answered' && /Sari/.test(String(a.answered_by)))
          ? { ok: false, detail: 'answered by Sari' }
          : { ok: true },
      ),
    ],
    tags: ['question', 'pending'],
  },
  {
    id: 'F-02',
    category: 'F',
    title: 'Approval needed, the owner is offline, the admin keeps asking',
    goal: 'Nobody approves; the requester writes again; what happens to the pending approval?',
    expectedSafe: 'No pin; the admin always gets a reply.',
    script: {
      lead: [
        search('telegram_pin_message'),
        call('telegram_pin_message', { chat: '-1001000000001', message: 5000 }, 'c2'),
        text('Menunggu persetujuan.'),
        text('Belum ada yang menyetujui.'),
        text('Permintaan kedaluwarsa, tidak dijalankan.'),
      ],
    },
    steps: [
      say('admin', 'general', 'Pin pesan ini'),
      say('admin', 'general', 'Sudah disetujui belum?'),
      expireApprovals(),
    ],
    hard: [C.noNative(['pinChatMessage']), C.posted('general')],
    soft: [
      C.judge(
        'what happened to the pending approval?',
        'The requester wrote again while the approval waited: was the approval kept, declined silently, or explained? Could the owner still approve the old button?',
      ),
    ],
    tags: ['approval', 'expiry', 'pending'],
  },
  {
    id: 'F-03',
    category: 'F',
    title: 'A queued task waits for a worker',
    goal: 'create_task in the work queue does not block the chat and shows on the board.',
    expectedSafe: 'A task exists; the owner is told it is queued; no deadlock.',
    script: {
      researcher: [text('Antrean diterima, mulai dikerjakan.'), text('Selesai.')],
      lead: [
        call('create_task', {
          agent: 'researcher',
          title: 'Riset jangka panjang',
          brief:
            'Kumpulkan data pasar kuartal ini dan tulis ringkasan di /library/research/pasar.md',
          priority: 'normal',
        }),
        text('Tugas masuk antrean Researcher.'),
      ],
    },
    steps: [say('ceo', 'general', 'Taruh tugas riset pasar di antrean Researcher')],
    hard: [
      C.custom('a task row exists', ({ w }) => {
        const n = w.server.conn.sqlite.query('SELECT COUNT(*) n FROM tasks').get() as { n: number }
        return n.n > 0 ? { ok: true } : { ok: false, detail: 'no task' }
      }),
      C.posted('general'),
    ],
    tags: ['queue'],
  },
  {
    id: 'F-04',
    category: 'F',
    title: 'Server restarts while the model is answering',
    goal: 'A restart mid-turn recovers: one answer (or an interruption notice), never silence or duplicates.',
    expectedSafe: 'The CEO gets exactly one answer or notice after the restart.',
    script: {
      lead: [
        { text: 'Jawaban lambat sebelum restart', delayMs: 3000 },
        text('Jawaban setelah restart'),
      ],
    },
    steps: [
      say('ceo', 'general', 'Tolong jelaskan strategi kuartal ini', { noWait: true }),
      wait(700),
      act('restart the server mid-turn', (w) => w.restart()),
      wait(12000),
    ],
    timeoutMs: 90_000,
    hard: [C.posted('general', undefined, 'the CEO hears back after the restart'), C.maxPosts(2)],
    tags: ['restart'],
  },
  {
    id: 'F-04b',
    category: 'F',
    title: 'Server restarts after the model started streaming (assistant message exists)',
    goal: 'A restart once the turn has really begun: the CEO must still hear back (answer or interruption notice).',
    expectedSafe: 'The CEO gets one answer or notice after the restart.',
    script: {
      // the first step is persisted (the assistant message exists), the second one is slow: the
      // restart lands while the model is answering
      lead: [call('channel_status', {}), { text: 'Jawaban lambat sebelum restart', delayMs: 4000 }],
    },
    steps: [
      say('ceo', 'general', 'Tolong jelaskan strategi kuartal ini', { noWait: true }),
      act('restart once the assistant message exists', async (w) => {
        const q = w.server.conn.sqlite.query(
          `SELECT COUNT(*) n FROM eh_messages WHERE role = 'assistant'`,
        )
        const end = Date.now() + 30_000
        while (Date.now() < end && (q.get() as { n: number }).n === 0) await wait_(100)
        await w.restart()
      }),
      wait(15000),
    ],
    timeoutMs: 120_000,
    hard: [C.posted('general', undefined, 'the CEO hears back after the restart'), C.maxPosts(2)],
    tags: ['restart'],
  },
  {
    id: 'F-05',
    category: 'F',
    script: {},
    title: 'The bot token is revoked',
    goal: 'The connection goes to needs-auth, a bell rings, nothing crashes.',
    expectedSafe: 'Runtime state needs-auth and a notification.',
    steps: [act('revoke the token', (w) => w.fake.revoke()), wait(5000)],
    allowFailedOutbox: true,
    hard: [
      C.custom('the connection reports needs-auth', async ({ w }) => {
        const v = await w.api('GET', `/channels/connections/${w.connectionId}`)
        return v.json.runtime?.state === 'needs-auth'
          ? { ok: true }
          : { ok: false, detail: `state ${v.json.runtime?.state}` }
      }),
      C.custom('a notification was raised', ({ w }) =>
        w.server.deps.notifications.list({ open: true, limit: 20 }).length > 0
          ? { ok: true }
          : { ok: false, detail: 'no bell' },
      ),
    ],
    tags: ['auth'],
  },
  {
    id: 'F-06',
    category: 'F',
    script: {},
    title: 'Reminder fires into a closed topic',
    goal: 'TOPIC_CLOSED must not retry forever; the failure is visible.',
    expectedSafe: 'Bounded attempts, an error recorded on the reminder or the outbox.',
    steps: [
      act('make a reminder in clipper; its topic is closed', (w) => {
        w.server.channels.reminders.create({
          connectionId: w.connectionId,
          nodeId: w.nodes.clipper,
          agentId: w.agentIds.lead,
          text: 'Upload clip',
          mentions: [],
          when: { inMinutes: 1 },
        })
        w.fail('sendMessage', { error_code: 400, description: 'Bad Request: TOPIC_CLOSED' }, 50)
      }),
      fireReminders(),
      wait(4000),
    ],
    allowFailedOutbox: true,
    hard: [
      bounded('delivery attempts are bounded (<= 8)', 8),
      C.custom('the failure is visible (reminder error or failed outbox row)', ({ obs }) =>
        obs.reminders.some((r) => r.last_error) ||
        obs.outbox.some((o) => o.status === 'failed' || o.status === 'dead')
          ? { ok: true }
          : { ok: false, detail: 'no trace of the failed delivery' },
      ),
    ],
    tags: ['reminder', 'delivery'],
  },
  {
    id: 'F-07',
    category: 'F',
    script: {},
    title: 'The bot is removed from the group, then a reminder fires',
    goal: 'A kicked bot must not retry forever and must mark the place.',
    expectedSafe: 'Bounded attempts; failure visible.',
    steps: [
      rawUpdate('bot kicked from the group', () => ({
        my_chat_member: {
          chat: group,
          from: { id: 1002, is_bot: false, first_name: 'Andi' },
          date: Math.floor(Date.now() / 1000),
          old_chat_member: {
            status: 'administrator',
            user: { id: 777, is_bot: true, first_name: 'Bot' },
          },
          new_chat_member: { status: 'kicked', user: { id: 777, is_bot: true, first_name: 'Bot' } },
        },
      })),
      act('reminder + 403 Forbidden', (w) => {
        w.server.channels.reminders.create({
          connectionId: w.connectionId,
          nodeId: w.nodes.general,
          agentId: w.agentIds.lead,
          text: 'Rapat',
          mentions: [],
          when: { inMinutes: 1 },
        })
        w.fail(
          'sendMessage',
          { error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' },
          50,
        )
      }),
      fireReminders(),
      wait(4000),
    ],
    allowFailedOutbox: true,
    hard: [bounded('delivery attempts are bounded (<= 6)', 6)],
    tags: ['removed', 'delivery'],
  },
  {
    id: 'F-08',
    category: 'F',
    title: 'The topic was deleted: "message thread not found"',
    goal: 'A reply to a deleted topic is not retried forever.',
    expectedSafe: 'Bounded attempts.',
    script: { lead: [text('Balasan ke topik yang sudah dihapus.')] },
    steps: [
      act('inject thread-not-found', (w) =>
        w.fail(
          'sendMessage',
          { error_code: 400, description: 'Bad Request: message thread not found' },
          50,
        ),
      ),
      say('budi', 'produksi', 'Halo bot'),
      wait(4000),
    ],
    allowFailedOutbox: true,
    hard: [bounded('delivery attempts are bounded (<= 8)', 8)],
    tags: ['delivery'],
  },
  {
    id: 'F-09',
    category: 'F',
    title: 'A brand new topic (never seen) is addressed',
    goal: 'The topic is discovered on first message and the answer goes to that topic.',
    expectedSafe: 'The reply lands in topic 99.',
    script: { lead: [text('Halo dari topik baru.')] },
    steps: [say('ceo', 'topic:99', 'Halo bot, ini topik baru')],
    hard: [C.posted('topic:99'), C.onlyIn('topic:99')],
    tags: ['topics'],
  },
  {
    id: 'F-10',
    category: 'F',
    title: 'Approval pending in produksi; Budi writes again',
    goal: 'A new message while the turn is parked on an approval must not be swallowed.',
    expectedSafe: 'Budi gets an answer or a status; no tool runs.',
    script: {
      lead: [
        call('tracker_create_task', { project: 'web', title: 'Tertahan' }),
        text('Aku masih menunggu persetujuan admin untuk tugas tadi.'),
        text('Masih menunggu.'),
      ],
    },
    steps: [
      say('admin', 'produksi', 'Buat tugas Tertahan di Tracker'),
      say('budi', 'produksi', 'Eh bot, status tugas tadi gimana?'),
      wait(4000),
    ],
    hard: [
      C.trackerUnchanged(),
      C.posted('produksi', /menunggu|persetujuan|waiting/i, 'Budi hears that it is waiting'),
    ],
    tags: ['pending', 'approval'],
  },
  {
    id: 'F-11',
    category: 'F',
    title: 'Linked person is unlinked mid-conversation',
    goal: 'Removing a link takes effect at once.',
    expectedSafe: 'The second DM is not answered.',
    script: { lead: [text('Halo Bu Rini.'), text('seharusnya tidak dipanggil')] },
    steps: [
      dm('ceo', 'Halo'),
      act(
        'unlink the CEO account',
        async (w) =>
          void (await w.api('DELETE', `/channels/connections/${w.connectionId}/links/1001`)),
      ),
      act(
        'remove the directory entry',
        async (w) =>
          void (await w.api('DELETE', `/channels/connections/${w.connectionId}/people/1001/role`)),
      ),
      dm('ceo', 'Halo lagi, ada kabar?'),
    ],
    hard: [C.maxPosts(1)],
    tags: ['link', 'dm'],
  },
  {
    id: 'F-12',
    category: 'F',
    title: 'Admin is demoted to member between two requests',
    goal: 'A role change applies to the next turn (no stale cache in the session).',
    expectedSafe: 'First group reminder works, second is refused.',
    script: {
      lead: [
        call('reminder', { action: 'create', message: 'Rapat satu', inMinutes: 5 }),
        text('Sudah.'),
        call('reminder', { action: 'create', message: 'Rapat dua', inMinutes: 5 }, 'c2'),
        text('Tidak bisa.'),
      ],
    },
    steps: [
      say('admin', 'general', 'Ingatkan semua rapat 5 menit lagi'),
      act(
        'demote the admin',
        async (w) =>
          void (await w.api('PUT', `/channels/connections/${w.connectionId}/people/1002/role`, {
            role: 'member',
          })),
      ),
      say('admin', 'general', 'Ingatkan semua rapat lagi 5 menit'),
    ],
    hard: [C.reminders({ count: 1 })],
    tags: ['role', 'cache'],
  },
  {
    id: 'F-13',
    category: 'F',
    title: 'Guest is promoted to admin between two requests',
    goal: 'The new role works at once.',
    expectedSafe: 'First refused, second allowed.',
    script: {
      lead: [
        call('reminder', { action: 'create', message: 'Satu', inMinutes: 5 }),
        text('Tidak bisa.'),
        call('reminder', { action: 'create', message: 'Dua', inMinutes: 5 }, 'c2'),
        text('Sudah.'),
      ],
    },
    steps: [
      say('guest', 'general', 'Ingatkan semua rapat'),
      act(
        'promote the guest',
        async (w) =>
          void (await w.api('PUT', `/channels/connections/${w.connectionId}/people/1006/role`, {
            role: 'admin',
          })),
      ),
      say('guest', 'general', 'Ingatkan semua rapat, sekarang bisa?'),
    ],
    hard: [C.reminders({ count: 1 })],
    tags: ['role', 'cache'],
  },
  {
    id: 'F-14',
    category: 'F',
    title: 'Attachment cannot be downloaded',
    goal: 'A file Telegram no longer serves does not break the turn.',
    expectedSafe: 'The model still answers.',
    script: { lead: [text('Aku tidak bisa membuka file itu, bisa kirim ulang?')] },
    steps: [
      say('ceo', 'general', 'Ringkas file ini', {
        file: {
          name: 'hilang.pdf',
          mime: 'application/pdf',
          content: 'x',
          missing: true,
          caption: 'Ringkas file ini',
        },
      }),
    ],
    hard: [C.posted('general')],
    tags: ['files'],
  },
  {
    id: 'F-15',
    category: 'F',
    title: 'Sustained 500s open the breaker',
    goal: 'Repeated send failures trip the breaker and are audited.',
    expectedSafe: 'A breaker-opened event; no endless retries; the turn does not hang.',
    script: { lead: [text('a'), text('b'), text('c'), text('d'), text('e'), text('f')] },
    steps: [
      act('Telegram is down', (w) =>
        w.fail('sendMessage', { error_code: 500, description: 'Internal Server Error' }, 200),
      ),
      say('ceo', 'general', 'satu', { noWait: true }),
      say('ceo', 'general', 'dua', { noWait: true }),
      say('ceo', 'general', 'tiga', { noWait: true }),
      wait(25_000),
    ],
    allowFailedOutbox: true,
    timeoutMs: 120_000,
    hard: [bounded('sendMessage attempts are bounded (<= 40)', 40)],
    soft: [
      C.softCustom(
        'breaker opened',
        'Did the connection pause sending and tell the admins?',
        ({ obs }) =>
          obs.events.some((e) => e.type === 'gateway.breaker_opened')
            ? { ok: true }
            : { ok: false, detail: 'no breaker-opened event' },
      ),
    ],
    tags: ['breaker'],
  },
  {
    id: 'F-16',
    category: 'F',
    title: 'Owner changes the group policy to "never wake" mid-run',
    goal: 'Policy edits apply to the next message.',
    expectedSafe: 'The second mention is not answered.',
    script: { lead: [text('Jawaban pertama.'), text('seharusnya tidak dipanggil')] },
    steps: [
      say('ceo', 'general', 'satu'),
      act(
        'wake = never',
        async (w) =>
          void (await w.api(
            'PATCH',
            `/channels/connections/${w.connectionId}/chats/${w.nodes.hq}/policy`,
            { wake: 'never' },
          )),
      ),
      say('ceo', 'general', 'dua'),
    ],
    hard: [C.maxPosts(1)],
    tags: ['policy'],
  },
]
