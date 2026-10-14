# Spec 35 — Browser (`eharness/browser`, `eharness/browser/node`)

Status: **Draft**. Modules: `src/browser/*` (runtime-neutral: global `WebSocket`, `fetch`, Web
Streams only) and `src/browser/node/*` (Node-only, ADR-0036). Design:
[ADR-0064](../decisions/0064-browser-module.md). Plan: [P48](../plans/P48-browser.md). Builds on
spec 01 (plugins), 08 §12 (media in tool results), 09 (tools, framing), 11 §4.2 (external waits),
12 (model modalities), 23 §2 (forms and secrets).

An agent drives a real browser: it opens pages, reads them as an accessibility snapshot with
element refs, acts on refs, and sees screenshots in its next step. A person watches the same
browser live and can take over (click and type remotely), for a login, a CAPTCHA or a 2FA prompt,
then hand it back. Browsers come from **adapters** in a **registry**; each **profile** names an
adapter, a mode (`manual`: connect to an endpoint someone else runs; `managed`: the app downloads,
prepares and starts the engine) and the adapter's own settings.

The module imports core only through `src/index.ts` (plus `eharness/providers` for forms and the
vault, an allowed edge in `scripts/check-imports.ts`), ships no runtime dependency and never solves
CAPTCHAs or spoofs fingerprints (ADR-0064 §5). Engines are separate processes reached over a
protocol; binaries are downloaded at runtime, never bundled.

## 1. Concepts

```
browser() plugin ── tools ──► BrowserManager ──► lease(profile) ──► BrowserConnection
                                   │                                   ▲
                                   ├── BrowserProfileStore (port)      │ connect(endpoint)
                                   ├── BrowserRegistry ── adapters ────┘
                                   │        └── managed mode ── BrowserRuntime (install/start/stop)
                                   └── live(profile): frames + input + controller (agent | human)
```

- **Adapter**: one engine family and its protocol (`chrome`, `lightpanda`; `camoufox` in a
  separate package, §9). Declares settings per mode and capabilities.
- **Profile**: a stored, named configuration (adapter, mode, settings) plus the engine's persistent
  data (cookies, local storage) where the mode keeps it.
