# P45 — team: Artifacts (generated documents, web pages and images with viewers and sharing)

Status: in progress (designed 2026-10-13, revised 2026-10-14). Example app only (`examples/team`); no library change expected.

## Goal

Everything the agent generates for a person to look at (a document, a web page, an image, a data
table, a code file) becomes an **artifact**: one normalized record with a kind, versions, a viewer
in the web app and a share setting. In a web chat the artifact renders inline (an HTML landing page
runs in place, a document reads like a page) with actions above it (open, export, share, versions,
edit). From a chat channel (Telegram) a person asks the agent for something, the agent builds it as
an artifact in the background, and the reply carries the share link (and, on request, the exported
file). Adding a new kind later means one kind definition on the server and one viewer component on
the web, nothing else.

## Research (2026-10-13)

- Claude: artifacts start private; sharing is "only you" or "anyone with the link" (more scopes on
  team plans); a link shows either the latest version or a pinned one; unpublishing revokes the link.
  We copy the two basic scopes and the latest/pinned choice.
- Untrusted HTML (W3C iframe guidance, Google "securely hosting user data", assistant-ui safe content
  frame): serve it from a separate origin when possible; `sandbox` with `allow-scripts` but **never**
  together with `allow-same-origin`; a `Content-Security-Policy: sandbox …` header so the page is an
  opaque origin even when opened directly; a restrictive CSP (no network except a CDN allowlist);
  talk to the frame only through `postMessage`.
- Markdown WYSIWYG: Tiptap 3 ships an official `@tiptap/markdown` extension (since 3.7: parse and
  serialize, CommonMark, marked.js; still labelled early release). Milkdown (remark-based) is the
  fallback. Round-trip of tables, nested lists and code blocks is tested before we commit to one.

## Decisions (owner, 2026-10-13)

- Share scopes for now: **private** (only the signed-in web app) and **public** (anyone with the
  link). No per-person scope yet.
- The agent may change an artifact's visibility when asked (authority below).
- An optional separate origin for artifact content via env; without it everything runs on the one
  host and stays safe (see "Content origin").
- Not now: motion, video, audio.

## Model

Artifact files live in the Library, so the filesystem tools, history and the Files page keep
working: `/library/artifacts/<slug>-<short id>/` (entry file plus assets).

- `artifacts` — `id` (UUIDv7), `kind`, `title`, `description`, `dir` (library folder), `entry`
  (file inside `dir`), `agent_id`, `chat_id` / `session_id` of origin (nullable), `version`
  (current number), `visibility` (`private` | `public`), `share_token` (random 128-bit, base64url;
  null while private), `share_version` (null = latest, else a pinned number), `created_at`,
  `updated_at`, `deleted_at`.
- `artifact_versions` — `artifact_id`, `n`, `files` (JSON: path → library version hash), `note`,
  `by` (`agent:<id>` | `web`), `at`. Content is kept per version (copy-on-write rows in
  `artifact_blobs` keyed by hash) because `library_history` stores metadata only.
- `artifact_events` — append-only audit: create, version, visibility, export, delete (actor, origin
  chat/channel).

Going private → public issues a **new** token; public → private clears it. A leaked old link stays dead.

## Kind registry (the extension point)

`examples/team/shared/artifacts/kinds.ts` (pure, used by server and web):

```ts
interface ArtifactKindDef {
  id: string                       // 'html', 'document', ...
  label: string
  entry: string[]                  // accepted entry extensions
  mediaTypes: string[]
  render: 'frame' | 'native'       // frame = sandboxed iframe from the content origin
  validate?(files): string[]       // structure problems (like deliverables), shown to the agent
  exports: { id: string; label: string; mediaType: string }[]
  editable?: 'markdown' | 'text'   // which editor the web offers
}
```

Server: `server/src/domain/artifacts/kinds/<kind>.ts` adds `produceExport(id, files)`.
Web: `web/src/lib/artifacts/viewers.ts` maps kind → `{ Viewer, Editor?, actions? }`. An unknown kind
falls back to `file` (generic preview + download).

Kinds in this phase:

