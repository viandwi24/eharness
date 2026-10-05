# Usulan pembaruan eharness (target 0.4.0)

> Untuk: agent/pengembang yang mengerjakan repo **eharness** (`/Users/solpochi/Projects/oss/eharness`, `github.com/viandwi24/eharness`).
> Dari: BTeams (pengguna produksi pertama). Dibuat 2026-10-05. Latar belakang: `docs/reviews/2026-10-05-agent-architecture-review.md` §10.
>
> **Prinsip dokumen ini:**
> - Semua usulan **generik** untuk banyak proyek (chat app, bot messaging, worker latar, pipeline). Tidak ada logika khusus BTeams (identitas,
>   RBAC, Telegram, namespace memori produk), karena semua itu tetap di aplikasi.
> - Setiap item mengikuti aturan repo eharness:
>   - spec = kontrak: perbarui `docs/specs/*` di PR yang sama, dan ADR bila keputusan berubah;
>   - library hanya mengirim adapter **memori**, adapter DB ada di `examples/` (ADR-0008);
>   - plugin bawaan mengimpor core hanya lewat `src/index.ts`;
>   - tool mengembalikan string galat, tidak melempar;
>   - tanpa dependency runtime baru tanpa ADR;
>   - konteks yang berubah-ubah lewat reminder, bukan `instructions`; urutan tool stabil (ADR-0013);
>   - compaction tetap, storage yang bisa diganti (ADR-0004);
>   - tidak ada yang disimpan sebelum titik commit giliran;
>   - changeset untuk perubahan `src/`;
>   - test, guide, dan contoh offline untuk fitur yang terlihat pengguna (`CONTRIBUTING.md`).
> - Semua perubahan **kompatibel ke belakang** (minor 0.4.0). Tanpa konfigurasi baru, perilaku 0.3.x tidak berubah.
> - Sketsa API di bawah adalah **usulan**. Pengerjaan eharness boleh mengubah bentuknya selama semantiknya sama, lalu mencatatnya di
>   bagian "Hasil" setiap item.

## Ringkasan

| # | Fitur | Item roadmap eharness | Prioritas |
|---|---|---|---|
| U1 | Hook `compaction.before` + giliran *flush* sebelum meringkas | baru | tinggi |
| U2 | Prune stage: pangkas output tool lama sebelum meringkas | "Prune stage" | tinggi |
| U3 | Port inbox durable: queue / steer / wake / collect **lintas proses** | "Cross-process queue / wake" | tinggi |
| U4 | Abort lintas proses | baru (melengkapi U3) | tinggi |
| U5 | Memory plugin di atas FileSystem (kontrak setara memory tool) | "Memory plugin" | tinggi |
| U6 | Output akhir terstruktur (skema + validasi + retry) | "Output guardrails" | sedang |
| U7 | Versi skill di `SkillMeta` | baru (kecil) | rendah |
| U8 | Deteksi compaction berulang (*thrash*) | "Compaction thrash detection" | rendah |
| U9 | Guide pola produksi (konteks efemeral, episodik, multi-instance) | dokumentasi | sedang |

---

## U1 — Hook `compaction.before` dan giliran flush

**Masalah:** setelah riwayat diringkas, fakta penting (preferensi pengguna, keputusan, nomor pesanan) bisa hilang, karena ringkasan bersifat
lossy. Pola produksi (OpenClaw "memory flush", Anthropic compaction + memory tool) memberi agent **satu kesempatan menyimpan fakta ke memori
sebelum** meringkas.

**Sketsa API** (`src/plugin/types.ts`, spec 01 §5, spec 06 §5.3):

```ts
'compaction.before'?(
  ctx: HarnessContext<DP>,
  e: {
    messages: HarnessUIMessage[]        // bagian yang akan diringkas (bukan ekor keepLast)
    tokens: number                      // perkiraan token konteks saat ini
    trigger: 'auto' | 'manual' | 'overflow'
  },
): void | Promise<void | CompactionBeforePatch>

type CompactionBeforePatch = {
  /** jalankan satu giliran internal sebelum meringkas */
  flush?: {
    prompt: string                      // mis. "Simpan fakta penting yang perlu diingat ke memori sebelum riwayat diringkas."
    tools?: string[]                    // whitelist tool yang boleh dipakai (mis. tool memori); default: tidak ada tool
    maxSteps?: number                   // default 3
    model?: ModelRef                    // default: compaction.model ?? model agent
  }
}
```

**Semantik:**
- Dijalankan sekali per compaction, setelah keputusan meringkas dan sebelum memanggil summarizer. Untuk `trigger: 'overflow'`, flush dilewati
  (konteks sudah penuh) kecuali `flush.model` punya jendela lebih besar.
