# Browser agents: let the agent use a real browser

`eharness/browser` gives an agent a browser. It opens pages, reads them as an accessibility
snapshot with element refs, clicks and types by ref, and sees screenshots in its next step. A person
can watch the same browser live and take it over for a login, a CAPTCHA or a 2FA prompt, then hand
it back. The contract is [spec 35](../specs/35-browser.md); the design is
[ADR-0064](../decisions/0064-browser-module.md); the plan is [P48](../plans/P48-browser.md). The
subpath is a **draft**: every symbol may change in a minor release
([API stability](../engineering/api-stability.md)).

It speaks the Chrome DevTools Protocol (CDP) over a WebSocket with no dependency, so it works with
Chrome, Chromium, Lightpanda and every hosted browser service. It does not bundle a browser: engines
are separate processes that you point at, or that the app downloads at runtime.

## 1. A first agent

```ts
import { createAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import {
  browser,
  chromeAdapter,
  createBrowserManager,
  createBrowserRegistry,
  memoryBrowserProfileStore,
} from 'eharness/browser'
import { chromeRuntime } from 'eharness/browser/node'

const registry = createBrowserRegistry([
  chromeAdapter({ managed: chromeRuntime({ root: './data/browser' }) }),
])
const profiles = memoryBrowserProfileStore()
const manager = createBrowserManager({ registry, profiles })

// A profile is data: a name, an adapter, a mode and the adapter's settings.
const profile = await profiles.create({
  name: 'research',
  adapter: 'chrome',
  mode: 'managed',
  settings: {},
})

const agent = createAgent({
  model,
  plugins: [
    filesystem({ fs: memoryFs() }), // screenshots are files; register this first
    browser({ manager, profile: profile.id, images: true }),
  ],
})
```

Notes:

- `profiles` is the store you passed to the manager; any `BrowserProfileStore` works (the team example
  uses SQLite). Wrap it with `sealedBrowserProfiles({ store, vault, registry })` so secret fields
  (CDP URLs, headers) are encrypted at rest.
- `profile` is a profile id, or a function of the context when the profile depends on the agent. An
  `undefined` result means the tools are not registered for that session.
- `images` says whether the model accepts images (from the model catalog,
  [spec 12](../specs/12-models-and-cost.md)). A text-only model gets no screenshot tool.
- Call `await manager.close()` when the process ends: it releases every lease and stops the engines
  this manager started.

## 2. Adapters and modes

A **profile** names an adapter and a mode, and the adapter declares its own settings per mode.

| Mode | What it means | Example |
|---|---|---|
| `manual` | connect to an endpoint someone else runs | a Chrome you started, a container, a hosted service |
| `managed` | the app downloads, prepares and starts the engine | Chrome for Testing or Lightpanda on the same server |

A mode is offered only when the adapter has it. An app that passes no runtime gets a manual-only
`chrome`. `registry.forms(id)` returns a form description for each mode (labels, groups, secret
fields) that a UI can render.

### Manual: point at a CDP endpoint

The `chrome` adapter takes `cdpUrl` (a secret), optional `headers` (secret values) and an optional
`liveUrl`. The URL can be `ws://` or `wss://`, or `http://host:port` (the module resolves it through
`/json/version`).

- **Your own Chrome.** Start it with a debugging port and a user-data directory that is not the
  default one: `google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/agent-profile`.
  Since Chrome 136 remote debugging is refused on the default profile. Use
  `http://127.0.0.1:9222`. Anyone who can reach that port controls the browser, so bind it to
  loopback.
- **A container** such as `browserless/chrome`: use its WebSocket URL (with its token in the query
  string, which makes the URL a secret).
- **Hosted services** such as Browserbase, Kernel, Steel, Anchor Browser and Browser Use: each one
  gives a CDP WebSocket URL when you create a session or with an API key. Paste it as `cdpUrl`. Some
  offer a live view page; put it in `liveUrl` and the team app shows it in an iframe. The library
  ships no provider presets, because their session APIs change: read the provider's docs for the URL
  format ([ADR-0064 D11](../decisions/0064-browser-module.md)).

```ts
const hosted = await profiles.create({
  name: 'hosted',
  adapter: 'chrome',
  mode: 'manual',
  settings: { cdpUrl: 'wss://connect.example.com?apiKey=...' },
})
const test = await manager.test(hosted) // { ok: true, version } or { ok: false, error }
```

A hosted session usually lives only as long as the provider keeps it, so persistence of logins is
the provider's setting, not the library's (`persistentProfile` is `false` in manual mode).

### Managed Chrome

`chromeRuntime({ root })` downloads Chrome for Testing the first time (`runtime.install()` with
progress), then starts one Chrome per profile.

