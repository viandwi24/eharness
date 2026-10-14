# P48 — Browser agent (`eharness/browser`) and the team Browser page

Status: done (2026-10-14); the Camoufox package is designed (P48-camoufox-design.md), not built · Owner: maintainer · Branch: `main` (batched, see release workflow)

## Goal

Agents drive a real browser, and people can watch and take it over. After this plan:

- `eharness/browser` has a **registry of adapters** (Chrome and Lightpanda in the library, Camoufox
  as a separate package). Each adapter declares its own settings for two modes:
  - **manual**: connect to an endpoint someone else runs, such as a hosted browser service, a
    container, or a Chrome on another machine;
  - **managed**: the app downloads, prepares and starts the engine itself.
- The model reads a page as an accessibility **snapshot with refs** (`button "Pay" [ref=e5]`), acts on
  refs (`browser_act({ ref: 'e5', kind: 'click' })`), and **sees screenshots in its next step**. The
  screenshot reaches the model as a tool-result image, the same loop as a provider computer-use tool.
- A person watches the browser **live** in the team app. They click **Take control**, use their own
  mouse and keyboard on the streamed page, then click **Give back**. The agent can ask for this
  itself (`browser_request_human`) when it meets a login, a CAPTCHA or a 2FA prompt. The turn parks
  until the person hands back.
- In the team app an admin creates **browser profiles**: a name, an adapter, then a mode.
  - For a manual profile they fill in the adapter's form (CDP URL, headers, live view URL) and
    press **Test connection**.
  - For a managed profile they press **Download**, then **Start**, and see progress, version and size.
  - A profile keeps its login (a Chrome user-data directory per profile) and is assigned to agents
    through a **Browser** connector.

Design and rejected options: [ADR-0064](../decisions/0064-browser-module.md). Contract:
[spec 35](../specs/35-browser.md).

## Specs

- New: `docs/specs/35-browser.md` (phase A).
- Spec 08 §12 covers media references: screenshots reuse them.
- Spec 03 §10 covers `untrustedContent()`: page text is framed.
- Spec 11 §4.2 covers `externalTool()`: `browser_request_human` parks the turn.
- Spec 12 covers `inputModalities`: models without image input get text only.
- Spec 18 covers risk and approvals.
- Spec 22 covers private-host rules, reused for navigation.
- Spec 23 §2 covers forms, secret fields and redaction, reused for adapter settings.
- Spec 24 covers connectors (the team Browser connector).
- Spec 32 covers handoff kind `takeover` (team).

## Owns

- `src/browser/**`: the new subpath `eharness/browser` (runtime-neutral) and `eharness/browser/node`
  (Node-only, ADR-0036). It imports core only via `src/index.ts` and may import `providers` for
  forms and the vault. That needs one allowed edge in `scripts/check-imports.ts`, as `http` →
  `activity` has.
- `src/testing/browser*.ts`: profile store conformance and the fake CDP peer exported for adapters.
- `scripts/check-imports.ts`: add `browser` to the subpaths and `browser/node/` to `nodeOnly`.
- `package.json` exports `./browser`, `./browser/node`; the exports snapshot; CLAUDE.md layout and
  hard rule 4 list.
- `examples/team/**` browser parts (phase E); `examples/sandbox-server/**` browser runtime (phase F).
- Docs: spec 35, ADR-0064, `docs/guides/browser-agents.md`, `docs/architecture.md` module row.

## Research summary (2026-10-14)

