# P48 appendix: design of `@eharness/browser-camoufox`

Status: design only (phase G of [P48](P48-browser.md)); not built. A separate plan will build it.
Relates to [spec 35 §9](../specs/35-browser.md), [ADR-0064](../decisions/0064-browser-module.md) D2 and D9,
and [ADR-0062](../decisions/0062-platform-rings-and-rule-of-two.md) (ring 2).

## Why a separate package

[Camoufox](https://github.com/daijro/camoufox) is a Firefox build with its own anti-fingerprinting
patches. Playwright drives it over its Juggler protocol, not CDP, so the library's CDP core cannot talk to it.
Doing so needs `playwright-core`, and the library takes no new runtime dependency (hard rule 10).
So it ships as `@eharness/browser-camoufox` (ring 2), with `playwright-core` as **its own**
dependency. The library stays free of it, and an app that does not want it never installs it. It implements the
same `BrowserConnection` (spec 35 §4), so the plugin, manager, live view and the team UI work unchanged.

The package is a convenience for people who already chose Camoufox. The library still ships no evasion
(D8) and the guide says plainly that no engine avoids detection reliably.

## Public surface

```ts
import { camoufoxAdapter } from '@eharness/browser-camoufox'
import { camoufoxRuntime } from '@eharness/browser-camoufox/node'   // managed mode, Node-only

createBrowserRegistry([
  chromeAdapter({ managed: chromeRuntime({ root }) }),
  camoufoxAdapter({ managed: camoufoxRuntime({ root }) }),
])
```

`camoufoxAdapter({ managed? }): BrowserAdapter` built with `defineBrowserAdapter`, adapter id `camoufox`.

- **Manual mode.** Settings: `wsEndpoint` (secret, a Playwright server URL, `ws://` or `wss://`),
  optional `headers` (secret values), optional `liveUrl`. The endpoint is `{ protocol: 'playwright-ws', url, headers }`.
  `connect` calls `firefox.connect(url, { headers })`.
- **Managed mode.** The runtime launches Camoufox itself (below) and the adapter attaches to it. Settings:
  `headless?` (default `true`), `windowSize`, `proxy?`, `locale?`, `os?` (the fingerprint OS Camoufox picks
  from), `humanize?`. Anything that would turn off Camoufox's own safeguards is not offered.
- **Capabilities.** `snapshot`, `screenshot`, `tabs` true; `takeover` true; `liveView: 'poll'`;
  `persistentProfile` true in managed mode and false in manual mode.

## Managed runtime

- **Pinned release.** The runtime pins one Camoufox release (a version constant in the package,
  bumped by a release of the package) and downloads that asset for the platform (Linux, macOS and Windows,
  x64 and arm64) into `<root>/camoufox/<version>/`. It never follows "latest": Camoufox is under
  development and beta builds break. It verifies a checksum from the release when one exists, else
  it records the size. The download is large (about 1.3 GB), so the runtime card shows progress and
  size, as for Chrome. Extraction, executable bit and macOS quarantine removal reuse the library's
  download helpers where public, otherwise the package carries its own small copy.
- **Persistent context per profile.** One `firefox.launchPersistentContext(userDataDir, options)` per
  profile, with `userDataDir = <root>/profiles/<profileId>` and `executablePath` set to the pinned
  Camoufox binary. Cookies and local storage therefore survive restarts as they do for Chrome.
- **Idempotent start, one process per profile**, a pid file and orphan cleanup as in `chromeRuntime`.
- **No telemetry.** The package disables anything that phones home (the crash reporter and update
  checks of the Camoufox/Firefox build and of the Node wrapper), sets the relevant environment variables and
  preferences, and has a test that fails if a start would contact a host other than the target page.
  It uses no `camoufox-js` helper that downloads or reports on its own.
- **Loopback only.** If a Playwright server is started, it binds to `127.0.0.1`.
- **Licence.** Camoufox is MPL-2.0. It is downloaded at runtime and not bundled into the npm package.

## The `BrowserConnection` it implements

Same interface as the CDP connection (spec 35 §4); the mapping to Playwright:

| Operation | Implementation |
|---|---|
| `navigate` | `page.goto`, `goBack`, `goForward`, `reload`; domain rules checked before, and after settle |
| `snapshot` | an accessibility tree from `page.accessibility.snapshot()` or an injected ARIA snapshot; refs `e<n>` map to `(snapshotId, frame, element handle)`; stale when the document changed (`STALE:` text as in the CDP core) |
| `act` | locate by ref, scroll into view, bounding box centre, hit test with `document.elementFromPoint` for `BLOCKED:`, then `page.mouse` move, down, up; `fill` through `locator.fill`; `press` through `page.keyboard` |
| `screenshot` | `page.screenshot({ type: 'jpeg', quality: 70 })`, scaled to `maxWidth` 1280, SHA-1 hash from `crypto.subtle` |
| `read` | the same constant text extractor, run with `page.evaluate` |
| `tabs` | `context.pages()`, `newPage`, `bringToFront`, `close` |
| `live` | polled frames (below) |
| `onClose` | `browser.on('disconnected')` / `context.on('close')` |

Error strings, the 20 000-character snapshot cap and offsets, the settle rule (network idle or 2 s) and the
`BLOCKED:` / `STALE:` / `BUSY:` texts match the CDP core, so the model sees one behaviour. The shared
pure parts (outline formatting, ref table, text extractor, domain rules) move into a small public
helper surface of `eharness/browser` first, if they are not exported already, so the package does not
copy them.

## Live view and takeover

Firefox over Playwright has no screencast API. The connection polls a screenshot every 500 ms and emits a
frame only when the hash changed (the `poll` mode of spec 35 §7), JPEG at quality 60. Takeover input from a
person is mapped from `LiveInput`:

- `mouse` events to `page.mouse.move`, `down`, `up` and `wheel`;
- `key` events to `page.keyboard.down`, `up` and `press`;
- `text` to `page.keyboard.insertText`;
- `navigate` to `page.goto`, with the domain rules.

The controller flag, the `BUSY:` answers and the hand-back that clears refs come from the manager,
unchanged. The poll rate is lower than a screencast, so the live view feels slower than Chrome's; the guide
for the package says so.

## Tests

- A fake Playwright (an object with the used `Page`, `Mouse`, `Keyboard` methods) in `eharness/testing`
  style: refs and staleness, blocked clicks, polled frames and the hash rule, `LiveInput` mapping.
- `browserProfileStoreConformance` is not needed (the package adds no store).
- Runtime: platform pick and install steps with an injected `fetch` and a fake launcher; the no-telemetry
  test; real runs only with `EH_BROWSER_E2E=1`.

## Open questions for its own plan

1. Playwright's `accessibility` snapshot is deprecated in newer versions: choose between an injected ARIA
   snapshot and a small DOM walk, and test on Camoufox.
2. Which Camoufox release to pin first, and where its checksum comes from.
3. Whether the package needs a `Page.screencast`-like faster feed (a Firefox remote-debugging screencast
   if one appears) before the team app offers it as a card.