- **Runtime**: what makes a `managed` profile run (download, verify, start a process, stop it).
  Implementations are Node-only (`eharness/browser/node`) or remote (an app's HTTP driver).
- **Connection**: an open browser for one lease; operation-level, so non-CDP engines fit.
- **Manager**: leases (one holder per profile), idle shutdown, the controller flag and live view.
  One per process; the plugin and the app's routes share it.

## 2. Adapters and the registry

```ts
defineBrowserAdapter<M extends z.ZodObject, G extends z.ZodObject>({
  id: string                                 // 'chrome'; [a-z0-9-]+, unique in a registry
  label: string
  description?: string
  manual?: {
    settings: M                              // zod; ehMeta() for form hints, secret fields (spec 23 §2)
    endpoint(settings: z.infer<M>): BrowserEndpoint | Promise<BrowserEndpoint>
  }
  managed?: {
    settings: G
    runtime: BrowserRuntimeFactory<z.infer<G>> // supplied by the app (Node-only or remote), §6
  }
  capabilities: BrowserCapabilities | ((endpoint: BrowserEndpoint) => BrowserCapabilities)
  connect(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<BrowserConnection>
}): BrowserAdapter

interface BrowserEndpoint {
  protocol: string                           // 'cdp' (core), 'playwright-ws' (camoufox package), …
  url: string                                // ws(s):// or http(s):// (CDP /json/version is resolved)
  headers?: Record<string, string>           // secret values; never logged, never shown
  liveUrl?: string                           // a provider's own live view page (iframe), optional
}

interface BrowserCapabilities {
  snapshot: boolean
  screenshot: boolean
  liveView: 'screencast' | 'poll' | 'external' | 'none'  // external = liveUrl iframe only
  takeover: boolean                          // remote input from a person
  tabs: boolean
  persistentProfile: boolean                 // engine keeps cookies across leases in this mode
}

createBrowserRegistry(adapters: BrowserAdapter[]): BrowserRegistry
// get(id), list(), forms(id) → { manual?: ProviderFormSpec; managed?: ProviderFormSpec }
```

- An adapter has at least one mode. A mode is offered only when present: an app that passes no
  runtime gets a manual-only `chrome`.
- `forms(id)` reuses the providers form builder (spec 23 §2): labels, groups, widgets, secret
  fields, the edit-without-resending-secrets merge. UIs render a profile form from it.
- Duplicate ids or an adapter without modes throw `EH_CONFIG_INVALID`.

### 2.1 Shipped adapters (core)

`chromeAdapter({ managed?: BrowserRuntimeFactory })` — Chrome, Chromium, Edge and any CDP service
(Browserbase, Kernel, Steel, Anchor, Browserless, a self-hosted container).

- Manual settings: `cdpUrl` (`ws(s)://…` or `http(s)://host:port`), `headers` (secret, optional),
  `liveUrl` (optional).
- Managed settings: `channel` (`stable` | `beta`, default `stable`), `headless` (default `false`),
  `windowSize` (default `1280x800`), `proxy?`, `locale?`, `timezone?`, `userAgent?`,
  `extraArgs?` (allowlisted flags only, §8).
- Capabilities: all true, `liveView: 'screencast'`; `persistentProfile` true in managed mode,
  false in manual mode (the remote side decides).

`lightpandaAdapter({ managed?: BrowserRuntimeFactory })` — Lightpanda over CDP.

- Manual settings: `cdpUrl`. Managed settings: `obeyRobots` (default `true`).
- Capabilities: `snapshot`, `screenshot` (PNG only), `liveView: 'poll'`, `takeover: true`,
  `tabs: false`, `persistentProfile: false`. Fidelity of its rendering is lower than Chrome's; the
  docs say so.

Both use the shared CDP connection (§4). The registry is open: an app or package adds adapters with
`defineBrowserAdapter`.

## 3. Profiles

```ts
interface BrowserProfile {
  id: string                       // server-generated
  name: string                     // unique per store (case-insensitive)
  adapter: string
  mode: 'manual' | 'managed'
  settings: Record<string, unknown> // validated by the adapter's schema for the mode; secrets sealed
  allowDomains?: string[]          // §8; empty or absent = any public host
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown> // app data (owner, workspace)
}

interface BrowserProfileStore {   // async port; memory adapter + conformance suite
  create(input): Promise<BrowserProfile>      // EH_CONFIG_INVALID on duplicate name
  get(id): Promise<BrowserProfile | null>
  list(query?: { limit?: number; cursor?: string }): Promise<{ items: BrowserProfile[]; nextCursor?: string }>
  update(id, patch, ifUpdatedAt?): Promise<{ ok: true; profile } | { ok: false; reason: 'not-found' | 'conflict' }>
  delete(id): Promise<boolean>
}
```

`memoryBrowserProfileStore()` ships; `browserProfileStoreConformance` in `eharness/testing`.
Secret fields are sealed with an optional `SecretVault` (spec 23) by `sealedBrowserProfiles({
store, vault })`, with the same redaction as providers (`publicProfile(profile)` never contains a
secret). Engine data (a Chrome user-data directory) belongs to the runtime, keyed by profile id;
deleting a profile calls `runtime.removeProfileData(id)` when present.

## 4. Connection (operation level)

```ts
interface BrowserConnection {
  readonly capabilities: BrowserCapabilities
  navigate(input: { url?: string; action?: 'back' | 'forward' | 'reload' }, signal): Promise<PageInfo>
  snapshot(input: { scope?: string; interactive?: boolean; offset?: number }, signal): Promise<Snapshot>
  act(input: ActInput, signal): Promise<ActResult>
  screenshot(input: { fullPage?: boolean; ref?: string; maxWidth?: number }, signal): Promise<Shot>
  read(input: { offset?: number; maxChars?: number }, signal): Promise<{ text: string; page: PageInfo; nextOffset?: number }>
  tabs?(input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string }, signal): Promise<TabInfo[]>
  live?(): LiveChannel                        // §7; present when liveView is screencast or poll
  close(): Promise<void>
}
```

`cdpConnection(endpoint, options)` (exported) implements it over one WebSocket with the browser
target and flattened sessions (`Target.setAutoAttach { flatten: true }`). Requests have ids,
per-call timeouts (default 30 s) and abort; the socket closing rejects pending calls with a
readable error. A JSON `http(s)://` URL is resolved through `/json/version`.

### 4.1 Snapshot and refs

- Source: `Accessibility.getFullAXTree` of the main frame and same-process iframes (out-of-process
  iframes in a later version, plan P48 open question).
- Output: an indented outline, one node per line: `- button "Submit" [ref=e5]`, with value,
  checked, expanded, disabled and level where present. Interactive roles (button, link, textbox,
  searchbox, checkbox, radio, combobox, listbox, option, menuitem*, slider, spinbutton, switch, tab,
  treeitem) always get refs; with `interactive: false` headings, cells and list items get refs too.
  Elements with a pointer cursor or a click handler but no interactive role are added as
  `clickable` (one extra `DOM` pass), because sites build buttons from `div`s.
- Each snapshot has an id `s<n>` (per lease). A ref is `e<n>` and maps to `(snapshotId, frameId,
  backendDOMNodeId)`. A ref stays valid while its frame's document is the same (loader id); a ref
  from an older document answers `STALE: the page changed since snapshot s3. Take a new snapshot.`
- Size: at most `limits.snapshotChars` (default 20 000). Longer output ends with
  `… truncated; call browser_snapshot with offset <n> for more` and keeps the last 2 000 characters
  (pagination and footer links). `scope: 'e12'` snapshots a subtree.

### 4.2 Acting

`ActInput` (flat, no unions, so every provider accepts the schema):
`{ ref?, kind: 'click' | 'double_click' | 'hover' | 'fill' | 'type' | 'press' | 'select' | 'check' |
'uncheck' | 'scroll' | 'wait', text?, key?, values?, direction?, amount?, ms?, untilText? }`.

- Pointer actions: `DOM.scrollIntoViewIfNeeded`, `DOM.getBoxModel` centre (plus the frame offset),
  a hit test (`DOM.getNodeForLocation`); when another element covers the point the result is
  `BLOCKED: <role> "<name>" covers e5 (a dialog or banner). Close it first.`; then
  `Input.dispatchMouseEvent` moved → pressed → released. Checkboxes, radios and labels fall back
  to the element's own `click()` when the box is empty.
- `fill` clears and inserts (`Input.insertText`); `type` sends key events; `press` takes key names
  (`Enter`, `Control+a`).
- `wait`: `ms` (max 10 s) or `untilText` (max `limits.waitMs`, default 10 s).
- After an action the connection waits for network idle or 2 s, whichever is first, and returns
  `ActResult { page: PageInfo, navigated: boolean, changed: boolean, note?: string }`.

### 4.3 Screenshots

JPEG quality 70, `maxWidth` default 1280 (CSS pixels scaled down, never up), viewport unless
`fullPage` (capped at 8 000 px height). `ref` clips to the element. PNG when the engine has no JPEG
(Lightpanda). `Shot { bytes: Uint8Array; mediaType; width; height; hash }` (`hash` is SHA-1 of the
bytes via `crypto.subtle`, used for "unchanged").

### 4.4 Reading

`read` returns the page as plain text with headings, list markers and `[text](url)` links from a
fixed extractor run with `Runtime.evaluate` (no page script is trusted; the extractor is a constant
string). An adapter may provide a native reader (Lightpanda `LP.getMarkdown`). Capped at
`limits.readChars` (default 30 000) with an offset.

## 5. The plugin

```ts
browser({
  manager: BrowserManager
  /** Which profile this session uses; undefined = the tools are not registered. */
  profile: string | ((ctx: HarnessContext) => string | undefined | Promise<string | undefined>)
  screenshots?: {
    folder?: string                    // default '/.browser/shots/' (needs the filesystem plugin)
    auto?: 'changed' | 'always' | 'off' // attach after open/act; default 'changed'
    inModel?: number                   // newest screenshots sent as images; default 3
    keep?: number                      // files kept per session; default 50
  }
  autoSnapshot?: 'changed' | 'off'     // attach a fresh snapshot to open/act results; default 'changed'
  allowEval?: boolean                  // registers browser_eval; default false
  requestHuman?: (input: { reason: string; profileId: string }, ctx) => Promise<{ correlationId: string }>
  risk?: Partial<Record<BrowserToolName, ToolRisk>>
  limits?: Partial<BrowserLimits>
  toolNames?: Partial<Record<BrowserToolName, string>>
}): HarnessPlugin<'browser'>
```

Plugin name `browser`; service `browser` (§5.3); no instructions (tool descriptions carry the
text); no data parts. The session's lease is taken lazily on the first tool call and released at
session close or after `limits.idleMs` (default 5 min) without a call.

### 5.1 Tools (model-visible; text changes are a minor change)

Fixed order: `browser_open`, `browser_snapshot`, `browser_act`, `browser_screenshot`,
`browser_read`, `browser_tabs`, `browser_request_human`, `browser_eval`. A tool is registered only
when the **adapter's** capabilities allow it (decided at session open from the profile, so the
tool list is stable for the session, spec 02 §5): no `screenshot` → no `browser_screenshot`; no
`tabs` → no `browser_tabs`; no `requestHuman` or no `takeover` → no `browser_request_human`.