- **Platforms.** `linux64`, `linux-arm64`, `mac-arm64`, `mac-x64`, `win64`. Extraction uses the
  system `unzip` (macOS falls back to `ditto`), the macOS quarantine attribute is removed, and the
  version is checked.
- **Where things live.** `<root>/chrome/<version>/` is the engine; `<root>/profiles/<profileId>/` is
  that profile's Chrome user-data directory (cookies, local storage). The root is a cache: deleting it
  loses downloads and logins, not the profile records.
- **Already have Chrome?** `executablePath` skips the download (a system Chrome, Edge, or another
  Chromium build).
- **Headless or headed.** Headless (`--headless=new`) is the default. On a Linux server with no
  display, headed Chrome needs `xvfb: true` (runs under `xvfb-run -a`); without it the runtime fails
  with a readable error instead of hanging.
- **Containers.** Chrome needs system libraries (`libnss3`, `libgbm1`, `libatk1.0-0`, `libxkbcommon0`,
  fonts and a few more). The team Dockerfile lists them under the build argument `TEAM_BROWSER_LIBS`.
  `--no-sandbox` is added only when the runtime detects a container (`/.dockerenv` and similar),
  never on a desktop. Override with `inContainer`.
- **Port and loopback.** Chrome starts with `--remote-debugging-port=0` bound to `127.0.0.1`, and the
  runtime reads the chosen port from `DevToolsActivePort`. The debugging port is never exposed
  beyond loopback, and `extraArgs` refuses flags that move or expose it.
- **Stop and crashes.** Stop sends `Browser.close`, then kills the process after 5 s. After a crash
  the runtime clears stale `Singleton*` locks and kills an orphan engine of the same profile before it
  starts again.

Profile settings: `headless`, `windowSize` (default `1280x800`), `proxy`, `locale`, `extraArgs` (an
allowlist: `--lang`, `--window-size`, `--proxy-server`, `--force-device-scale-factor`,
`--disable-gpu`).

### Managed Lightpanda