| Topic | Finding | Consequence |
|---|---|---|
| Control layer | CDP over WebSocket is a Web API (global `WebSocket` in Node 22 and Bun). Chrome, Chromium builds, Lightpanda and the hosted services (Browserbase, Kernel, Steel, Anchor, Browserless, Browser Use) all speak it. | Own CDP client in core, no dependency (D1) |
| agent-browser (Vercel, Apache-2.0) | `Accessibility.getFullAXTree`, refs `e<n>` → `backendDOMNodeId`, a hit-tested click with an `el.click()` fallback, `--if-changed` screenshots. Its `stream` WebSocket sends JPEG frames and takes `input_mouse` / `input_keyboard` / `input_touch`. | Copy these designs, not the binary (D3, D7) |
| playwright-mcp | Injected-script ARIA snapshot with `aria-ref=e12`. | Same ref shape; we use the AX tree because it is engine-side and works on Lightpanda |
| OpenClaw browser (from OpenAlice) | 63 files over `playwright-core` + `express`. Removed by its host project in 2026-05 as too heavy. | Not vendored |
| camofox-browser (MIT) | REST server over `camoufox-js` + `playwright-core`. It has no screencast; takeover only via VNC. Refs are re-issued every snapshot (stale-ref misclicks), crash telemetry is on by default, and the Camoufox download is ~1.3 GB, pinned because betas break. | Snapshot ids + `STALE:` (D3); Camoufox as a separate package (D9) |
| Camoufox | Firefox driven over Juggler (Playwright protocol), not CDP; MPL-2.0; "under development". | Operation-level connection contract (D2) |
| Lightpanda | AGPL-3.0. Has `Accessibility.getFullAXTree`, `Input.*` and `Page.captureScreenshot` (PNG only), but no screencast. Single binaries for linux/macos × x86_64/aarch64, no Windows. Telemetry is on unless `LIGHTPANDA_DISABLE_TELEMETRY=true`. | Polled live view; download at runtime, never bundle (D5) |
| Chrome for Testing | `last-known-good-versions-with-downloads.json`; platforms linux64, linux-arm64, mac-arm64, mac-x64, win32, win64. Chrome 136+ refuses remote debugging on the default user-data-dir. | Per-profile user-data-dir; port 0 + `DevToolsActivePort` (D5) |
| Live view | `Page.startScreencast` sends JPEG frames that must each be acked (`Page.screencastFrameAck`); `Input.dispatch*` and `insertText` for takeover. | Screencast with ack-based backpressure (D7) |
| Stealth engines | CloakBrowser's binary licence is unclear (newer builds paid). puppeteer-extra-stealth is abandoned, nodriver/zendriver are AGPL Python, and no engine avoids detection reliably. | No evasion in the library; human takeover is the supported path (D8) |
| AI SDK 7 | No browser primitive. Tool results may contain image parts (`toModelOutput` → `content`), as `read_file` already does. | Screenshots as media references (D6) |

## Decisions

- **D1: Own CDP client in core.** `cdpConnection()` uses one WebSocket to the browser target with
  flattened sessions (`Target.setAutoAttach { flatten: true }`). It handles ids, per-call timeouts,
  abort, and readable errors when the socket closes, and resolves an `http(s)://` endpoint through
  `/json/version`. No `playwright-core`, no `ws`.
- **D2: Adapters return an operation-level connection, not "a CDP URL".** `BrowserConnection` has
  `navigate`, `snapshot`, `act`, `screenshot`, `read`, `tabs?` and `live?`. Capabilities (`snapshot`,
  `screenshot`, `liveView: screencast | poll | external | none`, `takeover`, `tabs`,
  `persistentProfile`) decide which tools a session gets. The tool list is fixed at session open,
  to keep the prompt-cache prefix stable.
- **D3: Snapshots and refs.**
  - The snapshot comes from the AX tree of the main frame and same-process iframes.
  - Interactive roles always get refs.
  - A `clickable` pass adds elements with a pointer cursor or a click handler, for sites that build
    buttons from `div`s.
  - Every snapshot has an id `s<n>`. A ref maps to `(snapshotId, frameId, backendDOMNodeId)` and is
    valid while the frame's document (loader id) is the same; otherwise the tool answers `STALE:`.
  - Output is capped (20 000 chars) with an offset; the tail is kept so pagination links survive.
- **D4: Acting like a person, failing like a tool.** A pointer action scrolls the element into view,
  takes the box centre, hit-tests it, then sends mouse moved → pressed → released.
  - A covered element answers `BLOCKED: <role> "<name>" covers e5` instead of clicking the wrong thing.
  - `fill` uses `insertText`. Key names (`Enter`, `Control+a`) work for `press`.
  - After an action the tool waits for network idle or 2 s, whichever comes first.
  - Expected failures are strings, never throws.
- **D5: Two modes; runtimes are injected.**
  - The runtime-neutral core never spawns a process. A managed mode exists only when the app passes
    a `BrowserRuntime`.
  - `eharness/browser/node` ships `chromeRuntime` (Chrome for Testing) and `lightpandaRuntime`
    (release binary). Each one downloads with progress, extracts with the system `unzip` (macOS
    `ditto`), sets the exec bit, removes the macOS quarantine attribute, verifies the version, and
    starts one process per profile on `127.0.0.1` with port 0.
  - `executablePath` skips the download, for a system Chrome or another Chromium build.
  - A remote runtime (the sandbox server) is app code with the same interface.