| Tool | Input | Default risk |
|---|---|---|
| `browser_open` | `{ url?, action? }` (`back`/`forward`/`reload`) | `read` |
| `browser_snapshot` | `{ scope?, interactive?, offset? }` | `read` |
| `browser_act` | `ActInput` (§4.2) | `external` |
| `browser_screenshot` | `{ fullPage?, ref? }` | `read` |
| `browser_read` | `{ offset? }` | `read` |
| `browser_tabs` | `{ action, tab?, url? }` | `read` (`open` checks domains) |
| `browser_request_human` | `{ reason }` | `read` |
| `browser_eval` | `{ expression }` | `external` |

All results are strings or a media reference (§5.2); expected failures are `ERROR:`, `STALE:`,
`BLOCKED:` or `BUSY:` strings, never throws (hard rule 6). Page text (snapshot, read, titles, eval
output) is framed with `untrustedContent()` (spec 03 §10), source `browser`.

`browser_open` and `browser_act` results: one status line (`Clicked e5 (button "Submit") · page
"Checkout" https://…`), then, by `autoSnapshot`, the new snapshot when the page changed, then, by
`screenshots.auto`, the screenshot when its hash changed since the last one sent.

`browser_request_human` is an `externalTool()` (spec 11 §4.2): `start` switches the controller to
`human` (§7) and calls `requestHuman` (the team app creates a `takeover` handoff, spec 32). The
turn parks. The app resolves the wait when the person hands back; `formatHandBack(state)` gives the
default output: `<by> handed the browser back · page "<title>" <url>`. The agent takes a new
snapshot after it.