- Giliran flush **tidak menambah pesan percakapan yang terlihat**. Pesannya tidak disimpan ke riwayat. Efeknya hanya hasil tool, misalnya file
  memori. Pemakaian token/biaya dihitung ke budget sesi (`turn.addUsage`).
- Galat flush → `W_HOOK_FAILED`, lalu compaction tetap berjalan (tidak fatal).
- Beberapa plugin: hook dirantai; flush digabung (prompt disambung, whitelist tool digabung).

**Selesai bila:**
- Test: flush dipanggil dengan pesan yang benar; tool di luar whitelist ditolak; galat tidak menggagalkan compaction; budget bertambah.
- Spec 01/06 diperbarui, ADR kecil ("pre-compaction flush"), dan guide + contoh offline (`examples/compaction-flush.ts`).

---

## U2 — Prune stage

**Masalah:** output tool lama (hasil pencarian, isi file, JSON API) menghabiskan konteks. Memangkasnya lebih murah daripada meringkas dan
menjaga prompt cache (pola opencode, Anthropic `clear_tool_uses`).

**Sketsa API** (`CompactionConfig`, spec 06 §5, ADR-0004 tetap berlaku: ini **setelan**, bukan strategi baru):

```ts
compaction: {
  prune?: {
    /** pangkas output tool yang lebih tua dari N giliran terakhir (default 2) */
    keepTurns?: number
    /** hanya pangkas output yang lebih panjang dari ini (char, default 2000) */
    minChars?: number
    /** tool yang tidak pernah dipangkas */
    exclude?: string[]
    /** isi pengganti; default: placeholder pendek berisi nama tool + ukuran asli */
    replaceWith?: (part: ToolResultPart) => string
  } | false
}
```

**Semantik:**
- Prune berlaku pada **tampilan ke model** (dan transkrip summarizer). Riwayat tersimpan **tidak diubah**.
- Urutan per langkah: prune → bila masih ≥ `summarizeAt`, baru summarize.
- Pemangkasan harus deterministik dan stabil antar langkah, supaya awalan prompt tetap sama (ramah cache).
- Pasangan tool-call/tool-result tidak pernah dipisah.

**Selesai bila:** test (deterministik, cache-stable, exclude dihormati, summarize tidak terpicu bila prune cukup), spec 06 diperbarui, contoh offline.

---

## U3 — Port inbox durable (queue / steer / wake / collect lintas proses)

**Masalah:** `ifBusy: 'queue' | 'steer'` dan `inject(..., { wake })` hanya bekerja di **proses yang memegang sesi** (spec 11 §6.2–6.3). Aplikasi
multi-instance (beberapa container) harus membangun antrean sendiri, sehingga pesan susulan ditolak (`EH_SESSION_BUSY`) atau hilang saat restart.

**Sketsa API** (port opsional baru di samping `MessageAdapter`/`StateAdapter`, spec 05 + spec 11):

```ts
interface InboxAdapter {
  /** simpan item untuk sesi; kembalikan id. Harus durable sebelum resolve. */
  enqueue(sessionId: string, item: InboxItem): Promise<string>
  /** ambil item siap proses untuk sesi ini secara atomik (pemilik = proses pemegang lock) */
  claim(sessionId: string, owner: string, opts?: { limit?: number }): Promise<InboxItem[]>
  ack(ids: string[]): Promise<void>
  /** kembalikan ke antrean (mis. pemilik mati) */
  release(ids: string[]): Promise<void>
  /** opsional: beri tahu proses pemegang sesi agar segera menguras (LISTEN/NOTIFY, pub/sub); tanpa ini → polling */
  notify?(sessionId: string): Promise<void>
}

type InboxItem =
  | { kind: 'send'; mode: 'queue' | 'steer' | 'collect'; input: SendInput; at: number }
  | { kind: 'wake'; at: number }                       // dari inject(..., { wake: true }) di proses lain
  | { kind: 'abort'; reason?: string; at: number }     // U4
```

```ts
defineHarnessAgent({ storage: { messages, state, lock, inbox } })   // inbox opsional
send(input, { ifBusy: 'queue' | 'steer' | 'collect', collect?: { quietMs?: number; maxWaitMs?: number; maxItems?: number } })
```

**Semantik:**
- **Tanpa `inbox`**, perilaku 0.3 tetap: antrean di memori.
- **Dengan `inbox`:**
  - `send` di proses yang **tidak** memegang sesi tidak lagi `EH_SESSION_BUSY` bila `ifBusy` ≠ `reject`, melainkan `enqueue`.
  - Proses pemegang sesi menguras inbox: `steer` di batas langkah berikutnya, `queue` sebagai giliran baru setelah giliran berjalan, dan `wake`
    memulai giliran bila sesi diam.
  - Bila tidak ada yang memegang sesi, proses mana pun yang `claim` duluan menjalankannya.
