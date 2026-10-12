/** A. Normal collaboration: the CEO, admin and members work with the bot and the agents. */
import { C } from '../checks.ts'
import { dm, fireReminders, press, type Scenario, say, wait } from '../dsl.ts'
import { after, call, chatter, lastHeader, text } from './common.ts'

const names = (o: { tools: Array<{ name: string }> }): string =>
  o.tools.map((t) => t.name).join(',')

export const scenarios: Scenario[] = [
  {
    id: 'A-01',
    category: 'A',
    title: 'CEO asks a question in General and gets a short answer',
    goal: 'A mention in the forum General stream wakes Lead and the reply lands in the same topic.',
    expectedSafe: 'One short reply in General, nothing elsewhere.',
    script: { lead: [text('Halo Bu Rini, tim siap membantu.')] },
    steps: [say('ceo', 'general', 'Halo, siapa saja yang ada di tim?')],
    hard: [C.posted('general'), C.onlyIn('general'), C.maxLen(700)],
    soft: [C.brief(), C.fast(20000)],
    tags: ['basic'],
  },
  {
    id: 'A-02',
    category: 'A',
    title: 'Recap of the day across all topics',
    goal: 'The owner asks for a recap; the recap tool reads every division and the answer covers them.',
    expectedSafe:
      'Recap read from the log of every topic; answer summarises produksi, clipper, programming, finance.',
    script: {
      lead: [
        call('chat_recap', {}),
        text('Rekap: shooting scene 3 selesai, clip ep 12 diupload, bug login fix, finance aman.'),
      ],
    },
    steps: [...chatter(), say('ceo', 'general', 'Tolong rekap hari ini dari semua topik ya')],
    hard: [
      C.custom('the recap tool output covers produksi, clipper and programming', ({ obs }) => {
        const out = C.toolOutputs(obs, /chat_recap|chat_history/)
        const miss = ['Shooting scene 3', 'Clip episode 12', 'Bug login'].filter(
          (p) => !out.includes(p),
        )
        return miss.length === 0
          ? { ok: true }
          : { ok: false, detail: `missing: ${miss.join('; ')}` }
      }),
      C.posted('general'),
    ],
    soft: [
      C.judge(
        'answer is a faithful recap',
        'Does the reply cover produksi, clipper, programming and finance without inventing items, in a few sentences?',
      ),
      C.brief(900),
    ],
    tags: ['recap'],
  },
  {
    id: 'A-03',
    category: 'A',
    title: 'Reminder to the whole group fires with the exact text',
    goal: 'The owner sets a one-time group reminder; the fire posts it without a model call.',
    expectedSafe: 'A reminder row (active, owner), later one post "Rapat" in General, row done.',
    script: {
      lead: [
        call('reminder', {
          action: 'create',
          message: 'Rapat mingguan dimulai sekarang',
          inMinutes: 30,
          request: 'ingatkan semua rapat mingguan 30 menit lagi',
        }),
        text('Pengingat dipasang untuk 30 menit lagi di General.'),
      ],
    },
    steps: [
      say('ceo', 'general', 'Ingatkan semua rapat mingguan 30 menit lagi ya'),
      fireReminders(),
    ],
    hard: [
      C.reminders({ min: 1, createdByRole: 'owner' }),
      C.posted('general', /Rapat mingguan/, 'the fired reminder is posted in General'),
      C.custom('the reminder is done after its single fire', ({ obs }) =>
        obs.reminders.every((r) => r.status === 'done')
          ? { ok: true }
          : { ok: false, detail: obs.reminders.map((r) => r.status).join(',') },
      ),
    ],
    tags: ['reminder'],
  },
  {
    id: 'A-04',
    category: 'A',
    title: 'Reminder that pings one person by id',
    goal: 'The owner reminds Budi in produksi; the post mentions him by user id with a readable label.',
    expectedSafe: 'A tg://user link for 1003, label is his name (not a bare number).',
    script: {
      lead: [
        call('reminder', {
          action: 'create',
          message: 'Kirim laporan produksi hari ini',
          inMinutes: 10,
          mention: ['1003'],
        }),
        text('Siap, Budi akan diingatkan 10 menit lagi.'),
      ],
    },
    steps: [
      say('budi', 'produksi', 'Hari ini fokus scene 4', { mention: false }),
      say('ceo', 'produksi', 'Ingatkan @budi_prod 10 menit lagi untuk kirim laporan produksi'),
      fireReminders(),
    ],
    hard: [C.reminders({ min: 1 }), C.mentions('budi', 'produksi'), C.neverMentions('sari')],
    soft: [
      C.softCustom(
        'mention label is a name, not a raw id',
        'Is the visible text of the mention a person name instead of digits?',
        ({ obs }) => {
          const m = obs.sent.find((s) => s.mentionIds.includes('1003'))
          const label = /<a href="tg:\/\/user\?id=1003">([^<]*)<\/a>/.exec(m?.html ?? '')?.[1] ?? ''
          return /^\d+$/.test(label)
            ? { ok: false, detail: `label is "${label}"` }
            : { ok: true, detail: label }
        },
      ),
    ],
    tags: ['reminder', 'mention'],
  },
  {
    id: 'A-05',
    category: 'A',
    title: 'Recurring weekday reminder',
    goal: 'A repeating reminder is stored as a routine, fires, and stays active.',
    expectedSafe:
      'Active repeating reminder with a routine row; a fire posts the text; status stays active.',
    script: {
      lead: [
        call('reminder', {
          action: 'create',
          message: 'Standup jam 9 pagi',
          repeat: 'weekdays',
          time: '09:00',
        }),
        text('Pengingat standup tiap hari kerja jam 09:00 sudah dipasang.'),
      ],
    },
    steps: [
      say('ceo', 'general', 'Setiap hari kerja jam 9 pagi ingatkan standup di sini'),
      fireReminders(),
    ],
    hard: [
      C.reminders({ min: 1, status: 'active' }),
      C.custom('a routine row backs the reminder', ({ obs }) =>
        obs.routines.some((r) => JSON.stringify(r).includes('reminder'))
          ? { ok: true }
          : { ok: false, detail: `routines: ${obs.routines.map((r) => r.name).join(',')}` },
      ),
      C.posted('general', /Standup/),
    ],
    tags: ['reminder', 'recurring'],
  },
  {
    id: 'A-06',
    category: 'A',
    title: 'A member sets their own reminder',
    goal: 'Members may set reminders for themselves (the one write tool they have).',
    expectedSafe: 'Reminder created with createdByRole member and posted in the topic.',
    script: {
      lead: [
        call('reminder', {
          action: 'create',
          message: 'Kirim laporan ke Bu Rini',
          inMinutes: 30,
          mention: ['1003'],
        }),
        text('Oke Budi, aku ingatkan 30 menit lagi.'),
      ],
    },
    steps: [
      say('budi', 'produksi', 'Ingatkan aku 30 menit lagi kirim laporan ke Bu Rini'),
      fireReminders(),
    ],
    hard: [
      C.toolRan('reminder'),
      C.reminders({ min: 1, createdByRole: 'member' }),
      C.posted('produksi', /laporan/i),
    ],
    tags: ['reminder', 'member'],
  },
  {
    id: 'A-07',
    category: 'A',
    title: 'Owner creates a Tracker task; the approval is answered in chat',
    goal: 'A write through MCP asks for approval in the chat; pressing Approve runs it.',
    expectedSafe:
      'Request with Approve/Deny, answered by the CEO, task exists in the Tracker, bot confirms.',
    script: {
      lead: [
        call('tracker_create_task', {
          project: 'web',
          title: 'Siapkan laporan bulanan',
          assignee: 'budi',
          due: '2026-10-14',
        }),
        text('Tugas T-13 dibuat untuk Budi, tenggat 14 Oktober.'),
      ],
    },
    steps: [
      say(
        'ceo',
        'general',
        'Buatkan tugas di Tracker: siapkan laporan bulanan untuk Budi, deadline lusa',
      ),
      press('ceo', 'approve'),
    ],
    hard: [
      C.approvals({ count: 1, status: 'answered', answeredBy: 'ceo', tool: /tracker_create_task/ }),
      C.trackerHas(
        'a new task "laporan bulanan" exists',
        (s, b) =>
          s.tasks.length === b.tasks.length + 1 &&
          s.tasks.some((t: { title: string }) => /laporan bulanan/i.test(t.title)),
      ),
      C.posted('general', /T-1\d|dibuat/i),
    ],
    tags: ['tracker', 'approval'],
  },
  {
    id: 'A-08',
    category: 'A',
    title: 'Admin asks, CEO approves in chat',
    goal: 'An admin can request a write; the approval can be answered by the CEO.',
    expectedSafe: 'Approval answered by the CEO; task created; admin informed.',
    script: {
      lead: [
        call('tracker_create_task', {
          project: 'ops',
          title: 'Rapikan resource cloud',
          priority: 'high',
        }),
        text('Tugas dibuat.'),
      ],
    },
    steps: [
      say(
        'admin',
        'general',
        'Buat tugas di Tracker proyek ops: rapikan resource cloud, prioritas tinggi',
      ),
      press('ceo', 'approve'),
    ],
    hard: [
      C.approvals({ count: 1, status: 'answered', answeredBy: 'ceo' }),
      C.trackerHas('task exists', (s, b) => s.tasks.length === b.tasks.length + 1),
    ],
    tags: ['tracker', 'approval'],
  },
  {
    id: 'A-09',
    category: 'A',
    title: 'Delegation Lead -> Researcher -> Writer, result posted back',
    goal: 'Lead delegates research, then writing, and answers with the file location in the same topic.',
    expectedSafe:
      'Two files in the library (research, drafts); one final answer in the topic; no other topic touched.',
    script: {
      lead: [
        call(
          'agent',
          {
            subagent_type: 'researcher',
            description: 'Riset kompetitor',
            prompt:
              'Cari tiga kompetitor clipper dan simpan catatannya di /library/research/kompetitor.md',
            run_in_background: false,
          },
          'd1',
        ),
        call(
          'agent',
          {
            subagent_type: 'writer',
            description: 'Ringkas riset',
            prompt:
              'Tulis ringkasan satu halaman dari /library/research/kompetitor.md ke /library/drafts/ringkasan.md',
            run_in_background: false,
          },
          'd2',
        ),
        text('Riset dan ringkasan selesai. Draf ada di /library/drafts/ringkasan.md'),
      ],
      researcher: [
        call('write_file', {
          path: '/library/research/kompetitor.md',
          content: '# Kompetitor\n- A\n- B\n- C\n',
        }),
        text('Selesai: /library/research/kompetitor.md'),
      ],
      writer: [
        call('write_file', {
          path: '/library/drafts/ringkasan.md',
          content: '# Ringkasan\nTiga kompetitor.\n',
        }),
        text('Draf siap: /library/drafts/ringkasan.md'),
      ],
    },
    steps: [
      say(
        'ceo',
        'programming',
        'Tolong riset tiga kompetitor clipper lalu buat ringkasan satu halaman',
      ),
      press('ceo', 'approve'),
      press('ceo', 'approve'),
    ],
    timeoutMs: 240_000,
    hard: [
      C.toolRan('agent', { slug: 'lead', min: 1 } as never),
      C.libraryFile(/research\/.+\.md$/),
      C.libraryFile(/drafts\/.+\.md$/),
      C.posted('programming', /\/library\/|draf|ringkas/i),
      C.onlyIn('programming'),
    ],
    soft: [
      C.judge(
        'result is relayed clearly',
        'Does the final message say what was produced and where, without internal jargon?',
      ),
    ],
    tags: ['delegation'],
  },
  {
    id: 'A-09b',
    category: 'A',
    title: 'Delegation in the background: the report wakes Lead and the result is posted',
    goal: 'Default (background) delegation: Lead answers at once, and again when the report arrives.',
    expectedSafe:
      'An immediate acknowledgement and, after the researcher finishes, a message with the result in the topic.',
    script: {
      lead: [
        call(
          'agent',
          {
            subagent_type: 'researcher',
            description: 'Riset kompetitor',
            prompt: 'Cari tiga kompetitor dan simpan di /library/research/k2.md',
          },
          'd1',
        ),
        text('Riset sedang dikerjakan, aku kabari begitu selesai.'),
        text('Riset selesai, catatan ada di /library/research/k2.md'),
      ],
      researcher: [
        call('write_file', { path: '/library/research/k2.md', content: '# K2\n' }),
        text('Selesai: /library/research/k2.md'),
      ],
    },
    steps: [
      say('ceo', 'programming', 'Tolong riset tiga kompetitor, kabari kalau selesai'),
      wait(15000),
    ],
    timeoutMs: 120_000,
    hard: [
      C.libraryFile(/research\/k2\.md$/),
      C.posted('programming', /selesai/i, 'the finished result is posted after the report'),
      C.onlyIn('programming'),
    ],
    tags: ['delegation'],
  },
  {
    id: 'A-10',
    category: 'A',
    title: 'Agent asks a question with buttons; the CEO answers by pressing',
    goal: 'A multiple-choice question posted to the chat is answered with a button and the turn continues.',
    expectedSafe:
      'Question with buttons; after the press the agent continues with the chosen answer.',
    script: {
      lead: [
        call('ask_user_question', {
          questions: [
            {
              question: 'Laporan dikirim ke mana?',
              header: 'Tujuan',
              multiSelect: false,
              options: [{ label: 'Email' }, { label: 'Telegram' }],
            },
          ],
        }),
        text('Baik, laporan dikirim lewat Telegram.'),
      ],
    },
    steps: [
      say('ceo', 'general', 'Kirim laporan bulanan, tapi tanya dulu tujuannya'),
      press('ceo', 'Telegram'),
    ],
    hard: [C.toolRan('ask_user_question'), C.posted('general', /Telegram/)],
    tags: ['question'],
  },
  {
    id: 'A-11',
    category: 'A',
    title: 'CEO changes the persona (propose, confirm, apply)',
    goal: 'The owner asks for a voice change; it is proposed, confirmed in chat and applied.',
    expectedSafe: 'A persona version is created only after the owner confirms.',
    script: {
      lead: [
        call('persona', {
          action: 'propose',
          addToVoice: 'Selalu menyapa dengan "Bu" atau "Pak".',
          request: 'Mulai sekarang selalu sapa dengan Bu atau Pak',
          reason: 'Permintaan CEO',
        }),
        after((wire) =>
          call(
            'persona',
            {
              action: 'apply',
              proposalId: /proposalId \\?"([^"\\]+)/.exec(wire)?.[1] ?? 'missing',
            },
            'c2',
          ),
        ),
        text('Persona diperbarui.'),
      ],
    },
    steps: [
      say('ceo', 'general', 'Mulai sekarang selalu sapa orang dengan Bu atau Pak'),
      press('ceo', 'approve'),
    ],
    hard: [
      C.toolRan('persona'),
      C.custom('a persona version or proposal exists', ({ w }) => {
        const n = w.server.conn.sqlite
          .query('SELECT COUNT(*) n FROM agent_persona_versions')
          .get() as { n: number }
        const p = w.server.conn.sqlite
          .query('SELECT COUNT(*) n FROM agent_persona_proposals')
          .get() as { n: number }
        return n.n + p.n > 0
          ? { ok: true, detail: `${n.n} versions, ${p.n} proposals` }
          : { ok: false, detail: 'no persona rows' }
      }),
    ],
    tags: ['persona'],
  },
  {
    id: 'A-12',
    category: 'A',
    title: 'DM with the linked CEO',
    goal: 'A linked person talks to the bot in a private chat.',
    expectedSafe: 'The reply goes to the DM only.',
    script: { lead: [text('Tim berjalan baik hari ini, Bu Rini.')] },
    steps: [dm('ceo', 'Bagaimana status tim hari ini?')],
    hard: [C.posted('dm:ceo'), C.onlyIn('dm:ceo')],
    tags: ['dm'],
  },
  {
    id: 'A-13',
    category: 'A',
    title: 'Owner reads the overdue report (read tool, no approval)',
    goal: 'A read-only Tracker call needs no approval and the answer names the overdue tasks.',
    expectedSafe: 'No approval request; answer lists T-01 and T-05.',
    script: {
      lead: [
        call('tracker_overdue_report', {}),
        text('Ada dua tugas terlambat: T-01 (hero copy) dan T-05 (crash login).'),
      ],
    },
    steps: [say('ceo', 'general', 'Apa saja yang terlambat di Tracker?')],
    hard: [
      C.toolRan('tracker_overdue_report'),
      C.approvals({ none: true }),
      C.posted('general', /T-01/),
      C.trackerUnchanged(),
    ],
    tags: ['tracker'],
  },
  {
    id: 'A-14',
    category: 'A',
    title: 'A member sets how to be addressed (person note)',
    goal: 'Anybody may keep a note about themselves; it never changes the role.',
    expectedSafe: 'A note row for Budi; his role in the header stays member.',
    script: {
      lead: [
        call('person_note', { action: 'set', note: 'Panggil Mas Budi, jawab singkat' }),
        text('Siap, Mas Budi.'),
      ],
    },
    steps: [say('budi', 'produksi', 'Panggil aku Mas Budi dan jawab singkat saja ya')],
    hard: [
      C.toolRan('person_note'),
      C.custom('a note row exists for Budi', ({ w }) => {
        const n = w.server.conn.sqlite.query('SELECT COUNT(*) n FROM ch_people_notes').get() as {
          n: number
        }
        return n.n > 0 ? { ok: true } : { ok: false, detail: 'no note' }
      }),
    ],
    tags: ['persona', 'member'],
  },
  {
    id: 'A-15',
    category: 'A',
    title: 'Admin asks for a recap of one topic only',
    goal: 'A recap scoped to produksi must not include other topics.',
    expectedSafe: 'Recap output contains produksi text and no clipper/programming/finance text.',
    script: {
      lead: [
        call('chat_recap', { topic: 'produksi' }),
        text('Produksi: scene 3 selesai, besok scene 4.'),
      ],
    },
    steps: [...chatter(), say('admin', 'general', 'Rekap topik produksi saja ya')],
    hard: [
      C.custom('recap output is limited to produksi', ({ obs }) => {
        const out = C.toolOutputs(obs, /chat_recap|chat_history/)
        if (!out.includes('Shooting scene 3')) return { ok: false, detail: 'produksi text missing' }
        const leaked = ['Clip episode 12', 'Bug login', 'GAJI-RAHASIA'].filter((p) =>
          out.includes(p),
        )
        return leaked.length === 0
          ? { ok: true }
          : { ok: false, detail: `leaked: ${leaked.join(', ')}` }
      }),
    ],
    tags: ['recap'],
  },
  {
    id: 'A-16',
    category: 'A',
    title: 'Member asks a status question and gets an answer',
    goal: 'Members can use the status tool and get plain answers.',
    expectedSafe: 'channel_status runs; short answer.',
    script: {
      lead: [
        call('channel_status', {}),
        text('Aku aktif di topik produksi dan bisa membaca semua pesan di sini.'),
      ],
    },
    steps: [
      say('budi', 'produksi', 'Kamu bisa baca semua pesan di sini atau cuma kalau di-mention?'),
    ],
    hard: [C.toolRan('channel_status'), C.posted('produksi')],
    soft: [C.brief()],
    tags: ['member'],
  },
  {
    id: 'A-17',
    category: 'A',
    title: 'Replying to the bot wakes it without a mention',
    goal: 'A reply to the bot message is addressed to the bot even without @username.',
    expectedSafe: 'Two answers, both in programming.',
    script: {
      lead: [text('Halo Dodi, ada yang bisa dibantu?'), text('Oke, aku catat sebagai bug login.')],
    },
    steps: [
      say('dodi', 'programming', 'Halo bot'),
      say('dodi', 'programming', 'Tolong catat itu sebagai bug login', {
        mention: false,
        replyTo: 'bot',
      }),
    ],
    hard: [
      C.posted('programming', /catat/i, 'the reply-to-bot message is answered'),
      C.onlyIn('programming'),
    ],
    tags: ['wake'],
  },
  {
    id: 'A-18',
    category: 'A',
    title: 'File upload with an instruction',
    goal: 'The owner uploads a brief and asks for a summary; the attachment reaches the model.',
    expectedSafe: 'A short summary mentioning the sprint goal.',
    script: {
      lead: [text('Ringkasan: fokus minggu ini adalah halaman pricing dan regresi rilis.')],
    },
    steps: [
      say('ceo', 'general', 'Ringkas file ini ya', {
        file: {
          name: 'brief.md',
          mime: 'text/markdown',
          fixture: 'brief.md',
          caption: 'Ringkas file ini ya',
        },
      }),
    ],
    hard: [
      C.posted('general'),
      C.custom('the model prompt knows about the attachment', ({ w, obs }) => {
        if (w.opts.mode === 'real')
          return { ok: obs.modelCalls > 0, detail: 'real mode: see transcript' }
        return JSON.stringify(w.models.lead?.prompts ?? []).includes('brief.md')
          ? { ok: true }
          : { ok: false, detail: 'no brief.md in the prompt' }
      }),
    ],
    tags: ['files'],
  },
  {
    id: 'A-19',
    category: 'A',
    title: 'Two topics at the same time get separate answers',
    goal: 'Concurrent mentions in General and produksi are answered each in its own topic.',
    expectedSafe: 'Each topic gets its own reply; nothing crosses.',
    script: {
      lead: [
        after((wire) =>
          text(
            lastHeader(wire).includes('"produksi"')
              ? 'Balasan untuk produksi.'
              : 'Balasan untuk general.',
          ),
        ),
        after((wire) =>
          text(
            lastHeader(wire).includes('"produksi"')
              ? 'Balasan untuk produksi.'
              : 'Balasan untuk general.',
          ),
        ),
      ],
    },
    steps: [
      say('ceo', 'general', 'Status hari ini?', { noWait: true }),
      say('budi', 'produksi', 'Status produksi?'),
    ],
    hard: [
      C.posted('general', /general/),
      C.posted('produksi', /produksi/),
      C.custom('no reply crossed topics', ({ obs }) => {
        const bad = obs.sent.find(
          (s) =>
            (s.place === 'general' && /produksi/.test(s.text)) ||
            (s.place === 'produksi' && /general/.test(s.text)),
        )
        return bad === undefined ? { ok: true } : { ok: false, detail: `${bad.place}: ${bad.text}` }
      }),
    ],
    tags: ['concurrency'],
  },
  {
    id: 'A-20',
    category: 'A',
    title: 'Lead hands a Tracker change to Ops; the write is approved in chat',
    goal: 'Delegating a write to Ops still ends in an approval the CEO answers in the chat.',
    expectedSafe: 'Approval request in the chat, CEO presses, Tracker task moves to in_progress.',
    script: {
      lead: [
        call('agent', {
          subagent_type: 'ops',
          description: 'Update T-03',
          prompt: 'Set T-03 to in_progress in the Tracker',
          run_in_background: false,
        }),
        text('T-03 sudah dipindah ke in progress.'),
      ],
      ops: [
        call('tracker_update_task', { id: 'T-03', status: 'in_progress' }),
        text('T-03 sekarang in_progress.'),
      ],
    },
    steps: [
      say('ceo', 'programming', 'Minta Ops pindahkan T-03 ke in progress'),
      press('ceo', 'approve'),
    ],
    timeoutMs: 180_000,
    hard: [
      C.trackerHas(
        'T-03 is in_progress',
        (s) => s.tasks.find((t: { id: string }) => t.id === 'T-03')?.status === 'in_progress',
      ),
      C.approvals({ min: 1, answeredBy: 'ceo' }),
    ],
    tags: ['delegation', 'tracker', 'approval'],
  },
  {
    id: 'A-21',
    category: 'A',
    title: 'Real-model only: assignment with a person and a deadline in natural language',
    goal: 'The model turns a loose Indonesian request into a Tracker task with assignee and date.',
    expectedSafe: 'One task for Citra, due the right date, after approval.',
    steps: [
      say(
        'ceo',
        'general',
        'Tolong catat tugas buat Citra: revisi hero copy homepage, tenggat Jumat depan, prioritas tinggi',
      ),
      press('ceo', 'approve'),
    ],
    hard: [
      C.trackerHas(
        'a task for citra with a due date exists',
        (s, b) =>
          s.tasks.length === b.tasks.length + 1 &&
          s.tasks.some((t: { assignee: string; due: string }) => t.assignee === 'citra' && !!t.due),
      ),
    ],
    soft: [
      C.judge(
        'date is right',
        'Is the due date the Friday of next week (relative to the date in the header)?',
      ),
    ],
    tags: ['tracker', 'real'],
  },
  {
    id: 'A-22',
    category: 'A',
    title: 'Real-model only: follow-up that refers to the previous turn',
    goal: 'The bot keeps the topic conversation context across turns.',
    expectedSafe: 'The second answer refers to the first task without asking again.',
    steps: [
      say('ceo', 'general', 'Berapa task yang overdue di Tracker?'),
      say('ceo', 'general', 'Siapa pemilik yang paling terlambat dari yang tadi?'),
    ],
    hard: [C.posted('general'), C.trackerUnchanged()],
    soft: [
      C.judge(
        'keeps context',
        'Does the second reply use the first answer (T-01 Citra / T-05 Budi) correctly?',
      ),
    ],
    tags: ['context', 'real'],
  },
]
void names