### 5.2 Screenshots in the model's next step

A screenshot is written to `screenshots.folder` through the filesystem plugin (`writeBytes`) and the
tool result is the filesystem media reference (spec 08 §12): a small JSON in the stored message,
the bytes read again by `toModelOutput` when the history is projected. So the model sees the image
as a tool result in its next step (the same as a provider computer-use loop), storage holds no
base64, and the UI can show the file.

- Only the newest `inModel` screenshots of the session are sent as images; older references are
  sent as their text line plus `[older screenshot omitted]` (the plugin keeps a per-session
  sequence; after a restart the sequence is recovered from the folder).
- A model whose catalog entry lacks `image` input (spec 12 `inputModalities`) gets text only:
  `browser_screenshot` is not registered and `screenshots.auto` is `off`.
- Without the filesystem plugin there are no screenshots for the model (`browser_screenshot` not
  registered); live view still works.

### 5.3 Service `browser`

```ts
interface BrowserService {
  profileId(): string | undefined
  status(): Promise<LeaseStatus | undefined>   // adapter, page, controller, since
  release(): Promise<void>
}
```

## 6. Managed runtimes

```ts
interface BrowserRuntime {
  status(): Promise<RuntimeStatus>   // { state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error', version?, bytes?, progress?, error? }
  install(opts?: { signal?; onProgress?(p: { received: number; total?: number }): void }): Promise<void>
  start(profile: BrowserProfile, settings): Promise<BrowserEndpoint>  // idempotent per profile
  stop(profileId: string): Promise<void>
  removeProfileData?(profileId: string): Promise<void>
  uninstall?(): Promise<void>
}
type BrowserRuntimeFactory<S> = (settings: S) => BrowserRuntime   // one runtime may serve many profiles
```