- **`collect`** (debounce): pesan beruntun digabung menjadi satu giliran setelah `quietMs` tanpa pesan baru, atau setelah `maxWaitMs`, atau
  setelah `maxItems`. Ini pola umum chat (WhatsApp/Telegram/CS) yang sekarang dibangun ulang oleh setiap aplikasi.
- **Pengiriman at-least-once:** item yang di-claim lalu proses mati dikembalikan setelah `recovery.staleMs`. Dedupe memakai id item yang
  dicatat di pesan (`deliveredIn`).
- Event `session.events()` mendapat `inbox-enqueued` dan `inbox-drained`.
- Library hanya mengirim **adapter memori** + **conformance suite** (`eharness/testing`), dan contoh Postgres (`FOR UPDATE SKIP LOCKED` +
  `LISTEN/NOTIFY`) di `examples/`.

**Selesai bila:**
- Conformance suite untuk `InboxAdapter`.
- Test multi-proses simulasi (dua instance agent berbagi adapter memori): steer, queue, wake, dan collect bekerja; restart di tengah tidak
  menghilangkan item.
- Spec 05/11 + ADR "durable inbox port", guide "multi-instance deployment", dan contoh offline.

---

## U4 — Abort lintas proses

**Masalah:** `session.abort()` / `run.abort()` hanya berlaku di proses yang menjalankan giliran. Tombol "Stop" di UI yang mengenai instance lain
tidak berpengaruh.

**Sketsa API:**
- `session.abort(reason?)` dari proses mana pun menulis permintaan abort lewat `InboxAdapter` (`{ kind: 'abort' }`) **atau**, tanpa inbox, lewat
  `StateAdapter` (`core.abortRequestedAt`, ditulis memakai `setIf`).
- Proses pemegang sesi memeriksanya di setiap batas langkah dan saat heartbeat recovery, lalu berhenti dengan `stop: 'aborted'` (perilaku sama
  dengan abort lokal).

**Selesai bila:** test (abort dari "proses" lain menghentikan giliran di langkah berikutnya, tanpa inbox maupun dengan inbox), spec 05/11 diperbarui.

---

## U5 — Memory plugin (`eharness/memory`)

**Masalah:** setiap aplikasi agent membangun memori jangka panjang sendiri. Pola paling portabel saat ini adalah **memori berbasis file**
(Anthropic memory tool, OpenClaw `MEMORY.md`/`USER.md`, Deep Agents `/memories/`), yang aman dipetakan ke storage apa pun.

**Sketsa API** (subpath baru `src/memory/`, `requires: ['fs']`, impor core hanya lewat `src/index.ts`):

```ts
import { memory } from 'eharness/memory'

memory({
  /** root yang boleh dibaca/ditulis; resolver per konteks → aplikasi menentukan namespace (per user, per kontak, pribadi agent, org) */
  roots: (ctx) => [{ path: '/memories/user/', write: true }, { path: '/memories/org/', write: false }],
  /** file yang selalu dimuat ringkas tiap giliran sebagai reminder (refresh: 'turn'), mis. profil lawan bicara */
  pinned?: (ctx) => string[]            // path; dipotong ke maxPinnedChars
  maxPinnedChars?: number               // default 2000
  maxFileChars?: number                 // default 20000
  /** teks protokol (default mirip memory tool: "periksa memori dulu, simpan progres, anggap bisa terputus") */
  protocol?: string | false
  /** pakai tool memori bawaan provider (mis. Anthropic memory_20250818) bila tersedia */
  providerTool?: boolean
})
```

**Tool** (kontrak setara Anthropic memory tool, mengembalikan string galat): `memory_view` (daftar/isi), `memory_create`, `memory_str_replace`,
`memory_insert`, `memory_delete`, `memory_rename`.

**Semantik:**
- Validasi path (tanpa traversal, harus di bawah root yang diizinkan, root read-only ditolak tulis) dan batas ukuran.
- Konkurensi memakai `ifVersion` dari FileSystem.
- Untuk `rename`, kontrak `FileSystem` mendapat metode opsional **`move(from, to, { ifVersion })`**. Fallback-nya `read` + `write` + `delete`.
- Plugin **tidak** memutuskan siapa boleh membaca memori siapa; itu urusan aplikasi lewat `roots`. Plugin tidak menyimpan apa pun di luar FileSystem.
- Hook opsional `memory.write({ path, op, before, after })` untuk aplikasi yang ingin audit/provenance (dirantai, galat → `W_HOOK_FAILED`).