`lightpandaAdapter({ managed: lightpandaRuntime({ root }) })` runs [Lightpanda](https://lightpanda.io),
a small headless browser built for automation. It needs no system libraries and uses little memory.
The trade-offs:

- Linux and macOS (x86_64 and aarch64) only. On Windows `status()` says it is not available.
- Rendering fidelity is lower than Chrome's, and JavaScript-heavy sites may not work.
- Screenshots are PNG, there is no screencast (the live view is a poll of about 2 frames per
  second), no tabs, and no persistent profile.
- It is AGPL-3.0. The runtime downloads the release binary on your server and runs it unmodified as
  a separate process; the npm package never contains it. Check that this fits your licensing.
- Telemetry is switched off for you (`LIGHTPANDA_DISABLE_TELEMETRY=true`).

Use Lightpanda for reading pages and simple forms; use Chrome when the site is complex or you need a
persistent login.

## 3. Profiles and persistent logins

A managed Chrome profile keeps its own user-data directory, so a login survives restarts. The usual
flow is:

1. Create a managed Chrome profile.
2. Open the live view (section 6), take control, and log in to the site once, including 2FA.
3. Give the profile to an agent. The agent starts already logged in.

Rules that follow from this:

- **One holder per profile.** A second session that asks for a busy profile gets `BUSY: profile
  "<name>" is used by another session.` Give each agent its own profile, so logins do not mix.
- **The lease lives with the session, not the turn.** The browser opens on the first tool call and is
  released after `idleMs` (default 5 minutes) of no tool calls and no live input, or by
  `service.release()`. It is not released at the end of a turn.
- **Limits.** `maxLeases` (default 8) bounds how many browsers are open at once.
- **Deleting a profile** calls `runtime.removeProfileData(id)`: the logins go with it.

## 4. The tools

The tool list is decided when the session opens, from the adapter's capabilities, so the prompt-cache
prefix stays stable. In this fixed order:

| Tool | What it does | Default risk |
|---|---|---|
| `browser_open` | open a URL, or go `back`, `forward`, `reload` | `read` |
| `browser_snapshot` | the page as an outline with refs; `scope`, `interactive`, `offset` | `read` |
| `browser_act` | `click`, `double_click`, `hover`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `scroll`, `wait` on a ref | `external` |
| `browser_screenshot` | an image of the viewport, a full page or one ref | `read` |
| `browser_read` | the page as plain text with links, with an offset | `read` |
| `browser_tabs` | list, open, switch, close tabs (Chrome) | `read` |
| `browser_request_human` | ask a person to take over; the turn waits | `read` |
| `browser_eval` | run JavaScript; off unless `allowEval: true` | `external` |

### Snapshots and refs

A snapshot is an indented outline of the page's accessibility tree:

```
- heading "Checkout" [level=1]
- textbox "Email" [ref=e3]
- button "Pay now" [ref=e5]
```

The model passes a ref to `browser_act` (`{ ref: 'e5', kind: 'click' }`). Buttons built from plain
`div`s are found by a second pass and shown as `clickable`. Output is capped at 20 000 characters; a
long page ends with a note and `offset` continues it.

A ref is tied to the snapshot and the page document it came from. This is why a click does not land on
the wrong element:

- **`STALE:`** the page navigated or reloaded since the snapshot. The model must take a new snapshot.
  A ref keeps its number while its element is still on the same page.
- **`BLOCKED:`** another element covers the target, for example `BLOCKED: dialog "Cookies" covers e5`.
  The tool does not click; the model closes the cookie banner or dialog first.
- **`BUSY:`** a person controls the browser, or another session holds the profile.
- **`ERROR:`** anything else expected (timeout, element gone, an unsupported cross-site iframe).

Expected failures are strings the model reads and corrects; no tool throws.

### Screenshots and token cost

A screenshot is written to `/.browser/shots/` in the virtual file system and the tool result is a media
reference ([spec 08 §12](../specs/08-filesystem-plugin.md)). The stored message holds no base64, and the
model sees the image in its next step, the same loop as a provider computer-use tool.

Images cost tokens, so the defaults are conservative:

- JPEG at quality 70, at most 1280 px wide (never scaled up). Lightpanda produces PNG.
- Only the **newest 3** screenshots of the session are sent as images; older ones become a text line.
  Change it with `screenshots.inModel`.
- `screenshots.auto: 'changed'` (the default) attaches a screenshot to `browser_open` and
  `browser_act` results only when the picture changed since the last one sent. Use `'off'` for
  text-first agents, or `'always'` for debugging.
- Files beyond `screenshots.keep` (default 50) are deleted.
- `autoSnapshot: 'changed'` (the default) attaches a fresh snapshot when the page changed, which
  saves a call per step. Set `'off'` if snapshots are large for your sites.

Prefer snapshots and `browser_read` for text; use screenshots for layout, charts and canvases.

## 5. Live view, take over and request human

`manager.live(profileId, { id })` returns a channel with a stream of frames and an `input()` method.
Chrome gives a screencast (JPEG, with backpressure); Lightpanda is polled; hosted services may give a
`liveUrl` to embed instead. An app turns this into a canvas, as the team app's Browser page does.

- A viewer only watches until it calls `takeOver()`. Input (`mouse`, `key`, `text`, `navigate`) is
  refused unless that viewer took over.
- While a person controls the browser, the agent's acting tools answer `BUSY:`; read-only tools still
  work. `handBack()` returns control and clears the agent's refs.
- A viewer that closes the page while in control hands back automatically.

**`browser_request_human`** is for logins, CAPTCHAs and 2FA. The agent calls it with a reason; the
browser switches to the person and the turn parks (an `externalTool()`, [spec 11](../specs/11-interaction.md)).
The app's `requestHuman` callback notifies someone (the team app opens a `takeover` handoff with an
**Open browser** button). When the person hands back, the app resolves the wait with
`formatHandBack(info)`, for example `Dana handed the browser back · page "Dashboard" https://...`. The
agent then takes a new snapshot. Without a `requestHuman` callback the tool is not registered.

## 6. Security

- **Page text is untrusted.** Snapshots, read output, titles and eval results are framed with
  `untrustedContent()` ([spec 03](../specs/03-messages.md)). A page that says "ignore
  your instructions" is data. Instructions on a page never change permissions.
- **Acting is `external` risk by default.** With the [permissions plugin](permissions.md) the user is
  asked before `browser_act` and `browser_eval`. An admin can mark a profile `trusted: true` to lower
  them to `write`, for a profile that only logs in to a few known sites. Use it sparingly: a logged-in
  browser can spend money or send mail. Override per tool with the plugin's `risk` option.
- **Domains.** `allowDomains` on the profile (and `limits.denyDomains`) is checked before every
  navigation and after every action. A page that ended on a blocked host is replaced with
  `about:blank`. Private, loopback and link-local hosts are blocked by default
  (`allowPrivateHosts: false`), as in `web_fetch`. Sub-resource requests are not filtered. For an
  agent that handles a login, set `allowDomains` to the site's domains.
- **Endpoints are credentials.** A CDP URL gives full control of a browser. Settings fields for URL and
  headers are secret: sealed with a `SecretVault`, never logged, never returned by `publicProfile()`.
  Editing a profile without resending secrets keeps them; sending a new URL drops the stored headers.
- **Loopback only.** Managed engines bind to `127.0.0.1`. The live view is served by your own routes,
  behind your own auth; do not forward the debugging port.