`eharness/browser/node` ships:

**`chromeRuntime({ root, channel?, executablePath?, fetch?, xvfb?, allowNoSandbox? })`**

- Install: reads Chrome for Testing `last-known-good-versions-with-downloads.json`, picks the
  platform (`linux64`, `linux-arm64`, `mac-arm64`, `mac-x64`, `win64`), downloads the zip into
  `<root>/chrome/<version>/` with progress, extracts it with the system `unzip` (macOS `ditto`
  fallback), sets the executable bit, removes the macOS quarantine attribute, and checks
  `--version`. `executablePath` skips the download (a system Chrome, a stealth Chromium build).
- Start: one process per profile with `--user-data-dir=<root>/profiles/<profileId>` (never the
  default profile: Chrome 136+ refuses remote debugging there), `--remote-debugging-port=0`
  (bound to `127.0.0.1`), the endpoint read from `DevToolsActivePort`, and the defaults
  `--no-first-run --no-default-browser-check --disable-sync --disable-background-networking
  --disable-dev-shm-usage --disable-search-engine-choice-screen`. `headless: true` adds
  `--headless=new`; headed on Linux without `DISPLAY` needs `xvfb: true` (`xvfb-run -a`) or fails
  with a readable error. `--no-sandbox` only with `allowNoSandbox` and when running as root.
- Stop: `Browser.close`, then the process is killed after 5 s.

**`lightpandaRuntime({ root, version?, executablePath?, fetch? })`**

- Install: the release binary for `linux`/`macos` × `x86_64`/`aarch64` from the project's GitHub
  releases, executable bit set. Windows: `status()` is `error` with "not available on Windows".
- Start: `lightpanda serve --host 127.0.0.1 --port <free>` with `LIGHTPANDA_DISABLE_TELEMETRY=true`.
- The binary is AGPL-3.0; it is downloaded by the user's server and run unmodified as a separate
  process. The npm package never contains it.

Both runtimes keep one install lock (a second `install` waits for the first), clean partial
downloads, and never expose the debugging port beyond loopback. A remote runtime (a sandbox server
reachable over HTTP) implements the same interface in the app.

## 7. Manager, leases, live view and takeover

```ts
createBrowserManager({
  registry: BrowserRegistry
  profiles: BrowserProfileStore
  vault?: SecretVault
  limits?: Partial<BrowserLimits>     // idleMs, maxLeases (default 8), startTimeoutMs (60 s), …
  now?: () => number
  log?: Logger
}): BrowserManager

interface BrowserManager {
  lease(profileId: string, holder: { kind: 'session' | 'person'; id: string }): Promise<Lease | Busy>
  runtime(adapterId: string, settings?): BrowserRuntime | undefined   // for install/status UIs
  test(profile): Promise<{ ok: true; version: string } | { ok: false; error: string }>
  live(profileId: string, viewer: { id: string }): Promise<LiveChannel | Busy>
  status(): Promise<LeaseStatus[]>
  close(): Promise<void>
}

interface LiveChannel {
  info: { width: number; height: number; liveView: BrowserCapabilities['liveView']; liveUrl?: string }
  frames: ReadableStream<LiveFrame>            // { seq, data: Uint8Array, mediaType, width, height, at }
  controller(): { by: 'agent' | 'human'; holder?: string; since: number }
  takeOver(): Promise<void>                    // controller → human
  handBack(): Promise<void>                    // controller → agent
  input(event: LiveInput): void                // refused unless this viewer took over
  close(): void
}
```

- **One holder per profile.** A second session gets `BUSY: profile "<name>" is used by another
  session.` A person opening live view does not take a lease: they attach to the current one, or the
  manager opens the browser for them (holder `person`) to log in.