- **D6: Screenshots reach the model through the virtual file system.**
  - A screenshot is written to `/.browser/shots/`, and the tool result is the filesystem media
    reference (spec 08 §12). `toModelOutput` re-reads the bytes when history is projected. The
    stored message holds no base64, and the UI shows the same file.
  - Only the newest 3 screenshots are sent as images; older ones become a text line.
  - Defaults are JPEG q70, max 1280 px wide. `screenshots.auto: 'changed'` attaches a screenshot
    to `browser_open`/`browser_act` results only when the image hash changed.
  - A model without image input gets no screenshot tool and no auto screenshots.
- **D7: Live view and takeover are part of the manager.**
  - `live(profileId)` gives a `ReadableStream` of frames: screencast with acks, or polling at
    2 fps when the hash changed. It also gives `input(event)` (mouse, key, text, navigate), plus
    `takeOver()` and `handBack()`.
  - Input is refused unless that viewer took over.
  - While a person controls the browser, the agent's acting tools answer `BUSY:`. Read-only tools
    keep working.
  - `handBack` invalidates refs. One lease per profile; a second session gets `BUSY:`.
- **D8: No evasion in the library.**
  - The library ships no CAPTCHA solving and no fingerprint spoofing.
  - CAPTCHA and 2FA go through `browser_request_human` (an `externalTool()` that parks the turn)
    and a person.
  - Apps may choose a stealth engine via `executablePath` or a hosted service's own option. The
    guide says plainly that none is reliable.
- **D9: Camoufox is a separate package** (`@eharness/browser-camoufox`, ring 2), because it needs
  `playwright-core` (hard rule 10). It implements the same `BrowserConnection` with polled frames and
  `page.mouse` takeover. Phase G designs it; its own plan builds it.
- **D10: Security defaults.**
  - Acting and `browser_eval` default to `external` risk; eval is off unless enabled.
  - Private, loopback and link-local hosts are blocked unless allowed. A profile's `allowDomains`
    is checked before navigation and after every action.
  - CDP URLs and headers are secret fields sealed with the app's vault. Runtimes never bind beyond
    loopback.
  - `extraArgs` is an allowlist; `--remote-debugging-address` and `--user-data-dir` are refused.
- **D11: Docs over presets.** There is no "stealth preset" or provider presets in the library.
  The guide shows how to point a manual profile at Browserbase, Kernel, Steel or a container.

## Team example: profiles, modes and the Browser page

### Data

- Table `browser_profiles` holds `id`, `name`, `adapter`, `mode`, `settings_json` (secret fields
  sealed), `allow_domains`, `created_by`, `created_at`, `updated_at`. It is a drizzle migration
  implementing `BrowserProfileStore`, and must pass the conformance suite.
- Agent assignment is done by the Browser connector (a connection per agent naming a profile id).
- The runtime root is `TEAM_BROWSER_ROOT`, default `<data dir>/browser`. It holds
  `chrome/<version>/`, `lightpanda/<version>/` and `profiles/<profileId>/`. It is never inside the
  database and is safe to delete: logins are lost, profiles stay.
- Env:
  - `TEAM_BROWSER_DRIVER`: `off` | `local`. The default is `local` when the root is writable.
  - `TEAM_BROWSER_XVFB=1`: headed Chrome on Linux servers.
  - `TEAM_BROWSER_MAX=4`: concurrent running profiles.

### Server

- One `BrowserManager` at boot, with `chromeAdapter({ managed: chromeRuntime(...) })` and
  `lightpandaAdapter({ managed: lightpandaRuntime(...) })` when the driver is `local`, manual-only
  otherwise.