- **Eval is off by default.**

## 7. Resources

A managed Chrome profile is a full browser: expect roughly 300 to 800 MB of memory and a share of a
CPU core while a page is active, and more on heavy sites. Lightpanda is far smaller. The manager does
not cap this low; it shows it:

- `manager.usage()` lists each running managed profile's memory (RSS of the engine process tree) and
  CPU, the totals, and the machine's memory when you pass `systemMemory` (from
  `eharness/browser/node`).
- `limits.maxLeases` bounds browsers open at once; the team example exposes it as `TEAM_BROWSER_MAX`
  (default 4).
- Idle browsers stop after `idleMs` (`stopOnIdle` is on by default), and logins stay in the profile.

Size the server for `max` browsers at once, and watch free memory on small hosts.

## 8. Why no CAPTCHA solving or fingerprint spoofing

The library does not solve CAPTCHAs and does not hide that the browser is automated
([ADR-0064 D8](../decisions/0064-browser-module.md)). No engine avoids detection reliably, the
techniques age quickly, and the better tools are paid services or abandoned projects with unclear
licences. A CAPTCHA or 2FA is a person's job: the agent calls `browser_request_human`, a person solves
it in the live view and hands back. If your use case needs a stealth Chromium build or a provider's
own anti-detection option, you can still use one: pass its binary as `executablePath`, or use the
provider's manual endpoint. That choice, and its legal and terms-of-service questions, is yours. Always
respect a site's terms and use accounts you own.

## 9. Long jobs

The lease belongs to the session, so a [long-running job](chunked-work.md) that stops at a checkpoint
and resumes in a later turn keeps its logged-in browser as long as it stays active within `idleMs`. If the
process restarts, the engine and the lease are gone: the first browser call re-opens the profile
(a managed profile keeps its login), the agent starts from a fresh snapshot, and old refs answer
`STALE:`. Write the job's state to files, not to the page (see
[P49](../plans/P49-long-run.md) for the long-run plan).

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `DevTools remote debugging requires a non-default data directory` | Chrome 136 and later refuse debugging on the default profile. Start your own Chrome with `--user-data-dir=<new dir>`, or use a managed profile (it always does). |
| `ERROR: the browser could not start (... error while loading shared libraries ...)` | Missing system libraries on a Linux server or container. Install `libnss3`, `libgbm1`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxrandr2`, `libasound2` (`libasound2t64` on newer Debian and Ubuntu), `fonts-liberation`, or use the team image with `TEAM_BROWSER_LIBS=1`. |
| Headed Chrome fails on a server with "no display" | Set `xvfb: true` (team: `TEAM_BROWSER_XVFB=1`) and install `xvfb` and `xauth`, or stay headless. |
| macOS: "cannot be opened because the developer cannot be verified" | The quarantine attribute. The runtime removes it; if you moved the folder yourself, run `xattr -dr com.apple.quarantine <root>/chrome`. |
| The install hangs or fails at extract | `unzip` is missing (install it; macOS uses `ditto`). A stuck install lock is released by restarting; partial downloads are cleaned. |
| Timeout waiting for `DevToolsActivePort` | Chrome started with `--remote-debugging-port=0` and never wrote its port: a stale lock or a crash on start. The runtime clears dead locks; check for a leftover Chrome with the same `--user-data-dir` and that the profile directory is writable. A container without `--no-sandbox` also fails here; the runtime adds it when it detects a container. |
| `BUSY: profile ... is used by another session` | One holder per profile. Wait, release, or use a second profile. |
| `BUSY: a person is controlling the browser` | Hand back in the live view, or the agent can call `browser_request_human`. |
| `STALE:` on every click | The page changes between the snapshot and the act (a SPA re-render). Take a new snapshot and act on its refs straight away. |
| `BLOCKED: ... covers e5` | A banner or dialog is in the way: close it first. |
| `ERROR: ... cross-site iframe ... not supported yet` | Out-of-process iframes (embedded widgets) are not covered in this version; use the page's own URL or a person's takeover. |
| Hosted service connects, then drops | Its sessions expire. Create a new session and update the profile's `cdpUrl`. |
| No screenshot tool | The model has no image input (`images: false`), there is no `filesystem()` plugin, or the adapter has no screenshot capability. |

## Where next

- [Spec 35](../specs/35-browser.md) is the full contract, including the `BrowserConnection` that adapters
  implement.
- [Camoufox adapter design](../plans/P48-camoufox-design.md) covers the planned separate package.
- [Connectors](connectors.md) and the [team example](../../examples/team/README.md#browser) show profiles
  assigned to agents through a Browser connector.
- [Production checklist](production-checklist.md#security) covers the browser items.