| Kind | Entry | Viewer | Edit | Exports |
|---|---|---|---|---|
| `html` (landing page, 3D with three.js, prototype, slide deck) | `index.html` + assets | frame | — (agent edits) | HTML, ZIP |
| `document` | `.md` | rendered markdown (existing Streamdown styles) | WYSIWYG (Tiptap + `@tiptap/markdown`) | MD, HTML, PDF (print stylesheet) |
| `image` | `.png` `.jpg` `.webp` `.svg` | native (`svg` through the frame, never inline) | — | original, PNG for SVG |
| `code` | any text source | highlighted (existing code block) | text | original |
| `data` | `.csv` `.json` | table (sort, filter) | — | CSV, JSON |
| `file` (fallback) | anything | metadata + download | — | original |

Mermaid diagrams render inside `document`.

## Content origin

- `TEAM_ARTIFACT_URL` (optional): public base URL of the content origin, e.g.
  `https://artifacts.example.com`. `TEAM_ARTIFACT_PORT` (optional): when set, the server also listens
  on that port and serves **only** the content routes there (for a separate host/port behind a proxy
  or in dev, e.g. `http://localhost:4001`).
- Unset: content is served by the main server under `/art/*` on the same host. Still safe because:
  every content response carries `Content-Security-Policy: sandbox allow-scripts allow-popups
  allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline' <cdn allowlist>; style-src
  'unsafe-inline' <cdn allowlist> fonts.googleapis.com; img-src data: blob: <self> <cdn>; font-src
  …; connect-src 'none'` so even a direct top-level open is an opaque origin with no network; the
  session cookie is `HttpOnly` + `SameSite=Lax` and requests from an opaque origin are cross-site;
  `/api` rejects `Origin: null`; `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- The iframe in the web app: `sandbox="allow-scripts allow-popups allow-forms allow-modals"`, never
  `allow-same-origin`. CDN allowlist: cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, Google Fonts.
- Access to content never depends on cookies (they do not reach a separate origin): private content
  is loaded with a short-lived signed view URL (`/art/v/<artifactId>/<version>/<path>?t=<hmac>`,
  10 min, bound to artifact + version, minted by the authenticated API); public content by
  `/art/s/<shareToken>/<path>`. Same code path in both origin modes.
- `postMessage` bridge (a small script the server injects into `html` entries): `resize` (height),
  `error` (uncaught errors → "Ask the agent to fix" button), `ready`. The parent checks
  `event.source === frame.contentWindow` (origin is `null`).

## Sharing

- Public page: `/s/<token>` on the web app host (no login, no app shell, no session probe): a
  full-screen page that is only the artifact viewer (owner decision 2026-10-14: no title bar).
  Web route `web/src/routes/s/[token]` reads `GET /share/{token}` and the public content URLs.
  Unknown or revoked token → "This link is not available", no detail. Link previews (Telegram):
  in the single-port deployment (`TEAM_WEB_DIR`) the server injects `og:title`, `og:description`
  (the artifact description, else "Shared <kind> artifact"), `og:site_name` and `robots: noindex`
  into the app shell of `/s/<token>` (`infra/web-static.ts`); an unknown token gets no preview.
  A separately hosted web (Vite dev, static host) has no preview.
- Private: the artifact page `/artifacts/<id>` in the signed-in app; the "copy link" action gives
  that URL.
- Version: public link follows the latest version by default; "pin this version" sets
  `share_version`.

## Agent tools

Split by risk (P41 tool layering rule); authorization is code at the tool boundary.

- `artifact_create` — `{ kind, title, description?, files: [{ path, content | base64 }], entry? }`.
  Validates with the kind, writes the folder, version 1, returns `{ id, url, problems[] }` as text.
  Big files: the agent may create with a stub and continue with the filesystem `edit` / `write`
  tools on the artifact folder.
- Versions: Library `onChange` under `/library/artifacts/**` marks the artifact dirty; at the end of
  the turn (or the run, for background work) the server snapshots one new version and runs
  `validate`; problems go back to the agent as a step reminder once.
- `artifact_list` — `{ query?, kind?, limit? }` (read).
- `artifact_visibility` — `{ id, visibility: 'private' | 'public', pinVersion? }`, returns the link.
  Who may run it:
  - web chat (signed-in owner): yes;
  - channel requester whose resolved role (P43 People) is `owner` or `admin`: yes;
  - `member` / `guest`: making something **public** is refused with a readable string (they may
    ask for it to be made private);
  - autonomous runs (programs, routines, heartbeat) with no human requester: `public` opens a
    decision for the owner (existing decision center) instead of acting.
- Errors are strings, never throws (unknown id, wrong kind, too large, not allowed).
- Instructions (static, prompt-cache safe): when the person asks for a page, design, document,
  report, table or image to look at, create an artifact instead of pasting long content into chat;
  in channels reply with a one-line summary and the link; never claim a link is public unless the
  tool said so.

## Channels flow

1. Admin on Telegram: "bikinin landing page 3D produk X, share public".
2. Gateway wakes the agent (existing). The agent runs `artifact_create(kind: 'html')`, edits, then
   `artifact_visibility(public)` (allowed: admin).
3. The reply is the summary plus the public link; when the person asks for the file, the agent adds
   the export as an `OutboundMessage.files` attachment (existing `sendDocument`). Private artifacts
   are only linked to the signed-in web app (the reply says so).
4. The artifact also shows in the web app (Artifacts list, and in the channel session view).

## Web

- Chat: the `artifact_create` tool part renders the artifact inline (existing `artifact-card` while
  `generating` from the streamed tool input, then the viewer). Toolbar: Open (full page), Export
  (kind exports), Share (private/public switch, copy link, pin version), Versions (switch, compare
  text kinds), Edit (when the kind is editable). An error from the frame offers "Ask the agent to
  fix" (sends a message with the error text).
- `/artifacts`: list (search, kind filter, visibility, agent), and `/artifacts/<id>` full viewer.
- Document editor: Tiptap + `@tiptap/markdown`; save is a compare-and-set write of the entry
  (existing library version) and creates a version by `web`; a conflict shows the existing conflict
  helper (`lib/conflict.ts`).
- FileCard of a file inside an artifact folder links to the artifact, not to Files.

## Server API (OpenAPI, regenerated web client)

`GET /artifacts`, `GET /artifacts/{id}`, `GET /artifacts/{id}/versions`,
`POST /artifacts/{id}/view-url` (signed content URL), `PATCH /artifacts/{id}` (title, visibility,
pin), `PUT /artifacts/{id}/entry` (editor save with `ifVersion`), `GET /artifacts/{id}/export/{format}`,
`DELETE /artifacts/{id}` (soft); public `GET /share/{token}` (metadata for the share page).
Content routes `/art/v/…`, `/art/s/…` outside `/api`.

## Phases

1. **Core**: tables + migration, kind registry (`html`, `document`, `image`, `code`, `data`,
   `file`), versions/snapshots, content routes with headers, signed view URLs,
   `TEAM_ARTIFACT_URL` / `TEAM_ARTIFACT_PORT`, API, exports (HTML, ZIP, MD, CSV/JSON, original).
2. **Agent**: `artifact_create`, `artifact_list`, `artifact_visibility` with the authority rules,
   end-of-turn versioning and validation reminder, instructions.
3. **Web viewers**: viewer registry, frame viewer with the bridge, inline chat rendering, toolbar,
   `/artifacts` pages, versions.
4. **Document editor**: Tiptap + `@tiptap/markdown` round-trip tests (tables, nested lists, code,
   mermaid fences) before wiring; Milkdown if it fails them. CAS save, conflict UI, PDF print.
5. **Sharing + channels**: public share page with OG tags, revoke/re-issue, pin version; Telegram
   flow (link reply, export attachment); e2e.

## Acceptance matrix (e2e per case)

| # | Case | Expected |
|---|---|---|
| A-01 | Web: "buat landing page 3D untuk produk X" | `html` artifact renders inline, three.js from CDN works, Export HTML downloads a working file |
| A-02 | Web: "tulis proposal …" then edit in the WYSIWYG editor | `document` artifact; edit saves version 2 by `web`; agent sees the edited text next turn |
| A-03 | Agent edits an existing artifact ("ganti warna hero jadi biru") | new version, old version still viewable |
| A-04 | Telegram admin: "… share public" | reply has a public link; link opens without login; OG preview shows the title |
| A-05 | Telegram member: "jadikan public" | refused with a readable reason; stays private |
| A-06 | "jadikan private lagi" then the old link | 404; making it public again gives a new link |
| A-07 | Program run creates a report artifact and wants it public | a decision opens; nothing public until approved |
| A-08 | HTML artifact tries `fetch('/api/…')`, reads `document.cookie`, or `top.location` | blocked (CSP / sandbox); both origin modes |
| A-09 | Raw content URL opened directly, same-origin mode | opaque origin, no cookie, no network |
| A-10 | Telegram: "kirim file html-nya" | export attached as a document |
| A-11 | Uncaught error in an HTML artifact | "Ask the agent to fix" sends the error; agent fixes in a new version |
| A-12 | Expired signed view URL | 403; the web refreshes it transparently |

## Revision 2026-10-14 (owner): chat-first artifacts, split panel, charts four ways, code sandbox

The owner tested the code sandbox (P44) and compared with Claude and ChatGPT. Decisions:

### R1 — Split panel, not a floating dialog

Opening an artifact splits the chat page: chat on the left, the artifact panel on the right
(`paneforge` / `ui/resizable`, the handle is draggable, the split is remembered per browser,
min widths 360 px chat / 420 px panel). The panel has a header (title, kind, version picker,
actions: copy, download/export, open full page, share, close) and the viewer. On narrow screens
(< 900 px) the panel takes the whole width with a back button. Creating an artifact in the current
turn opens the panel automatically (like Claude); clicking any artifact card or preview opens it.
The URL carries the open artifact (`?artifact=<id>` or `?preview=<message id>:<block index>`) so a
reload keeps it open.

### R2 — Four ways to a chart, all rendered

| Way | What the agent does | What the web shows |
|---|---|---|
| **SVG** | writes an ```` ```svg ```` fence in its reply (or `artifact_create` kind `image` with an `.svg`) | an inline preview of the SVG (sandboxed frame, never inline DOM) + "Open" → panel |
| **HTML** | `artifact_create` kind `html` (Chart.js / Plotly / ECharts / D3 from the CDN allowlist) or an ```` ```html ```` fence | artifact card → panel with the live page; fence → "Preview" → panel |
| **Python** (matplotlib, pandas, …) | `run_python` saves `chart.png` / `.svg` / `.html` into the library, then `artifact_create` **adopts** the files (no bytes through the tool input) | the `run_python` tool card shows thumbnails of saved images and links to saved files (like a code interpreter); the artifact opens in the panel |
| **Mermaid** | writes a ```` ```mermaid ```` fence (flowchart, sequence, gantt, pie, xychart, …) or `artifact_create` kind `mermaid` | the fence renders as a diagram inline (lazy-loaded `mermaid`, theme follows light/dark, `securityLevel: 'strict'`), with a "Code" toggle, copy, download SVG/PNG and "Open" → panel; a render error shows the code and the error |

### R3 — Implicit previews from fences (no tool call needed)

Assistant text is scanned for fences: `mermaid` → diagram; `svg` (or `xml`/no language whose body
starts with `<svg`) → SVG preview; `html` with a full document or `<body>`/`<script>` → "Preview"
button. Previews are computed on the client from the message text (nothing stored), use the same
viewers as artifacts, and offer **"Save as artifact"** (creates a stored, versioned, shareable
artifact from the fence through `POST /artifacts` with `origin: { messageId, block }`). While a
message streams, an unfinished fence shows as code; it renders once the fence is closed.

### R4 — Kinds added

`mermaid` (entry `.mmd`, viewer = mermaid renderer, exports SVG/PNG/MMD) and `svg` handling inside
`image` (always through the frame). `document` renders mermaid fences and relative images
(`![](chart.png)` → a signed view URL of the same artifact folder).

### R5 — `artifact_create` adopts library files

Input: `{ kind, title, description?, files?: [{ path, content? , base64?, from? }], dir?, entry? }`.
`from` copies an existing library file (e.g. `/library/work/chart.png` written by `run_python`)
into the artifact folder; `dir` adopts a whole library folder as the artifact folder in place. The
instructions tell the agent: compute with `run_python`, save outputs, then create the artifact from
them; never paste data or base64 images into the tool input or the chat.

### R6 — Code sandbox integration

- `run_python` results already list `Saved: …`; the web parses that footer and renders image
  thumbnails (signed library view URLs) and file chips; clicking opens the file in the panel (as a
  transient `file` view) with "Save as artifact".
- Writes by `run_python` into `/library/artifacts/**` go through the same library `onChange`, so the
  end-of-turn version snapshot of R-versions applies unchanged.
- Program runs need write authority on `/library/artifacts/**` for this (documented).

### Acceptance additions

| # | Case | Expected |
|---|---|---|
| A-13 | "buat chart penjualan dummy" — agent answers with a ```` ```mermaid ```` xychart or pie | diagram renders inline; Open → panel; Save as artifact works |
| A-14 | same with an ```` ```svg ```` fence | SVG preview inline (frame), panel, download |
| A-15 | "buat chart pakai matplotlib" (sandbox with matplotlib) | run_python card shows the PNG thumbnail; artifact created by adopting the PNG; panel opens |
| A-16 | "buat dashboard chart interaktif" | `html` artifact with Chart.js from the CDN; panel shows the live chart |
| A-17 | Panel UX | split with draggable handle; auto-opens on create; survives reload; mobile full width |

### Order of work (this revision)

Phase 1 (core) and 2 (agent tools incl. R5) on the server; phase 3 (viewers, split panel R1,
fences R3, mermaid R2/R4, run_python thumbnails R6) on the web — in parallel against the API
below. Phase 4 (WYSIWYG editor) and the channel parts of phase 5 follow; public sharing basics
(visibility switch, `/s/<token>` page) are part of phase 1–3.

### API contract (server ↔ web, this revision)

- `GET /artifacts?query&kind&agentId&limit&cursor` → `{ items: ArtifactSummary[], nextCursor }`
- `GET /artifacts/{id}` → `Artifact` (`id, kind, title, description, dir, entry, agentId,
  sessionId, version, visibility, shareUrl|null, shareVersion|null, files: [{ path, size,
  mediaType }], createdAt, updatedAt`)
- `GET /artifacts/{id}/versions` → `[{ n, note, by, at, files }]`
- `POST /artifacts/{id}/view-url` body `{ version?, path? }` → `{ url, expiresAt }` (signed content
  URL of the entry or one file)
- `POST /artifacts` body `{ kind, title, files: [{ path, content }], origin?: { sessionId,
  messageId, block } }` → `Artifact` (web "Save as artifact")
- `PATCH /artifacts/{id}` `{ title?, visibility?, shareVersion? }` → `Artifact`
- `GET /artifacts/{id}/export/{format}` → file download
- `DELETE /artifacts/{id}` (soft)
- `POST /library/view-url` body `{ path }` → `{ url, expiresAt }` (signed raw view of a library file,
  for run_python thumbnails; respects the caller's library access)
- Public: `GET /share/{token}` → `{ artifact: ArtifactSummary, entryUrl }`; content routes
  `/art/v/…`, `/art/s/…`, `/art/l/…` (library view) outside `/api`.
- Chat parts: `artifact_create` tool output (text for the model) plus a data part
  `data-artifact` `{ id, kind, title, version }` written by the tool (`ctx.stream.data`) so the web
  renders the card and auto-opens the panel without parsing text.

## Out of scope (later)

Motion, video and audio kinds (and MP4 export); per-person or workspace-member sharing; comments on
artifacts; server-side thumbnails / OG images (headless render); React/JSX kind (in-browser
bundling); artifacts that call the model at runtime; artifact storage shared between viewers.

## Open questions

- Version content storage: `artifact_blobs` by hash (proposed) vs. keeping full rows in the
  Library under `.versions/` — decide in phase 1 by size of real artifacts.
- Size limits per artifact (proposed 5 MB per file, 20 MB per artifact, 100 versions kept).

## Requests to other phases

- P41/P43: the requester's resolved role must be available to tool `execute` (it is for `people`;
  reuse the same accessor).