- Routes (`src/http/routes/browser.ts`, admin only except live viewing):
  - `GET /browser/adapters`: adapters, modes, `forms()` and per-runtime status.
  - `GET|POST|PATCH|DELETE /browser/profiles`: the public profile, with secrets redacted.
  - `POST /browser/profiles/:id/test`.
  - `POST /browser/runtimes/:adapter/install` (progress over SSE), `/uninstall`, `GET …/status`.
  - `POST /browser/profiles/:id/start` and `/stop`.
  - `GET /browser/profiles/:id/live`: WebSocket through Hono `upgradeWebSocket` on Bun. Binary JPEG
    frames go out with a small JSON header; input, take-over and hand-back come in as JSON. Auth is
    by the session cookie; viewers see frames, and only admins and the agent's owners may take over.
  - `GET /browser/profiles/:id/shots`: recent screenshots from the library.
- The Browser connector (`src/app/connectors.ts`) assigns one profile to the agent. Activation adds
  `browser({ manager, profile })` and maps tool risks to the agent's permission mode.
- `browser_request_human` uses `requestHuman` → `startHandoff({ kind: 'takeover' })` (spec 32). The
  decision center shows a card with **Open browser**; channel notices follow the existing handoff
  notify. **Give back** on the page resolves the handoff with `formatHandBack`.

### Web (`/browser`)

1. **List.** Profiles show their adapter, mode, a state badge (`Missing` / `Ready` / `Running` /
   `In use by <agent>` / `Controlled by <person>`), assigned agents, and the last screenshot as a
   thumbnail.