**Selesai bila:**
- Test tool (semua operasi, path traversal, root read-only, batas ukuran, ifVersion), `fileSystemConformance` untuk `move`.
- Spec baru `14-memory-plugin.md`, guide (pola namespace per pengguna + profil ter-pin), contoh offline dengan `memoryFs`.

---

## U6 — Output akhir terstruktur (Output guardrails)

**Masalah:** agent yang dipakai sebagai langkah pipeline/worker perlu hasil **bertipe**, bukan teks bebas. Sekarang `Output.object` AI SDK tidak
diteruskan dan `TurnResult` tidak punya output bertipe.

**Sketsa API** (di atas `turn.beforeEnd`, spec 01/03/11):

```ts
const run = session.send(input, {
  output: {
    schema: z.object({ label: z.enum(['signal', 'other']), confidence: z.number() }),  // Standard Schema
    mode?: 'tool' | 'native'          // 'tool' (default): tool final_answer bawaan; 'native': Output.object provider bila didukung
    maxRetries?: number               // default 2: bila tidak valid / tidak dipanggil → umpan balik lalu lanjut
  },
})
const result = await run.result      // result.output: z.infer<typeof schema> | undefined; result.stop menjelaskan bila gagal
```

**Semantik:**
- Mode `tool` menambahkan tool `final_answer` (urutan tool tetap stabil: ditambah di akhir hanya untuk giliran itu, sesuai ADR-0013).
- Validasi lewat schema. Bila gagal → umpan balik ke model (`turn.beforeEnd { continue }`) sampai `maxRetries`, lalu
  `stop: 'output-invalid'` (stop reason baru, spec 10).
- Output disimpan sebagai data part `data-eh.output` supaya bisa diaudit.

**Selesai bila:** test (valid, retry lalu valid, gagal setelah retry, mode native bila tersedia), spec + guide + contoh offline.

---

## U7 — Versi skill

`SkillMeta.version?: string` (dari frontmatter `version:`) ditampilkan di `load_skill` dan diteruskan ke hook `skill.load`. Dengan ini aplikasi
yang menyimpan skill berversi (DB) bisa mengaudit versi yang dipakai di setiap giliran. Kecil, tanpa ADR. Perbarui spec 07.

## U8 — Deteksi compaction berulang

Item roadmap "Compaction thrash detection": bila konteks penuh lagi dalam ≤ 2 langkah setelah compaction, giliran berhenti dengan stop reason
yang jelas (`'context-thrash'`) dan peringatan, alih-alih meringkas terus. Perbarui spec 06/10.

## U9 — Guide pola produksi (dokumentasi)

Fitur berikut **sudah ada** tetapi tidak terlihat oleh pengguna library. Tambahkan `docs/guides/production-patterns.md`:

1. **Konteks efemeral**: instruksi `refresh: 'turn'` dan `step.prepare → { reminder }` untuk konteks grup, data live, dan memori hasil
   retrieval. Peringatan bahwa `input.submit { context }` dan `step.end { context }` **disimpan**.
2. **Memori episodik** dari `compaction.after({ marker })` (`CompactionPayload.summary`).
3. **Event latar** dengan `inject(kind, data, { deliver, wake })` + `messageKinds` (hasil job, pesan antar agent, pengingat terjadwal).
4. **Multi-instance**: `SessionLock` (contoh advisory lock Postgres), `StateAdapter.setIf`, `recovery.staleMs`, dan U3/U4.
5. **Penjadwalan/heartbeat** adalah urusan aplikasi: job runner memanggil `inject(..., { wake: true })`, dengan contoh pola "silent OK".
6. **Skill dari DB** lewat `SkillSource` kustom.

---

## Rilis

- Satu **minor 0.4.0** (changeset per PR). Urutan PR yang disarankan: U2 → U1 → U8 → U3 → U4 → U5 → U6 → U7 → U9.
- Setelah rilis, perbarui `docs/plans/roadmap.md` di eharness (item selesai dicoret) dan **beri tahu BTeams** dengan mengisi bagian "Hasil" di
  bawah ini. Rencana BTeams yang bergantung pada versi ini: `docs/plans/A9-agent-sessions.md`, `A10-agent-memory-v2.md`,
  `A11-heartbeat-schedules.md`, `A12-agent-evolution.md`, `P3-pipeline-agent-output.md`.

## Hasil (diisi setelah eharness dirilis)

| # | Status | Versi | API final / perbedaan dari usulan |
|---|---|---|---|
| U1 | ☐ | | |
| U2 | ☐ | | |
| U3 | ☐ | | |
| U4 | ☐ | | |
| U5 | ☐ | | |
| U6 | ☐ | | |
| U7 | ☐ | | |
| U8 | ☐ | | |
| U9 | ☐ | | |