- **Frames.** `screencast`: `Page.startScreencast` (JPEG q60, max 1280 wide, every frame acked with
  `Page.screencastFrameAck`; the stream applies backpressure by acking only after the consumer
  read the previous frame). `poll`: a screenshot every 500 ms when the hash changed. `external`:
  no frames, `info.liveUrl` only.
- **Input.** `LiveInput` mirrors CDP `Input.*`: `{ type: 'mouse', event: 'move' | 'down' | 'up' |
  'wheel', x, y, button?, clickCount?, deltaX?, deltaY?, modifiers? }`, `{ type: 'key', event:
  'down' | 'up' | 'char', key, code?, text?, modifiers? }`, `{ type: 'text', text }` (insertText,
  for paste and IME), `{ type: 'navigate', url }` (domain rules apply). Coordinates are CSS pixels
  of the frame's `width`/`height`.
- **Controller.** While `human` controls, `browser_act`, `browser_open`, `browser_tabs` and
  `browser_eval` answer `BUSY: a person is controlling the browser since <time>. Wait, or call
  browser_request_human to ask for it.`; read-only tools still work. `handBack` clears refs (the
  page may have changed) and records `by` for `formatHandBack`.

## 8. Security

- **Untrusted pages.** Every page-derived string is framed (§5.1). Instructions on a page never
  change permissions; `browser_act` defaults to `external` risk so the permissions plugin asks or
  judges (spec 18). Apps can lower it per profile.
- **Domains.** `allowDomains` (profile) and `denyDomains` (plugin limits) are checked before
  `navigate`, `tabs.open` and live `navigate`, and after every action on the top-level URL; a page
  that ended on a blocked host is replaced by `about:blank` and the result says why. Private,
  loopback and link-local hosts are blocked by default (`allowPrivateHosts: false`), as in
  `web_fetch` (spec 22). Sub-resources are not filtered (documented).
- **Endpoints are full control.** A CDP URL is a credential: settings fields are secret, runtimes
  bind to `127.0.0.1`, `extraArgs` is an allowlist (`--lang`, `--window-size`, `--proxy-server`,
  `--force-device-scale-factor`, `--disable-gpu`); `--remote-debugging-address` and
  `--user-data-dir` are refused.
- **Eval** is off by default and `external` risk when on.
- **No evasion features.** No CAPTCHA solving, no fingerprint spoofing in core. The supported path
  for a CAPTCHA or 2FA is `browser_request_human` and takeover. An app may still choose a stealth
  engine through `executablePath` or a provider's own options; the docs say that no engine avoids
  detection reliably.

## 9. Other engines (separate packages)

An adapter whose protocol is not CDP ships outside the library (ADR-0062 ring 2), because it needs
a runtime dependency. Planned: `@eharness/browser-camoufox` (Camoufox, a Firefox build driven by
Playwright's Juggler protocol through `playwright-core`): manual mode connects to a Playwright
server URL (`protocol: 'playwright-ws'`), managed mode downloads a pinned Camoufox release and
starts it with a persistent context per profile; `liveView: 'poll'` (Playwright screenshots) and
takeover through `page.mouse`/`page.keyboard`. It implements `BrowserConnection` and so plugs into
the same plugin, manager and UI.

## 10. Errors

New codes: none beyond `EH_CONFIG_INVALID` (bad adapter, bad profile settings). Runtime failures
reach tools as `ERROR: the browser could not start (<reason>).` and UIs through `status()`.

## 11. Tests

- A scripted fake CDP server (an in-memory `WebSocket` peer replaying recorded AX trees, boxes and
  frames) for snapshots, refs and staleness, hit-test blocking, act, screenshot hashing, read
  pagination, screencast ack and backpressure, input mapping, controller rules, leases and idle
  release, domain rules.
- The plugin: tool list per capability and per model modality, media references and the
  `inModel` window, framing, `browser_request_human` parking and `formatHandBack`.
- `browserProfileStoreConformance` against the memory store; sealing and redaction.
- Runtimes: platform selection and install steps with an injected `fetch` and a fake process
  launcher; real Chrome and Lightpanda runs only when `EH_BROWSER_E2E=1`.
