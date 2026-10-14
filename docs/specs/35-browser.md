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
  One runtime per adapter serves every managed profile of it. Implementations are Node-only
  (`eharness/browser/node`) or remote (an app's HTTP driver).
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
    runtime: BrowserRuntime                  // supplied by the app (Node-only or remote), §6; one per adapter
    runtimeSettings?(settings: z.infer<G>): Record<string, unknown> // what runtime.start reads; default: the settings
    endpoint?(started: RuntimeEndpoint, settings: z.infer<G>): BrowserEndpoint // default { protocol: 'cdp', url: cdpUrl }
  }
  capabilities: BrowserCapabilities | ((mode: 'manual' | 'managed', settings) => BrowserCapabilities)
  connect(endpoint: BrowserEndpoint, ctx: ConnectContext): Promise<BrowserConnection>
  test?(endpoint, ctx): Promise<{ version: string }>   // default: connect and close
}): BrowserAdapter

interface ConnectContext { signal?: AbortSignal; limits: CdpLimits; profile: { id: string; name: string } }

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
interface BrowserRegistry {
  get(id), list(): BrowserAdapterInfo[]      // id, label, modes, default capabilities per mode
  forms(id): { manual?: ProviderFormSpec; managed?: ProviderFormSpec }
  validate(id, mode, settings): settings     // defaults applied; throws EH_CONFIG_INVALID, no values echoed
  merge(id, mode, stored, patch): settings   // edit without resending secrets, then validate
  publicProfile(profile): PublicBrowserProfile
}
```

The capabilities are a function of the mode and settings, not of a connected endpoint: the plugin
fixes its tool list when the session opens, before any browser runs.

- An adapter has at least one mode. A mode is offered only when present: an app that passes no
  runtime gets a manual-only `chrome`.
- `forms(id)` reuses the providers form builder (spec 23 §2): labels, groups, widgets, secret
  fields, the edit-without-resending-secrets merge. UIs render a profile form from it.
- Duplicate ids, a bad id or an adapter without modes throw `EH_CONFIG_INVALID`.
- A secret field that is also an endpoint (the CDP URL: a hosted service's key sits in it) is kept
  on edit by leaving it out of the patch (`''` and `{ keep: true }` count as left out); sending a
  new URL drops the stored secrets (they would be sent to the new host), as in spec 23 §2.

### 2.1 Shipped adapters (core)

`chromeAdapter({ managed?: BrowserRuntime })` — Chrome, Chromium, Edge and any CDP service
(Browserbase, Kernel, Steel, Anchor, Browserless, a self-hosted container).

- Manual settings: `cdpUrl` (`ws(s)://…` or `http(s)://host:port`; a secret, ADR-0064 D10),
  `headers` (secret values, optional), `liveUrl` (optional).
- Managed settings: `headless?` (empty: the runtime's default), `windowSize` (default `1280x800`,
  `--window-size`), `proxy?` (`--proxy-server`), `locale?` (`--lang`), `extraArgs?` (flags; those
  that move or expose the debugging port are refused by the runtime, §6). The Chrome channel is a
  runtime option (`chromeRuntime({ channel })`), not a profile setting; `timezone` and `userAgent`
  are not offered in this version.
- Capabilities: all true, `liveView: 'screencast'`; `persistentProfile` true in managed mode,
  false in manual mode (the remote side decides).

`lightpandaAdapter({ managed?: BrowserRuntime })` — Lightpanda over CDP.

- Manual settings: `cdpUrl` (secret). Managed settings: none yet (the runtime starts `lightpanda
  serve` on loopback).
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
  trusted?: boolean                // an admin trusts it: acting tools run at risk `write`, not `external` (§5.1)
  createdAt: number
  updatedAt: number
  metadata?: Record<string, unknown> // app data (owner, workspace)
}