2. **New profile wizard.**
   1. Name.
   2. Adapter cards: Chrome, Lightpanda, plus Camoufox when installed. Each card shows its
      capabilities (live view, takeover, persistent login). Unavailable ones say why ("Lightpanda is
      not available on Windows", "managed mode is off on this server").
   3. Mode: **Connect to an existing browser** (manual) or **Run it on this server** (managed); only
      offered modes are shown.
   4. The adapter's form for that mode, rendered from `forms()` with secrets as password fields.
      Manual mode has **Test connection**. Managed mode shows the runtime card.
   5. Done: optionally open live view to log in once.
3. **Runtime card (managed).**
   - State machine: `Missing → Downloading (bytes / total) → Ready → Starting → Running`, with
     Stop, Update and Remove.
   - It shows the version and disk size. A failure shows the error text and a retry.
4. **Profile detail.**
   - A live `<canvas>` sized to the frame, with letterboxing and coordinate mapping to CSS pixels.
   - **Take control** / **Give back**. A banner shows who controls the browser.
   - While in control: keyboard capture with a visible focus ring, a paste box (sends `text`), and a
     URL bar (sends `navigate`; domain rules apply).
   - An external live URL (hosted services) is shown in an iframe instead.
   - Side panel: the agent's recent browser actions (from activity), screenshots, settings.
5. **Nav.** Add a Browser section, admin only, visible when the driver is not `off` or a profile exists.

## Phases and checklist

### A. Contract

- [x] Research: control layers, engines, hosted services, live view, screenshots for vision (table above)
- [x] Spec 35, ADR-0064 (Proposed), this plan, board row, spec and ADR index rows
- [x] Owner review; ADR-0064 → Accepted; CLAUDE.md layout and hard rule 4; `check-imports` lists

### B. CDP core (`src/browser/cdp/*`)

- [x] `client.ts`: request ids, timeouts, abort, events, flattened sessions, `/json/version`, close
      handling, no reconnect (a lease reopens)
- [x] `fake-peer.ts` (exported from `eharness/testing`): an in-memory WebSocket peer that replays
      recorded responses (AX trees, box models, hit tests, frames) and records sent commands
- [x] `snapshot.ts`: AX tree → outline, roles, refs, snapshot ids, loader-id staleness,
      `clickable` pass, scope, cap and offset with a kept tail
- [x] `act.ts`: scroll, box centre with frame offset, hit test, mouse sequence, `el.click()` fallback,
      fill/type/press/select/check/uncheck/scroll/wait, settle rule
- [x] `shot.ts` (JPEG/PNG, `maxWidth`, full page cap, element clip, SHA-1 hash), `read.ts`
      (constant extractor, cap and offset), `tabs.ts`
- [x] `live.ts`: screencast with ack-on-read backpressure, poll mode, `LiveInput` → `Input.*` mapping

### C. Module surface (`src/browser/*`)

- [x] `adapter.ts`: `defineBrowserAdapter`, `createBrowserRegistry`, `forms()` via the providers form builder
- [x] `adapters/chrome.ts`, `adapters/lightpanda.ts` (settings schemas per mode, capabilities)
- [x] `profiles.ts`: `BrowserProfileStore`, `memoryBrowserProfileStore`, `sealedBrowserProfiles`,
      `publicProfile`; `browserProfileStoreConformance` in `eharness/testing`
- [x] `manager.ts`: leases, idle release, `maxLeases`, `test()`, `runtime()`, `live()`, controller
      rules, `close()`
- [x] `plugin.ts` and `texts.ts`: capability-driven tool list, framing, media references and the
      `inModel` window, modality check, `autoSnapshot` / `screenshots.auto`, `browser_request_human`
      as `externalTool()`, `formatHandBack`, domain rules, the `browser` service
- [x] `index.ts` exports, exports snapshot, changeset (`minor`, Draft subpath)

### D. Node runtimes (`src/browser/node/*`)

- [x] `download.ts`: fetch with progress, a temp file, atomic rename, `unzip`/`ditto`, exec bit,
      quarantine removal, install lock, partial-download cleanup
- [x] `chrome.ts`: Chrome for Testing JSON and platform pick, launch flags, `DevToolsActivePort`,
      headless/headed, `xvfb-run`, `--no-sandbox` rule, `Browser.close` then kill, `removeProfileData`
- [x] `lightpanda.ts`: release asset pick, `serve` on loopback with a free port, telemetry off,
      Windows status
- [x] Unit tests with an injected `fetch` and a fake process launcher; real runs only with
      `EH_BROWSER_E2E=1`

### E. Team example

- [x] Migration + `BrowserProfileStore` adapter + conformance test
- [x] Boot wiring, env, routes, live WebSocket, SSE install progress
- [x] Browser connector and activation; risk mapping
- [x] `takeover` handoff, decision center card, hand back resolution
- [x] Web: nav, list, wizard, runtime card, detail with live canvas and takeover, screenshots panel
- [x] Settings page: browser driver status (as the code sandbox status)
- [x] E2E (Playwright in the team's e2e suite): create a managed Chrome profile → download → start
      → an agent opens a local fixture page and clicks → a person takes control, types, gives back →
      the agent continues and sees the change in its next snapshot and screenshot

### F. Remote runtime (sandbox server)

- [x] `examples/sandbox-server`: an image variant with Chromium + Xvfb (build arg
      `SANDBOX_BROWSER_LIBS=1`, default off; `SANDBOX_BROWSER=1` turns the routes on), `/v1/browser`
      routes (install, start, stop, uninstall, status, usage), CDP proxied only through the
      authenticated server (WebSocket proxy, signed short-lived query token); `remoteBrowserRuntime`
      client
- [x] Team: the Remote sandbox connection can host managed profiles (`mode: managed`, `runtime:
      "remote"` in the create body, stored in `metadata.runtime`); the wizard and profile pages show
      where it runs; the engine has its own card (`chrome@remote`)

### G. Camoufox package design and docs

- [x] Design note for `@eharness/browser-camoufox` (pinned release, persistent context per profile,
      polled frames, takeover via `page.mouse` / `page.keyboard`, no telemetry)
- [x] Guide `docs/guides/browser-agents.md`: adapters and modes, hosted services as manual
      profiles, profiles and logins, screenshots and token cost, takeover, security, why no
      CAPTCHA solving
- [x] `docs/architecture.md` row, examples README, production checklist entry

## Execution

Work in waves, following the release workflow: commit to `main`, no per-phase branch, one release
for the batch.

- **Wave 1:** B (the CDP core).
- **Wave 2:** C and D in parallel (two subagents).
- **Wave 3:** E (team server, then web).
- **Wave 4:** F and G.

Subagents develop without running the full suite. Each wave ends with one gate run by the
maintainer:

```bash
bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports
```

After each wave, check for leftover Chrome or Lightpanda processes and ports.

## Acceptance criteria

- [ ] A session on a Chrome profile completes open → snapshot → act → screenshot. The next step's
      model input contains the screenshot image for a vision model, and text only otherwise.
- [ ] Stale refs, covered elements, blocked domains, a busy profile and a person in control all
      give readable strings; no tool throws.
- [ ] Live view shows a page change within 1 s (screencast). Input is refused until the viewer took
      over. Hand back resumes a parked `browser_request_human` turn.
- [ ] Managed Chrome downloads, starts and keeps a login across restarts on macOS arm64 and Linux
      x64 (headless and Xvfb).
- [ ] Lightpanda manual and managed profiles work with snapshot, act and polled live view.
- [ ] A manual profile pointed at a hosted CDP endpoint works with the same tools (tested once by
      the maintainer; not in CI).
- [ ] No new runtime dependency; `check:imports` passes with `browser/node/` as the only Node-only part.
- [ ] Gate green; changeset added; spec 35 updated wherever the code differs.

## Owner decisions (2026-10-14)

- **Open questions answered:** (1) OOPIF later; a ref inside a cross-site iframe answers a readable
  "not supported yet" string instead of a guess. (2) Per-process leases are enough (one server).
  (3) `browser_act` stays `external` (ask) by default; a profile an admin marks **trusted** lets
  its acting tools run without asking. (4) One profile per agent by default; sharing is allowed and
  serial. (5) Downloads and uploads are a later plan.
- **Resources are visible, not capped low:** `TEAM_BROWSER_MAX` stays 4; the Browser page and the
  runtime card show each running profile's memory (RSS of the engine process tree) and CPU, the
  total, and the server's free memory, so people judge it themselves while they try it.
- **Container:** the team Dockerfile documents the Chrome system libraries for a managed profile
  (or `TEAM_BROWSER_DRIVER=off`), and `--no-sandbox` only inside a container (detected), never on a
  desktop.
- **Long-run jobs (P49):** a profile lease survives the checkpoint between chunks of a long job (it
  is released on idle, not at every turn end); after a restart the agent re-opens the browser and
  starts with a fresh snapshot (old refs are stale).

## Open questions (answered above)

1. Out-of-process iframes (cross-site embeds, many login widgets): the first version covers the main
   frame and same-process iframes. Add OOPIF in B, or later?
2. Leases are per process. That is enough for the team app today (one server). Do we need a
   store-backed lease for multi-instance deployments?
3. `browser_act` risk: the conservative default is `external` (ask). Should the team default be
   lower for profiles an admin marked as trusted?
4. One profile shared by several agents: the lock makes it safe but serial. Is that acceptable, or
   should the team create one profile per agent by default?
5. Downloads and uploads (a report from a portal, a file into a form): later phase, through the
   virtual file system. Confirm they are out of scope for this plan.

## Requests to other phases

(empty)

## Real-Chrome check (2026-10-14, macOS arm64, Chrome for Testing 155)

Done by hand instead of a Playwright suite in CI (a real download per run):
- `EH_BROWSER_E2E=1` runtime test: install (about 360 MB unpacked), start, usage, stop: pass.
- CDP flow on a local fixture: snapshot with refs, fill, click, read ("Hello, Vian"), screenshot,
  `STALE:` for an old ref after navigation, a live frame, about 0.7–0.9 GB RSS for one Chrome.
- Team app: wizard (Ready engine) → profile → start → live view → Take control → URL bar
  navigation (frames stream) → Give back.
- Fixed from it: headless Chrome now opens at 1280×800 (was 800×600); a ref that was never
  listed gets a precise message; the Vite dev proxy forwards WebSockets (`ws: true`); boolean
  fields of SchemaForm no longer bind `undefined` (the profile page crashed, new profiles were
  saved headed); a browser a person only watches is "Running", not "In use by an agent".

## Lightpanda and token-auth check (2026-10-14, owner's dev app)

- Lightpanda attaches a new tab by itself (auto-attach) and sends that page's events only to that
  session: the CDP client now reuses an auto-attached session instead of attaching a second one
  (navigation used to wait for a load event that never came).
- Lightpanda takes PNG screenshots only: a refused JPEG is retried as PNG and remembered per
  connection (screenshots and the polled live view).
- Lightpanda's picture is approximate (its layout boxes do not match the drawn page), so the live
  view says clicks on it can miss; the address bar, paste box and keyboard work.
- With token auth a browser cannot send the bearer token on a WebSocket: the page asks for a
  one-time ticket (`POST /browser/profiles/{id}/live-ticket`, one minute, one use, one profile) and
  opens the live view with `?ticket=`.
- The Browser connector's profile is a dropdown of the Browser page's profiles; empty means the
  only profile when there is one, so a new connection works without a choice.