interface BrowserProfileStore {   // async port; memory adapter + conformance suite
  create(input & { id? }): Promise<BrowserProfile> // EH_CONFIG_INVALID on duplicate name; id only for wrappers
  get(id): Promise<BrowserProfile | null>
  list(query?: { limit?: number; cursor?: string }): Promise<{ items: BrowserProfile[]; nextCursor?: string }>
  update(id, patch, ifUpdatedAt?): Promise<{ ok: true; profile } | { ok: false; reason: 'not-found' | 'conflict' }>
                                              // patch: name, settings, allowDomains ([] clears), trusted, metadata; duplicate name throws
  delete(id): Promise<boolean>
}
```

`memoryBrowserProfileStore()` ships; `browserProfileStoreConformance` in `eharness/testing`.
Secret fields (`secret` and `secretValues`, found with the adapter's schema from the registry) are
sealed with a `SecretVault` (spec 23) by `sealedBrowserProfiles({ store, vault, registry })`; each
blob is bound to the profile id and the field path. `publicProfile(registry, profile)` has the same
redaction as providers and never contains a secret. Engine data (a Chrome user-data directory) belongs to the runtime, keyed by profile id;
deleting a profile calls `runtime.removeProfileData(id)` when present.

## 4. Connection (operation level)

```ts
interface BrowserConnection {
  // Expected failures are `ERROR:` / `STALE:` / `BLOCKED:` strings (a string result, or `error`), never throws.
  navigate(input: { url?: string; action?: 'back' | 'forward' | 'reload' }, signal): Promise<PageInfo & { error?: string }>
  snapshot(input: { scope?: string; interactive?: boolean; offset?: number }, signal): Promise<Snapshot | string>
  act(input: ActInput, signal): Promise<ActResult>
  screenshot(input: { fullPage?: boolean; ref?: string; maxWidth?: number }, signal): Promise<Shot | string>
  read(input: { offset?: number; maxChars?: number }, signal): Promise<{ text: string; page: PageInfo; nextOffset?: number } | string>
  tabs?(input: { action: 'list' | 'open' | 'switch' | 'close'; tab?: string; url?: string }, signal): Promise<TabInfo[] | string>
  page?(signal): Promise<PageInfo>            // URL and title, cheap (no snapshot)
  live?(): Promise<LiveFeed>                  // §7; the manager wraps it with controller rules into LiveChannel
  eval?(expression: string, signal): Promise<string>  // browser_eval; result as text, `ERROR:` text on failure
  clearRefs?(): void                          // hand back: the page may have changed
  onClose?(handler: (reason: string) => void): () => void // the connection ended by itself: the manager drops the lease
  close(): Promise<void>
}
```

The CDP core lives in `src/browser/cdp/*`: `cdpConnection(endpoint, options)` (`client.ts`) opens one
WebSocket to the browser target with flattened sessions (`Target.setAutoAttach { flatten: true }`)
and returns the low-level `CdpClient`; `cdpBrowserConnection(endpoint, options)` (`connection.ts`)
wraps it as the `BrowserConnection` above. Requests have ids, per-call timeouts (default 30 s) and
abort; the socket closing rejects pending calls with a readable error; there is no reconnect (a
lease reopens). A JSON `http(s)://` URL is resolved through `/json/version`. The `CdpClient` throws
`CdpError` (readable message); the connection turns every one of them into an `ERROR:` string.

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
  A ref keeps its number while its element is listed again in the same document. A ref on a
  cross-site (out-of-process) iframe answers `ERROR: e7 is inside a cross-site iframe … not
  supported yet.` (the iframe line is shown as `[cross-site, not supported yet]`).
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
  `ActResult { page: PageInfo, navigated: boolean, changed: boolean, summary: string, note?: string, error?: string }`
  (`summary` is the status text, e.g. `Clicked e5 (button "Submit")`; a failure sets `error`).

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

### Engine differences handled by the CDP client

- A page target the browser attached by itself (`Target.setAutoAttach` on the browser session) is
  reused by `attach()`; some engines (Lightpanda) route that page's events only to that session.
- A screenshot refused in JPEG ("unsupported screenshot format") is taken again in PNG, and later
  screenshots of that connection ask for PNG directly (Lightpanda).

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
  requestHuman?: (
    input: { reason: string; profileId: string; sessionId: string; waitId: string; toolCallId: string; ctx },
    ctx,
  ) => WaitStart | undefined | Promise<…>   // waitId: what session.resolveWait takes
  images?: boolean | ((ctx) => boolean | Promise<boolean>)  // does the model accept images (spec 12)? default true
  risk?: Partial<Record<BrowserToolName, ToolRisk>>
  limits?: { denyDomains?: string[]; allowPrivateHosts?: boolean }  // added to the profile's and the manager's rules (§8)
  toolNames?: Partial<Record<BrowserToolName, string>>
}): HarnessPlugin<'browser'>
```

Plugin name `browser`; service `browser` (§5.3); no instructions (tool descriptions carry the
text); no data parts. The core cannot tell a plugin the model's modalities at session open, so the
app answers `images` (typically from the model catalog, spec 12 §1.1).

**The lease lives with the session, not with the turn.** It is taken lazily on the first tool call
and is released only when idle (the manager's `limits.idleMs`, default 5 min, reset by every tool
call and every live input) or by `service.release()`. It is not released at the end of a turn, so a
long-running job (`longRun`, spec 33) keeps its logged-in browser across the checkpoint between
chunks, and a session evicted from memory and opened again with the same id gets the same lease
back. After a restart (the lease or the engine is gone) the first call re-opens the browser; the
agent then starts from a fresh snapshot and old refs answer `STALE:`. A profile is used by one
agent by default; sharing a profile between agents is allowed and serial (`BUSY:`).

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
| `browser_act` | `ActInput` (§4.2) | `external`; `write` for a trusted profile |
| `browser_screenshot` | `{ fullPage?, ref? }` | `read` |
| `browser_read` | `{ offset? }` | `read` |
| `browser_tabs` | `{ action, tab?, url? }` | `read` (`open` checks domains) |
| `browser_request_human` | `{ reason }` | `read` |
| `browser_eval` | `{ expression }` | `external`; `write` for a trusted profile |

All results are strings or a media reference (§5.2); expected failures are `ERROR:`, `STALE:`,
`BLOCKED:` or `BUSY:` strings, never throws (hard rule 6). Page text (snapshot, read, titles, eval
output) is framed with `untrustedContent()` (spec 03 §10), source `browser`.

`browser_open` and `browser_act` results: one status line (`Opened "Checkout" https://…`,
`Clicked e5 (button "Submit")`), then the framed page block (title, URL and, by `autoSnapshot`,
the new snapshot when the page changed), then, by `screenshots.auto`, the screenshot: for `open`
always taken, for `act` only when the page changed (or `'always'`); under `'changed'` it is
attached only when its hash differs from the last screenshot sent. Every risk can be replaced with
the `risk` option; a profile marked `trusted` lowers `browser_act` and `browser_eval` from
`external` to `write` so a permissions plugin (spec 18) does not ask for them.

`browser_request_human` is an `externalTool()` (spec 11 §4.2): `start` takes the lease, switches
the controller to `human` (§7) and calls `requestHuman` (the team app creates a `takeover`
handoff, spec 32); its `WaitStart` is returned with `payload.kind: 'browser-takeover'` and
`payload.profileId` added. The turn parks. When no browser can be leased the wait resolves at once
with the refusal text. The app resolves the wait when the person hands back; `formatHandBack(state)` gives the
default output: `<by> handed the browser back · page "<title>" <url>`. The agent takes a new
snapshot after it.

### 5.2 Screenshots in the model's next step

A screenshot is written to `<folder><session>-<seq>.jpg` through the `fs` service of the filesystem
plugin (`writeBytes`) and the tool result is a media reference with the shape of the filesystem's
(spec 08 §12: `type: 'media-ref'`, `path`, `version`, `mediaType`, `bytes`, `text`) plus `seq`, the
position in the session's sequence. A result that carries a screenshot (`browser_open`,
`browser_act`, `browser_screenshot`) is this reference, with the status text in `text`; the stored
message holds the small JSON, and `toModelOutput` reads the bytes again when the history is
projected. So the model sees the image
as a tool result in its next step (the same as a provider computer-use loop), storage holds no
base64, and the UI can show the file.

- Only the newest `inModel` screenshots of the session are sent as images; older references are
  sent as their text line plus `[older screenshot omitted]` (the plugin keeps a per-session
  sequence; after a restart the sequence is recovered from the folder). Within a turn the loop keeps
  each step's tool results as produced, so the plugin also applies the window with a wire-only
  `step.prepare` hook. Files beyond `keep` are deleted.
- A model that does not accept images (the `images` option, from spec 12 `inputModalities`) gets
  text only: `browser_screenshot` is not registered and no screenshot is attached.
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
interface BrowserRuntime {            // src/browser/runtime.ts; one per adapter, serves every managed profile of it
  status(): Promise<RuntimeStatus>
  install(opts?: { signal?; onProgress?(p: { received: number; total?: number }): void }): Promise<void>
  start(profile: { id: string; name?: string }, settings?: Record<string, unknown>): Promise<RuntimeEndpoint> // idempotent per profile
  stop(profileId: string): Promise<void>
  removeProfileData?(profileId: string): Promise<void>
  uninstall?(): Promise<void>
  usage?(profileId: string): Promise<ProcessUsage | null>   // memory and CPU of the engine process tree
}
interface RuntimeStatus {
  state: 'missing' | 'installing' | 'ready' | 'starting' | 'running' | 'stopping' | 'error'
  version?: string
  diskBytes?: number                  // disk used by the installed engine
  progress?: { received: number; total?: number }   // while `installing`
  running?: string[]                  // ids of profiles with a running engine
  error?: string
}
interface RuntimeEndpoint { cdpUrl: string; pid?: number; headers?: Record<string, string>; liveUrl?: string }
interface ProcessUsage { rssBytes: number; cpuPercent: number }
```

`installing` is the state while a download or extract runs (with `progress`); `running` while at
least one profile runs. Expected failures of a runtime throw `HarnessError('EH_CONFIG_INVALID', …)`
with a readable message; the manager turns them into `ERROR: the browser could not start (…)`.
Resources are visible, not capped low (P48 owner decision): `usage(profileId)` gives the RSS of the
engine process tree and its CPU, and the Node module exports `systemMemory()` for the machine's
total and free memory; `manager.usage()` (§7) puts them together.

`eharness/browser/node` ships:

**`chromeRuntime({ root, channel?, executablePath?, fetch?, launcher?, headless?, xvfb?, inContainer?, … })`**

- Install: reads Chrome for Testing `last-known-good-versions-with-downloads.json`, picks the
  platform (`linux64`, `linux-arm64`, `mac-arm64`, `mac-x64`, `win64`), downloads the zip into
  `<root>/chrome/<version>/` with progress, extracts it with the system `unzip` (macOS `ditto`
  fallback), sets the executable bit, removes the macOS quarantine attribute, and checks
  `--version`. `executablePath` skips the download (a system Chrome, a stealth Chromium build).
- Start: one process per profile with `--user-data-dir=<root>/profiles/<profileId>` (never the
  default profile: Chrome 136+ refuses remote debugging there), `--remote-debugging-port=0`
  (bound to `127.0.0.1`), the endpoint read from `DevToolsActivePort`, and the defaults
  `--no-first-run --no-default-browser-check --disable-sync --disable-background-networking
  --disable-dev-shm-usage --disable-search-engine-choice-screen`. `headless` (the runtime option or
  the profile's setting, default `true`) adds `--headless=new`; headed on Linux without `DISPLAY`
  needs `xvfb: true` (`xvfb-run -a`) or fails with a readable error. `--no-sandbox` is added only
  inside a container (detected: `/.dockerenv`, `/run/.containerenv`, cgroup names; `inContainer`
  overrides it), never on a desktop. `extraArgs` of a profile are appended; flags that move or
  expose the debugging port (`--remote-debugging-address|port|pipe`, `--user-data-dir`) are refused.
- Stop: `Browser.close`, then the process is killed after 5 s.
- Crash leftovers: on `start` the runtime clears `SingletonLock`, `SingletonSocket`,
  `SingletonCookie` and `DevToolsActivePort` of the profile when the lock (`<host>-<pid>`) names a
  dead process or another host (a live process on this host keeps its lock). The engine pid is kept
  in `<profile>/eharness.pid`; a live process named there whose command line contains the profile
  directory is an orphan of a crashed run and is killed (SIGTERM, then SIGKILL) before launching.

**`lightpandaRuntime({ root, version?, executablePath?, fetch? })`**

- Install: the release binary for `linux`/`macos` × `x86_64`/`aarch64` from the project's GitHub
  releases, executable bit set. Windows: `status()` is `error` with "not available on Windows".
- Start: `lightpanda serve --host 127.0.0.1 --port <free>` with `LIGHTPANDA_DISABLE_TELEMETRY=true`.
  The pid is kept in `<root>/lightpanda/run/<profile>.pid`; an orphan of a crashed run is killed first.
- The binary is AGPL-3.0; it is downloaded by the user's server and run unmodified as a separate
  process. The npm package never contains it.

Both runtimes keep one install lock (a second `install` waits for the first), clean partial
downloads, and never expose the debugging port beyond loopback. A remote runtime (a sandbox server
reachable over HTTP) implements the same interface in the app.

Remote runtime (reference: `remoteBrowserRuntime({ baseUrl, token })` in `examples/sandbox-server`).
The sandbox server runs `chromeRuntime` itself and exposes `/v1/browser` (`status`, `install`
(background, poll `status`), `start`, `stop`, `uninstall`, `usage`, profile data removal) behind
its bearer token. `start` returns `cdpUrl: ws(s)://<server>/v1/browser/cdp/<profile>?t=<token>`: a
WebSocket proxy of the authenticated server to a Chrome that listens on its loopback only. `t` is an
HMAC-signed, 10-minute token bound to one profile and checked when the socket opens (the bearer
header is accepted too): WebSocket clients cannot set headers in every runtime, so the URL is a
credential and, like any `cdpUrl`, is never logged. A remote runtime may instead return
`RuntimeEndpoint.headers`. The manager calls `start` at every lease, so each lease gets a fresh URL.
An app that offers both places (the team example) wraps them in one runtime that routes by
profile; the choice is app data (`profile.metadata.runtime`), not an adapter setting.

## 7. Manager, leases, live view and takeover

```ts
createBrowserManager({
  registry: BrowserRegistry
  profiles: BrowserProfileStore       // wrap it with sealedBrowserProfiles for secrets at rest
  limits?: Partial<BrowserLimits>     // idleMs (5 min), maxLeases (8), startTimeoutMs (60 s), denyDomains, allowPrivateHosts, stopOnIdle (true), + the CDP sizes and waits
  systemMemory?: () => SystemMemory | Promise<SystemMemory>  // {totalBytes, freeBytes}  // `systemMemory` of eharness/browser/node
  now?: () => number
  log?: HarnessLogger
}): BrowserManager

interface BrowserManager {
  profile(id): Promise<BrowserProfile | null>
  capabilities(profile): BrowserCapabilities | undefined   // from the adapter, mode and settings
  rules(profile): DomainRules                               // allowDomains + the manager's deny list and private-host flag
  lease(profileId, holder: { kind: 'session' | 'person'; id: string }): Promise<Lease | LeaseRefusal>
  runtime(adapterId): BrowserRuntime | undefined            // install/status/uninstall UIs
  start(profileId): Promise<{ ok: true } | { ok: false; error: string }>  // start a managed engine without a lease; it keeps running until stop()
  stop(profileId): Promise<void>                            // release the lease and stop the managed engine
  test(profile | { adapter, mode, settings }): Promise<{ ok: true; version: string } | { ok: false; error: string }>
  live(profileId, viewer: { id: string }): Promise<LiveChannel | LeaseRefusal>
  handBack(profileId, by: string): Promise<HandBackInfo | undefined>   // a person hands back without a channel (a decision card)
  status(): Promise<LeaseStatus[]>                          // holder, controller, page, viewers per open lease
  usage(): Promise<{ profiles: { profileId, adapter, rssBytes?, cpuPercent? }[]; totals; system? }>
  on(listener: (e: BrowserEvent) => void): () => void       // lease, release, request-human, takeover, handback
  close(): Promise<void>                                    // release all leases, stop the engines this manager started
}

interface LeaseRefusal { refused: true; kind: 'busy' | 'limit' | 'error'; text: string } // text is `BUSY: …` or `ERROR: …`

interface Lease {                     // what a tool holds
  profile; holder; capabilities; connection: BrowserConnection
  controller(): ControllerState; busyText(): string | undefined   // BUSY text while a person controls
  touch(); setPage(page); requestHuman(reason); release(); readonly open: boolean
}

interface LiveChannel {
  info: { width: number; height: number; liveView: BrowserCapabilities['liveView']; liveUrl?: string }
  frames: ReadableStream<LiveFrame>            // { seq, data: Uint8Array, mediaType, width, height, at }; newest wins
  controller(): { by: 'agent' | 'human'; holder?: string; since: number; reason?: string }
  takeOver(): Promise<string | undefined>      // controller → human; a refusal text, or undefined
  handBack(): Promise<string | undefined>      // controller → agent; a refusal text, or undefined
  input(event: LiveInput): Promise<string | undefined>   // an ERROR:/BLOCKED: text unless this viewer took over
  close(): void
}
```

- **One holder per profile.** A second session gets `BUSY: profile "<name>" is used by another
  session.` A person opening live view does not take a lease from a session: they attach to the
  current one, or the manager opens the browser for them (holder `person`) to log in; a lease only a
  person opened is released when the last viewer leaves, and a session can take it over while the
  agent controls it. `maxLeases` answers `BUSY: <n> browsers are open (the limit is <max>)`.
- **Release.** A lease ends when it is idle for `idleMs` (every tool call and live input moves the
  deadline; it is never released at the end of a turn, so a long-run job keeps it across
  checkpoints, §5; it is not released while a viewer is attached or a person controls), by the
  holder (`release()`), or when the connection ends by itself (`lost`). A managed engine is stopped
  on idle and on loss (`stopOnIdle`, default `true`; logins stay in the profile's data) unless
  `start()` pinned it; an explicit `release()` leaves it running.
- **Resources.** `usage()` lists every running managed profile with `rssBytes` and `cpuPercent`
  (from `runtime.usage`), the totals, and the machine's memory when `systemMemory` was given.
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
  browser_request_human to ask for it.`; read-only tools still work. `takeOver` is refused while
  another person controls; a viewer that closes the live view while in control hands back
  (`reason: 'viewer-left'`). `handBack` clears refs (the page may have changed) and records `by` and
  the page for `formatHandBack`; the manager emits the `handback` event, which the app uses to
  resolve a parked `browser_request_human`. `browser_request_human` sets the controller to `human`
  with no holder until a viewer takes it.

## 8. Security

- **Untrusted pages.** Every page-derived string is framed (§5.1). Instructions on a page never
  change permissions; `browser_act` defaults to `external` risk so the permissions plugin asks or
  judges (spec 18). Apps can lower it per profile.
- **Domains.** `allowDomains` (profile) and `denyDomains` (manager and plugin limits) are checked before
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

New codes: none beyond `EH_CONFIG_INVALID` (bad adapter, bad profile settings, a runtime that
cannot install or start). Runtime failures reach tools as `ERROR: the browser could not start
(<reason>).` (secrets scrubbed from the reason) and UIs through `runtime.status()` and
`manager.test()`.

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
